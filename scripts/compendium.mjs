/**
 * Part of awesome-vtt-core, shared by awesome-vtt and awesome-vtt-mobile.
 * Compendium search and browsing, independent of the game system.
 * Only Item and Journal compendiums the user can see are included.
 */

import { escapeHTML } from "./ui.mjs";

const TextEditor = () => foundry.applications.ux.TextEditor.implementation;

export const MIN_QUERY = 2;
const MAX_QUERY = 64;
const MAX_RESULTS = 30;
/** Entries shown per page when browsing a compendium. */
export const BROWSE_PAGE = 60;
const TYPES = ["Item", "JournalEntry"];
const TYPE_ICONS = { Item: "fa-solid fa-suitcase", JournalEntry: "fa-solid fa-book-open" };

export const cleanQuery = query => String(query ?? "").slice(0, MAX_QUERY);

const packs = () => game.packs.filter(p => TYPES.includes(p.documentName) && p.visible);
const entryUuid = (pack, e) => e.uuid ?? `Compendium.${pack.collection}.${pack.documentName}.${e._id}`;

/**
 * Where a compendium comes from: its sidebar folder, else its system, module or the world.
 * @param {CompendiumCollection} pack
 * @returns {string}
 */
function packGroup(pack) {
  if ( pack.folder ) return pack.folder.name;
  const { packageType, packageName } = pack.metadata;
  if ( packageType === "system" ) return game.system.title;
  if ( packageType === "module" ) return game.modules.get(packageName)?.title ?? packageName;
  return game.world.title;
}

/* -------------------------------------------- */
/*  Search                                      */
/* -------------------------------------------- */

/**
 * Entries whose name contains the query, across all visible compendiums; null below MIN_QUERY characters.
 * @param {string} query
 * @param {object} [options]
 * @param {string[]} [options.types]                 Document types searched (default Item and JournalEntry).
 * @param {(entry: object) => boolean} [options.filter]  Keep only index entries that pass (e.g. by item type).
 * @returns {Promise<{uuid: string, name: string, img: string, pack: string}[]|null>}
 */
export async function search(query, { types = TYPES, filter = () => true } = {}) {
  const q = cleanQuery(query).trim().toLowerCase();
  if ( q.length < MIN_QUERY ) return null;
  const results = [];
  for ( const pack of packs().filter(p => types.includes(p.documentName)) ) {
    const index = await pack.getIndex();
    for ( const e of index ) {
      if ( !e.name?.toLowerCase().includes(q) || !filter(e) ) continue;
      results.push({ uuid: entryUuid(pack, e), name: e.name, img: e.img, pack: pack.title });
      if ( results.length >= MAX_RESULTS ) break;
    }
    if ( results.length >= MAX_RESULTS ) break;
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------- */
/*  Browsing                                    */
/* -------------------------------------------- */

/**
 * All visible compendiums, grouped by origin and sorted by title.
 * @returns {{label: string, packs: {id: string, title: string, icon: string, count: number|null}[]}[]}
 */
export function listPacks() {
  const groups = new Map();
  for ( const pack of packs() ) {
    const label = packGroup(pack);
    if ( !groups.has(label) ) groups.set(label, []);
    groups.get(label).push({
      id: pack.collection,
      title: pack.title,
      icon: TYPE_ICONS[pack.documentName],
      count: pack.index.size || null
    });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => ({ label, packs: list.sort((a, b) => a.title.localeCompare(b.title)) }));
}

/**
 * One level of a compendium: its subfolders, then its entries (paged), with the folder path for a breadcrumb.
 * @param {string} packId          The compendium's collection id.
 * @param {string|null} folderId   A folder inside the compendium, or null for its top level.
 * @param {number} limit           How many entries to show.
 * @returns {Promise<object|null>} {id, title, path, folders, entries, more, total}, or null for an unknown or hidden compendium.
 */
export async function browse(packId, folderId, limit = BROWSE_PAGE) {
  const pack = game.packs.get(packId);
  if ( !pack || !TYPES.includes(pack.documentName) || !pack.visible ) return null;
  const index = await pack.getIndex();
  const folders = pack.folders ?? new foundry.utils.Collection();
  const folder = folderId ? folders.get(folderId) : null;
  const current = folder?.id ?? null;

  const path = [];
  for ( let f = folder; f; f = f.folder ) path.unshift({ id: f.id, name: f.name });

  const subfolders = folders
    .filter(f => (f.folder?.id ?? null) === current)
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name))
    .map(f => ({ id: f.id, name: f.name }));
  const entries = index
    .filter(e => ((e.folder && folders.has(e.folder)) ? e.folder : null) === current)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: pack.collection,
    title: pack.title,
    path,
    folders: subfolders,
    entries: entries.slice(0, limit).map(e => ({ uuid: entryUuid(pack, e), name: e.name, img: e.img })),
    more: entries.length > limit,
    total: entries.length
  };
}

/* -------------------------------------------- */
/*  Preview                                     */
/* -------------------------------------------- */

/**
 * An item's description HTML: dnd5e keeps it in `system.description.value`, SotDL in `system.description`.
 * @param {Item} item
 * @returns {string}
 */
function itemDescription(item) {
  const description = item.system?.description;
  return (typeof description === "string") ? description : (description?.value ?? "");
}

/**
 * An entry's preview: an item's description, or a journal entry's text pages.
 * @param {string} uuid
 * @returns {Promise<{uuid: string, name: string, img: string, html: string, documentName: string, type: string}|null>}
 */
export async function openEntry(uuid) {
  const doc = await fromUuid(uuid).catch(() => null);
  if ( !doc ) return null;
  let content = "";
  if ( doc.documentName === "Item" ) content = itemDescription(doc);
  else if ( doc.documentName === "JournalEntry" ) {
    content = doc.pages.contents
      .filter(p => p.type === "text")
      .map(p => `<h3>${escapeHTML(p.name)}</h3>${p.text.content ?? ""}`)
      .join("");
  }
  const html = await TextEditor().enrichHTML(content, { secrets: false, relativeTo: doc });
  return { uuid, name: doc.name, img: doc.img, html, documentName: doc.documentName, type: doc.type };
}
