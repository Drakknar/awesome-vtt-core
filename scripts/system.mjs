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

/** Mark the page with the world's system (`<body data-avtt-system="…">`), so the modules' CSS can adapt to it. */
export const markSystem = () => document.body.dataset.avttSystem = game.system?.id ?? "";

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
