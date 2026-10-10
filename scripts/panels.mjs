import * as compendium from "./compendium.mjs";
import * as journal from "./journal.mjs";
import { refocus } from "./ui.mjs";

/**
 * The state and actions of the Compendium and Journal panels, shared by the table seats and the phone app.
 * Each module draws the panel with its own template: it passes `render()` (draw the panel from `context()`) and
 * `root()` (the element holding the panel, to put the cursor back in its search field).
 * Actions come from buttons with the same data-action names in both modules' templates.
 */

const DEBOUNCE_MS = 250;

export class CompendiumPanel {
  /** Actions handled by `handle()`. */
  static ACTIONS = new Set(["compSearch", "compClear", "compBrowse", "compMore", "compOpen", "compBack", "compOpenSheet"]);

  /**
   * @param {object} options
   * @param {() => Promise<void>} options.render
   * @param {() => HTMLElement|null} options.root
   */
  constructor({ render, root }) {
    this.render = render;
    this.root = root;
    // Live search: runs shortly after typing stops.
    this.searchSoon = foundry.utils.debounce(() => this.search({ live: true }), DEBOUNCE_MS);
  }

  query = "";
  results = null;
  entry = null;
  searching = false;
  browsing = { pack: null, folder: null, limit: compendium.BROWSE_PAGE };

  /** Increases with each search, so a slower earlier search can't replace newer results. */
  #searchId = 0;

  /** Template data: the search, its results or open entry, or (with an empty search box) the browser. */
  async context() {
    const { query, results, entry, searching } = this;
    return { query, results, entry, searching, short: query.trim().length < compendium.MIN_QUERY, ...(await this.#browser()) };
  }

  /** With an empty search box, the compendium list or the open compendium (folder) is shown. */
  async #browser() {
    if ( this.query || this.entry ) return {};
    const b = this.browsing;
    if ( b.pack ) {
      const pack = await compendium.browse(b.pack, b.folder, b.limit);
      if ( pack ) return { pack };
      b.pack = b.folder = null;
    }
    return { packs: compendium.listPacks() };
  }

  /** Typing in the search field. */
  onInput(value) {
    this.query = compendium.cleanQuery(value);
    this.searchSoon();
  }

  /**
   * Search Item and Journal compendiums by name, from MIN_QUERY characters on.
   * @param {object} [options]
   * @param {boolean} [options.live]  Typing: keep the previous results (and the cursor) until the new ones are ready.
   */
  async search({ live = false } = {}) {
    const query = compendium.cleanQuery(this.query);
    const id = ++this.#searchId;
    if ( query.trim().length < compendium.MIN_QUERY ) {
      Object.assign(this, { results: null, searching: false });
      return live ? this.#renderKeepFocus() : this.render();
    }
    this.entry = null;
    if ( !live ) {
      this.searching = true;
      await this.render();
    }
    const results = await compendium.search(query);
    if ( id !== this.#searchId ) return;
    Object.assign(this, { results, searching: false });
    return live ? this.#renderKeepFocus() : this.render();
  }

  async #renderKeepFocus() {
    await this.render();
    refocus(this.root(), "compQuery");
  }

  /** Run a compendium action from a [data-action] button. */
  async handle(action, target) {
    const data = target.dataset;
    switch ( action ) {
      case "compSearch": return this.search();
      case "compClear":
        // Back to browsing, with the cursor ready for a new search.
        this.#searchId++;
        Object.assign(this, { query: "", results: null, searching: false });
        return this.#renderKeepFocus();
      case "compBrowse":
        // A compendium, or a folder inside it; without a pack, back to the list of compendiums.
        this.browsing = { pack: data.pack || null, folder: data.folder || null, limit: compendium.BROWSE_PAGE };
        return this.render();
      case "compMore": this.browsing.limit += compendium.BROWSE_PAGE; return this.render();
      case "compOpen": {
        const entry = await compendium.openEntry(data.uuid);
        if ( !entry ) return;
        this.entry = entry;
        return this.render();
      }
      case "compBack": this.entry = null; return this.render();
      case "compOpenSheet": return (await fromUuid(this.entry?.uuid))?.sheet?.render({ force: true });
    }
  }
}

/* -------------------------------------------- */

export class JournalPanel {
  /** Actions handled by `handle()`. */
  static ACTIONS = new Set(["journalOpen", "journalPage", "journalShared", "journalBack", "journalFull"]);

  /**
   * @param {object} options
   * @param {() => Promise<void>} options.render
   * @param {() => HTMLElement|null} options.root
   */
  constructor({ render, root }) {
    this.render = render;
    this.root = root;
    this.renderSoon = foundry.utils.debounce(async () => {
      await this.render();
      refocus(this.root(), "journalQuery");
    }, DEBOUNCE_MS);
  }

  /** The open entry and page, or a shared image; none means the list. */
  uuid = null;
  pageId = null;
  image = null;
  query = "";

  /** Is the list of journals shown (rather than an entry or image)? */
  get showsList() {
    return !this.uuid && !this.image;
  }

  async context() {
    const context = { query: this.query };
    if ( this.uuid ) context.entry = await journal.getEntry(this.uuid, this.pageId);
    else if ( this.image ) context.image = this.image;
    if ( !context.entry && !context.image ) {
      this.uuid = null;
      context.shared = journal.getShared();
      context.entries = journal.getEntries(this.query);
    }
    return context;
  }

  /** Typing in the filter field. */
  onInput(value) {
    this.query = journal.cleanQuery(value);
    this.renderSoon();
  }

  #show(uuid, image = null) {
    Object.assign(this, { uuid, pageId: null, image });
    return this.render();
  }

  /** Run a journal action from a [data-action] button. */
  async handle(action, target) {
    const data = target.dataset;
    switch ( action ) {
      case "journalOpen": return this.#show(data.uuid);
      case "journalPage": this.pageId = data.pageId; return this.render();
      case "journalShared": {
        // Something the GM showed to players (an entry, a page or an image).
        const item = journal.getSharedItem(data.index);
        if ( !item ) return;
        return (item.kind === "image") ? this.#show(null, item) : this.#show(item.uuid);
      }
      case "journalBack": return this.#show(null);
      case "journalFull": return journal.openFullEntry(data.uuid, data.pageId);
    }
  }
}
