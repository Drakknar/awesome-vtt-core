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

let statusIdsFixed = false;

/**
 * Mark the page with the world's system (`<body data-avtt-system="…">`), so the modules' CSS can adapt to it. Called
 * at init by both modules; also queues fixStatusIds for setup (once).
 */
export function markSystem() {
  document.body.dataset.avttSystem = game.system?.id ?? "";
  if ( statusIdsFixed ) return;
  statusIdsFixed = true;
  Hooks.once("setup", fixStatusIds);
}

/**
 * Give a static _id to every status effect that brings other statuses with it and has none: Foundry v14 refuses to
 * toggle it otherwise ("Status effects with implicit statuses must have a static _id"). SotDL 6.1.x registers Blinded
 * and Unconscious (both add core's "blind") without one, at its own setup hook, which runs before ours.
 */
function fixStatusIds() {
  for ( const status of Object.values(CONFIG.statusEffects) ) {
    if ( status._id || (new Set([status.id, ...status.statuses ?? []]).size < 2) ) continue;
    status._id = `avtt${status.id}`.replace(/[^A-Za-z0-9]/g, "").padEnd(16, "0").slice(0, 16);
  }
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
