/**
 * Part of awesome-vtt-core: the world settings both modules share. The core has no scripts of its own, so each
 * module calls registerCoreSettings() at init; the first call registers them under the core's id.
 */

const CORE_ID = "awesome-vtt-core";

/**
 * Register the core's world settings, once (the first module to call it does).
 */
export function registerCoreSettings() {
  if ( game.settings.settings.has(`${CORE_ID}.compendiumAdd`) ) return;
  // Players may add items they open in the Compendium panel to their character's inventory (GM's choice, on).
  game.settings.register(CORE_ID, "compendiumAdd", {
    name: "AVTTC.Settings.compendiumAdd.Name",
    hint: "AVTTC.Settings.compendiumAdd.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: true })
  });
}

/**
 * A core setting's value, or undefined before it is registered.
 * @param {string} key
 * @returns {unknown}
 */
export function coreSetting(key) {
  return game.settings.settings.has(`${CORE_ID}.${key}`) ? game.settings.get(CORE_ID, key) : undefined;
}
