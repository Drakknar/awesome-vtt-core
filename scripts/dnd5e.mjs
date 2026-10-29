/**
 * Part of awesome-vtt-core, shared by awesome-vtt and awesome-vtt-mobile.
 * dnd5e (6.x) adapter: reads actor data for the compact sheet and triggers system rolls.
 * Everything system-specific lives here so other systems can be added as separate adapters.
 */

import {
  MAX_QUANTITY, MAX_CURRENCY, byName, signed, getToggleEffects, queueEffects, raceTolerant, waitFor, plainText,
  onRollResult as onRollResultFor,
  hpAmount, changeQuantity, toggleEffect, rollNotice
} from "./common.mjs";

// System-neutral helpers the shared code reaches through this adapter (see system.mjs).
export { hpAmount, changeQuantity, toggleEffect, rollNotice };

const loc = key => (key ? game.i18n.localize(key) : "");

/* -------------------------------------------- */
/*  What this system offers                     */
/* -------------------------------------------- */

/**
 * Features the shared code shows or hides: death saves, automation prompts (dnd5e messages), the phone's
 * step-by-step use dialog (dnd5e activities), and how initiative is set ("roll").
 */
export const FEATURES = {
  deathSaves: true, prompts: true, useSteps: true, initiative: "roll", party: true,
  // Using an item doesn't take the Next roll choice: dnd5e's own attack roll asks (or the phone's use dialog).
  itemRollMode: false,
  // Checks, saves and skills from the sheet can first ask for advantage (prompts.mjs askSheetRoll; the module's
  // per-browser setting, off by default in dnd5e). dnd5e's own dialog is skipped, as before.
  abilityRollPrompt: true,
  /** RollDamageAfterAttacks rolls attack damage by itself (when the module's setting allows it). */
  autoDamage: true
};

/** The compact sheet's tabs, in the user's order (core sheet.mjs). */
export const SHEET_TABS = ["actions", "skills", "spells", "abilities", "inventory", "status", "bio"];

/** The "Next roll" choice for d20 rolls: advantage or disadvantage. Labels come from each module. */
export const ROLL_MODES = ["normal", "adv", "dis"];
export const rollModeLabel = () => null;
export const rollModeShort = () => null;
/**
 * The modules' own "Next roll" heading; no scale under the three choices.
 * @returns {null}
 */
export const rollModeScale = () => null;

/**
 * The dice pool's single d20 under a roll mode (rolled twice, keep the higher or lower), or null.
 * @param {string} mode
 * @returns {string|null}
 */
export const poolD20 = mode => ({ adv: "2d20kh", dis: "2d20kl" })[mode] ?? null;

/**
 * The rests offered in quick actions: a button each, with its sheet action.
 * @returns {{action: string, icon: string, label: string}[]}
 */
export const getRests = () => [
  { action: "shortRest", icon: "fa-mug-hot", label: loc("AVTTC.Rest.short") },
  { action: "longRest", icon: "fa-campground", label: loc("AVTTC.Rest.long") }
];

/**
 * Trackers changed with − / + in quick actions (none in dnd5e; exhaustion has its own line).
 * @returns {null}
 */
export const changeTrack = () => null;

/**
 * Fast / slow turns are SotDL's; dnd5e rolls initiative.
 * @returns {null}
 */
export const turnSpeed = () => null;
export const setTurnSpeed = () => null;

/**
 * Roll results for the seat and phone notices, as summarizeRoll() sees them.
 * @param {function(object, ChatMessage): void} fn
 * @param {object} options
 * @returns {void}
 */
export const onRollResult = (fn, options = {}) => onRollResultFor(fn, { ...options, summarize: summarizeRoll });

/**
 * Advantage mode → dnd5e roll process config.
 * @param {string} mode
 * @returns {{advantage: boolean, disadvantage: boolean}}
 */
function advConfig(mode) {
  return { advantage: mode === "adv", disadvantage: mode === "dis" };
}

/** D20 rolls skip the dnd5e configuration dialog; advantage comes from the module's own choice (`mode`). */
const NO_DIALOG = { configure: false };

/**
 * The pill's summary of a character: name, level, HP, stats, death saves and conditions.
 * @param {Actor} actor
 * @returns {object}
 */
export function getSummary(actor) {
  const sys = actor.system;
  const hp = sys.attributes.hp ?? {};
  const max = hp.effectiveMax ?? hp.max ?? 0;
  const classes = Object.values(actor.classes ?? {}).map(c => `${c.name} ${c.system.levels}`).join(" / ");
  const conditionIds = new Set(Object.keys(CONFIG.DND5E.conditionTypes ?? {}));
  return {
    name: actor.name,
    img: actor.img,
    level: sys.details?.level ?? 0,
    classes,
    hp: { value: hp.value ?? 0, max, temp: hp.temp ?? 0, pct: max ? Math.clamp((hp.value / max) * 100, 0, 100) : 0 },
    ac: sys.attributes.ac?.value ?? 0,
    init: sys.attributes.init?.total ?? 0,
    speed: sys.attributes.movement?.speeds?.walk ?? sys.attributes.movement?.walk ?? 0,
    inspiration: !!sys.attributes.inspiration,
    inspirationLabel: loc("DND5E.Inspiration"),
    // The pill's stats under the HP bar: icon, value and the name shown in its tooltip.
    stats: [
      { key: "ac", icon: "fa-shield-halved", value: sys.attributes.ac?.value ?? 0, label: loc("AVTTC.Stat.ac") },
      { key: "init", icon: "fa-bolt", value: signed(sys.attributes.init?.total ?? 0), label: loc("AVTTC.Stat.init") },
      { key: "speed", icon: "fa-person-running", value: sys.attributes.movement?.speeds?.walk ?? sys.attributes.movement?.walk ?? 0,
        label: loc("AVTTC.Stat.speed") }
    ],
    death: sys.attributes.death ?? { success: 0, failure: 0 },
    dying: (hp.value ?? 1) <= 0,
    conditions: CONFIG.statusEffects
      .filter(e => conditionIds.has(e.id))
      .map(e => ({ id: e.id, label: loc(e.name), img: e.img, active: actor.statuses.has(e.id) }))
  };
}

/**
 * The Bio tab (read-only), as dnd5e's Biography tab: species, background, classes, alignment, faith, personality
 * (traits, ideals, bonds, flaws), appearance and the biography. The phone has no full sheet to read them on.
 * The biography is enriched by the core's enrichSheet.
 * @param {Actor} actor
 * @returns {{facts: object[], appearance: object[], appearanceLabel: string, descriptionLabel: string,
 *   description: string}}
 */
export function getBio(actor) {
  const d = actor.system.details ?? {};
  const itemName = type => actor.items.find(i => i.type === type)?.name;
  const classes = actor.items.filter(i => i.type === "class").map(c => `${c.name} ${c.system.levels ?? ""}`.trim()).join(", ");
  const rows = list => list.map(([label, value]) => ({ label: loc(label), value: String(value ?? "").trim() })).filter(r => r.value);
  return {
    facts: rows([
      ["TYPES.Item.race", itemName("race")], ["TYPES.Item.background", itemName("background")],
      ["TYPES.Item.classPl", classes], ["DND5E.Alignment", d.alignment], ["DND5E.Faith", d.faith],
      ["DND5E.PersonalityTraits", d.trait], ["DND5E.Ideals", d.ideal], ["DND5E.Bonds", d.bond], ["DND5E.Flaws", d.flaw]
    ]),
    appearance: rows([
      ["DND5E.Gender", d.gender], ["DND5E.Age", d.age], ["DND5E.Height", d.height], ["DND5E.Weight", d.weight],
      ["DND5E.Eyes", d.eyes], ["DND5E.Hair", d.hair], ["DND5E.Skin", d.skin], ["DND5E.Appearance", d.appearance]
    ]),
    appearanceLabel: loc("DND5E.Appearance"),
    descriptionLabel: loc("DND5E.Biography"),
    description: d.biography?.value ?? ""
  };
}

/**
 * The abilities with their score, modifier and save, for the Abilities tab.
 * @param {Actor} actor
 * @returns {{key: string, abbr: string, value: number, mod: string, save: string, proficient: boolean}[]}
 */
export function getAbilities(actor) {
  return Object.entries(CONFIG.DND5E.abilities).map(([key, cfg]) => {
    const a = actor.system.abilities?.[key] ?? {};
    return {
      key,
      abbr: loc(cfg.abbreviation).toUpperCase(),
      value: a.value ?? 10,
      mod: signed(a.mod ?? 0),
      save: signed(a.save?.value ?? a.mod ?? 0),
      proficient: !!a.proficient
    };
  });
}

/**
 * The skills with their total, passive score and proficiency, sorted by name.
 * @param {Actor} actor
 * @returns {{key: string, label: string, total: string, passive: number, proficient: boolean}[]}
 */
export function getSkills(actor) {
  return Object.entries(CONFIG.DND5E.skills)
    .map(([key, cfg]) => {
      const s = actor.system.skills?.[key] ?? {};
      return {
        key, label: loc(cfg.label), total: signed(s.total ?? 0), passive: s.passive ?? 10, proficient: (s.value ?? 0) > 0
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Groups of usable items: favorites, weapons, spells by level, features, consumables.
 * @param {Actor} actor
 * @returns {{label: string, items: object[], slots?: object|null}[]}
 */
export function getActions(actor) {
  const toEntry = item => {
    const uses = item.system.uses;
    return {
      id: item.id,
      name: item.name,
      img: item.img,
      favorite: isFavorite(actor, item),
      // Remaining uses, editable to undo an accidental use.
      usesValue: uses?.max ? uses.value : null,
      usesMax: uses?.max || null
    };
  };

  const favoriteIds = new Set(
    (actor.system.favorites ?? [])
      .filter(f => f.type === "item")
      .map(f => fromUuidSync(f.id, { relative: actor })?.id)
      .filter(Boolean)
  );

  const groups = [];
  const push = (label, items, extra = {}) => {
    if ( items.length ) groups.push({ label, items: items.map(toEntry), ...extra });
  };

  push(loc("AVTTC.Sheet.Favorites"), actor.items.filter(i => favoriteIds.has(i.id)));
  push(loc("AVTTC.Sheet.Weapons"), actor.items.filter(i => i.type === "weapon" && i.system.equipped));

  // Spells that can be cast now (see isSpellAvailable); the Spells tab lists all of them.
  const spells = actor.items.filter(i => i.type === "spell" && isSpellAvailable(i) && i.system.activities?.size);
  for ( const { level, label, slots } of spellLevels(actor) ) {
    push(label, spells.filter(s => s.system.level === level), { slots });
  }
  const pact = pactSlots(actor);
  if ( pact ) groups.push({ label: loc("AVTTC.Sheet.PactSlots"), items: [], slots: pact });

  push(loc("AVTTC.Sheet.Features"), actor.items.filter(i => i.type === "feat" && i.system.activities?.size));
  push(loc("AVTTC.Sheet.Consumables"), actor.items.filter(i => i.type === "consumable"));
  return groups;
}

/**
 * Spell levels 0–9 with their label and remaining slots (null for cantrips or without slots).
 * @param {Actor} actor
 * @returns {{level: number, label: string, slots: {key: string, value: number, max: number}|null}[]}
 */
function spellLevels(actor) {
  return Array.from({ length: 10 }, (_, level) => {
    const slot = actor.system.spells?.[`spell${level}`];
    return {
      level,
      label: loc(CONFIG.DND5E.spellLevels[level]),
      slots: (level > 0) && slot?.max ? { key: `spell${level}`, value: slot.value, max: slot.max } : null
    };
  });
}

/**
 * Pact magic slots, if the actor has any.
 * @param {Actor} actor
 * @returns {{key: string, value: number, max: number}|null}
 */
function pactSlots(actor) {
  const pact = actor.system.spells?.pact;
  return pact?.max ? { key: "pact", value: pact.value, max: pact.max } : null;
}

/**
 * Every spell the character has, by level, for the Spells tab: whether it can be cast now (prepared, or from a
 * method that doesn't prepare), and whether the player may prepare or unprepare it (not always-prepared ones).
 * Slot counts are shown per level, as in Actions.
 * @param {Actor} actor
 * @returns {{label: string, slots: object|null, items: object[]}[]}
 */
export function getSpells(actor) {
  const states = CONFIG.DND5E.spellPreparationStates;
  const toEntry = item => {
    const s = item.system;
    const always = s.prepared === states.always.value;
    const uses = s.uses;
    return {
      id: item.id,
      name: item.name,
      img: item.img,
      favorite: isFavorite(actor, item),
      usable: isSpellAvailable(item) && !!s.activities?.size,
      canPrepare: !!CONFIG.DND5E.spellcasting[s.method]?.prepares && (s.level > 0) && !always,
      prepared: s.prepared >= states.prepared.value,
      always,
      concentration: !!s.properties?.has("concentration"),
      ritual: !!s.properties?.has("ritual"),
      usesValue: uses?.max ? uses.value : null,
      usesMax: uses?.max || null
    };
  };
  const spells = actor.items.filter(i => i.type === "spell").sort((a, b) => a.name.localeCompare(b.name));
  const groups = spellLevels(actor)
    .map(({ level, label, slots }) => ({
      label, slots, items: spells.filter(s => s.system.level === level).map(toEntry)
    }))
    .filter(g => g.items.length);
  const pact = pactSlots(actor);
  if ( pact ) groups.push({ label: loc("AVTTC.Sheet.PactSlots"), items: [], slots: pact });
  return groups;
}

/**
 * Prepare or unprepare a spell (not always-prepared ones, nor methods without preparation).
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {Promise<Item>|undefined}
 */
export function togglePrepared(actor, itemId) {
  const item = actor.items.get(itemId);
  const s = item?.system;
  const states = CONFIG.DND5E.spellPreparationStates;
  if ( (item?.type !== "spell") || !CONFIG.DND5E.spellcasting[s.method]?.prepares || !(s.level > 0) ) return;
  if ( s.prepared === states.always.value ) return;
  const value = (s.prepared >= states.prepared.value) ? states.unprepared.value : states.prepared.value;
  return item.update({ "system.prepared": value });
}

/** Most favorites the table pill shows on its favorites row. */
const FAVORITES_MAX = 8;

/**
 * Can this actor keep favorites (dnd5e characters can)?
 * @param {Actor|null} actor
 * @returns {boolean}
 */
export const canFavorite = actor => typeof actor?.system.addFavorite === "function";

/**
 * The relative uuid dnd5e uses for an item favorite.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {string}
 */
const favoriteId = (actor, item) => foundry.utils.buildRelativeUuid(item, actor);

/**
 * Is this item one of the actor's dnd5e favorites?
 * @param {Actor|null} actor
 * @param {Item} item
 * @returns {boolean}
 */
export const isFavorite = (actor, item) => !!actor?.system.hasFavorite?.(favoriteId(actor, item));

/**
 * Add an item to the actor's dnd5e favorites, or remove it, as the dnd5e sheet's star does.
 * @param {Actor|null} actor
 * @param {string} itemId
 * @returns {Promise<Actor>|undefined}
 */
export function toggleFavorite(actor, itemId) {
  const item = actor?.items.get(itemId);
  if ( !item || !canFavorite(actor) ) return;
  const id = favoriteId(actor, item);
  return actor.system.hasFavorite(id) ? actor.system.removeFavorite(id) : actor.system.addFavorite({ type: "item", id });
}

/**
 * The actor's favorite items, in dnd5e's favorites order (the table pill's favorites row), at most FAVORITES_MAX.
 * @param {Actor} actor
 * @returns {{id: string, name: string, img: string}[]}
 */
export function getFavoriteActions(actor) {
  return (actor.system.favorites ?? [])
    .filter(f => f.type === "item")
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map(f => fromUuidSync(f.id, { relative: actor }))
    .filter(item => item?.parent === actor)
    .slice(0, FAVORITES_MAX)
    .map(({ id, name, img }) => ({ id, name, img }));
}

/**
 * Cantrips, prepared/always-prepared spells, and spells from methods that don't require preparation.
 * @param {Item} spell
 * @returns {boolean}
 */
function isSpellAvailable(spell) {
  const s = spell.system;
  if ( s.level === 0 ) return true;
  if ( !CONFIG.DND5E.spellcasting[s.method]?.prepares ) return true;
  return s.prepared >= CONFIG.DND5E.spellPreparationStates.prepared.value;
}


/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

export const rollAbility = (actor, ability, mode) =>
  actor.rollAbilityCheck({ ability, ...advConfig(mode) }, NO_DIALOG);

export const rollSave = (actor, ability, mode) =>
  actor.rollSavingThrow({ ability, ...advConfig(mode) }, NO_DIALOG);

export const rollSkill = (actor, skill, mode) =>
  actor.rollSkill({ skill, ...advConfig(mode) }, NO_DIALOG);

export const rollDeathSave = (actor, mode) =>
  actor.rollDeathSave({ ...advConfig(mode) }, NO_DIALOG);

/**
 * Item use keeps dnd5e's own dialog logic (e.g. choosing a spell slot); the roll mode isn't used (FEATURES).
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {Promise<object|undefined>|undefined}
 */
export const useItem = (actor, itemId) => actor.items.get(itemId)?.use();

/* -------------------------------------------- */
/*  Levelling up                                */
/* -------------------------------------------- */

/**
 * Whether the character can gain a level (below dnd5e's maximum character level), and whether it is due by XP.
 * @param {Actor|null} actor
 * @returns {{canLevel: boolean, ready: boolean}}
 */
export function levelInfo(actor) {
  const level = actor?.system.details?.level ?? 0;
  const xp = actor?.system.details?.xp;
  const canLevel = (actor?.type === "character") && (level < CONFIG.DND5E.maxLevel);
  return { canLevel, ready: canLevel && Number.isFinite(xp?.max) && (xp.value >= xp.max) };
}

/**
 * Open a level-up window: Hero Mancer's (its public API, `openLevelUp(actor)`) when that module is active, otherwise
 * the character's own sheet, where dnd5e levels up from the class level selector. No levelling logic of our own.
 * @param {Actor|null} actor
 * @returns {Promise<unknown>|undefined}
 */
export function openLevelUp(actor) {
  if ( !actor ) return;
  const heroMancer = game.modules.get("hero-mancer");
  if ( heroMancer?.active && (typeof heroMancer.api?.openLevelUp === "function") ) return heroMancer.api.openLevelUp(actor);
  return actor.sheet?.render({ force: true });
}

/** HP field modes: damage, healing, or temporary hit points (kept only if higher than the current, per the rules). */
export const HP_MODES = ["damage", "heal", "temp"];

/**
 * Apply an HP field entry in one of HP_MODES. dnd5e's applyDamage takes damage as positive and healing as negative;
 * applyTempHP only raises temporary hit points, per the rules.
 * @param {Actor|null} actor
 * @param {"damage"|"heal"|"temp"} mode
 * @param {number} amount
 * @returns {Promise<Actor>|undefined}
 */
export function applyHpChange(actor, mode, amount) {
  if ( !actor || !amount ) return;
  if ( mode === "temp" ) return actor.applyTempHP(amount);
  return actor.applyDamage(mode === "damage" ? amount : -amount);
}

export const toggleInspiration = actor =>
  actor.update({ "system.attributes.inspiration": !actor.system.attributes.inspiration });

/**
 * Toggle a condition. For a condition with levels (exhaustion), dnd5e's toggle only ever adds a level, so here a
 * tap clears it when it's on and adds one level when it's off; the levels themselves are set with the − / + controls.
 * @param {Actor} actor
 * @param {string} id
 * @returns {Promise<void>|undefined}
 */
export function toggleCondition(actor, id) {
  if ( CONFIG.DND5E.conditionTypes?.[id]?.levels && (id === "exhaustion") ) {
    return exhaustionEffect(actor) ? setExhaustion(actor, 0) : changeExhaustion(actor, 1);
  }
  // CONFIG.statusEffects is an array that can also be read by status id (Foundry v14).
  if ( !CONFIG.statusEffects[id] ) return;
  // Decided now, from what the player saw; applied as an explicit on / off, so a repeat can't flip it back.
  const active = !actor.statuses.has(id);
  return queueEffects(actor, async () => {
    if ( actor.statuses.has(id) === active ) return;
    await raceTolerant(() => actor.toggleStatusEffect(id, { active }));
    await waitFor(() => actor.statuses.has(id) === active, 2000);
  });
}

/**
 * Change an item's remaining uses by one (stored by dnd5e as uses spent).
 * @param {Actor} actor
 * @param {string} itemId
 * @param {number} delta
 * @returns {Promise<Item>|undefined}
 */
export function changeUses(actor, itemId, delta) {
  const item = actor.items.get(itemId);
  const max = item?.system.uses?.max;
  if ( !max ) return;
  const value = Math.clamp((item.system.uses.value ?? 0) + Math.sign(delta), 0, max);
  return item.update({ "system.uses.spent": max - value });
}

/**
 * Change the remaining slots of a spell level ("spell1"…"spell9", or "pact") by one.
 * @param {Actor} actor
 * @param {string} key
 * @param {number} delta
 * @returns {Promise<Actor>|undefined}
 */
export function changeSlots(actor, key, delta) {
  const slot = actor.system.spells?.[key];
  if ( !slot?.max || !/^(spell[1-9]|pact)$/.test(key) ) return;
  const value = Math.clamp((slot.value ?? 0) + Math.sign(delta), 0, slot.max);
  return actor.update({ [`system.spells.${key}.value`]: value });
}

export const shortRest = actor => actor.shortRest();
export const longRest = actor => actor.longRest();

/**
 * The actor's combatants in a combat (the viewed one by default) that haven't rolled initiative.
 * @param {Actor|null} actor
 * @param {Combat|null} combat
 * @returns {Combatant[]}
 */
export const initiativeDue = (actor, combat = game.combat) =>
  combat?.combatants.filter(c => (c.actorId === actor?.id) && (c.initiative === null) && !c.isDefeated) ?? [];

/**
 * Roll initiative for the actor's combatants that haven't rolled, without dnd5e's dialog (like the other d20 rolls
 * here), using the module's Next roll choice on top of the actor's own modifiers (e.g. features granting advantage):
 * only an armed choice is passed, so dnd5e's automatic advantage or disadvantage is kept. dnd5e's own
 * Actor#rollInitiative does the rest (roll message, tiebreaker, fixed scores, physical dice).
 * @param {Actor} actor
 * @param {"normal"|"adv"|"dis"} [mode]
 * @returns {Promise<Combat>|null}
 */
export function rollInitiative(actor, mode = "normal") {
  if ( !initiativeDue(actor).length ) return null;
  const rollOptions = (mode === "adv") ? { advantage: true } : (mode === "dis") ? { disadvantage: true } : {};
  return actor.rollInitiative({ createCombatants: false, rerollInitiative: false }, rollOptions);
}

/* -------------------------------------------- */
/*  Inventory                                   */
/* -------------------------------------------- */

/** Item types that are carried (dnd5e physical items), in display order. */
export const INVENTORY_TYPES = ["weapon", "equipment", "consumable", "tool", "container", "loot"];


/**
 * The actor's coins, one entry per kind (the inventory and the shared inventory).
 * @param {Actor|null} actor
 * @returns {{key: string, label: string, abbr: string, icon: string, value: number}[]}
 */
export const getCurrency = actor => Object.entries(CONFIG.DND5E.currencies ?? {}).map(([key, cfg]) => ({
  key, label: loc(cfg.label), abbr: loc(cfg.abbreviation), icon: cfg.icon, value: actor?.system.currency?.[key] ?? 0
}));

/**
 * Currency, carrying weight, attunement and carried items grouped by type (container contents nested).
 * @param {Actor} actor
 * @returns {{currency: object[], encumbrance: object|null, attunement: object|null, groups: object[]}}
 */
export function getInventory(actor) {
  const sys = actor.system;
  const enc = sys.attributes?.encumbrance ?? {};
  const att = sys.attributes?.attunement ?? {};
  const carried = actor.items.filter(i => INVENTORY_TYPES.includes(i.type));
  const inContainer = item => !!item.system.container && !!actor.items.get(item.system.container);

  const toEntry = item => {
    const s = item.system;
    return {
      id: item.id,
      name: item.name,
      img: item.img,
      favorite: isFavorite(actor, item),
      quantity: s.quantity ?? 1,
      equippable: "equipped" in s,
      equipped: !!s.equipped,
      attunable: ["required", "optional"].includes(s.attunement),
      attuned: !!s.attuned,
      usable: !!s.activities?.size,
      uses: s.uses?.max ? `${s.uses.value}/${s.uses.max}` : "",
      contents: item.type === "container"
        ? carried.filter(i => i.system.container === item.id).sort(byName).map(toEntry)
        : []
    };
  };

  const groups = INVENTORY_TYPES.map(type => {
    const items = carried.filter(i => (i.type === type) && !inContainer(i)).sort(byName);
    const key = `TYPES.Item.${type}Pl`;
    return { label: game.i18n.has(key) ? loc(key) : loc(CONFIG.Item.typeLabels[type]), items: items.map(toEntry) };
  }).filter(g => g.items.length);

  return {
    currency: getCurrency(actor),
    encumbrance: Number.isFinite(enc.max) && enc.max > 0
      ? { value: enc.value ?? 0, max: enc.max, pct: enc.pct ?? 0, encumbered: !!enc.encumbered }
      : null,
    attunement: att.max ? { value: att.value ?? 0, max: att.max } : null,
    groups
  };
}


/**
 * The description a player may see (dnd5e hides the real one of unidentified items from players).
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {Promise<string>}
 */
export async function getItemDescription(actor, itemId) {
  const item = actor.items.get(itemId);
  if ( !item ) return "";
  const path = item.system.embeddedDescriptionKeyPath ?? "description.value";
  const html = foundry.utils.getProperty(item.system, path) ?? "";
  return foundry.applications.ux.TextEditor.implementation.enrichHTML(html, {
    secrets: item.isOwner, relativeTo: item, rollData: item.getRollData?.()
  });
}

/**
 * Set how many coins of one kind the actor has (kept from 0 to MAX_CURRENCY).
 * @param {Actor} actor
 * @param {string} key
 * @param {number|string} value
 * @returns {Promise<Actor>|undefined}
 */
export function setCurrency(actor, key, value) {
  if ( !(key in (CONFIG.DND5E.currencies ?? {})) ) return;
  const n = Math.clamp(Math.floor(Number(value) || 0), 0, MAX_CURRENCY);
  return actor.update({ [`system.currency.${key}`]: n });
}


/* -------------------------------------------- */
/*  Moving coins and items between actors       */
/* -------------------------------------------- */

/**
 * Move coins of one kind from one actor to another (e.g. a character and the party), at most what the giver has.
 * The giver is updated first, so a failed second update never creates coins.
 * @param {Actor|null} from
 * @param {Actor|null} to
 * @param {string} key
 * @param {number|string} amount
 * @returns {Promise<number>}  How many coins were moved.
 */
export async function moveCurrency(from, to, key, amount) {
  if ( !from?.isOwner || !to?.isOwner || !(key in (CONFIG.DND5E.currencies ?? {})) ) return 0;
  const have = from.system.currency?.[key] ?? 0;
  const n = Math.min(Math.clamp(Math.floor(Number(amount) || 0), 0, MAX_CURRENCY), have);
  if ( !n ) return 0;
  await from.update({ [`system.currency.${key}`]: have - n });
  await to.update({ [`system.currency.${key}`]: Math.min((to.system.currency?.[key] ?? 0) + n, MAX_CURRENCY) });
  return n;
}

/**
 * A loose item with this name and type (not a container, not inside one), to add quantities to.
 * @param {Actor} actor
 * @param {string} name
 * @param {string} type
 * @returns {Item|undefined}
 */
function stackFor(actor, name, type) {
  const lower = name.toLowerCase();
  return actor.items.find(i => (i.type === type) && (type !== "container") && !i.system.container
    && (i.name.toLowerCase() === lower) && ("quantity" in i.system));
}

const addToStack = (stack, quantity) =>
  stack.update({ "system.quantity": Math.min((stack.system.quantity ?? 0) + quantity, MAX_QUANTITY) });

/**
 * Add an item typed by name, as loot: more of a loose loot item with that name, or a new one.
 * @param {Actor|null} actor
 * @param {string} name
 * @param {number|string} quantity
 * @returns {Promise<Item|undefined>|null}
 */
export function addNamedItem(actor, name, quantity) {
  name = String(name ?? "").trim().slice(0, 80);
  if ( !actor?.isOwner || !name ) return null;
  const qty = Math.clamp(Math.floor(Number(quantity) || 1), 1, MAX_QUANTITY);
  const stack = stackFor(actor, name, "loot");
  if ( stack ) return addToStack(stack, qty);
  return Item.implementation.create({ name, type: "loot", system: { quantity: qty } }, { parent: actor });
}

/**
 * Copy carried items onto an actor, with any container contents, as dnd5e does for items dropped on a sheet.
 * Items that aren't containers are added to a loose item of the same name and type that is already there.
 * @param {Item[]} items  From another actor, the world or a compendium.
 * @param {Actor} target
 */
export async function copyItems(items, target) {
  for ( const item of items ) {
    if ( !INVENTORY_TYPES.includes(item.type) ) continue;
    const stack = stackFor(target, item.name, item.type);
    if ( stack ) {
      await addToStack(stack, item.system.quantity ?? 1);
      continue;
    }
    const data = await dnd5e.documents.Item5e.createWithContents([item]);
    if ( data?.length ) await Item.implementation.createDocuments(data, { parent: target, keepId: true });
  }
}

/**
 * Move a whole stack (with any container contents) from one actor to another.
 * @param {Actor|null} from
 * @param {Actor|null} to
 * @param {string} itemId
 * @returns {Promise<Item|undefined>}
 */
export async function moveItem(from, to, itemId) {
  const item = from?.items.get(itemId);
  if ( !item || !INVENTORY_TYPES.includes(item.type) || !from.isOwner || !to?.isOwner || (from === to) ) return;
  await copyItems([item], to);
  return item.delete({ deleteContents: true });
}

/**
 * Equip or unequip an item that can be equipped.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {Promise<Item>|undefined}
 */
export function toggleEquipped(actor, itemId) {
  const item = actor.items.get(itemId);
  if ( item && ("equipped" in item.system) ) return item.update({ "system.equipped": !item.system.equipped });
}

/**
 * Attune to an item that allows attunement, or end it.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {Promise<Item>|undefined}
 */
export function toggleAttuned(actor, itemId) {
  const item = actor.items.get(itemId);
  if ( item && ["required", "optional"].includes(item.system.attunement) ) {
    return item.update({ "system.attuned": !item.system.attuned });
  }
}

/* -------------------------------------------- */
/*  Quick actions                               */
/* -------------------------------------------- */

/** Status effects offered as one-tap toggles (the full list stays with the conditions). */
const QUICK_STATUSES = ["prone", "dodging", "hiding", "invisible"];

/**
 * Data for quick actions: exhaustion, concentration, a few common conditions, and toggleable effects.
 * @param {Actor5e} actor
 * @param {Set<string>} [toggled]  Effect uuids toggled during this session, kept in the list after being enabled.
 * @returns {{exhaustion: {value: number, max: number}, concentration: object[], tracks: object[],
 *   quickConditions: object[], effects: object[]}}
 */
export function getQuickActions(actor, toggled = new Set()) {
  const sys = actor.system;
  const concentration = [...(actor.concentration?.effects ?? [])].map(e => ({ id: e.id, name: e.name }));
  const statusById = new Map(CONFIG.statusEffects.map(e => [e.id, e]));
  const quickConditions = QUICK_STATUSES.filter(id => statusById.has(id)).map(id => ({
    id, label: loc(statusById.get(id).name), img: statusById.get(id).img, active: actor.statuses.has(id)
  }));
  return {
    exhaustion: {
      value: exhaustionEffect(actor)?.system.level ?? sys.attributes?.exhaustion ?? 0,
      max: CONFIG.DND5E.conditionTypes?.exhaustion?.levels ?? 6
    },
    concentration,
    tracks: [],
    quickConditions,
    effects: getToggleEffects(actor, toggled)
  };
}


/**
 * End one concentration, if it is still going (it may have been broken by a save, or ended on another device).
 * @param {Actor} actor
 * @param {string} effectId
 * @returns {Promise<void>}
 */
export function endConcentration(actor, effectId) {
  return queueEffects(actor, async () => {
    if ( !actor.effects.has(effectId) ) return;
    await raceTolerant(() => actor.endConcentration(effectId));
  });
}

/* -------------------------------------------- */
/*  Changing effects safely                     */
/* -------------------------------------------- */


/**
 * dnd5e's exhaustion effect (fixed id) on this actor, if any.
 * @param {Actor} actor
 * @returns {ActiveEffect|undefined}
 */
const exhaustionEffect = actor => actor.effects.get(dnd5e.utils.staticID("dnd5eexhaustion"));

/**
 * Change the exhaustion level by one step.
 * dnd5e keeps the level on an effect with a fixed id ("dnd5eexhaustion0") and reads the actor's exhaustion from it.
 * Going through the actor's exhaustion number made dnd5e edit that effect afterwards, unawaited, from a difference
 * that could be stale: a change could do nothing, or delete an effect that was already gone. So the effect is
 * changed directly, and changes for an actor are queued so they never overlap.
 * @param {Actor} actor
 * @param {number} delta
 * @returns {Promise<void>}
 */
export function changeExhaustion(actor, delta) {
  return queueExhaustion(actor, current => current + Math.sign(delta));
}

/**
 * Set the exhaustion level (e.g. 0 to clear it), through the same queue.
 * @param {Actor} actor
 * @param {number} level
 * @returns {Promise<void>}
 */
function setExhaustion(actor, level) {
  return queueExhaustion(actor, () => level);
}

/**
 * Queue a change of the exhaustion level, worked out from the current level when it runs.
 * @param {Actor} actor
 * @param {(current: number) => number} levelFrom
 * @returns {Promise<void>}
 */
function queueExhaustion(actor, levelFrom) {
  const run = async () => {
    const max = CONFIG.DND5E.conditionTypes?.exhaustion?.levels ?? 6;
    const effect = exhaustionEffect(actor);
    const current = effect?.system.level ?? 0;
    const value = Math.clamp(Math.floor(levelFrom(current)), 0, max);
    if ( value === current ) return;
    if ( value === 0 ) {
      // Only delete it if it is still there.
      if ( exhaustionEffect(actor) ) await raceTolerant(() => exhaustionEffect(actor)?.delete());
    }
    else if ( effect ) await raceTolerant(() => effect.update({ "system.level": value }));
    // No effect yet: dnd5e creates it with the given number of levels.
    else await raceTolerant(() => actor.toggleStatusEffect("exhaustion", { levels: value }));
    await waitFor(() => (exhaustionEffect(actor)?.system.level ?? 0) === value, 2000);
  };
  return queueEffects(actor, run);
}


/* -------------------------------------------- */
/*  Prompted rolls                              */
/* -------------------------------------------- */

/**
 * Concentration saving throw, as requested by dnd5e's concentration prompt message.
 * @param {Actor} actor
 * @param {object} root0
 * @param {string} root0.ability
 * @param {number} root0.dc
 * @param {string} mode
 * @returns {Promise<Roll[]|null>}
 */
export const rollConcentration = (actor, { ability, dc } = {}, mode = "normal") =>
  actor.rollConcentration({ ...(ability ? { ability } : {}), target: dc ?? 10, ...advConfig(mode) }, NO_DIALOG);

/**
 * Saving throw against a save activity's chat card, rolled the way dnd5e's own card button does
 * (SaveActivity#rollSave): same ability, DC and activity bonus, and linked to the card so its outcome is tracked.
 * @param {Actor} actor
 * @param {Activity} activity
 * @param {ChatMessage} message
 * @param {string} ability
 * @param {string} mode
 * @returns {Promise<Roll[]|null>}
 */
export async function rollActivitySave(actor, activity, message, ability, mode) {
  const dc = activity.save?.dc?.value;
  const bonus = CONFIG.Dice.BasicRoll.replaceFormulaData(activity.save?.bonus ?? "", activity.getRollData(), { missing: 0 });
  const bonusData = CONFIG.Dice.BasicRoll.constructParts({ activityBonus: bonus });
  const config = { ability, ...advConfig(mode) };
  if ( Number.isFinite(dc) ) config.target = dc;
  if ( bonusData.parts.length ) config.rolls = [bonusData];
  return actor.rollSavingThrow(config, NO_DIALOG, {
    data: { speaker: ChatMessage.getSpeaker({ actor }), system: { ...activity.messageSources, origin: message.id } }
  });
}

/**
 * Answer a GM request card (group rest, save or skill check) for one actor, the way dnd5e's card button does,
 * including linking the result back to the request.
 * @param {Actor} actor
 * @param {ChatMessage} message
 * @returns {Promise<unknown>}
 */
export async function answerRequest(actor, message) {
  const handler = CONFIG.DND5E.requests?.[message.system?.handler];
  if ( !handler ) return;
  const result = await handler(actor, message, message.system.data, {});
  if ( (result instanceof ChatMessage) && !result.getFlag("dnd5e", "requestResult") ) {
    await result.setFlag("dnd5e", "requestResult", { actorUuid: actor.uuid, requestId: message.id });
  }
  return result;
}

/* -------------------------------------------- */
/*  Using activities                            */
/* -------------------------------------------- */

/** Target types (CONFIG.DND5E.individualTargetTypes) that mean "one or more specific tokens". */
const TARGETED_TYPES = new Set(["ally", "enemy", "creature", "object", "creatureOrObject", "any", "willing"]);

/**
 * SotDL's item-level targets question; dnd5e asks per activity (needsTargets).
 * @returns {boolean}
 */
export const itemNeedsTargets = () => false;

/** In dnd5e, chat cards take their targets from the user's (the phone's bridge); SotDL lists its buttons. */
export const CARD_TARGET_BUTTONS = null;

/**
 * Does this activity act on specific tokens that must be targeted before use? Attacks and saves do, and activities
 * aimed at creatures (ally, enemy, …).
 * @param {Activity} activity
 * @param {object} [options]
 * @param {boolean} [options.areasNeedTargets]  Areas (measured templates): true where there is no map to place
 *   them on (the player picks the creatures inside instead); false where the area is placed on the map after use.
 * @returns {boolean}
 */
export function needsTargets(activity, { areasNeedTargets = false } = {}) {
  const { affects, template } = activity.target ?? {};
  if ( template?.type ) return areasNeedTargets;
  if ( ["attack", "save"].includes(activity.type) ) return true;
  return TARGETED_TYPES.has(affects?.type);
}

/**
 * Something the activity needs that is missing, checked before use without changing anything, or null.
 * - "noSlot": a spell that uses a slot, with no slot of its level or higher left (pact slots included).
 * - "noUses": the item's or the activity's uses, for fixed costs. Costs with dice, and other resources (actions,
 *   attributes, hit dice, materials), are left to dnd5e's own check after its dialog.
 * Targets are checked separately (needsTargets), since how they are picked differs per module.
 * @param {Activity} activity
 * @param {object} usageConfig  As prepared by dnd5e (the "dnd5e.preUseActivity" hook's second argument).
 * @returns {{reason: "noSlot"|"noUses", name: string, level?: number, value?: number, cost?: number}|null}
 */
export function usageProblem(activity, usageConfig) {
  return missingSlot(activity, usageConfig) ?? missingUses(activity, usageConfig);
}

/**
 * A spell slot the activity needs and the actor doesn't have (see usageProblem), or null.
 * @param {Activity} activity
 * @param {object} usageConfig
 * @returns {{reason: "noSlot", name: string, level: number}|null}
 */
function missingSlot(activity, usageConfig) {
  if ( !activity.requiresSpellSlot || !activity.consumption?.spellSlot ) return null;
  if ( !usageConfig.consume || (usageConfig.consume.spellSlot === false) || usageConfig.cause ) return null;
  if ( activity.item.getFlag("dnd5e", "spellLevel") ) return null; // Spell scrolls: no slot.
  const level = activity.item.system.level ?? 0;
  const spells = activity.actor?.system.spells ?? {};
  const available = Object.entries(spells).some(([key, slot]) => {
    const slotLevel = key.startsWith("spell") ? Number(key.slice(5)) : Number(slot?.level ?? 0);
    return (slotLevel >= level) && (slot?.max > 0) && (slot?.value > 0);
  });
  return available ? null : { reason: "noSlot", name: activity.item.name, level };
}

/**
 * Uses the activity consumes and doesn't have (see usageProblem), or null.
 * @param {Activity} activity
 * @param {object} usageConfig
 * @returns {{reason: "noUses", name: string, value: number, cost: number}|null}
 */
function missingUses(activity, usageConfig) {
  const consume = usageConfig.consume;
  if ( !consume || !consume.resources ) return null;
  const targets = activity.consumption?.targets ?? [];
  const indexes = (consume === true) || (consume.resources === true) ? [...targets.keys()] : consume.resources;
  for ( const index of indexes ) {
    const target = targets[index];
    if ( !["activityUses", "itemUses"].includes(target?.type) ) continue;
    // The cost as dnd5e works it out, without rolling (like its hasZeroCost).
    const roll = target.resolveCost?.({ config: usageConfig, evaluate: false });
    if ( !roll?.isDeterministic ) continue;
    const cost = roll.evaluateSync().total;
    if ( !(cost > 0) ) continue;
    const itemUses = target.type === "itemUses";
    const item = itemUses ? (target.target ? activity.actor?.items.get(target.target) : activity.item) : null;
    const uses = itemUses ? item?.system.uses : activity.uses;
    if ( !uses || !(uses.max > 0) || (uses.value >= cost) ) continue;
    return { reason: "noUses", name: itemUses ? (item?.name ?? activity.item.name) : activity.name, value: uses.value, cost };
  }
  return null;
}

/* -------------------------------------------- */

/**
 * Roll the damage of every attack this client rolls for an actor `applies(actor)` accepts, right after the attack
 * roll: as the chat card's Damage button would (same ability, ammunition and attack mode; critical when the attack
 * roll was), without dnd5e's damage dialog. A hit or a miss doesn't matter: both are always rolled. Register once.
 * @param {(actor: Actor) => boolean} applies
 */
export function rollDamageAfterAttacks(applies) {
  // The dnd5e.rollAttackV2 hook runs before ammunition is used up (an emptied stack may be deleted), so the item can
  // still be read.
  Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => {
    const roll = rolls?.[0];
    const actor = subject?.actor;
    if ( !roll || !actor || !hasDamageToRoll(subject) || !applies(actor) ) return;
    const { ability, ammunition, attackMode } = roll.options ?? {};
    const config = { ability, attackMode, isCritical: roll.isCritical === true };
    const ammo = ammunition ? actor.items.get(ammunition) : null;
    if ( ammo ) config.ammunition = ammo;
    // After the attack's own hooks and message, so the damage card follows the attack card.
    window.setTimeout(() => rollActivityDamage(subject, config, "after the attack"), 0);
  });
}

/**
 * Roll the damage of an attack roll message, as the usage card's Damage button does (same ability, ammunition and
 * attack mode, critical when the attack was, the spell's scaling from the card) but without the damage dialog.
 * Offered on the attack's notice (summarizeRoll's `damage`).
 * @param {ChatMessage} message  The attack roll message.
 * @returns {Promise<void>}
 */
export async function rollDamageFrom(message) {
  if ( !message?.isAuthor || (message.type !== "attack") ) return;
  const origin = message.getOriginatingMessage?.() ?? message;
  const activity = origin.getAssociatedActivity?.({ scaled: true })
    ?? message.getAssociatedActivity?.({ scaled: true });
  if ( typeof activity?.rollDamage !== "function" ) return;
  const { ability, ammunitionItem: ammunition, mode: attackMode } = message.system ?? {};
  const config = { ability, attackMode, isCritical: message.rolls[0]?.isCritical === true };
  if ( ammunition ) config.ammunition = ammunition;
  return rollActivityDamage(activity, config, "from the notice");
}

/**
 * Roll an activity's damage without dnd5e's dialog; a failure is reported, not thrown.
 * @param {Activity} activity
 * @param {object} config
 * @param {string} when
 */
async function rollActivityDamage(activity, config, when) {
  try {
    await activity.rollDamage(config, { configure: false });
  } catch ( err ) {
    console.error(`awesome-vtt-core | Rolling damage ${when} failed`, err);
    ui.notifications.error(err.message);
  }
}

/**
 * Has this activity damage to roll? The same test as dnd5e's Damage button on the attack card.
 * @param {Activity|undefined} activity
 * @returns {boolean}
 */
function hasDamageToRoll(activity) {
  if ( typeof activity?.rollDamage !== "function" ) return false;
  return !!activity.damage?.parts?.length || !!activity.item?.system.properties?.has("amm");
}

/**
 * Has this attack message's activity damage to roll?
 * @param {ChatMessage} message
 * @returns {boolean}
 */
const attackHasDamage = message => hasDamageToRoll(message.getAssociatedActivity?.());

/* -------------------------------------------- */


/**
 * A dnd5e world setting, or undefined if it can't be read (then treated as the most private choice).
 * @param {string} key
 * @returns {unknown}
 */
function dnd5eSetting(key) {
  try {
    return game.settings.get("dnd5e", key);
  } catch {
    return undefined;
  }
}

/**
 * May this roll's pass or fail against its DC be shown? As dnd5e decides for its chat cards
 * (ChatMessage5e#shouldDisplayChallenge): the roller always sees it. A shared screen is read by everyone at the
 * table, so there it follows the "challenge visibility" setting as for another player watching a player's roll:
 * "all" and "player" show it, "none" doesn't.
 * @param {boolean} shared
 * @returns {boolean}
 */
const challengeVisible = shared => game.user.isGM || !shared || ["all", "player"].includes(dnd5eSetting("challengeVisibility"));

/**
 * May hit or miss be shown? dnd5e's "attack roll visibility": shown to players unless "none" (for the roller too).
 * @returns {boolean}
 */
const attackResultVisible = () => game.user.isGM || ["all", "hideAC"].includes(dnd5eSetting("attackRollVisibility"));

/**
 * Hits and misses of an attack against its targets with a known AC, as dnd5e evaluates them (a natural 20 hits,
 * a natural 1 misses). dnd5e counts a target without an AC as a miss; those are left out here.
 * @param {ChatMessage} message
 * @returns {{hit: number, miss: number}|null}
 */
function attackHits(message) {
  const targets = (message.system?.evaluatedTargets ?? []).filter(t => t.ac !== null);
  if ( !targets.length ) return null;
  const miss = targets.filter(t => t.isMiss).length;
  return { hit: targets.length - miss, miss };
}

/**
 * The result of a roll message, for a short notice: damage and healing as summarizeDamage(), any other roll as
 * `kind: "roll"` with its total(s), what was rolled (the message's flavor, else the formula), a natural 20 or 1 on
 * a d20, pass or fail against a DC (checks and saves that carry one), and hits and misses of an attack, each only
 * where dnd5e would show it (see challengeVisible and attackResultVisible). The DC and AC themselves aren't included.
 * `damage` is true for an attack with damage to roll (rollDamageFrom) that didn't miss: it hit a target, or whether
 * it hit isn't known or isn't shown to this player (no target with an AC, "attack roll visibility" off).
 * @param {ChatMessage} message
 * @param {object} [options]
 * @param {boolean} [options.shared]  A screen everyone at the table can read (the table), not the roller's own.
 * @returns {{kind: "damage"|"healing"|"roll", total: number|string, title: string, breakdown: string,
 *   natural?: "critical"|"fumble"|null, outcome?: "success"|"failure"|null, hits?: {hit: number, miss: number}|null,
 *   damage?: boolean}|null}
 */
export function summarizeRoll(message, { shared = false } = {}) {
  const rolls = message.rolls ?? [];
  if ( !rolls.length ) return null;
  if ( (message.type === "damage") || (message.type === "healing") ) {
    return summarizeDamage(rolls, message.getAssociatedActivity?.() ?? message.getAssociatedItem?.());
  }
  const first = rolls[0];
  const test = (message.type === "check") || (message.type === "save");
  let outcome = null;
  if ( test && challengeVisible(shared) ) outcome = (first.isSuccess === true) ? "success" : (first.isFailure === true) ? "failure" : null;
  const attack = message.type === "attack";
  const hits = attack && attackResultVisible() ? attackHits(message) : null;
  return {
    kind: "roll",
    total: rolls.map(r => r.total).join(" / "),
    title: plainText(message.flavor) || first.formula,
    breakdown: "",
    natural: (first.isCritical === true) ? "critical" : (first.isFumble === true) ? "fumble" : null,
    outcome,
    hits,
    damage: attack && (!hits || (hits.hit > 0)) && attackHasDamage(message)
  };
}


/**
 * The totals of evaluated damage or healing rolls, per type.
 * @param {DamageRoll[]} rolls
 * @param {object} [subject]  The activity that rolled.
 * @returns {{kind: "damage"|"healing", total: number, title: string, breakdown: string,
 *   parts: {total: number, label: string, healing: boolean}[]}}
 */
export function summarizeDamage(rolls, subject) {
  const healingTypes = CONFIG.DND5E.healingTypes ?? {};
  const totals = new Map();
  for ( const roll of rolls ) {
    const type = roll.options?.type ?? "";
    totals.set(type, (totals.get(type) ?? 0) + (Number(roll.total) || 0));
  }
  const parts = [...totals].map(([type, total]) => ({
    total,
    label: loc(CONFIG.DND5E.damageTypes?.[type]?.label ?? healingTypes[type]?.label),
    healing: type in healingTypes
  }));
  return {
    kind: parts.every(p => p.healing) ? "healing" : "damage",
    total: parts.reduce((sum, p) => sum + p.total, 0),
    title: subject?.item?.name ?? subject?.name ?? "",
    parts,
    // Split by type only when there are several.
    breakdown: (parts.length > 1) ? parts.map(p => `${p.total} ${p.label}`.trim()).join(" + ") : ""
  };
}
