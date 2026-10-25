/**
 * Part of awesome-vtt-core: the game system adapter for this world. Each adapter (dnd5e.mjs, demonlord.mjs) has the
 * same interface, so the table and phone modules and the rest of the core stay system-neutral:
 *
 *   import sys from "../../awesome-vtt-core/scripts/system.mjs";
 *   sys.getSummary(actor);
 *
 * `sys` looks the adapter up on each use (the world's system is known once the game is set up).
 */

import * as dnd5e from "./dnd5e.mjs";
import * as demonlord from "./demonlord.mjs";

const ADAPTERS = { dnd5e, demonlord };

/** Is this world's game system supported? */
export const isSupported = () => game.system?.id in ADAPTERS;

/** The adapter of this world's system (dnd5e's when the system isn't supported; callers check isSupported first). */
export const adapter = () => ADAPTERS[game.system?.id] ?? dnd5e;

/**
 * Mark the page with the world's system (`<body data-avtt-system="…">`), so the modules' CSS can adapt to it. Called
 * at init by both modules; also runs fixStatusIds.
 */
export function markSystem() {
  document.body.dataset.avttSystem = game.system?.id ?? "";
  fixStatusIds();
}

/** Status id → the static _id fixStatusIds gave it. */
const staticIds = new Map();
let statusIdsFixed = false;

/**
 * Foundry v14 refuses to toggle a status effect that brings other statuses with it unless it has a static _id ("Status
 * effects with implicit statuses must have a static _id"), and once it has one, core's toggle and token HUD only find
 * the effect with that _id. SotDL 6.1.x registers Blinded and Unconscious (both add core's "blind") without one, and
 * creates such effects itself with random ids (Dying or Asleep → Unconscious, the sheet, the afflictions compendium).
 * Call at init (markSystem does; modules that don't call it call this); the hooks are added once:
 * - at setup, after the system's own setup hook, every such status without _id gets one;
 * - an effect created on an actor with one of those statuses gets that _id, unless the actor already has it, so core
 *   finds it and the token HUD doesn't add a second copy.
 */
export function fixStatusIds() {
  if ( statusIdsFixed ) return;
  statusIdsFixed = true;
  Hooks.once("setup", () => {
    for ( const status of Object.values(CONFIG.statusEffects) ) {
      if ( status._id || (new Set([status.id, ...status.statuses ?? []]).size < 2) ) continue;
      status._id = `avtt${status.id}`.replace(/[^A-Za-z0-9]/g, "").padEnd(16, "0").slice(0, 16);
      staticIds.set(status.id, status._id);
    }
  });
  Hooks.on("preCreateActiveEffect", (effect, data, options) => {
    const actor = effect.parent;
    if ( !staticIds.size || (actor?.documentName !== "Actor") ) return;
    const id = [...staticIds.keys()].find(s => effect.statuses.has(s));
    const _id = staticIds.get(id);
    if ( !_id || actor.effects.has(_id) ) return;
    effect.updateSource({ _id });
    options.keepId = true;
  });
}

/**
 * Should a roll's notice offer to roll its damage (the adapter's rollDamageFrom)? When the adapter's summarizeRoll
 * found damage to roll on a roll that didn't miss, unless the adapter already rolls it after the attack by itself
 * (FEATURES.autoDamage with the module's "damage after attacks" setting on).
 * @param {object} result       From the adapter's summarizeRoll.
 * @param {boolean} autoDamage  The module's setting for rolling damage after attacks.
 */
export const offersDamage = (result, autoDamage) => !!result?.damage && !(adapter().FEATURES.autoDamage && autoDamage);

/**
 * A roll notice's "Roll damage" button (`notice.action`, see the core's fillNoticeAction) when offersDamage, else
 * undefined: it rolls the damage with the adapter's rollDamageFrom.
 * @param {object} result          From the adapter's summarizeRoll.
 * @param {ChatMessage} message    The roll's message.
 * @param {boolean} autoDamage     As for offersDamage.
 * @param {string} label           The button's text.
 * @param {() => Promise<boolean>} [before]  Runs first; false cancels (the phone: SotDL targets picked without the map).
 */
export function damageAction(result, message, autoDamage, label, before) {
  if ( !offersDamage(result, autoDamage) ) return undefined;
  return { label, run: async () => {
    if ( !before || await before() ) return adapter().rollDamageFrom(message);
  } };
}

export default new Proxy({}, { get: (_, key) => adapter()[key] });
