/**
 * Part of awesome-vtt-core, shared by awesome-vtt and awesome-vtt-mobile.
 * Shadow of the Demon Lord ("demonlord" system, 6.x) adapter: the same interface as dnd5e.mjs (see system.mjs), so
 * the table and phone draw the same compact sheet, quick actions and rolls for a SotDL character.
 *
 * Rules that differ from dnd5e, and how they are handled here:
 * - Health counts damage taken (0 = unhurt); the sheet shows health left (max − damage).
 * - Boons and banes are one signed number of d6 (highest kept) added to or taken from the d20; the "Next roll"
 *   choice is a number of boons or banes (ROLL_MODES), passed to the system's no-dialog roll methods
 *   (rollAttributeChallenge, rollItemAttack, useSpell, useTalent, useItem), as the user chose (2026-10-04). Those
 *   methods skip what the system's dialog path checks, so it is done here: afflictions that make an action fail,
 *   spell castings and talent uses left (and spending them), and ammunition.
 * - Castings and talent uses are stored as the number used so far (strings); the sheet shows what is left.
 * - Initiative in the default mode is fast or slow turns, set on the actor (system.fastturn).
 * - No skills, saves, death saves or prepared spells. Favorites are kept in an actor flag (the system has none).
 * - Damage isn't rolled after attacks automatically; the notice of an attack that didn't miss offers it
 *   (rollDamageFrom): the card is rendered (the system binds its buttons in renderChatMessageHTML) and its damage
 *   buttons clicked, as the player would.
 */

import {
  MAX_CURRENCY, MAX_QUANTITY, byName, signed, getToggleEffects, queueEffects, raceTolerant, waitFor, plainText, parseHTML,
  onRollResult as onRollResultFor
} from "./common.mjs";

export { hpAmount, changeQuantity, toggleEffect, rollNotice } from "./common.mjs";

const CORE_ID = "awesome-vtt-core";
const loc = key => (key ? game.i18n.localize(key) : "");
const int = value => parseInt(value) || 0;
const setting = key => {
  try { return game.settings.get("demonlord", key); } catch { return undefined; }
};

/* -------------------------------------------- */
/*  What this system offers                     */
/* -------------------------------------------- */

export const FEATURES = {
  deathSaves: false,
  /** GM challenge requests and the fast / slow turn choice (see prompts.mjs). */
  prompts: true,
  useSteps: false,
  party: true,
  /** Using an item rolls straight away with the Next roll's boons or banes (useItem's mode). */
  itemRollMode: true,
  /** An attribute rolled from the sheet can first ask for boons or banes (abilityRollPrompt, the module's setting). */
  abilityRollPrompt: true,
  /** Damage is never rolled after attacks by itself (see rollDamageAfterAttacks): the notice offers it. */
  autoDamage: false,
  /** "speed" (fast / slow turns) in the default mode; the optional modes roll. */
  get initiative() { return (setting("optionalRuleInitiativeMode") ?? "s") === "s" ? "speed" : "roll"; }
};

/** No Skills tab: SotDL rolls attributes (the user's tab order, without skills). */
export const SHEET_TABS = ["actions", "spells", "abilities", "inventory", "status", "bio"];

/** The "Next roll" choice: up to three banes or boons. "normal" is none, as in dnd5e. */
export const ROLL_MODES = ["bane3", "bane2", "bane1", "normal", "boon1", "boon2", "boon3"];

/** Boons (positive) or banes (negative) of a roll mode. */
export const boonsOf = mode => {
  const m = /^(boon|bane)(\d)$/.exec(mode ?? "");
  return m ? (m[1] === "boon" ? 1 : -1) * Number(m[2]) : 0;
};

export function rollModeLabel(mode) {
  const n = boonsOf(mode);
  if ( !n ) return loc("AVTTC.Boons.none");
  const key = n > 0 ? (n === 1 ? "AVTTC.Boons.boon" : "AVTTC.Boons.boons") : (n === -1 ? "AVTTC.Boons.bane" : "AVTTC.Boons.banes");
  return game.i18n.format(key, { n: Math.abs(n) });
}

/** The Next roll choice's heading and the names of its two ends (banes on the left, boons on the right). */
export const rollModeScale = () => ({
  title: loc("AVTTC.Boons.title"), low: loc("AVTTC.Boons.banesEnd"), high: loc("AVTTC.Boons.boonsEnd")
});

/** "+2" for two boons, "−1" for one bane. */
export const rollModeShort = mode => {
  const n = boonsOf(mode);
  return n ? (n > 0 ? `+${n}` : `−${-n}`) : "0";
};

/** The dice pool's single d20 with boons or banes (d6, highest kept), or null. */
export const poolD20 = mode => {
  const n = boonsOf(mode);
  return n ? `1d20 ${n > 0 ? "+" : "-"} ${Math.abs(n)}d6kh` : null;
};

export const getRests = () => [
  { action: "shortRest", icon: "fa-bed", label: loc("AVTTC.Rest.night") },
  { action: "longRest", icon: "fa-campground", label: loc("AVTTC.Rest.day") }
];

export const onRollResult = (fn, options = {}) => onRollResultFor(fn, { ...options, summarize: summarizeRoll });

/* -------------------------------------------- */
/*  Character data                              */
/* -------------------------------------------- */

const ATTRIBUTES = ["strength", "agility", "intellect", "will", "perception"];

/** Afflictions shown in the Status tab (the system's statuses that aren't actions or health states). */
const AFFLICTIONS = [
  "asleep", "blinded", "charmed", "compelled", "dazed", "deafened", "defenseless", "diseased", "fatigued", "frightened",
  "grabbed", "horrified", "immobilized", "impaired", "poisoned", "prone", "slowed", "stunned", "surprised", "unconscious"
];

/** Statuses offered as one-tap toggles in quick actions (actions a creature takes, and Prone). */
const QUICK_STATUSES = ["defend", "concentrate", "prone", "help", "prepare"];

const PATH_ORDER = ["novice", "expert", "master", "legendary"];

/** Health as the sheet shows it: what is left of the maximum (the system stores damage taken). */
function health(actor) {
  const h = actor.system.characteristics?.health ?? {};
  const max = int(h.max);
  const damage = int(h.value);
  return { value: Math.max(max - damage, 0), max, temp: 0, pct: max ? Math.clamp(((max - damage) / max) * 100, 0, 100) : 0 };
}

const statusChoices = (actor, ids) => {
  const byId = new Map(CONFIG.statusEffects.map(e => [e.id, e]));
  return ids.filter(id => byId.has(id)).map(id => ({
    id, label: loc(byId.get(id).name), img: byId.get(id).img, active: actor.statuses.has(id)
  }));
};

export function getSummary(actor) {
  const sys = actor.system;
  const c = sys.characteristics ?? {};
  const hp = health(actor);
  const paths = actor.items.filter(i => i.type === "path")
    .sort((a, b) => PATH_ORDER.indexOf(a.system.type) - PATH_ORDER.indexOf(b.system.type))
    .map(p => p.name);
  const ancestry = actor.items.find(i => i.type === "ancestry")?.name;
  return {
    name: actor.name,
    img: actor.img,
    level: sys.level ?? 0,
    classes: [ancestry, ...paths].filter(Boolean).join(" / "),
    hp,
    ac: c.defense ?? 0,
    init: 0,
    speed: c.speed ?? 0,
    inspiration: int(c.fortune) > 0,
    inspirationLabel: loc("DL.CharFortune"),
    stats: [
      { key: "defense", icon: "fa-shield-halved", value: c.defense ?? 0, label: loc("DL.AttributeDefense") },
      { key: "perception", icon: "fa-eye", value: sys.attributes?.perception?.value ?? 0, label: loc("DL.AttributePerception") },
      { key: "speed", icon: "fa-person-running", value: c.speed ?? 0, label: loc("DL.CharSpeed") },
      { key: "healing", icon: "fa-heart-pulse", value: c.health?.healingrate ?? 0, label: loc("DL.CharHealthHealingRating") }
    ],
    death: { success: 0, failure: 0 },
    // Incapacitated: damage reached the maximum.
    dying: hp.max > 0 && hp.value <= 0,
    conditions: statusChoices(actor, AFFLICTIONS)
  };
}

/** The five attributes, each rolled as a challenge (the Abilities tab). */
export function getAbilities(actor) {
  return ATTRIBUTES.map(key => {
    const a = actor.system.attributes?.[key] ?? {};
    return {
      key,
      abbr: loc(CONFIG.DL?.attributes?.[key]).toUpperCase(),
      value: a.value ?? 10,
      mod: signed(int(a.modifier)),
      save: null,
      proficient: false,
      checkLabel: loc("AVTTC.Roll.challenge")
    };
  });
}

export const getSkills = () => [];

/**
 * The Bio tab (read-only): ancestry, paths, professions, languages and religion, the appearance fields the system's
 * sheet shows, and the description, where the character builder writes the background tables and the interesting
 * thing. The description is enriched by the core's enrichSheet.
 */
export function getBio(actor) {
  const names = type => actor.items.filter(i => i.type === type).map(i => i.name).join(", ");
  const s = actor.system;
  const a = s.appearance ?? {};
  const rows = list => list.map(([label, value]) => ({ label: loc(label), value: String(value ?? "").trim() })).filter(r => r.value);
  return {
    facts: rows([
      ["DL.CharAncestry", names("ancestry")], ["AVTTC.Bio.paths", names("path")],
      ["DL.CharProfessions", names("profession")], ["DL.CharLanguages", names("language")],
      ["DL.CharReligion", s.religion?.value]
    ]),
    appearance: rows([
      ["DL.CharGender", a.sex], ["DL.CharAge", a.age], ["DL.CharHeight", a.height], ["DL.CharWeight", a.weight],
      ["DL.CharEyes", a.eyes], ["DL.CharHair", a.hair]
    ]),
    appearanceLabel: loc("AVTTC.Bio.appearance"),
    descriptionLabel: loc("DL.TabsBackground"),
    description: s.description ?? ""
  };
}

/* -------------------------------------------- */
/*  Uses                                        */
/* -------------------------------------------- */

/** Castings (spells) or uses (talents) as { left, max }, or null without a limit. The system stores what is used. */
function usesOf(item) {
  const field = (item.type === "spell") ? item.system.castings : (item.type === "talent") ? item.system.uses : null;
  const max = int(field?.max);
  if ( !max ) return null;
  return { left: Math.max(max - int(field.value), 0), max, path: (item.type === "spell") ? "system.castings.value" : "system.uses.value" };
}

const entry = item => {
  const uses = usesOf(item);
  return {
    id: item.id, name: item.name, img: item.img, favorite: isFavorite(item.parent, item),
    usesValue: uses ? uses.left : null, usesMax: uses?.max ?? null
  };
};

/** Groups of usable items: weapons in hand, talents, spells, and usable gear (consumables, items with an action). */
export function getActions(actor) {
  const groups = [];
  const push = (label, items) => {
    if ( items.length ) groups.push({ label, items: items.sort(byName).map(entry) });
  };
  push(loc("AVTTC.DL.Weapons"), actor.items.filter(i => (i.type === "weapon") && (i.system.wear !== false)));
  push(loc("DL.TabsTalents"), actor.items.filter(i => i.type === "talent"));
  push(loc("AVTTC.DL.Spells"), actor.items.filter(i => i.type === "spell"));
  push(loc("DL.TabsItems"), actor.items.filter(i => (i.type === "item") && (i.system.consumabletype || i.system.action?.attack)));
  return groups;
}

/** Spells by tradition and rank, with castings left. Every spell an actor has is known (no preparation). */
export function getSpells(actor) {
  const spells = actor.items.filter(i => i.type === "spell");
  const groups = new Map();
  for ( const spell of spells ) {
    const tradition = spell.system.tradition || loc("AVTTC.DL.NoTradition");
    const rank = int(spell.system.rank);
    const key = `${tradition}\u0000${String(rank).padStart(2, "0")}`;
    if ( !groups.has(key) ) groups.set(key, { label: game.i18n.format("AVTTC.DL.TraditionRank", { tradition, rank }), slots: null, items: [] });
    const uses = usesOf(spell);
    groups.get(key).items.push({
      ...entry(spell),
      usable: !uses || (uses.left > 0),
      canPrepare: false, prepared: true, always: false, concentration: false, ritual: false
    });
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => {
    g.items.sort(byName);
    return g;
  });
}

export const togglePrepared = () => null;

/** Change what is left of a spell's castings or a talent's uses by one (to undo an accidental use). */
export function changeUses(actor, itemId, delta) {
  const item = actor.items.get(itemId);
  const uses = item && usesOf(item);
  if ( !uses ) return;
  const left = Math.clamp(uses.left + Math.sign(delta), 0, uses.max);
  return item.update({ [uses.path]: String(uses.max - left) });
}

export const changeSlots = () => null;

/* -------------------------------------------- */
/*  Favorites                                   */
/* -------------------------------------------- */

/** At most this many favorites on the pill's row, as in dnd5e. */
const FAVORITES_MAX = 8;

/** Favorite item ids, in the order they were starred (actor flag; the system has no favorites). */
const favoriteIds = actor => {
  const ids = actor?.getFlag?.(CORE_ID, "favorites");
  return Array.isArray(ids) ? ids.filter(id => typeof id === "string") : [];
};

export const canFavorite = actor => !!actor?.isOwner && (actor.type === "character");

export const isFavorite = (actor, item) => !!item && favoriteIds(actor).includes(item.id);

export function toggleFavorite(actor, itemId) {
  if ( !canFavorite(actor) || !actor.items.has(itemId) ) return;
  // Ids of items that no longer exist are dropped as the list changes.
  const ids = favoriteIds(actor).filter(id => actor.items.has(id));
  const next = ids.includes(itemId) ? ids.filter(id => id !== itemId) : [...ids, itemId];
  return actor.setFlag(CORE_ID, "favorites", next);
}

/** @returns {{id: string, name: string, img: string}[]} */
export const getFavoriteActions = actor => favoriteIds(actor)
  .map(id => actor.items.get(id)).filter(Boolean).slice(0, FAVORITES_MAX)
  .map(({ id, name, img }) => ({ id, name, img }));

/* -------------------------------------------- */
/*  Rolls and using items                       */
/* -------------------------------------------- */

/**
 * Afflictions that make an action of this kind fail (e.g. a stunned creature can't act), as the system's own roll
 * paths check before their dialog; shown as the system's warning.
 */
function blocked(actor, kind, attribute) {
  const attr = String(attribute ?? "").toLowerCase();
  if ( !(actor.system.maluses?.autoFail?.[kind]?.[attr] > 0) ) return false;
  const msg = [...actor.allApplicableEffects()].find(e => e.flags?.demonlord?.warningMessage)?.flags.demonlord.warningMessage;
  ui.notifications.error(msg ?? loc(`DL.AutoFail${kind.capitalize()}s`));
  return true;
}

/** The system's "target on select" setting: selecting a token targets it. */
export const targetOnSelect = () => !!setting("targetingOnSelect");

/** Chat card buttons that act on the user's targets (the system's chat listeners read them); see the phone's app. */
export const CARD_TARGET_BUTTONS = ".roll-damage, .apply-damage, .roll-healing, .apply-effect";

/**
 * The tokens an attack is aimed at, as the system reads them (selected tokens with its "target on select").
 * Without a map (the phone), the targets picked in the use dialog are passed instead: token documents, which have
 * the `actor` the system's attack reads from its target.
 */
const targetTokens = () => (targetOnSelect() ? (canvas?.tokens?.controlled ?? []) : [...game.user.targets]);

/**
 * Does using this item ask for targets? (The phone's use dialog; the table uses the map's targets.) Weapons and
 * attack spells: the system's attack takes the target we pass. Talents and gear that attack read the user's targets
 * themselves, which the phone fills from the picked ones (its no-map token layer, see the phone's targets.mjs).
 */
export function itemNeedsTargets(item) {
  const action = item?.system.action;
  if ( !action?.attack || !action.against ) return false;
  if ( item.type === "spell" ) return item.system.spelltype === "Attack";
  return ["weapon", "talent", "item"].includes(item.type);
}

/**
 * A challenge roll with an attribute (the Abilities tab, a GM's request), with the Next roll's boons or banes.
 * @param {number} [extra]  Boons (or banes) the request itself gives.
 */
export function rollAbility(actor, key, mode, extra = 0) {
  const attribute = actor.getAttribute?.(key);
  if ( !attribute || blocked(actor, "challenge", key) ) return null;
  return actor.rollAttributeChallenge(attribute, boonsOf(mode) + (parseInt(extra) || 0), 0);
}

export const rollSave = () => null;
export const rollSkill = () => null;
export const rollDeathSave = () => null;

/**
 * Use an item without the system's dialog, with the Next roll's boons or banes: attack with a weapon (once per
 * target, then spend its ammunition), cast a spell (spend a casting), use a talent (spend a use), or use gear (spend
 * one of a consumable). What the system's dialog path checks first is checked here too.
 * @param {Actor} actor
 * @param {string} itemId
 * @param {string} [mode]  A ROLL_MODES id.
 * @param {object} [options]
 * @param {TokenDocument[]} [options.targets]  Targets picked without the map (the phone); otherwise the user's.
 * @param {number} [options.modifier]          A flat modifier for the roll.
 */
export async function useItem(actor, itemId, mode = "normal", { targets, modifier = 0 } = {}) {
  const item = actor?.items.get(itemId);
  if ( !item ) return null;
  const roll = { boons: boonsOf(mode), modifier: parseInt(modifier) || 0, targets: targets ?? targetTokens() };
  switch ( item.type ) {
    case "weapon": return attackWith(actor, item, roll);
    case "spell": return castSpell(actor, item, roll);
    case "talent": return useTalent(actor, item, roll);
    case "item": return useGear(actor, item, roll);
    default: return actor.rollItem?.(itemId);
  }
}

async function attackWith(actor, item, { boons, modifier, targets }) {
  if ( blocked(actor, "action", item.system.action?.attack) ) return;
  const consume = item.system.consume ?? {};
  let ammo = null;
  if ( consume.ammorequired ) {
    ammo = actor.items.get(consume.ammoitemid);
    if ( !ammo ) return ui.notifications.warn(game.i18n.format("DL.WeaponNoAmmo", { weaponName: item.name }));
    if ( !(ammo.system.quantity > 0) ) return ui.notifications.warn(game.i18n.format("DL.WeaponRunOutOfAmmo", { weaponName: item.name }));
  }
  if ( targets.length ) for ( const target of targets ) await actor.rollItemAttack(item, boons, modifier, target);
  else await actor.rollItemAttack(item, boons, modifier);
  if ( ammo ) await ammo.update({ "system.quantity": Math.max(ammo.system.quantity - (int(consume.amount) || 1), 0) });
}

async function castSpell(actor, item, { boons, modifier, targets }) {
  const attack = item.system.action?.attack;
  const attacks = (item.system.spelltype === "Attack") && attack;
  if ( attacks && blocked(actor, "attack", attack) ) return;
  if ( !attacks && item.system.attribute && blocked(actor, "challenge", item.system.attribute) ) return;
  const used = int(item.system.castings?.value);
  const max = int(item.system.castings?.max);
  if ( max && (used >= max) ) return ui.notifications.warn(loc("DL.SpellMaxUsesReached"));
  await item.update({ "system.castings.value": String(used + 1) });
  if ( attacks && targets.length ) for ( const target of targets ) await actor.useSpell(item, boons, modifier, [target]);
  else await actor.useSpell(item, attacks ? boons : 0, attacks ? modifier : 0);
}

async function useTalent(actor, item, { boons, modifier }) {
  if ( blocked(actor, "challenge", "strength") ) return;
  const used = int(item.system.uses?.value);
  const max = int(item.system.uses?.max);
  if ( max && (used >= max) ) return ui.notifications.warn(loc("DL.TalentMaxUsesReached"));
  const attacks = !!item.system.action?.attack;
  return actor.useTalent(item, attacks ? boons : 0, attacks ? modifier : 0);
}

async function useGear(actor, item, { boons, modifier }) {
  // Incantations cast the spell they hold: the system's own path, with its dialog.
  if ( (item.system.consumabletype === "I") && (item.system.contents?.length === 1) ) return actor.rollItem(item.id);
  let remove = false;
  if ( (item.system.quantity != null) && item.system.consumabletype ) {
    if ( item.system.quantity < 1 ) {
      if ( item.system.autoDestroy ) return item.delete();
      return ui.notifications.warn(loc("DL.ItemMaxUsesReached"));
    }
    remove = (item.system.quantity === 1) && item.system.autoDestroy;
    await item.update({ "system.quantity": item.system.quantity - 1 });
  }
  const attacks = !!item.system.action?.attack;
  await actor.useItem(item, attacks ? boons : 0, attacks ? modifier : 0);
  if ( remove ) await item.delete();
}

/* -------------------------------------------- */
/*  Levelling up                                */
/* -------------------------------------------- */

/** SotDL levels are given by the GM; the sheet's own controls are used. */
export const levelInfo = () => ({ canLevel: false, ready: false });
export const openLevelUp = actor => actor?.sheet?.render({ force: true });

/* -------------------------------------------- */
/*  Quick actions                               */
/* -------------------------------------------- */

/** HP field modes: damage taken or healed (SotDL has no temporary health). */
export const HP_MODES = ["damage", "heal"];

export function applyHpChange(actor, mode, amount) {
  if ( !actor || !amount ) return;
  return actor.increaseDamage((mode === "damage") ? amount : -amount);
}

/** Fortune: the character has it or not (the quick actions' "inspiration" button). */
export const toggleInspiration = actor =>
  actor.update({ "system.characteristics.fortune": int(actor.system.characteristics?.fortune) > 0 ? 0 : 1 });

export function toggleCondition(actor, id) {
  if ( !CONFIG.statusEffects.some(e => e.id === id) ) return;
  const active = !actor.statuses.has(id);
  return queueEffects(actor, async () => {
    if ( actor.statuses.has(id) === active ) return;
    await raceTolerant(() => actor.toggleStatusEffect(id, { active }));
    await waitFor(() => actor.statuses.has(id) === active, 2000);
  });
}

export const shortRest = actor => actor.restActor(8, true, true, true);
export const longRest = actor => actor.restActor(24, true, true, true);

/** Insanity and corruption, changed with − / + in quick actions. */
export function getQuickActions(actor, toggled = new Set()) {
  const c = actor.system.characteristics ?? {};
  return {
    exhaustion: null,
    concentration: [],
    tracks: [
      { key: "insanity", label: loc("DL.CharInsanity"), value: int(c.insanity?.value), max: int(c.insanity?.max) || null },
      { key: "corruption", label: loc("DL.CharCorruption"), value: int(c.corruption?.value), max: null }
    ],
    quickConditions: statusChoices(actor, QUICK_STATUSES),
    effects: getToggleEffects(actor, toggled)
  };
}

export function changeTrack(actor, key, delta) {
  const step = Math.sign(Number(delta));
  if ( !step ) return;
  if ( key === "insanity" ) return actor.increaseInsanity(step);
  if ( key === "corruption" ) return actor.increaseCorruption(step);
}

export const endConcentration = () => null;
export const changeExhaustion = () => null;

/* -------------------------------------------- */
/*  Initiative: fast and slow turns             */
/* -------------------------------------------- */

export const initiativeDue = (actor, combat = game.combat) =>
  combat?.combatants.filter(c => (c.actorId === actor?.id) && (c.initiative === null) && !c.isDefeated) ?? [];

/** Fast or slow turn (default initiative mode), and whether the character may take a fast turn. */
export function turnSpeed(actor) {
  if ( !actor || (FEATURES.initiative !== "speed") ) return null;
  return { fast: !!actor.system.fastturn, canBeFast: !actor.system.maluses?.noFastTurn };
}

/**
 * Choose a fast or slow turn. The system re-sets the initiative of the actor's combatants when its turn speed
 * changes; combatants still without one get it here, as its own fast / slow dialog would.
 */
export async function setTurnSpeed(actor, fast) {
  if ( !actor?.isOwner ) return;
  fast = !!fast && !actor.system.maluses?.noFastTurn;
  if ( !!actor.system.fastturn !== fast ) await actor.update({ "system.fastturn": fast });
  const combat = game.combat;
  for ( const c of initiativeDue(actor, combat) ) {
    if ( c.isOwner ) await combat.setInitiative(c.id, combat.getInitiativeValue(c, fast));
  }
}

/** Initiative without a dialog: the current turn speed (default mode), or the system's roll (optional modes). */
export function rollInitiative(actor) {
  const due = initiativeDue(actor);
  if ( !due.length ) return null;
  if ( FEATURES.initiative === "speed" ) return setTurnSpeed(actor, actor.system.fastturn);
  return game.combat.rollInitiative(due.map(c => c.id));
}

/* -------------------------------------------- */
/*  Inventory                                   */
/* -------------------------------------------- */

export const INVENTORY_TYPES = ["weapon", "armor", "ammo", "item", "relic"];

const COINS = ["gc", "ss", "cp", "bits"];

/** The actor's coins, one entry per kind (the inventory and the shared inventory). The system stores strings. */
export const getCurrency = actor => COINS.map(key => ({
  key, label: loc(`AVTTC.DL.Coin.${key}`), abbr: loc(`AVTTC.DL.CoinShort.${key}`), icon: null,
  value: int(actor?.system.wealth?.[key])
}));

export function getInventory(actor) {
  const carried = actor.items.filter(i => INVENTORY_TYPES.includes(i.type));
  const groups = INVENTORY_TYPES.map(type => ({
    label: loc(CONFIG.Item.typeLabels?.[type]) || type,
    items: carried.filter(i => i.type === type).sort(byName).map(item => ({
      id: item.id,
      name: item.name,
      img: item.img,
      // The star lights up for favorites, as in the Actions tab (it was always unlit here).
      favorite: isFavorite(actor, item),
      quantity: item.system.quantity ?? 1,
      equippable: "wear" in item.system,
      equipped: !!item.system.wear,
      attunable: false,
      attuned: false,
      usable: ["weapon", "item"].includes(item.type),
      uses: "",
      contents: []
    }))
  })).filter(g => g.items.length);
  return {
    currency: getCurrency(actor),
    encumbrance: null,
    attunement: null,
    groups
  };
}

export async function getItemDescription(actor, itemId) {
  const item = actor.items.get(itemId);
  if ( !item ) return "";
  return foundry.applications.ux.TextEditor.implementation.enrichHTML(item.system.description ?? "", {
    secrets: item.isOwner, relativeTo: item, rollData: actor.getRollData?.()
  });
}

export function setCurrency(actor, key, value) {
  if ( !COINS.includes(key) ) return;
  return actor.update({ [`system.wealth.${key}`]: Math.clamp(Math.floor(Number(value) || 0), 0, MAX_CURRENCY) });
}

export function toggleEquipped(actor, itemId) {
  const item = actor.items.get(itemId);
  if ( item && ("wear" in item.system) ) return item.update({ "system.wear": !item.system.wear });
}

export const toggleAttuned = () => null;

/* -------------------------------------------- */
/*  Moving coins and items between actors       */
/* -------------------------------------------- */

/**
 * Move coins of one kind from one actor to another (a character and the party), at most what the giver has.
 * The giver is updated first, so a failed second update never creates coins. The system stores coins as strings.
 * @returns {Promise<number>}  How many coins were moved.
 */
export async function moveCurrency(from, to, key, amount) {
  if ( !from?.isOwner || !to?.isOwner || !COINS.includes(key) ) return 0;
  const have = int(from.system.wealth?.[key]);
  const n = Math.min(Math.clamp(Math.floor(Number(amount) || 0), 0, MAX_CURRENCY), have);
  if ( !n ) return 0;
  await from.update({ [`system.wealth.${key}`]: have - n });
  await to.update({ [`system.wealth.${key}`]: Math.min(int(to.system.wealth?.[key]) + n, MAX_CURRENCY) });
  return n;
}

/** A carried item with this name and type, to add quantities to. */
function stackFor(actor, name, type) {
  const lower = name.toLowerCase();
  return actor.items.find(i => (i.type === type) && (i.name.toLowerCase() === lower) && ("quantity" in i.system));
}

const addToStack = (stack, quantity) =>
  stack.update({ "system.quantity": Math.min(int(stack.system.quantity) + quantity, MAX_QUANTITY) });

/** Add an item typed by name, as plain gear: more of a gear item with that name, or a new one. */
export function addNamedItem(actor, name, quantity) {
  name = String(name ?? "").trim().slice(0, 80);
  if ( !actor?.isOwner || !name ) return null;
  const qty = Math.clamp(Math.floor(Number(quantity) || 1), 1, MAX_QUANTITY);
  const stack = stackFor(actor, name, "item");
  if ( stack ) return addToStack(stack, qty);
  return Item.implementation.create({ name, type: "item", system: { quantity: qty } }, { parent: actor });
}

/**
 * Copy carried items onto an actor (SotDL has no containers). Items with a quantity are added to an item of the
 * same name and type that is already there.
 * @param {Item[]} items  From another actor, the world or a compendium.
 * @param {Actor} target
 */
export async function copyItems(items, target) {
  for ( const item of items ) {
    if ( !INVENTORY_TYPES.includes(item.type) ) continue;
    const stack = ("quantity" in item.system) ? stackFor(target, item.name, item.type) : null;
    if ( stack ) {
      await addToStack(stack, int(item.system.quantity) || 1);
      continue;
    }
    const data = item.toObject();
    delete data._id;
    // Carried by someone new: not worn or wielded.
    if ( "wear" in (data.system ?? {}) ) data.system.wear = false;
    await Item.implementation.create(data, { parent: target });
  }
}

/** Move a whole stack from one actor to another. */
export async function moveItem(from, to, itemId) {
  const item = from?.items.get(itemId);
  if ( !item || !INVENTORY_TYPES.includes(item.type) || !from.isOwner || !to?.isOwner || (from === to) ) return;
  await copyItems([item], to);
  return item.delete();
}

/* -------------------------------------------- */
/*  Damage after attacks                        */
/* -------------------------------------------- */

/**
 * Damage is not rolled automatically in SotDL (user's decision, 2026-10-10, both modules): players roll it with the
 * attack card's damage button. Kept as a no-op so both adapters export the same names.
 * @param {function(Actor): boolean} applies  Unused.
 */
export function rollDamageAfterAttacks(applies) {}

/* -------------------------------------------- */
/*  dnd5e-only parts of the interface           */
/* -------------------------------------------- */

export const rollConcentration = () => null;
export const rollActivitySave = () => null;
export const answerRequest = () => null;
/** dnd5e activities only; SotDL items use itemNeedsTargets. */
export const needsTargets = () => false;
export const usageProblem = () => null;

/* -------------------------------------------- */
/*  Roll results                                */
/* -------------------------------------------- */

/** Item types whose use posts a card (spell.hbs, talent.hbs, useitem.hbs, combat.hbs). */
const USE_TYPES = ["spell", "talent", "item", "weapon"];

/** The actor and item of a system card, as the system finds them (_getChatCardActor): token first, then actor id. */
function cardSubject(card) {
  const el = card.querySelector(".demonlord[data-item-id]");
  if ( !el ) return {};
  const { tokenId, actorId, itemId } = el.dataset;
  const actor = tokenId ? fromUuidSync(tokenId, { strict: false })?.actor : game.actors.get(actorId);
  return { actor, item: actor?.items.get(itemId) };
}

/**
 * Damage rolled from one notice: one message per damage button of the card, added up so the last notice shows the
 * whole damage ("9", "6 + 3"). Only messages of that actor while the group is open, up to the number of buttons.
 */
let damageGroup = null;
const DAMAGE_GROUP_MS = 20000;

function groupDamage(message, total, card) {
  const g = damageGroup;
  const open = g && (Date.now() < g.until) && (g.actor === cardSubject(card).actor);
  if ( !open || (!g.totals.has(message.id) && (g.totals.size >= g.expected)) ) return { total, breakdown: "" };
  g.totals.set(message.id, Number(total) || 0);
  const totals = [...g.totals.values()];
  return { total: totals.reduce((sum, t) => sum + t, 0), breakdown: (totals.length > 1) ? totals.join(" + ") : "" };
}

/**
 * Roll the damage of an attack, spell, talent or item card, as the player would: the card is rendered for this
 * user (the system binds its buttons in renderChatMessageHTML, and removes what this user may not see) and each of
 * its damage buttons clicked: the weapon's or spell's damage, extra damage types, and the 20+ extra damage when the
 * card offers it. Offered on the card's notice (summarizeRoll's `damage`).
 * @param {ChatMessage} message
 */
export async function rollDamageFrom(message) {
  if ( !message?.isAuthor ) return;
  const html = await message.renderHTML();
  const buttons = [...html.querySelectorAll(".roll-damage")];
  if ( !buttons.length ) return;
  damageGroup = { actor: cardSubject(html).actor, expected: buttons.length, totals: new Map(), until: Date.now() + DAMAGE_GROUP_MS };
  for ( const button of buttons ) button.click();
}

/**
 * The result of a message for the seat and phone notices. The system's cards carry no data about the result, only
 * markup: a damage card has "apply damage" buttons; challenge and attack cards mark the result box SUCCESS or
 * FAILURE (an attack card has one target; no mark when there is no target or it is immune). A spell cast without an
 * attack roll has no roll: it gets a notice with its name (`kind: "use"`), as do talents and items used without a
 * roll that have damage to roll. `damage` is true when the card has damage buttons and didn't miss.
 */
export function summarizeRoll(message) {
  const roll = message.rolls?.[0];
  const card = parseHTML(message.content);
  const hasDamage = !!card.querySelector(".roll-damage");
  if ( !roll ) {
    const { item } = cardSubject(card);
    if ( !USE_TYPES.includes(item?.type) || ((item.type !== "spell") && !hasDamage) ) return null;
    return { kind: "use", title: item.name, damage: hasDamage };
  }
  // The first header text that isn't a (player or GM) result line: the item or attribute rolled.
  const titleEl = [...card.querySelectorAll(".headertext")].find(el => !el.matches(".gmremove, .gmonlyzero"));
  const title = plainText(message.flavor) || titleEl?.textContent.trim() || roll.formula;
  if ( card.querySelector(".apply-damage") ) {
    return { kind: "damage", title, parts: [], ...groupDamage(message, roll.total, card) };
  }
  const box = card.querySelector(".box.SUCCESS, .box.FAILURE");
  const success = box ? box.classList.contains("SUCCESS") : null;
  const isChallenge = !!card.querySelector(".card-headersmall");
  return {
    kind: "roll",
    total: roll.total,
    title,
    breakdown: "",
    natural: null,
    outcome: (isChallenge && (success !== null)) ? (success ? "success" : "failure") : null,
    hits: (!isChallenge && (success !== null)) ? { hit: success ? 1 : 0, miss: success ? 0 : 1 } : null,
    damage: !isChallenge && hasDamage && (success !== false)
  };
}
