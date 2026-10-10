# Awesome VTT – Core

A library module with the code shared by [Awesome VTT](../awesome-vtt) (table mode) and [Awesome VTT – Phone Companion](../awesome-vtt-mobile). It does nothing on its own. Foundry enables it when either of those modules is enabled, because both declare it as required.

- **Targets:** Foundry VTT v14 and dnd5e 6.0.x (built against 6.0.5).

## Game systems

`scripts/system.mjs` picks the adapter for the world's system: `dnd5e.mjs` or `demonlord.mjs` (Shadow of the Demon Lord), which have the same interface. The modules import `system.mjs` (`import sys from …/system.mjs`) and call `sys.getSummary(actor)` and the rest, so they stay system-neutral. `common.mjs` holds helpers that don't depend on the system (effect queue, toggleable effects, roll result notices, quantities, the HP amount field).

## Contents

```
module.json          library module ("library": true)
lang/en.json         labels used by the shared code (prefix AVTTC.)
scripts/
  dnd5e.mjs          dnd5e adapter: character summary, actions, abilities, skills, inventory, quick actions,
                     rolls (checks, saves, death and concentration saves, activity saves, GM requests),
                     initiative (no dialog, with the Next roll choice), the HP field (damage / heal / temp), level-up info and opening a level-up window (Hero Mancer's, or the sheet), which activities need targets, checks before use
                     (spell slots, uses), damage / healing roll totals, the Spells tab (every spell, preparing),
                     rolling an attack's damage right after the attack roll, and moving coins and items between
                     actors (used by the shared inventory module)
  sheet.mjs          the compact sheet and quick actions: tabs and per-tab data, button actions (rolls, rests,
                     conditions, exhaustion, concentration, effects, uses, slots, inventory), item descriptions,
                     and chat (All / Mine filter, which messages a log shows, sending)
  prompts.mjs        automation prompts (death saves, concentration, saves, GM requests, initiative) and their
                     queue; answering one closes it on the player's other devices (the core's socket)
  dice.mjs           the Dice panel (pool, formula, real or Foundry dice, roll), advantage modes and their
                     choice list, and the Physical dice default method
  panels.mjs         state and actions of the Compendium and Journal panels
  ui.mjs             the shared sections (character, dice, chat, journal, compendium; party with the shared
                     inventory module) and their icons, busy buttons, notices, chat message rendering and updates, focus and escaping helpers,
                     actor / chat hook helpers, closing the startup User Configuration window
  journal.mjs        journals the user can view, page rendering, and recently shared handouts
  compendium.mjs     compendium search, browsing (packs, folders, entries) and previews
  wake-lock.mjs      keeps the screen on (Screen Wake Lock API)
```

The other modules import these files by relative path, for example `../../awesome-vtt-core/scripts/dnd5e.mjs`. That keeps working when Foundry is served under a URL prefix.

Templates and styles are not shared: each module has its own layout and class prefix (`avtt-`, `avttm-`). The shared UI code works on each module's markup: the modules pass their own class names and elements (e.g. `fillNotice(el, "avtt-notice", …)`), and both use the same `data-action` names for shared panels (`comp…`, `journal…`, `dice…`, `rollAbility`, `rollSave`, `rollSkill`, `deathSave`, `invDetails`, `invQty`, `invEquip`, `invAttune`, `usesAdjust`, `slotAdjust`, `toggleCondition`, `toggleInspiration`, `shortRest`, `longRest`, `spellPrepare`, `invToParty`).

The optional [Shared Inventory](../awesome-vtt-shared-inventory) module is found through `sharedInventory()` in `ui.mjs` (its API, or null), so neither module needs it.
