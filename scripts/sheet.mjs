import sys from "./system.mjs";
import { escapeHTML, sharedInventory } from "./ui.mjs";

/**
 * The compact character sheet, shared by the table seats and the phone app: its tabs, the data each tab shows,
 * and the actions of its buttons. Each module draws it with its own template (same data-action names) and keeps
 * its own layout: rotated seat panels with mouse controls on the table, a full-screen touch view on the phone.
 */

/**
 * The sheet's tabs come from the system adapter (SHEET_TABS), in the order the user chose (2026-10-04): actions,
 * skills, spells, abilities, inventory, status; a system without one (SotDL has no skills) leaves it out.
 * @returns {string[]}
 */
const sheetTabs = () => sys.SHEET_TABS;

/**
 * A known tab, or the first one.
 * @param {string|undefined} tab
 * @returns {string}
 */
export const sheetTab = tab => (sheetTabs().includes(tab) ? tab : sheetTabs()[0]);

/**
 * Template data for the sheet: the character summary, the tab list, and the chosen tab's data.
 * @param {Actor} actor
 * @param {string} tab
 * @param {(id: string) => string} tabLabel  The module's label key for a tab, e.g. id => `AVTT.Sheet.Tab.${id}`.
 * @returns {object}
 */
export function sheetContext(actor, tab, tabLabel) {
  tab = sheetTab(tab);
  const context = {
    ...sys.getSummary(actor),
    tab,
    tabs: sheetTabs().map(id => ({ id, active: id === tab, label: game.i18n.localize(tabLabel(id)) })),
    // Rows can be starred as dnd5e favorites (characters).
    canFavorite: sys.canFavorite(actor),
    // Inventory rows offer "Give to the party" with the shared inventory module and a party this user may change.
    toParty: !!sharedInventory()?.canGive()
  };
  if ( tab === "actions" ) context.actions = sys.getActions(actor);
  if ( tab === "spells" ) context.spells = sys.getSpells(actor);
  if ( tab === "inventory" ) context.inventory = sys.getInventory(actor);
  if ( tab === "abilities" ) context.abilities = sys.getAbilities(actor);
  if ( tab === "skills" ) context.skills = sys.getSkills(actor);
  if ( tab === "status" ) context.status = true;
  if ( tab === "bio" ) context.bio = sys.getBio(actor);
  return context;
}

/**
 * The parts of sheetContext's data that need async work: the Bio tab's description, enriched like a journal.
 * @param {object} context
 * @param {Actor} actor
 * @returns {Promise<object>}
 */
export async function enrichSheet(context, actor) {
  if ( !context.bio ) return context;
  const TextEditor = foundry.applications.ux.TextEditor.implementation;
  context.bio.html = context.bio.description
    ? await TextEditor.enrichHTML(context.bio.description, { secrets: actor.isOwner, relativeTo: actor })
    : "";
  return context;
}

/* -------------------------------------------- */

/** d20 rolls: the module resets its one-shot advantage choice after them. */
export const D20_ACTIONS = new Set(["rollAbility", "rollSave", "rollSkill", "deathSave", "rollInitiative"]);

/**
 * Sheet and quick-action buttons handled by runSheetAction(). Items (useItem), descriptions (invDetails) and the HP
 * field (hpMode, applyHp) are module-side.
 */
export const SHEET_ACTIONS = new Set([
  ...D20_ACTIONS, "toggleInspiration", "toggleCondition", "shortRest", "longRest",
  "usesAdjust", "slotAdjust", "invQty", "invEquip", "invAttune",
  "endConcentration", "exhaustion", "toggleEffect", "spellPrepare", "invToParty", "toggleFavorite", "trackAdjust"
]);

/**
 * Run a sheet button's action.
 * @param {Actor} actor
 * @param {string} action     One of SHEET_ACTIONS.
 * @param {DOMStringMap} data The button's dataset.
 * @param {"normal"|"adv"|"dis"} [advMode]  For d20 rolls.
 * @param {object} [options]
 * @param {Set<string>} [options.toggled]  Effects toggled from the quick actions, kept in their list (see below).
 * @returns {unknown} What the system adapter returns (often a Promise).
 */
export function runSheetAction(actor, action, data, advMode = "normal", { toggled } = {}) {
  if ( !actor ) return;
  const delta = Number(data.delta);
  switch ( action ) {
    case "rollAbility": return sys.rollAbility(actor, data.ability, advMode);
    case "rollSave": return sys.rollSave(actor, data.ability, advMode);
    case "rollSkill": return sys.rollSkill(actor, data.skill, advMode);
    case "deathSave": return sys.rollDeathSave(actor, advMode);
    case "rollInitiative": return sys.rollInitiative(actor, advMode);
    case "toggleInspiration": return sys.toggleInspiration(actor);
    case "toggleCondition": return sys.toggleCondition(actor, data.condition);
    case "shortRest": return sys.shortRest(actor);
    case "longRest": return sys.longRest(actor);
    case "usesAdjust": return sys.changeUses(actor, data.itemId, delta);
    case "slotAdjust": return sys.changeSlots(actor, data.slot, delta);
    case "invQty": return sys.changeQuantity(actor, data.itemId, delta);
    case "invEquip": return sys.toggleEquipped(actor, data.itemId);
    case "invAttune": return sys.toggleAttuned(actor, data.itemId);
    case "spellPrepare": return sys.togglePrepared(actor, data.itemId);
    case "invToParty": return sharedInventory()?.giveItem(actor, data.itemId);
    case "toggleFavorite": return sys.toggleFavorite(actor, data.itemId);
    case "trackAdjust": return sys.changeTrack(actor, data.track, delta);
    case "endConcentration": return sys.endConcentration(actor, data.effectId);
    case "exhaustion": return sys.changeExhaustion(actor, delta);
    case "toggleEffect":
      toggled?.add(data.effectUuid);
      return sys.toggleEffect(actor, data.effectUuid);
  }
}

/**
 * The quick actions' tabs (user's decisions, 2026-10-04):
 * - "quick": only the character's actions (the sheet's Actions tab);
 * - "effects": death saves (at 0 HP), inspiration, the HP field (damage / heal / temp), concentration, exhaustion,
 *   common conditions and toggleable effects;
 * - "rest": short and long rest.
 */
const QUICK_TABS = ["quick", "effects", "rest"];

/**
 * A known quick actions tab, or the first one.
 * @param {string|undefined} tab
 * @returns {string}
 */
export const quickTab = tab => (QUICK_TABS.includes(tab) ? tab : QUICK_TABS[0]);

/**
 * Template data for the quick actions: its tabs, the character's actions (Quick tab), and death saves,
 * inspiration and rests, the HP field, concentration, exhaustion, common conditions and toggleable effects.
 * @param {Actor} actor
 * @param {object} options
 * @param {string} options.tab                   The open tab (QUICK_TABS).
 * @param {(id: string) => string} options.tabLabel  The module's label key for a tab.
 * @param {Set<string>} options.toggled          Effects toggled this session, kept in the list once enabled.
 * @param {string} options.hpMode                The HP field's mode (sys.HP_MODES).
 * @param {(mode: string) => string} options.hpLabel  The module's label key for an HP mode.
 * @returns {object}
 */
export function quickActionsContext(actor, { tab, tabLabel, toggled, hpMode, hpLabel }) {
  const summary = sys.getSummary(actor);
  tab = quickTab(tab);
  return {
    tab,
    tabs: QUICK_TABS.map(id => ({ id, active: id === tab, label: game.i18n.localize(tabLabel(id)) })),
    actions: (tab === "quick") ? sys.getActions(actor) : null,
    canFavorite: sys.canFavorite(actor),
    ...sys.getQuickActions(actor, toggled),
    inspiration: summary.inspiration,
    inspirationLabel: summary.inspirationLabel,
    // Death saves only where the system has them (dnd5e), while the character is dying.
    deathSave: summary.dying && sys.FEATURES.deathSaves,
    death: summary.death,
    rests: sys.getRests(),
    hpModes: sys.HP_MODES.map(id => ({ id, label: game.i18n.localize(hpLabel(id)), active: id === hpMode }))
  };
}

/**
 * A changed sheet field (currency). Returns true if it was one.
 * @param {Actor|null} actor
 * @param {string} name
 * @param {string} value
 * @returns {boolean}
 */
export function onSheetChange(actor, name, value) {
  if ( !actor || !name?.startsWith("currency.") ) return false;
  sys.setCurrency(actor, name.slice("currency.".length), value);
  return true;
}

/**
 * Show or hide an item's description (Actions and Inventory tabs), stored in `details` (id -> enriched HTML).
 * @param {object} details
 * @param {Actor} actor
 * @param {string} itemId
 * @param {string} emptyText  Localized text for an item without a description.
 * @param {string} emptyClass The module's class for muted text.
 */
export async function toggleItemDetails(details, actor, itemId, emptyText, emptyClass) {
  if ( itemId in details ) delete details[itemId];
  else details[itemId] = (await sys.getItemDescription(actor, itemId)) || `<p class="${emptyClass}">${escapeHTML(emptyText)}</p>`;
}

/* -------------------------------------------- */

/**
 * Chat messages to show: the visible ones, optionally only those spoken as one actor, the most recent `limit`.
 * @param {object} root0
 * @param {string|null} root0.actorId
 * @param {number} root0.limit
 * @returns {{messages: ChatMessage[], hasMore: boolean}}
 */
export function chatMessages({ actorId = null, limit = Infinity } = {}) {
  const shown = game.messages.contents.filter(m => chatShows(m, actorId));
  return { messages: shown.slice(-limit), hasMore: shown.length > limit };
}

/** Chat filters: every visible message, or only those spoken as the character shown. */
export const CHAT_FILTERS = ["all", "mine"];

/**
 * The actor id to filter a chat log by, for a filter and the character shown.
 * @param {string} filter
 * @param {Actor|null} actor
 * @returns {string|null}
 */
export const chatActorId = (filter, actor) => ((filter === "mine") ? (actor?.id ?? null) : null);

export const MAX_CHAT_TEXT = 2000;

/**
 * Send chat text through Foundry's chat processing (so commands such as /r and whispers work), as the actor.
 * @param {string} text
 * @param {Actor|null} actor
 * @returns {Promise<boolean>}  Whether something was sent.
 */
export async function sendChat(text, actor) {
  text = String(text ?? "").slice(0, MAX_CHAT_TEXT).trim();
  if ( !text ) return false;
  const speaker = ChatMessage.implementation.getSpeaker(actor ? { actor } : {});
  await ui.chat.processMessage(text, { speaker });
  return true;
}

/**
 * Does a chat log (optionally filtered to one actor) show this message?
 * @param {ChatMessage} message
 * @param {string|null} actorId
 * @returns {boolean}
 */
export const chatShows = (message, actorId = null) =>
  message.visible && (!actorId || (message.speaker?.actor === actorId));
