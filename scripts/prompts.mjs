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
 *   - request: the system's "make a challenge roll" card (attribute and boons from the card). The GM's challenge
 *     button whispers it only to users whose assigned character has the target's name (demonlord 6.1.14
 *     `ChatMessage.getWhisperRecipients(actor.name)`), so a table user without a character never gets it; the active
 *     GM's client relays it on the core's socket (relayChallenges), and initPrompts with `relayed` takes the relay
 *     from a GM only. Each card is prompted once, however it arrives.
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
 * @property {function(): object[]|null} [sources]  SotDL 6.1.14: where the roll's boons and banes come from (the
 *   adapter's boonSources), read on each render; the player can switch them off (`disabled`).
 * @property {string} [attribute]  SotDL challenge request: the attribute's name.
 * @property {string} [boons]      SotDL challenge request: the card's own boons or banes as text ("" for none).
 * @property {Set<string>} [disabled]  Source ids switched off, passed to the choice's `run` as its second argument.
 * @property {{label: string, icon?: string, run: function(string, string[]): Promise}[]} choices
 */

const loc = key => game.i18n.localize(key);
const fmt = (key, data) => game.i18n.format(key, data);
const abilityLabel = id => loc(CONFIG.DND5E.abilities[id]?.label ?? id);
const fromUuidQuiet = uuid => (uuid ? fromUuidSync(uuid, { strict: false }) : null);
const unique = list => [...new Set(list.filter(Boolean))];

const CHANNEL = "module.awesome-vtt-core";
const MAX_KEY = 200;
/** Challenge cards already handled on this device (message id + actor), so a card is prompted once. */
const MAX_SEEN = 500;

/**
 * Watch for prompts (chat messages, turns and initiative) and hand them to the module; close those answered on
 * the player's other devices.
 * @param {object} options
 * @param {function(Prompt): void} options.show          Show (queue) a prompt.
 * @param {function(string): void} options.close         Close a prompt by key (answered on another device).
 * @param {function(string): boolean} options.enabled    Is a kind on? ("deathSave", "concentration", …)
 * @param {function(Actor): boolean} options.isMine      Is this character one this device prompts for?
 * @param {function(Prompt, boolean): void} [options.announce]  SotDL: called once for each challenge request for one
 *   of this device's characters, with whether it was shown as a prompt ("request" on), e.g. to tell the others.
 * @param {boolean} [options.relayed]  Also take challenge requests the GM relays (relayChallenges), for a device
 *   whose user isn't among the card's whisper recipients (the table screen).
 */
export function initPrompts({ show, close, enabled, isMine, announce, relayed = false }) {
  const builders = BUILDERS[game.system.id];
  if ( !sys.FEATURES.prompts || !builders ) return;
  const mine = actor => !!actor && !game.user.isGM && isMine(actor);
  const offer = prompt => prompt && show(prompt);

  // A challenge request, from its card or relayed by the GM: once per card and character.
  const seen = new Set();
  const challenge = data => {
    const prompt = challengePrompt(data, mine);
    if ( !prompt || seen.has(prompt.key) ) return;
    if ( seen.size >= MAX_SEEN ) seen.delete(seen.values().next().value);
    seen.add(prompt.key);
    const on = !!enabled("request");
    if ( on ) offer(prompt);
    announce?.(prompt, on);
  };

  Hooks.on("createChatMessage", message => {
    if ( game.user.isGM ) return;
    if ( builders.readChallenge ) challenge(builders.readChallenge(message));
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

  // The handler takes every argument: a relay counts only as (data, sender id), the id added by the server, and only
  // from a GM. That layout is not verified in a live world, so another one is logged once (see the core's notes).
  let warnedArity = false;
  game.socket.on(CHANNEL, (...args) => {
    const [data] = args;
    if ( (data?.type === "promptDone") && (typeof data.key === "string") && (data.key.length <= MAX_KEY) ) close(data.key);
    else if ( relayed && builders.readChallenge && (data?.type === "challengeRelay") ) {
      if ( args.length !== 2 ) {
        if ( !warnedArity ) console.warn(`awesome-vtt-core | challengeRelay ignored: the socket handler got ${args.length} arguments, expected 2 (data, sender id).`);
        warnedArity = true;
        return;
      }
      if ( !game.users.get(args[1])?.isGM ) return;
      const relay = validRelay(data);
      if ( relay?.to.includes(game.user.id) ) challenge(relay);
    }
  });

  // The page may be (re)loaded during a turn or before initiative was rolled.
  initiative();
  deathSave();
}

/**
 * On the active GM's client (one GM, however many are connected): pass each new challenge card that the users in
 * `recipients()` can't read (whispered to others) on to them over the core's socket, so their device can prompt as
 * for a public card (initPrompts with `relayed`). Call on every client at "ready"; it does nothing in systems
 * without challenge cards (dnd5e) or on other clients.
 *
 * Socket message: `{ type: "challengeRelay", to: [userId], messageId, actorUuid, attribute, boons, userId }`
 * (attribute: a `CONFIG.DL.attributes` key; boons: the card's own boons, banes negative; userId: who made the card).
 * Module sockets reach every client, so other players can read it: it says which character was asked for which
 * roll, as the card's speaker does.
 * @param {function(): string[]} recipients  Ids of the users to relay to (the table user).
 */
export function relayChallenges(recipients) {
  const read = BUILDERS[game.system.id]?.readChallenge;
  if ( !read || !game.socket ) return;
  Hooks.on("createChatMessage", message => {
    if ( !game.user.isGM || (game.users.activeGM !== game.user) ) return;
    const whisper = message.whisper ?? [];
    // A public card reaches everyone already.
    if ( !whisper.length ) return;
    const to = recipients().filter(id => !whisper.includes(id) && game.users.get(id)?.active);
    const data = to.length ? read(message) : null;
    if ( !data ) return;
    game.socket.emit(CHANNEL, { type: "challengeRelay", to, ...data, userId: message.author?.id ?? null });
  });
}

const ID = /^[A-Za-z0-9]{16}$/;
const MAX_UUID = 200;
const MAX_BOONS = 20;

/**
 * A relayed challenge request with every field checked, or null.
 * @param {object} data
 * @returns {{to: string[], messageId: string, actorUuid: string, attribute: string, boons: number,
 *   userId: string|null}|null}
 */
function validRelay(data) {
  const { to, messageId, actorUuid, attribute, boons, userId } = data;
  if ( !Array.isArray(to) || (to.length > 20) || !to.every(id => (typeof id === "string") && ID.test(id)) ) return null;
  if ( (typeof messageId !== "string") || !ID.test(messageId) ) return null;
  if ( (typeof actorUuid !== "string") || !actorUuid || (actorUuid.length > MAX_UUID) ) return null;
  if ( (typeof attribute !== "string") || !Object.hasOwn(CONFIG.DL?.attributes ?? {}, attribute) ) return null;
  if ( !Number.isInteger(boons) || (Math.abs(boons) > MAX_BOONS) ) return null;
  if ( (userId !== null) && ((typeof userId !== "string") || !ID.test(userId)) ) return null;
  return { to, messageId, actorUuid, attribute, boons, userId };
}

/**
 * Tell the player's other devices that a prompt was answered or dismissed here.
 * @param {string} key
 */
function promptDone(key) {
  if ( typeof key === "string" ) game.socket.emit(CHANNEL, { type: "promptDone", key: key.slice(0, MAX_KEY) });
}

const activeCombat = () => game.combats.find(c => c.active) ?? game.combat;

/**
 * Does this character have to make a death saving throw?
 * @param {Actor|null} actor
 * @returns {boolean}
 */
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

/**
 * The dnd5e prompts in a new chat message (concentration, saves, GM requests), for the kinds that are on.
 * @param {ChatMessage} message
 * @param {function(string): boolean} enabled
 * @param {function(Actor): boolean} mine
 * @returns {Prompt[]}
 */
function promptsFromMessage(message, enabled, mine) {
  switch ( message.type ) {
    case "prompt": return enabled("concentration") ? concentrationPrompts(message, mine) : [];
    case "usage": return enabled("save") ? savePrompts(message, mine) : [];
    case "request": return enabled("request") ? requestPrompts(message, mine) : [];
    default: return [];
  }
}

/**
 * The concentration save asked for by dnd5e's prompt message, if it is for one of this device's characters.
 * @param {ChatMessage} message
 * @param {function(Actor): boolean} mine
 * @returns {Prompt[]}
 */
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

/**
 * A save prompt for each of this device's characters that a save activity's message targets.
 * @param {ChatMessage} message
 * @param {function(Actor): boolean} mine
 * @returns {Prompt[]}
 */
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

/**
 * A prompt for each of this device's characters that a GM request lists and that hasn't answered yet.
 * @param {ChatMessage} message
 * @param {function(Actor): boolean} mine
 * @returns {Prompt[]}
 */
function requestPrompts(message, mine) {
  if ( !CONFIG.DND5E.requests?.[message.system?.handler] ) return [];
  const label = loc(message.system.button?.label ?? "") || loc("AVTTC.Prompt.Request.Go");
  const icon = message.system.button?.icon || "fa-solid fa-bell";
  const waiting = (message.system.targets ?? []).filter(t => !t.result);
  const actors = unique(waiting.map(t => fromUuidQuiet(t.actor))).filter(mine);
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

/**
 * The attribute key for a (localized) attribute name, as the system's challenge card carries it.
 * @param {string|undefined} name
 * @returns {string|null}
 */
function attributeKey(name) {
  const lower = String(name ?? "").toLowerCase();
  return Object.entries(CONFIG.DL?.attributes ?? {})
    .find(([key, label]) => (key === lower) || (loc(label).toLowerCase() === lower))?.[0] ?? null;
}

/**
 * "with 2 boons" style text for a request's own boons (or banes), or "".
 * @param {number} n
 * @returns {string}
 */
function boonsText(n) {
  if ( !n ) return "";
  const key = n > 0 ? (n === 1 ? "AVTTC.Boons.boon" : "AVTTC.Boons.boons") : (n === -1 ? "AVTTC.Boons.bane" : "AVTTC.Boons.banes");
  return fmt(key, { n: Math.abs(n) });
}

/**
 * What a new message asks for, if it is the system's "make a challenge roll" card: the message, the character (its
 * token's uuid from the card, else the actor's), the attribute key and the card's own boons (banes negative).
 * @param {ChatMessage} message
 * @returns {{messageId: string, actorUuid: string, attribute: string, boons: number}|null}
 */
function readChallengeCard(message) {
  if ( !message?.content?.includes("make-challengeroll") ) return null;
  const card = parseHTML(message.content);
  const button = card.querySelector(".make-challengeroll .header");
  const attribute = attributeKey(button?.dataset.attribute);
  if ( !attribute ) return null;
  // The token's uuid when it resolves here (an unlinked token has its own actor), else the world actor's.
  const tokenUuid = card.querySelector(".demonlord")?.dataset.tokenId;
  const actorId = button.dataset.actorid;
  const actorUuid = (tokenUuid && fromUuidQuiet(tokenUuid)?.actor) ? tokenUuid : (actorId ? `Actor.${actorId}` : "");
  if ( !actorUuid ) return null;
  const boons = Math.clamp(parseInt(button.dataset.boonsbanes) || 0, -MAX_BOONS, MAX_BOONS);
  return { messageId: message.id, actorUuid, attribute, boons };
}

/**
 * The prompt for a challenge request (from readChallengeCard, or relayed by the GM), if it is for one of this
 * device's characters. The key is the same however the request arrived.
 * @param {{messageId: string, actorUuid: string, attribute: string, boons: number}|null} data
 * @param {function(Actor): boolean} mine
 * @returns {Prompt|null}
 */
function challengePrompt(data, mine) {
  if ( !data ) return null;
  const doc = fromUuidQuiet(data.actorUuid);
  const actor = { Actor: doc, Token: doc?.actor }[doc?.documentName] ?? null;
  const key = data.attribute;
  if ( !mine(actor) || !CONFIG.DL?.attributes?.[key] ) return null;
  const extra = data.boons;
  const attribute = loc(CONFIG.DL.attributes[key]);
  const boons = boonsText(extra);
  return {
    key: `challenge:${data.messageId}:${actor.uuid}`,
    kind: "request",
    actor,
    attribute,
    boons,
    icon: "fa-solid fa-dice-d20",
    title: loc("AVTTC.Prompt.Challenge.Title"),
    text: fmt(boons ? "AVTTC.Prompt.Challenge.TextBoons" : "AVTTC.Prompt.Challenge.Text", { name: actor.name, attribute, boons }),
    rollMode: true,
    sources: () => sys.boonSources(actor, { attribute: key }),
    choices: [{
      label: fmt("AVTTC.Prompt.Challenge.Roll", { attribute }),
      icon: "fa-solid fa-dice-d20",
      run: (mode, disabled) => sys.rollAbility(actor, key, mode, extra, disabled)
    }]
  };
}

/**
 * SotDL: an attribute rolled from the sheet (FEATURES.abilityRollPrompt), asking for boons or banes first. Shown like
 * the other prompts, with the Next roll choice preset to what is armed; only on this device.
 * @param {Actor|null} actor
 * @param {string} action
 * @param {DOMStringMap} data
 * @returns {Prompt|null}
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
    sources: () => sys.boonSources(actor, { attribute: key }),
    choices: [{
      label: fmt("AVTTC.Prompt.Challenge.Roll", { attribute }),
      icon: "fa-solid fa-dice-d20",
      run: (mode, disabled) => sys.rollAbility(actor, key, mode, 0, disabled)
    }]
  };
}

/**
 * SotDL 6.1.14: an attack with an item whose boons or banes come from somewhere (effects, the item, the target),
 * asking first so the player sees them and can switch some off, as the system's own roll dialog does. Null when
 * the roll has no such sources (the item is used straight away). Only on this device.
 * @param {Actor|null} actor
 * @param {string} itemId
 * @returns {Prompt|null}
 */
function itemRollPrompt(actor, itemId) {
  const item = actor?.items.get(itemId);
  if ( !item || !sys.boonSources(actor, { itemId })?.length ) return null;
  return {
    key: `roll:${actor.uuid}:item:${itemId}:${foundry.utils.randomID()}`,
    kind: "roll",
    local: true,
    actor,
    rollKey: `useItem:${itemId}`,
    icon: "fa-solid fa-dice-d20",
    title: fmt("AVTTC.Prompt.Item.Title", { item: item.name }),
    text: fmt("AVTTC.Prompt.Item.Text", { name: actor.name, item: item.name }),
    rollMode: true,
    // The user's targets when the prompt is drawn (they may change while it is open).
    sources: () => sys.boonSources(actor, { itemId }),
    choices: [{
      label: fmt("AVTTC.Prompt.Item.Roll", { item: item.name }),
      icon: "fa-solid fa-dice-d20",
      run: (mode, disabled) => sys.useItem(actor, itemId, mode, { disabled })
    }]
  };
}

/**
 * For dnd5e: an ability check, saving throw or skill rolled from the sheet, asking for advantage first.
 * @param {Actor|null} actor
 * @param {string} action
 * @param {DOMStringMap} data
 * @returns {Prompt|null}
 */
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
 * @returns {boolean}
 */
export function askSheetRoll(queue, actor, action, data) {
  if ( !sys.FEATURES.abilityRollPrompt ) return false;
  return queueLocal(queue, BUILDERS[game.system.id]?.sheetRoll(actor, action, data));
}

/**
 * Using an item that rolls with boons or banes from somewhere (SotDL 6.1.14, itemRollPrompt) asks first. True when
 * the use is taken care of, false to use it straight away (no sources, another system, or an older SotDL).
 * @param {PromptQueue} queue
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {boolean}
 */
export function askItemRoll(queue, actor, itemId) {
  return queueLocal(queue, itemRollPrompt(actor, itemId));
}

/**
 * Queue a prompt started on this device, unless the same one is already up (a second tap). False without a prompt.
 * @param {PromptQueue} queue
 * @param {Prompt|null} prompt
 * @returns {boolean}
 */
function queueLocal(queue, prompt) {
  if ( !prompt ) return false;
  if ( !queue.has(p => p.local && (p.actor === prompt.actor) && (p.rollKey === prompt.rollKey)) ) queue.add(prompt);
  return true;
}

/**
 * Boon sources (the adapter's boonSources) as template rows: boons "+n", banes "−n", and whether each still counts.
 * Prompts and the phone's use dialog draw these. Null when there are none.
 * @param {{id: string, label: string, value: number}[]|null} sources
 * @param {Set<string>} [disabled]  Source ids switched off: shown, but not counted.
 * @returns {{id: string, label: string, value: string, enabled: boolean}[]|null}
 */
export function sourceRows(sources, disabled) {
  if ( !sources?.length ) return null;
  return sources.map(({ id, label, value }) => ({
    id, label, value: (value > 0) ? `+${value}` : `−${-value}`, enabled: !disabled?.has(id)
  }));
}

/**
 * Switch a boon source off, or back on (`disabled` holds the ids switched off).
 * @param {Set<string>} disabled
 * @param {string} id
 */
export function toggleSourceIn(disabled, id) {
  if ( !disabled.delete(id) ) disabled.add(id);
}

/* -------------------------------------------- */
/*  Both systems                                */
/* -------------------------------------------- */

/**
 * One prompt per character with combatants without initiative in the active encounter: a fast or slow turn where
 * the system has them (SotDL's default mode), otherwise the core's rollInitiative (dnd5e: with the Next roll).
 * @param {function(string): boolean} enabled
 * @param {function(Actor): boolean} mine
 * @param {boolean} rollMode  Does the roll take the Next roll choice?
 * @returns {Prompt[]}
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
 * Prompts per system: built from a new chat message (SotDL: its challenge cards, readChallenge), and whether an
 * initiative roll takes the Next roll choice (SotDL's optional initiative modes roll with the system's own formula).
 */
const BUILDERS = {
  dnd5e: { fromMessage: promptsFromMessage, initiativeRollMode: true, sheetRoll: checkRollPrompt },
  // Challenge cards are read by readChallenge (initPrompts and relayChallenges), not by fromMessage.
  demonlord: {
    fromMessage: () => [], readChallenge: readChallengeCard, initiativeRollMode: false, sheetRoll: attributeRollPrompt
  }
};

/* -------------------------------------------- */

/**
 * The death save prompt for a dying character's turn.
 * @param {Actor} actor
 * @param {string} key
 * @returns {Prompt}
 */
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

  /**
   * The prompt on screen, or null.
   * @returns {Prompt|null}
   */
  get current() {
    return this.#items[0] ?? null;
  }

  /**
   * Template data for the current prompt, or null.
   * @param {object[]|null} modes  The Normal / Advantage / Disadvantage choice (advModeChoices), for d20 prompts.
   * @returns {object|null}
   */
  context(modes) {
    const prompt = this.current;
    if ( !prompt ) return null;
    const { key, kind, icon, title, text, tally, rollMode } = prompt;
    return {
      key, kind, icon, title, text, tally,
      sources: sourceRows(prompt.sources?.(), prompt.disabled),
      choices: prompt.choices.map(({ label, icon }) => ({ label, icon })),
      modes: rollMode ? modes : null,
      scale: rollMode ? sys.rollModeScale() : null,
      more: this.waiting
    };
  }

  /**
   * Is a prompt matching `test` shown or waiting? (e.g. the same attribute roll, tapped twice)
   * @param {function(Prompt): boolean} test
   * @returns {boolean}
   */
  has(test) {
    return this.#items.some(test);
  }

  /**
   * Prompts waiting after the current one.
   * @returns {number}
   */
  get waiting() {
    return Math.max(this.#items.length - 1, 0);
  }

  add(prompt) {
    if ( !prompt || this.#seen.has(prompt.key) ) return;
    this.#seen.add(prompt.key);
    this.#items.push(prompt);
    this.onChange();
  }

  /**
   * Remove a prompt by key (answered on another device); nothing is announced.
   * @param {string} key
   */
  close(key) {
    this.#seen.add(key);
    const before = this.#items.length;
    this.#items = this.#items.filter(p => p.key !== key);
    if ( this.#items.length !== before ) this.onChange();
  }

  /**
   * Switch one of the current prompt's boon sources off or back on.
   * @param {string} id
   */
  toggleSource(id) {
    const prompt = this.current;
    if ( !prompt?.sources || !id ) return;
    toggleSourceIn(prompt.disabled ??= new Set(), id);
    this.onChange();
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
   * @returns {Promise<unknown>}
   */
  async choose(index, d20) {
    const prompt = this.current;
    const choice = prompt?.choices[Number(index)];
    if ( !choice ) return;
    this.dismiss();
    const disabled = [...(prompt.disabled ?? [])];
    return prompt.rollMode ? d20(mode => choice.run(mode, disabled)) : choice.run("normal", disabled);
  }
}
