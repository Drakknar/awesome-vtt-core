/**
 * Part of awesome-vtt-core: helpers that don't depend on the game system, used by the system adapters
 * (dnd5e.mjs, demonlord.mjs) and through them by the table and phone modules.
 */

const loc = key => (key ? game.i18n.localize(key) : "");

export const MAX_QUANTITY = 9999;
export const MAX_CURRENCY = 9999999;

/** Sort by name. */
export const byName = (a, b) => a.name.localeCompare(b.name);

/** A number with its sign, e.g. "+2" or "-1". */
export const signed = n => (n >= 0 ? `+${n}` : `${n}`);

const MAX_HP_INPUT = 999;

/** A typed HP amount as a whole number from 0 to 999 (0 when not a number). */
export function hpAmount(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.clamp(n, 0, MAX_HP_INPUT) : 0;
}

/** Change an item's quantity by one (kept from 0 to MAX_QUANTITY). */
export function changeQuantity(actor, itemId, delta) {
  const item = actor.items.get(itemId);
  if ( !item || !("quantity" in item.system) ) return;
  const n = Math.clamp((item.system.quantity ?? 0) + Math.sign(delta), 0, MAX_QUANTITY);
  return item.update({ "system.quantity": n });
}

/* -------------------------------------------- */
/*  Effects                                     */
/* -------------------------------------------- */

/**
 * Effects a player switches on and off (e.g. Rage, Bladesong): effects on the actor or its items that are disabled,
 * timed, or were toggled this session. Conditions, concentration and enchantments are left out.
 */
export function getToggleEffects(actor, toggled) {
  const list = [];
  for ( const effect of actor.allApplicableEffects() ) {
    if ( effect.statuses?.size || (effect.type === "enchantment") || effect.isConcealed ) continue;
    if ( !(effect.disabled || effect.isTemporary || toggled.has(effect.uuid)) ) continue;
    list.push({
      uuid: effect.uuid,
      name: effect.name,
      img: effect.img,
      source: (effect.parent && (effect.parent !== actor)) ? effect.parent.name : "",
      active: !effect.disabled
    });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pending effect changes per actor (conditions, exhaustion, toggled effects, ending concentration), applied one after
 * another on this device, so two changes never work from the same stale state.
 */
const effectQueue = new WeakMap();

export function queueEffects(actor, task) {
  const next = (effectQueue.get(actor) ?? Promise.resolve()).then(task, task);
  effectQueue.set(actor, next.catch(() => {}));
  return next;
}

/**
 * Run an effect change that another device (e.g. the table screen and a phone, both owning the character) may have
 * made at the same moment. Foundry then reports "already exists" or "does not exist"; either way the effect is
 * already in the state that was asked for, so it's treated as done.
 */
export async function raceTolerant(change) {
  try {
    return await change();
  } catch(err) {
    if ( /already exists|does not exist/i.test(err?.message ?? "") ) {
      console.debug("awesome-vtt-core | Effect already changed elsewhere:", err.message);
      return null;
    }
    throw err;
  }
}

/** Resolve once `test()` is true, or after `timeout` ms. */
export function waitFor(test, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const tick = () => (test() || (Date.now() - start > timeout)) ? resolve() : window.setTimeout(tick, 50);
    tick();
  });
}

/** Switch an effect of this actor (or one of its items) on or off. */
export function toggleEffect(actor, uuid) {
  const initial = fromUuidSync(uuid, { strict: false });
  if ( !initial ) return;
  const disabled = !initial.disabled;
  return queueEffects(actor, async () => {
    // Read it again: it may have expired or been removed since the tap.
    const effect = fromUuidSync(uuid, { strict: false });
    const owner = (effect?.parent === actor) || (effect?.parent?.parent === actor);
    if ( !effect || !owner || (effect.disabled === disabled) ) return;
    await raceTolerant(() => effect.update({ disabled }));
  });
}

/** The actor a chat message is about: its associated actor, or the speaker's. */
export const messageActor = message => message.getAssociatedActor?.() ?? ChatMessage.getSpeakerActor(message.speaker);

/* -------------------------------------------- */
/*  Roll results                                */
/* -------------------------------------------- */

/**
 * Call `fn(result)` for each roll this user makes (any dice: Foundry's, physical dice entered, sheet or dice pool),
 * once the result may be shown: after Dice So Nice's animation, if it animates the roll, so the notice doesn't give
 * the result away early. Blind rolls, whose result the roller doesn't see, are skipped. Messages without dice are
 * passed to the adapter too: SotDL's cards for a spell, talent or item used without an attack roll (see its
 * summarizeRoll); dnd5e's summarizeRoll skips them. Register once.
 * @param {function(ReturnType<typeof summarizeRoll>, ChatMessage): void} fn
 * @param {object} [options]
 * @param {boolean} [options.shared]  A screen everyone at the table can read (see summarizeRoll).
 * @param {function(ChatMessage, object): object|null} options.summarize  The system adapter's summarizeRoll.
 * @param {function(ChatMessage): boolean} [options.enabled]  Checked first, so turned-off notices cost nothing.
 * @param {function(ChatMessage): boolean} [options.others]  Also take this roll made by another user (e.g. the table
 *   screen shows the rolls its seated characters make on their phones). `fn` can tell them by `message.isAuthor`.
 */
export function onRollResult(fn, { shared = false, summarize, enabled = () => true, others = () => false } = {}) {
  Hooks.on("createChatMessage", message => {
    if ( !message.isContentVisible || !enabled(message) ) return;
    if ( !message.isAuthor && !others(message) ) return;
    afterDiceAnimation(message).then(() => {
      const result = summarize(message, { shared });
      if ( result ) fn(result, message);
    });
  });
}

const DICE_ANIMATION_LIMIT = 15000;

/** Wait for Dice So Nice's animation of a message, if any (at most DICE_ANIMATION_LIMIT ms). */
async function afterDiceAnimation(message) {
  const dice3d = game.dice3d;
  if ( !message.isRoll || (typeof dice3d?.waitFor3DAnimationByMessageID !== "function") ) return;
  // Dice So Nice marks the message as animating in its own createChatMessage hook, which may run after this one.
  await new Promise(resolve => window.setTimeout(resolve, 0));
  await Promise.race([
    dice3d.waitFor3DAnimationByMessageID(message.id),
    new Promise(resolve => window.setTimeout(resolve, DICE_ANIMATION_LIMIT))
  ]);
}

/** The body of chat HTML, parsed in an inert document (nothing in it loads or runs). */
export const parseHTML = html => new DOMParser().parseFromString(String(html ?? ""), "text/html").body;

/** Plain text of chat HTML (see parseHTML). */
export const plainText = html => parseHTML(html).textContent.trim();

/**
 * A roll result as a notice for the core's fillNotice(): "12 damage" / "8 healing" with the item and the split by
 * type, or "17" followed by what applies of "Critical" / "Fumble", "Pass" / "Fail" and "Hit" / "Miss" (or
 * "2 hit, 1 missed" against several targets), with what was rolled; or, for something used without a roll
 * (`kind: "use"`), its name.
 * @param {ReturnType<typeof summarizeRoll>} result
 * @param {(id: string) => string} labelKey  The module's label key for "damage", "healing", "critical", "fumble",
 *   "success", "failure", "hit", "miss" and "hitCount" (formatted with {hit, miss}).
 * @returns {{kind: string, text: string, detail: string}}
 */
export function rollNotice({ kind, total, title, breakdown, natural, outcome, hits }, labelKey) {
  // Something used without a roll (SotDL): its name, drawn as a roll notice.
  if ( kind === "use" ) return { kind: "roll", text: title, detail: "" };
  if ( kind !== "roll" ) {
    return { kind, text: `${total} ${loc(labelKey(kind))}`, detail: [title, breakdown].filter(Boolean).join(" · ") };
  }
  const words = [natural, outcome].filter(Boolean).map(id => loc(labelKey(id)));
  if ( hits ) {
    const single = (hits.hit + hits.miss) === 1;
    words.push(single ? loc(labelKey(hits.hit ? "hit" : "miss")) : game.i18n.format(labelKey("hitCount"), hits));
  }
  return { kind, text: [`${total}`, ...words].join(" · "), detail: title };
}
