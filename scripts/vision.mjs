/**
 * Part of awesome-vtt-core: what one character can see, for the phone's target list. A device without the map (the
 * phone) can't work out vision, so it asks a device that has it: the table screen, where every seated character's
 * vision is drawn. The answer follows core's own visibility test (CanvasVisibility#testVisibility), limited to that
 * character's tokens: lights that give vision, then each of its vision sources with its token's detection modes.
 *
 * Socket (core channel): `{ type: "visibleAsk", id, actorId, sceneId, tokenIds }` from a user who owns the
 * character; a device that can tell (answerVisibility) replies `{ type: "visibleTell", id, tokenIds }` with the
 * visible ones. The first reply counts; without one in time the result is null (unknown).
 */

const CHANNEL = "module.awesome-vtt-core";
const REPLY_MS = 1500;
const MAX_IDS = 200;

const pending = new Map();
let listening = false;
let answering = false;

const isIdList = list => Array.isArray(list) && (list.length <= MAX_IDS) && list.every(id => typeof id === "string");

function listen() {
  if ( listening ) return;
  listening = true;
  game.socket.on(CHANNEL, (data, senderId) => {
    if ( (data?.type === "visibleTell") && pending.has(data.id) && isIdList(data.tokenIds) ) {
      pending.get(data.id)(data.tokenIds);
      return;
    }
    if ( (data?.type !== "visibleAsk") || !answering || (typeof data.id !== "string") || !isIdList(data.tokenIds) ) return;
    const user = game.users.get(senderId);
    const actor = game.actors.get(data.actorId);
    if ( !user || !actor?.testUserPermission(user, "OWNER") ) return;
    const ids = visibleHere(actor, data.sceneId, data.tokenIds);
    if ( ids ) game.socket.emit(CHANNEL, { type: "visibleTell", id: data.id, tokenIds: ids });
  });
}

/** Answer other devices' questions from this one's map (the table screen). */
export function answerVisibility() {
  answering = true;
  listen();
}

/**
 * The ids among `tokenIds` that the character's own tokens can see on this device's map, or null when this device
 * can't tell (no map, another scene, or no vision source of that character here).
 * @param {Actor} actor
 * @param {string} sceneId
 * @param {string[]} tokenIds
 * @returns {string[]|null}
 */
export function visibleHere(actor, sceneId, tokenIds) {
  if ( !canvas?.ready || (canvas.scene?.id !== sceneId) || !actor ) return null;
  const visibility = canvas.visibility;
  if ( !visibility?.tokenVision ) return [...tokenIds];
  if ( typeof visibility._createVisibilityTestConfig !== "function" ) return null;
  const sources = canvas.effects.visionSources.filter(s => s.active && !s.isBlinded && (s.object?.document?.actorId === actor.id));
  if ( !sources.length ) return null;
  const lights = canvas.effects.lightSources.filter(l => l.active && l.data?.vision);
  const modes = CONFIG.Canvas.detectionModes;
  return tokenIds.filter(id => {
    const token = canvas.tokens.get(id);
    if ( !token || token.document.hidden ) return false;
    if ( token.document.actorId === actor.id ) return true;
    const config = visibility._createVisibilityTestConfig(token.document.getVisibilityTestPoints(), { tolerance: 0, object: token });
    if ( lights.some(light => light.testVisibility(config) === true) ) return true;
    return sources.some(source => Object.entries(source.object.document.detectionModes ?? {})
      .some(([mode, data]) => modes[mode]?.testVisibility(source, data, config) === true));
  });
}

/**
 * What the character can see among `tokenIds` on a scene: from this device's map if it can tell, otherwise asked of
 * the other devices. Resolves null when nobody could tell in time.
 * @returns {Promise<string[]|null>}
 */
export function visibleTokenIds(actor, sceneId, tokenIds) {
  const here = visibleHere(actor, sceneId, tokenIds);
  if ( here ) return Promise.resolve(here);
  if ( !actor || !game.socket ) return Promise.resolve(null);
  listen();
  const asked = new Set(tokenIds);
  const id = foundry.utils.randomID();
  return new Promise(resolve => {
    const done = ids => {
      window.clearTimeout(timer);
      pending.delete(id);
      resolve(ids ? ids.filter(t => asked.has(t)) : null);
    };
    const timer = window.setTimeout(() => done(null), REPLY_MS);
    pending.set(id, done);
    game.socket.emit(CHANNEL, { type: "visibleAsk", id, actorId: actor.id, sceneId, tokenIds: [...asked].slice(0, MAX_IDS) });
  });
}
