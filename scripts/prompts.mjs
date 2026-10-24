import sys from "./system.mjs";
import { parseHTML, messageActor } from "./common.mjs";

/**
 * Automation prompts, shared by the table seats and the phone app: time-sensitive rolls offered to the player
 * straight away, built from the system's own data. The rolls are the system's, made the way its own chat buttons
 * make them. dnd5e:
 *   - death save: at the start of the character's turn at 0 HP, neither stable nor dead;
 *   - concentration: dnd5e's "prompt" message when a concentrating character takes damage;
 *   - save: a save activity's "usage" message targeting the character;
 *   - request: a GM request message (group rest, save or check) listing the character;
 *   - initiative: the character's combatants without initiative in the active encounter (one prompt per character).
 * Shadow of the Demon Lord (no death saves or concentration checks in the system):
 *   - request: the system's "make a challenge roll" card, which the GM's challenge button whispers to the target's
 *     owners (attribute and boons from the card);
 *   - initiative: a fast or slow turn (the default initiative mode), or the system's roll (its optional modes).
 * Each module decides which kinds are on (its own settings, all off by default), which characters are its own, and
 * how a prompt is shown. When a prompt is answered or dismissed on one device, the same prompt closes on the
 * player's other devices (e.g. the table screen and their phone), so the roll isn't made twice.
 *
 * @typedef {object} Prompt
 * @property {string} key          The same on every device, so the same prompt isn't shown twice.
 * @property {string} kind         "deathSave", "concentration", "save", "request" or "initiative".
 * @property {Actor} actor         The character it is for.
 * @property {string} icon         Font Awesome classes.
 * @property {string} title
 * @property {string} text
 * @property {{success: boolean[], failure: boolean[]}} [tally]  Death save successes and failures.
 * @property {boolean} rollMode    Offer Normal / Advantage / Disadvantage.
 * @property {boolean} [local]     Started on this device (e.g. an attribute rolled from the sheet): answering or
 *   dismissing it isn't sent to the player's other devices.
 * @property {{label: string, icon?: string, run: function(string): Promise}[]} choices
 */

const loc = key => game.i18n.localize(key);
const fmt = (key, data) => game.i18n.format(key, data);
const abilityLabel = id => loc(CONFIG.DND5E.abilities[id]?.label ?? id);
const fromUuidQuiet = uuid => (uuid ? fromUuidSync(uuid, { strict: false }) : null);
const unique = list => [...new Set(list.filter(Boolean))];

const CHANNEL = "module.awesome-vtt-core";
const MAX_KEY = 200;

/**
 * @param {object} options
 * @param {function(Prompt): void} options.show          Show (queue) a prompt.
 * @param {function(string): void} options.close         Close a prompt by key (answered on another device).
 * @param {function(string): boolean} options.enabled    Is a kind on? ("deathSave", "concentration", …)
 * @param {function(Actor): boolean} options.isMine      Is this character one this device prompts for?
 */
export function initPrompts({ show, close, enabled, isMine }) {
  const builders = BUILDERS[game.system.id];
  if ( !sys.FEATURES.prompts || !builders ) return;
  const mine = actor => !!actor && !game.user.isGM && isMine(actor);
  const offer = prompt => prompt && show(prompt);

  Hooks.on("createChatMessage", message => {
    if ( game.user.isGM ) return;
    for ( const prompt of builders.fromMessage(message, enabled, mine) ) offer(prompt);
  });

  const initiative = () => initiativePrompts(enabled, mine, builders.initiativeRollMode).forEach(offer);
  for ( const hook of ["createCombat", "updateCombat", "createCombatant", "updateCombatant"] ) Hooks.on(hook, initiative);

  let lastTurn = null;
  const deathSave = combat => {
    if ( !sys.FEATURES.deathSaves || !enabled("deathSave") || game.user.isGM ) return;
    combat ??= activeCombat();
    if ( !combat?.started ) return;
    const actor = combat.combatant?.actor;
    if ( !mine(actor) || (actor.type !== "character") || !needsDeathSave(actor) ) return;
    // Once per turn.
    const turn = `${combat.id}:${combat.round}:${combat.turn}:${actor.id}`;
    if ( turn === lastTurn ) return;
    lastTurn = turn;
    offer(deathSavePrompt(actor, `deathSave:${turn}`));
  };
  Hooks.on("combatTurnChange", combat => deathSave(combat));
  Hooks.on("updateCombat", (combat, change) => {
    if ( ("turn" in change) || ("round" in change) || ("started" in change) ) deathSave(combat);
  });

  game.socket.on(CHANNEL, data => {
    if ( (data?.type === "promptDone") && (typeof data.key === "string") && (data.key.length <= MAX_KEY) ) close(data.key);
  });

  // The page may be (re)loaded during a turn or before initiative was rolled.
  initiative();
  deathSave();
}

/** Tell the player's other devices that a prompt was answered or dismissed here. */
function promptDone(key) {
  if ( typeof key === "string" ) game.socket.emit(CHANNEL, { type: "promptDone", key: key.slice(0, MAX_KEY) });
}

const activeCombat = () => game.combats.find(c => c.active) ?? game.combat;

/** Does this character have to make a death saving throw? */
function needsDeathSave(actor) {
  const hp = actor?.system.attributes?.hp;
  const death = actor?.system.attributes?.death;
  if ( !hp || !death || ((hp.value ?? 1) > 0) ) return false;
  if ( (death.success >= 3) || (death.failure >= 3) ) return false;
  const dead = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  return !actor.statuses.has(dead) && !actor.statuses.has("stable");
}

/* -------------------------------------------- */
/*  dnd5e                                       */
/* -------------------------------------------- */

function promptsFromMessage(message, enabled, mine) {
  switch ( message.type ) {
    case "prompt": return enabled("concentration") ? concentrationPrompts(message, mine) : [];
    case "usage": return enabled("save") ? savePrompts(message, mine) : [];
    case "request": return enabled("request") ? requestPrompts(message, mine) : [];
    default: return [];
  }
}

function concentrationPrompts(message, mine) {
  const button = message.system?.buttons?.find(b => b.type === "concentration");
  const actor = messageActor(message);
  if ( !button || !mine(actor) ) return [];
  const dc = button.dc ?? 10;
  return [{
    key: `concentration:${message.id}`,
    kind: "concentration",
    actor,
    icon: "fa-solid fa-brain",
    title: loc("AVTTC.Prompt.Concentration.Title"),
    text: fmt("AVTTC.Prompt.Concentration.Text", { name: actor.name, dc }),
    rollMode: true,
    choices: [{
      label: fmt("AVTTC.Prompt.Concentration.Roll", { dc }),
      icon: "fa-solid fa-dice-d20",
      run: mode => sys.rollConcentration(actor, { ability: button.ability, dc }, mode)
    }]
  }];
}

function savePrompts(message, mine) {
  const activity = message.getAssociatedActivity?.() ?? fromUuidQuiet(message.system?.activity?.uuid);
  if ( activity?.type !== "save" ) return [];
  const dc = activity.save?.dc?.value;
  const actors = unique((message.system.targets ?? []).map(t => fromUuidQuiet(t.actor))).filter(mine);
  return actors.map(actor => ({
    key: `save:${message.id}:${actor.uuid}`,
    kind: "save",
    actor,
    icon: "fa-solid fa-shield-heart",
    title: loc("AVTTC.Prompt.Save.Title"),
    text: fmt("AVTTC.Prompt.Save.Text", { name: actor.name, source: activity.item?.name ?? activity.name }),
    rollMode: true,
    choices: [...(activity.save?.ability ?? [])].map(ability => ({
      label: dc ? fmt("AVTTC.Prompt.Save.RollDC", { ability: abilityLabel(ability), dc })
        : fmt("AVTTC.Prompt.Save.Roll", { ability: abilityLabel(ability) }),
      icon: "fa-solid fa-dice-d20",
      run: mode => sys.rollActivitySave(actor, activity, message, ability, mode)
    }))
  })).filter(p => p.choices.length);
}

function requestPrompts(message, mine) {
  if ( !CONFIG.DND5E.requests?.[message.system?.handler] ) return [];
  const label = loc(message.system.button?.label ?? "") || loc("AVTTC.Prompt.Request.Go");
  const icon = message.system.button?.icon || "fa-solid fa-bell";
  const actors = unique((message.system.targets ?? []).filter(t => !t.result).map(t => fromUuidQuiet(t.actor))).filter(mine);
  return actors.map(actor => ({
    key: `request:${message.id}:${actor.uuid}`,
    kind: "request",
    actor,
    icon,
    title: loc("AVTTC.Prompt.Request.Title"),
    text: fmt("AVTTC.Prompt.Request.Text", { name: actor.name, request: label }),
    rollMode: false,
    choices: [{ label, icon, run: () => sys.answerRequest(actor, message) }]
  }));
}

/* -------------------------------------------- */
/*  Shadow of the Demon Lord                    */
/* -------------------------------------------- */

/** The attribute key for a (localized) attribute name, as the system's challenge card carries it. */
function attributeKey(name) {
  const lower = String(name ?? "").toLowerCase();
  return Object.entries(CONFIG.DL?.attributes ?? {})
    .find(([key, label]) => (key === lower) || (loc(label).toLowerCase() === lower))?.[0] ?? null;
}

/** "with 2 boons" style text for a request's own boons (or banes), or "". */
function boonsText(n) {
  if ( !n ) return "";
  const key = n > 0 ? (n === 1 ? "AVTTC.Boons.boon" : "AVTTC.Boons.boons") : (n === -1 ? "AVTTC.Boons.bane" : "AVTTC.Boons.banes");
  return fmt(key, { n: Math.abs(n) });
}

/** The system's "make a challenge roll" card, whispered to the owners of the character it is for. */
function challengePrompts(message, enabled, mine) {
  if ( !enabled("request") ) return [];
  const card = parseHTML(message.content);
  const button = card.querySelector(".make-challengeroll .header");
  if ( !button ) return [];
  const actor = fromUuidQuiet(card.querySelector(".demonlord")?.dataset.tokenId)?.actor
    ?? game.actors.get(button.dataset.actorid);
  const key = attributeKey(button.dataset.attribute);
  if ( !mine(actor) || !key ) return [];
  const extra = parseInt(button.dataset.boonsbanes) || 0;
  const attribute = loc(CONFIG.DL.attributes[key]);
  const boons = boonsText(extra);
  return [{
    key: `challenge:${message.id}:${actor.uuid}`,
    kind: "request",
    actor,
    icon: "fa-solid fa-dice-d20",
    title: loc("AVTTC.Prompt.Challenge.Title"),
    text: fmt(boons ? "AVTTC.Prompt.Challenge.TextBoons" : "AVTTC.Prompt.Challenge.Text", { name: actor.name, attribute, boons }),
    rollMode: true,
    choices: [{
      label: fmt("AVTTC.Prompt.Challenge.Roll", { attribute }),
      icon: "fa-solid fa-dice-d20",
      run: mode => sys.rollAbility(actor, key, mode, extra)
    }]
  }];
}

/**
 * SotDL: an attribute rolled from the sheet (FEATURES.abilityRollPrompt), asking for boons or banes first. Shown like
 * the other prompts, with the Next roll choice preset to what is armed; only on this device.
 */
function attributeRollPrompt(actor, action, data) {
  const key = data.ability;
  const label = (action === "rollAbility") ? CONFIG.DL?.attributes?.[key] : null;
  if ( !actor || !label ) return null;
  const attribute = loc(label);
  return {
    key: `roll:${actor.uuid}:${key}:${foundry.utils.randomID()}`,
    kind: "roll",
    local: true,
    actor,
    rollKey: `${action}:${key}`,
    icon: "fa-solid fa-dice-d20",
    title: fmt("AVTTC.Prompt.Ability.Title", { attribute }),
    text: fmt("AVTTC.Prompt.Ability.Text", { name: actor.name, attribute }),
    rollMode: true,
    choices: [{
      label: fmt("AVTTC.Prompt.Challenge.Roll", { attribute }),
      icon: "fa-solid fa-dice-d20",
      run: mode => sys.rollAbility(actor, key, mode)
    }]
  };
}

/** dnd5e: an ability check, saving throw or skill rolled from the sheet, asking for advantage first. */
function checkRollPrompt(actor, action, data) {
  const skill = action === "rollSkill";
  const key = skill ? data.skill : data.ability;
  const config = skill ? CONFIG.DND5E.skills[key] : CONFIG.DND5E.abilities[key];
  const roller = { rollAbility: sys.rollAbility, rollSave: sys.rollSave, rollSkill: sys.rollSkill }[action];
  if ( !actor || !config || !roller ) return null;
  const roll = fmt(`AVTTC.Prompt.SheetRoll.${action}`, { name: loc(config.label) });
  return {
    key: `roll:${actor.uuid}:${action}:${key}:${foundry.utils.randomID()}`,
    kind: "roll",
    local: true,
    actor,
    rollKey: `${action}:${key}`,
    icon: "fa-solid fa-dice-d20",
    title: roll,
    text: fmt("AVTTC.Prompt.SheetRoll.Text", { actor: actor.name, roll }),
    rollMode: true,
    choices: [{
      label: fmt("AVTTC.Prompt.SheetRoll.Roll", { roll }),
      icon: "fa-solid fa-dice-d20",
      run: mode => roller(actor, key, mode)
    }]
  };
}

/**
 * A sheet roll asking first (FEATURES.abilityRollPrompt): SotDL's attributes for boons or banes, dnd5e's checks,
 * saves and skills for advantage. Queues its prompt in `queue`, unless the same one is already up (a second tap).
 * True when the roll is taken care of, false to roll it straight away (nothing to ask, or a roll the prompt can't
 * name).
 * @param {PromptQueue} queue
 * @param {Actor} actor
 * @param {string} action     The sheet button's action (rollAbility, rollSave, rollSkill).
 * @param {DOMStringMap} data The button's dataset (ability or skill).
 */
export function askSheetRoll(queue, actor, action, data) {
  if ( !sys.FEATURES.abilityRollPrompt ) return false;
  const prompt = BUILDERS[game.system.id]?.sheetRoll(actor, action, data);
  if ( !prompt ) return false;
  if ( !queue.has(p => p.local && (p.actor === actor) && (p.rollKey === prompt.rollKey)) ) queue.add(prompt);
  return true;
}

/* -------------------------------------------- */
/*  Both systems                                */
/* -------------------------------------------- */

/**
 * One prompt per character with combatants without initiative in the active encounter: a fast or slow turn where
 * the system has them (SotDL's default mode), otherwise the core's rollInitiative (dnd5e: with the Next roll).
 * @param {boolean} rollMode  Does the roll take the Next roll choice?
 */
function initiativePrompts(enabled, mine, rollMode) {
  if ( !enabled("initiative") || game.user.isGM ) return [];
  const combat = activeCombat();
  const actors = unique((combat?.combatants.contents ?? []).map(c => c.actor)).filter(mine);
  return actors.map(actor => ({ actor, combatants: sys.initiativeDue(actor, combat) }))
    .filter(({ combatants }) => combatants.length)
    .map(({ actor, combatants }) => {
      const names = combatants.map(c => c.name).join(", ");
      const prompt = {
        key: `initiative:${combat.id}:${combatants.map(c => c.id).sort().join(",")}`,
        kind: "initiative",
        actor,
        icon: "fa-solid fa-bolt"
      };
      const speed = sys.turnSpeed(actor);
      if ( !speed ) return Object.assign(prompt, {
        title: loc("AVTTC.Prompt.Initiative.Title"),
        text: fmt("AVTTC.Prompt.Initiative.Text", { names }),
        rollMode,
        choices: [{ label: loc("AVTTC.Prompt.Initiative.Roll"), icon: "fa-solid fa-dice-d20", run: mode => sys.rollInitiative(actor, mode) }]
      });
      const choices = [{ label: loc("AVTTC.Turn.slow"), icon: "fa-solid fa-person-walking", run: () => sys.setTurnSpeed(actor, false) }];
      if ( speed.canBeFast ) choices.unshift({ label: loc("AVTTC.Turn.fast"), icon: "fa-solid fa-person-running", run: () => sys.setTurnSpeed(actor, true) });
      return Object.assign(prompt, {
        title: loc("AVTTC.Prompt.Turn.Title"),
        text: fmt("AVTTC.Prompt.Turn.Text", { names }),
        rollMode: false,
        choices
      });
    });
}

/**
 * Prompts per system: built from a new chat message, and whether an initiative roll takes the Next roll choice
 * (SotDL's optional initiative modes roll with the system's own formula).
 */
const BUILDERS = {
  dnd5e: { fromMessage: promptsFromMessage, initiativeRollMode: true, sheetRoll: checkRollPrompt },
  demonlord: { fromMessage: challengePrompts, initiativeRollMode: false, sheetRoll: attributeRollPrompt }
};

/* -------------------------------------------- */

function deathSavePrompt(actor, key) {
  const death = actor.system.attributes?.death ?? {};
  const pips = n => [0, 1, 2].map(i => i < (n ?? 0));
  return {
    key,
    kind: "deathSave",
    actor,
    icon: "fa-solid fa-skull",
    title: loc("AVTTC.Prompt.DeathSave.Title"),
    text: fmt("AVTTC.Prompt.DeathSave.Text", { name: actor.name }),
    tally: { success: pips(death.success), failure: pips(death.failure) },
    rollMode: true,
    choices: [{
      label: loc("AVTTC.Prompt.DeathSave.Roll"),
      icon: "fa-solid fa-dice-d20",
      run: mode => (needsDeathSave(actor) ? sys.rollDeathSave(actor, mode) : null)
    }]
  };
}

/* -------------------------------------------- */

/**
 * A queue of prompts for one screen area (the phone app, or one seat): one shown at a time, each key once.
 * @param {function(): void} onChange  Redraw: the current prompt (or none) changed.
 */
export class PromptQueue {
  #items = [];
  #seen = new Set();

  constructor(onChange) {
    this.onChange = onChange;
  }

  /** The prompt on screen, or null. */
  get current() {
    return this.#items[0] ?? null;
  }

  /**
   * Template data for the current prompt, or null.
   * @param {object[]|null} modes  The Normal / Advantage / Disadvantage choice (advModeChoices), for d20 prompts.
   */
  context(modes) {
    const prompt = this.current;
    if ( !prompt ) return null;
    const { key, kind, icon, title, text, tally, rollMode } = prompt;
    return {
      key, kind, icon, title, text, tally,
      choices: prompt.choices.map(({ label, icon }) => ({ label, icon })),
      modes: rollMode ? modes : null,
      scale: rollMode ? sys.rollModeScale() : null,
      more: this.waiting
    };
  }

  /** Is a prompt matching `test` shown or waiting? (e.g. the same attribute roll, tapped twice) */
  has(test) {
    return this.#items.some(test);
  }

  /** Prompts waiting after the current one. */
  get waiting() {
    return Math.max(this.#items.length - 1, 0);
  }

  add(prompt) {
    if ( !prompt || this.#seen.has(prompt.key) ) return;
    this.#seen.add(prompt.key);
    this.#items.push(prompt);
    this.onChange();
  }

  /** Remove a prompt by key (answered on another device); nothing is announced. */
  close(key) {
    this.#seen.add(key);
    const before = this.#items.length;
    this.#items = this.#items.filter(p => p.key !== key);
    if ( this.#items.length !== before ) this.onChange();
  }

  /** "Not now": drop the current prompt here and on the player's other devices. */
  dismiss() {
    const prompt = this.#items.shift();
    if ( prompt && !prompt.local ) promptDone(prompt.key);
    this.onChange();
  }

  /**
   * Answer the current prompt with one of its choices.
   * @param {number} index
   * @param {function(function(string): Promise): Promise} d20  The module's d20 wrapper (passes the advantage mode,
   *   then resets it); used for prompts with a roll mode.
   */
  async choose(index, d20) {
    const prompt = this.current;
    const choice = prompt?.choices[Number(index)];
    if ( !choice ) return;
    this.dismiss();
    return prompt.rollMode ? d20(mode => choice.run(mode)) : choice.run("normal");
  }
}
