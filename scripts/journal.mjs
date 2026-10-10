/**
 * Part of awesome-vtt-core, shared by awesome-vtt and awesome-vtt-mobile.
 * Journals and handouts, independent of the game system.
 * Lists the journal entries the current user may observe, renders their pages, and remembers what the GM shared
 * recently ("Show to players" on entries, pages and images).
 */

const TextEditor = () => foundry.applications.ux.TextEditor.implementation;

const MAX_SHARED = 10;
const MAX_QUERY = 64;

/** @type {{kind: "entry"|"image", uuid?: string, image?: string, title: string, caption?: string, time: number}[]} */
const shared = [];

/**
 * Listen to core's share events next to core's own handlers, which still open their usual windows.
 * @param {function} onChange  Called after the shared list changes.
 */
export function activateShareListeners(onChange) {
  game.socket.on("showEntry", async uuid => {
    if ( typeof uuid !== "string" ) return;
    const doc = await fromUuid(uuid).catch(() => null);
    if ( !doc ) return;
    remember({ kind: "entry", uuid, title: doc.name ?? "" });
    onChange();
  });
  game.socket.on("shareImage", config => {
    const image = typeof config?.image === "string" ? config.image : "";
    if ( !image ) return;
    if ( Array.isArray(config.users) && config.users.length && !config.users.includes(game.user.id) ) return;
    remember({
      kind: "image",
      image,
      title: String(config.title ?? "").slice(0, 200),
      caption: String(config.caption ?? "").slice(0, 500)
    });
    onChange();
  });
}

function remember(item) {
  const key = item.uuid ?? item.image;
  const existing = shared.findIndex(s => (s.uuid ?? s.image) === key);
  if ( existing >= 0 ) shared.splice(existing, 1);
  shared.unshift({ ...item });
  shared.length = Math.min(shared.length, MAX_SHARED);
}

export const getShared = () => shared.map((s, index) => ({ ...s, index }));
export const getSharedItem = index => shared[Number(index)] ?? null;

export const cleanQuery = query => String(query ?? "").slice(0, MAX_QUERY);

/** Entries the user may observe, filtered by name and sorted by folder then name. */
export function getEntries(query = "") {
  const q = cleanQuery(query).trim().toLowerCase();
  return game.journal
    .filter(e => e.visible && (!q || e.name.toLowerCase().includes(q)))
    .map(e => ({ uuid: e.uuid, name: e.name, folder: e.folder?.name ?? "" }))
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
}

/** An entry with its observable pages; the first page (or the requested one) is rendered. */
export async function getEntry(uuid, pageId = null) {
  const entry = await fromUuid(uuid).catch(() => null);
  if ( !(entry instanceof foundry.documents.JournalEntry) || !entry.visible ) return null;
  const pages = entry.pages.contents
    .filter(p => p.testUserPermission(game.user, "OBSERVER"))
    .sort((a, b) => a.sort - b.sort);
  const page = pages.find(p => p.id === pageId) ?? pages[0] ?? null;
  return {
    uuid: entry.uuid,
    name: entry.name,
    pages: pages.map(p => ({ id: p.id, name: p.name, active: p === page })),
    page: page ? await renderPage(page) : null
  };
}

/** Page content: enriched text, an image, or a button to open other page types in the full journal. */
async function renderPage(page) {
  const base = { id: page.id, name: page.name };
  switch ( page.type ) {
    case "text":
      return { ...base, html: await TextEditor().enrichHTML(page.text?.content ?? "", { secrets: page.isOwner, relativeTo: page }) };
    case "image":
      return { ...base, image: page.src, caption: page.image?.caption ?? "" };
    default:
      return { ...base, external: true };
  }
}

/** Open an entry in its full sheet, e.g. for PDF or video pages. */
export async function openFullEntry(uuid, pageId) {
  const entry = await fromUuid(uuid).catch(() => null);
  if ( entry instanceof foundry.documents.JournalEntry ) return entry.sheet.render({ force: true, pageId });
}
