import sys from "./system.mjs";

/**
 * Dice shared by the table and phone modules: the click-to-build dice pool, rolling it, and making the Physical
 * dice method (registered by the awesome-vtt table module) this device's default.
 */

/** The table module, which registers the Physical dice fulfillment method under its own id. */
const TABLE_MODULE_ID = "awesome-vtt";
export const PHYSICAL_DICE_METHOD = "awesome-vtt";

/**
 * Is the Physical dice method registered on this device (the table module is active)?
 * @returns {boolean}
 */
export const physicalDiceRegistered = () =>
  !!game.modules.get(TABLE_MODULE_ID)?.active && !!CONFIG.Dice.fulfillment.methods[PHYSICAL_DICE_METHOD];

/**
 * Make Physical dice this device's default dice method, or stop it being the default.
 * Only the "default" entry of the device's dice configuration is changed, and only when it is empty or ours,
 * so per-die choices made in Configure Dice still win.
 * @param {boolean} enabled
 */
export async function syncDefaultDiceMethod(enabled) {
  const key = foundry.dice.Roll.DICE_CONFIGURATION_SETTING;
  const config = { ...(game.settings.get("core", key) ?? {}) };
  if ( enabled && !config.default ) config.default = PHYSICAL_DICE_METHOD;
  else if ( !enabled && (config.default === PHYSICAL_DICE_METHOD) ) delete config.default;
  else return;
  await game.settings.set("core", key, config);
}

/* -------------------------------------------- */

const DICE = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];
const MAX_PER_DIE = 20;
const MAX_MOD = 30;

/**
 * The "Next roll" modes of this system (the dice pool's single d20, sheet rolls and prompts): dnd5e's advantage and
 * disadvantage, or SotDL's boons and banes. "normal" is always the neutral one.
 * @returns {string[]}
 */
export const advModes = () => sys.ROLL_MODES;

/**
 * The Next roll choice as template data: each mode with its label (the module's label for dnd5e's modes, the
 * adapter's for others).
 * @param {Record<string, string>} labels  The module's label key per dnd5e mode.
 * @param {string} active
 * @returns {{id: string, label: string, text: string, tone: string, active: boolean}[]}
 */
export const advModeChoices = (labels, active) => advModes().map(id => {
  const label = sys.rollModeLabel(id) ?? game.i18n.localize(labels[id]);
  // The button text: dnd5e's three labels fit; SotDL's seven choices show "−2" … "+3" (the label is the tooltip).
  return { id, label, text: sys.rollModeShort(id) ?? label, tone: advModeTone(id), active: id === active };
});

/**
 * The Next roll choice's heading and end labels ({title, low, high}, SotDL: banes … boons), or null (dnd5e).
 * @returns {{title: string, low: string, high: string}|null}
 */
export const advModeScale = () => sys.rollModeScale();

/**
 * The colour of a mode: "adv" (advantage, boons), "dis" (disadvantage, banes) or "normal".
 * @param {string} id
 * @returns {string}
 */
export const advModeTone = id => (id.startsWith("boon") ? "adv" : id.startsWith("bane") ? "dis" : id);

/**
 * The short text of the pill's chip for an armed mode ("ADV", "+2"…): the adapter's, else the module's label.
 * @param {Record<string, string>} shortLabels
 * @param {string} mode
 * @returns {string}
 */
export const advModeShort = (shortLabels, mode) => sys.rollModeShort(mode) ?? game.i18n.localize(shortLabels[mode]);

/**
 * A dice pool built by clicking dice: counts per die and a flat modifier.
 * Plain data (`pool`, `mod`), so it can live in a panel's state.
 */
class DicePool {
  pool = {};

  mod = 0;

  add(die) {
    if ( DICE.includes(die) ) this.pool[die] = Math.min((this.pool[die] ?? 0) + 1, MAX_PER_DIE);
  }

  remove(die) {
    if ( !DICE.includes(die) || !this.pool[die] ) return;
    this.pool[die] -= 1;
    if ( !this.pool[die] ) delete this.pool[die];
  }

  /**
   * Change the modifier by a whole number (e.g. ±1).
   * @param {number|string} delta
   */
  changeMod(delta) {
    const step = Math.trunc(Number(delta)) || 0;
    this.mod = Math.clamp(this.mod + step, -MAX_MOD, MAX_MOD);
  }

  clear() {
    this.pool = {};
    this.mod = 0;
  }

  /**
   * Each die with its count, for the dice grid.
   * @returns {{die: string, count: number}[]}
   */
  get dice() {
    return DICE.map(die => ({ die, count: this.pool[die] ?? 0 }));
  }

  /**
   * Template data for the dice panel: the dice grid, modifier and formula.
   * @param {string} mode
   * @returns {{dice: object[], mod: number, formula: string}}
   */
  context(mode = "normal") {
    return { dice: this.dice, mod: this.mod, formula: this.formula(mode) };
  }

  /**
   * The pool as a roll formula; a single d20 takes the Next roll choice as the system rolls it (dnd5e: twice, keep
   * the higher or lower; SotDL: boons or banes as d6).
   * @param {string} [mode]
   * @returns {string}
   */
  formula(mode = "normal") {
    const parts = [];
    for ( const die of DICE ) {
      const n = this.pool[die] ?? 0;
      if ( !n ) continue;
      const d20 = ((die === "d20") && (n === 1)) ? sys.poolD20(mode) : null;
      parts.push(d20 ?? `${n}${die}`);
    }
    if ( this.mod ) parts.push(String(this.mod));
    return parts.join(" + ").replace("+ -", "- ");
  }
}

/**
 * Roll a formula from the dice pool and post it to chat as the actor.
 * @param {string} formula
 * @param {object} options
 * @param {Actor|null} [options.actor]  Speaker.
 * @param {string} [options.flavor]     Chat flavor text.
 * @param {boolean} [options.physical]  Ask for real dice (core opens the dice entry window); otherwise Foundry rolls.
 * @returns {Promise<Roll|null>}
 */
async function rollPool(formula, { actor = null, flavor = "", physical = false } = {}) {
  if ( !formula ) return null;
  const roll = new Roll(formula);
  await roll.evaluate({ allowInteractive: physical });
  await roll.toMessage({ speaker: ChatMessage.implementation.getSpeaker(actor ? { actor } : {}), flavor });
  return roll;
}

/* -------------------------------------------- */

/**
 * The Dice panel, shared by the table seats and the phone app: the pool, whether it rolls real dice, and its buttons
 * (the same data-action names in both modules' templates). A single d20 uses the module's armed advantage choice.
 */
export class DicePanel {
  /** Actions handled by `handle()`. */
  static ACTIONS = new Set(["diceAdd", "diceRemove", "diceMod", "diceClear", "diceSource", "diceRoll"]);

  /**
   * @param {object} options
   * @param {() => Promise<void>} options.render        Draw the panel from `context()`.
   * @param {() => boolean} options.physicalAvailable   Is physical dice entry on for this device?
   * @param {() => string} options.advMode              The armed advantage choice.
   * @param {() => Actor|null} options.actor            Who rolls.
   * @param {string} options.flavor                     Chat flavor of pool rolls (localized).
   * @param {(usedAdvantage: boolean) => void} options.onRolled  After a roll (e.g. reset the advantage choice).
   */
  constructor(options) {
    Object.assign(this, options);
  }

  pool = new DicePool();

  /** "physical" asks for real dice results (when available), "digital" lets Foundry roll. */
  source = "physical";

  get physical() {
    return this.physicalAvailable() && (this.source === "physical");
  }

  context() {
    const { physical } = this;
    return { ...this.pool.context(this.advMode()), physicalAvailable: this.physicalAvailable(), physical };
  }

  /**
   * Run a dice action from a [data-action] button.
   * @param {string} action
   * @param {DOMStringMap} data
   * @returns {Promise<void>}
   */
  async handle(action, data) {
    switch ( action ) {
      case "diceAdd": this.pool.add(data.die); break;
      case "diceRemove": this.pool.remove(data.die); break;
      case "diceMod": this.pool.changeMod(data.delta); break;
      case "diceClear": this.pool.clear(); break;
      case "diceSource": if ( ["physical", "digital"].includes(data.source) ) this.source = data.source; break;
      case "diceRoll": return this.#roll();
    }
    return this.render();
  }

  async #roll() {
    const mode = this.advMode();
    // The Next roll choice is used up only when the pool has the single d20 it applies to.
    const usedMode = (this.pool.pool.d20 === 1) && !!sys.poolD20(mode);
    const formula = this.pool.formula(mode);
    const roll = await rollPool(formula, { actor: this.actor(), flavor: this.flavor, physical: this.physical });
    if ( !roll ) return;
    this.pool.clear();
    await this.render();
    this.onRolled(usedMode);
  }
}
