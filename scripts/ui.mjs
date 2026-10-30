/**
 * UI helpers shared by the table and phone modules. They work on each module's own markup: class names are passed
 * in, so templates and styles stay in each module.
 */

/**
 * The sections of both apps, in order, with their icons: the phone's tab bar and the table pill's section bar.
 * Each opens one panel (on the table) or view (on the phone); the phone adds its own Settings view.
 */
export const SECTIONS = ["character", "dice", "chat", "journal", "compendium"];
export const SECTION_ICONS = {
  character: "fa-user",
  dice: "fa-dice-d20",
  chat: "fa-comments",
  journal: "fa-book-open",
  compendium: "fa-book-atlas",
  party: "fa-sack-dollar"
};

/** The optional shared inventory module (its own folder); its panel is mounted in a "party" section. */
export const SHARED_INVENTORY_ID = "awesome-vtt-shared-inventory";

/**
 * The shared inventory module's API, when it is installed and active, else null.
 * @returns {object|null}
 */
export function sharedInventory() {
  const module = game.modules.get(SHARED_INVENTORY_ID);
  return (module?.active && module.api) ? module.api : null;
}

/**
 * The sections shown now: SECTIONS, plus "party" while the shared inventory module is active.
 * @returns {string[]}
 */
export const sectionList = () => (sharedInventory() ? [...SECTIONS, "party"] : [...SECTIONS]);

/**
 * Text made safe for HTML. Unlike foundry.utils.escapeHTML, null and undefined give "".
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/**
 * Put the cursor back at the end of a text field after a re-render (e.g. while typing a search).
 * @param {HTMLElement|null} root
 * @param {string} name
 */
export function refocus(root, name) {
  const input = root?.querySelector(`input[name="${name}"]`);
  if ( !input ) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * Mark the chosen button of a radio-like group without re-rendering (keeps typed values).
 * @param {HTMLElement} root
 * @param {string} action
 * @param {string} key
 * @param {string} value
 */
export function markChoice(root, action, key, value) {
  for ( const b of root.querySelectorAll(`[data-action="${action}"]`) ) {
    const selected = b.dataset[key] === value;
    b.classList.toggle("selected", selected);
    b.setAttribute("aria-checked", String(selected));
  }
}

/**
 * Run a button's action. Buttons whose action is in `busyActions` stay disabled (aria-busy) until it's done, so a
 * slow server doesn't invite repeated clicks (which could also make dnd5e create the same effect twice).
 * Errors are logged and shown as a notification.
 * @param {HTMLElement} target       The clicked [data-action] element.
 * @param {Set<string>} busyActions
 * @param {() => Promise<any>} run
 * @param {string} logPrefix         e.g. "awesome-vtt | Seat action"
 * @param {string} [action]          The action's name, if not in `data-action` (e.g. the shared inventory's own).
 */
export async function runAction(target, busyActions, run, logPrefix, action = target.dataset.action) {
  const busy = busyActions.has(action);
  if ( busy ) {
    if ( target.getAttribute("aria-busy") === "true" ) return;
    target.disabled = true;
    target.setAttribute("aria-busy", "true");
  }
  try {
    await run();
  } catch ( err ) {
    console.error(`${logPrefix} "${action}" failed`, err);
    ui.notifications.error(err.message);
  } finally {
    if ( busy ) {
      target.disabled = false;
      target.removeAttribute("aria-busy");
    }
  }
}

/**
 * Run a task that two controls share (e.g. Enter and a button), ignoring calls while it's running.
 * @param {(...args: any[]) => Promise<unknown>} task
 * @returns {(...args: any[]) => Promise<unknown>}
 */
export function exclusive(task) {
  let running = false;
  return async (...args) => {
    if ( running ) return;
    running = true;
    try {
      return await task(...args);
    } finally {
      running = false;
    }
  };
}

/* -------------------------------------------- */
/*  Notices                                     */
/* -------------------------------------------- */

const NOTICE_ICONS = { warning: "fa-triangle-exclamation", damage: "fa-burst", healing: "fa-heart-pulse", roll: "fa-dice-d20" };

/**
 * Fill a dismissible notice element: an optional small name line (who it is about), an icon and main line, an
 * optional smaller line, and a close mark.
 * Classes: `<base>`, `<base>-<kind>`, `<base>-name`, `<base>-text`, `<base>-detail`, `<base>-close`.
 * @param {HTMLElement} el
 * @param {string} base  Class prefix, e.g. "avtt-notice".
 * @param {object} notice
 * @param {"warning"|"damage"|"healing"|"roll"} notice.kind
 * @param {string} notice.text
 * @param {string} [notice.detail]
 * @param {string} [notice.name]  e.g. the character who rolled.
 * @param {string} dismissLabel  Localized "tap / click to dismiss" text for screen readers.
 */
export function fillNotice(el, base, { kind, text, detail, name }, dismissLabel) {
  el.className = `${base} ${base}-${kind}`;
  el.replaceChildren();
  if ( name ) {
    const who = document.createElement("span");
    who.className = `${base}-name`;
    who.textContent = name;
    el.append(who);
  }
  const head = document.createElement("span");
  head.className = `${base}-text`;
  const icon = document.createElement("i");
  icon.className = `fa-solid ${NOTICE_ICONS[kind] ?? NOTICE_ICONS.warning}`;
  icon.setAttribute("inert", "");
  head.append(icon, ` ${text}`);
  el.append(head);
  if ( detail ) {
    const small = document.createElement("span");
    small.className = `${base}-detail`;
    small.textContent = detail;
    el.append(small);
  }
  const close = document.createElement("i");
  close.className = `fa-solid fa-xmark ${base}-close`;
  close.setAttribute("inert", "");
  el.append(close);
  el.setAttribute("aria-label", `${name ? `${name}: ` : ""}${text}${detail ? `, ${detail}` : ""}. ${dismissLabel}`);
  el.setAttribute("role", kind === "warning" ? "alert" : "status");
  el.hidden = false;
}

/** What each notice button does (fillNoticeAction), until it is used (takeNoticeAction). */
const noticeActions = new WeakMap();

/**
 * Fill or hide the button that goes with a notice (e.g. Roll damage), a sibling of the notice element (a notice is
 * itself a button, so it can't hold one). The module's click handler gets what it does with takeNoticeAction.
 * @param {HTMLButtonElement} el
 * @param {{label: string, run: Function}} [action]  Hidden without one.
 */
export function fillNoticeAction(el, action) {
  if ( !el ) return;
  el.hidden = !action;
  if ( action ) noticeActions.set(el, action.run);
  else noticeActions.delete(el);
  if ( !action ) return;
  const icon = document.createElement("i");
  icon.className = `fa-solid ${NOTICE_ICONS.damage}`;
  icon.setAttribute("inert", "");
  el.replaceChildren(icon, ` ${action.label}`);
}

/**
 * What a notice button filled by fillNoticeAction does, once: later taps get nothing.
 * @param {HTMLElement} el
 * @returns {Function|undefined}
 */
export function takeNoticeAction(el) {
  const run = noticeActions.get(el);
  noticeActions.delete(el);
  return run;
}

/**
 * Text colour for a background colour: near-black or white, whichever contrasts more (WCAG relative luminance).
 * @param {string} hex  "#rrggbb"; anything else gives near-black.
 * @returns {string}
 */
export function inkFor(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if ( !m ) return DARK_INK;
  const [r, g, b] = m.slice(1).map(h => {
    const c = parseInt(h, 16) / 255;
    return (c <= 0.03928) ? (c / 12.92) : (((c + 0.055) / 1.055) ** 2.4);
  });
  const lum = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  // Contrast with white (1.05 / (lum + 0.05)) against contrast with DARK_INK (luminance about 0.006).
  return ((1.05 / (lum + 0.05)) > ((lum + 0.05) / 0.056)) ? "#fff" : DARK_INK;
}

const DARK_INK = "#111";

/* -------------------------------------------- */
/*  Chat                                        */
/* -------------------------------------------- */

/**
 * A message as Foundry (and dnd5e, via its render hook) draws it, an <li class="chat-message">, or null.
 * @param {ChatMessage} message
 * @returns {Promise<HTMLElement|null>}
 */
export async function renderMessage(message) {
  try {
    const html = await message.renderHTML();
    html.dataset.messageId ??= message.id;
    return html;
  } catch ( err ) {
    console.error(`awesome-vtt-core | Failed to render chat message ${message.id}`, err);
    return null;
  }
}

/**
 * Bring one message in a chat log up to date after a chat hook.
 * @param {HTMLElement} log
 * @param {ChatMessage} message
 * @param {"create"|"update"|"delete"} action
 * @param {boolean} visible  Should the log show this message?
 * @returns {Promise<"added"|"replaced"|"removed"|null>}
 */
export async function syncMessage(log, message, action, visible) {
  const existing = log.querySelector(`[data-message-id="${message.id}"]`);
  if ( (action === "delete") || !visible ) {
    existing?.remove();
    return existing ? "removed" : null;
  }
  const html = await renderMessage(message);
  if ( !html ) return null;
  if ( existing ) {
    existing.replaceWith(html);
    return "replaced";
  }
  log.append(html);
  return "added";
}

/**
 * Clicks inside a rendered chat message belong to Foundry and dnd5e (their listeners come with renderHTML).
 * Only the roll breakdown toggle is handled here, as core's chat log would.
 * @param {Event} event
 * @param {HTMLElement} target
 * @param {string} messageSelector
 * @returns {boolean}  True if the click was inside a message (and must not be handled further).
 */
export function handleMessageClick(event, target, messageSelector) {
  if ( !target.closest(messageSelector) ) return false;
  if ( target.dataset.action === "expandRoll" ) {
    event.preventDefault();
    target.classList.toggle("expanded");
  }
  return true;
}

/* -------------------------------------------- */
/*  Foundry hooks                               */
/* -------------------------------------------- */

/**
 * The actor a changed document belongs to (the actor itself, or the actor of an item or effect).
 * @param {Actor|Item|ActiveEffect} doc
 * @returns {Actor|undefined}
 */
export const actorOf = doc => (doc instanceof Actor ? doc
  : doc.parent instanceof Actor ? doc.parent : doc.parent?.parent);

/**
 * Call `fn(doc)` whenever an actor, or one of its items or effects, is created, changed or deleted.
 * @param {function(Document): void} fn
 */
export function onActorDataChange(fn) {
  for ( const hook of ["updateActor", "createItem", "updateItem", "deleteItem",
    "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"] ) {
    Hooks.on(hook, doc => fn(doc));
  }
}

/**
 * Call `fn(message, action)` for created, changed and deleted chat messages.
 * @param {function(ChatMessage, string): void} fn
 */
export function onChatChange(fn) {
  Hooks.on("createChatMessage", m => fn(m, "create"));
  Hooks.on("updateChatMessage", m => fn(m, "update"));
  Hooks.on("deleteChatMessage", m => fn(m, "delete"));
}

/**
 * Core opens User Configuration on every load for a player without an assigned character. Close that startup
 * window when `applies()` says so; it can still be opened by hand later. Register during module load.
 * @param {() => boolean} applies
 */
export function closeStartupUserConfig(applies) {
  let skip = true;
  Hooks.on("renderUserConfig", app => {
    if ( !skip || (app.document !== game.user) || game.user.character || !applies() ) return;
    skip = false;
    app.close({ animate: false });
  });
  // Core renders the startup window before "ready"; allow a moment for that render to finish.
  Hooks.once("ready", () => window.setTimeout(() => skip = false, 5000));
}
