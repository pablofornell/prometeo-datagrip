# UX parity audit: shell (main window, toolbar, tool windows, tabs, status bar, menus, popups, navigation, settings, themes, global keymap)

Auditor: shell group. Date 2026-11-07. Compared docs/ux/screens/* (DataGrip 2026.3) with docs/ux/app-screens/* (release binary), and checked the code in src/ (HEAD of feat/ux-parity, no changes made).
I took extra browser-mock captures (vite :1441, headless Chromium) in both themes to check light/dark parity of popups and dialogs. They are not copied into app-screens because they use mock data. They are in /tmp/claude-1000/audit-shell/pw/ (main, File menu, menu-bar hover, Search Everywhere, Settings, Ctrl+E; `-dark`/`-light`).

**Overall:** the theme tokens match closely. dark.css and light.css define the same 299 tokens. Sampled pixels match DataGrip in both themes: window bg #26282C/#E9EAEE, islands #191A1C/#FFFFFF, toolbar tint, visible tool-window button #393A3E/#D9D9DD (68px pair, same as DataGrip), and tab pills. Light has no visual breakage in menus, Search Everywhere or Settings.
The gaps are functional: missing tool windows (Files, Services, Notifications), no split editor, no Recent Files/Switcher, main-menu items that are disabled stubs, an incomplete menu structure, a read-only keymap and a thin Settings tree.

---

## High

### SHELL-01 Edit and Code main-menu items are permanently disabled  — Impact: High  — Effort: M
- Area: main menu, action registry
- DataGrip reference: docs/ux/screens/126-main-menu-edit-dark.png (Undo Typing preselected and enabled, Cut/Copy/Paste enabled with focus in editor)
- Ours now: docs/ux/app-screens/126-main-menu-edit-dark.png: every Edit item is grey. Cause: `src/state/core-actions.ts` registers `edit.undo/redo/cut/copy/paste/selectAll/find/replace` and `code.complete/reformat/comment` as **stubs without `run`**. No module ever registers an implementation (grep: only core-actions defines these ids), so `isActionEnabled` is always false. The whole Code menu is therefore disabled too. The shortcuts still work only because CodeMirror and the grid handle the keys themselves.
- Should: register real actions that dispatch to the focused component. CodeMirror view → `undo`/`redo`/`cut`/`copy`/`paste`/`selectAll`/`openSearchPanel`/replace/`startCompletion`/reformat/`toggleLineComment`. Grid → copy/paste/select all. Text inputs → `document.execCommand`. Use `enabled()` from focus plus state, so Undo is disabled with an empty undo stack and Cut/Copy are disabled with no selection where DataGrip does that. Label Undo as "Undo Typing" when the last change was typing (DataGrip shows "Undo <command>").
  - Do not register a global shortcut for these. The component keeps the key, and the menu shows the shortcut only. This avoids double handling: add a `menuOnly` flag or a `when` guard to the dispatcher.
- Files: src/state/core-actions.ts, src/state/actions.ts (menu-only shortcut flag), src/components/editor/commands.ts, src/components/editor/SqlEditor.tsx, src/components/grid/DataGrid.tsx

### SHELL-02 Main menu structure and contents differ from DataGrip (no Run menu, extra Code/Tools, missing in-scope items)  — Impact: High  — Effort: M
- Area: main menu (hamburger → inline bar)
- DataGrip reference: 93-main-menu-file-dark.png, 126-main-menu-{edit,view,navigate,run,window}-dark.png, 127-view-tool-windows-submenu-dark.png; GAP-CAPTURES row 126
- Ours now: bar = File Edit View Navigate Code Tools Window Help (src/components/shell/menus.ts).
  - File has 7 items. View has 4. Navigate has 6. There is no Run menu: Execute, Cancel and Commit live under a non-existent "Tools" menu. Window has Restore Default Layout, tab cycling and Minimize/Maximize. Help has About only.
- Should: bar `File Edit View Navigate Run Window Help` (VCS out of scope). Show only operative items and leave out-of-scope ones out entirely:
  - **File:** New › (Query Console Ctrl+Shift+Q, Data Source ›, Scratch File Ctrl+Alt+Shift+Insert once SHELL-05 exists) / Open… / Save As… Ctrl+Shift+S (when files exist) / sep / Settings… Ctrl+Alt+S, Data Sources… Ctrl+Alt+Shift+S / sep / SQL Dialects…, SQL Resolution Scopes… (only if built) / sep / Save All Ctrl+S, Reload All from Disk Ctrl+Alt+Y / sep / Export › / Print… (optional) / sep / Exit. Move "Close Tab"/"Close All Tabs" to Window › Editor Tabs (DataGrip has no close items in File).
  - **Edit:** Undo / Redo / sep / Cut, Copy, Copy Path/Reference…, Paste ›, Delete / sep / Find › (Find… Ctrl+F, Replace… Ctrl+R, Find Usages Alt+F7 if built) / sep / Insert Live Template… Ctrl+J, Surround With… Ctrl+Alt+Shift+B (if editor has them) / sep / Reformat Code Ctrl+Alt+L, Comment with Line Comment Ctrl+/, Comment with Block Comment Ctrl+Shift+/ / sep / Toggle Case Ctrl+Shift+U, Join Lines Ctrl+Shift+J, Duplicate Entire Lines, Sort Lines. Order and separators as in 126-main-menu-edit. Code items go here, and the "Code" menu goes away.
  - **View:** Tool Windows › (first, preselected) / Appearance › / sep / Recent Locations Ctrl+Shift+E, Recent Files Ctrl+E, Recently Changed Files / sep / Increase / Decrease / Reset Font Size in All Editors (Alt+Shift+. / Alt+Shift+Comma; wire to settings.editorFontSize).
  - **Navigate:** Back Ctrl+Alt+Left, Forward Ctrl+Alt+Right / sep / Search Everywhere Shift Shift / sep / Database Object… Ctrl+N, File… Ctrl+Shift+N, Text… Ctrl+Alt+Shift+E / sep / Select In… Alt+F1, Declaration or Usages Ctrl+B, Scroll from Editor, Edit Data F4 / sep / Next Statement Alt+Down, Previous Statement Alt+Up. Move Next/Previous Tab to Window › Editor Tabs.
  - **Run:** Execute Ctrl+Enter, Export Data to File / sep / Run '<file>' Ctrl+Shift+F10, Edit Configurations… (other group's run configs) / sep / Compare Data (if built), Full-Text Search… Ctrl+Alt+Shift+F / sep / Import Data from File(s)…. Cancel / Commit / Roll back / Query History also fit here.
  - **Window:** Layouts › (Restore Default Layout, Save Current Layout as…) / Active Tool Window › (Hide Shift+Escape, Maximize Ctrl+Shift+', Move To ›, Resize ›) / Editor Tabs › (Split Right, Split Down, Unsplit, Close Ctrl+F4, Close Other Tabs, Close All Tabs, Reopen Closed Tab, Pin Tab, Select Next/Previous Tab Alt+Right/Alt+Left) / Notifications › (Show all, Expire All).
  - **Help:** Keymap Reference, Find Action… Ctrl+Shift+A, About.
  - Submenus show ›. The first item is preselected when a menu opens from the keyboard (DataGrip preselects it on hamburger open too).
- Files: src/components/shell/menus.ts, src/state/core-actions.ts, src/state/layout.ts

### SHELL-03 No split editor (Split Right / Split Down)  — Impact: High  — Effort: L
- Area: editor area, tab strip
- DataGrip reference: 133-split-editor-dark.png, 113-editor-tab-context-menu-dark.png (Split Right / Split Down), GAP-CAPTURES row 133
- Ours now: MISSING. `EditorArea.tsx` has a single `Tabs` strip and one view per tab. There is no split action in the menus or the keymap. Search Everywhere's "Open In Right Split" cannot exist.
- Should: the editor island holds a tree of splitters. Each pane has its own pill tab strip, its own ⋮, and the full console toolbar.
  - Panes are divided by a 1px vertical (or horizontal) line in `--dg-border`, inside one island.
  - Split Right / Split Down open the same tab in a new pane, and the new pane gets focus (its tab uses the focused-selected style, the old one inactive-selected).
  - Closing the last tab of a pane removes the split. Also add Unsplit / Unsplit All, Move Tab to Opposite Group, and Shift+Enter in Search Everywhere / Recent Files to "Open In Right Split".
  - The same console open in two panes must share one document (one CodeMirror state or synced transactions), with run inlays per pane as in DataGrip.
  - Entry points: tab context menu, Window › Editor Tabs, keymap (no default shortcut in DataGrip).
- Files: src/components/shell/EditorArea.tsx, src/state/tabs.ts (panes/groups model), src/components/ui/Tabs.tsx, src/components/ui/Splitter.tsx, src/features/console/ConsoleView.tsx

### SHELL-04 No Recent Files (Ctrl+E) and no Switcher (Ctrl+Tab)  — Impact: High  — Effort: M
- Area: navigation popups, global keymap
- DataGrip reference: 124-recent-files-ctrl-e-dark.png, GAP-CAPTURES row 124
- Ours now: MISSING. Ctrl+E and Ctrl+Tab are not bound anywhere (grep `Ctrl+E"`, `Ctrl+Tab`: no hits).
- Should: popup centered over the editor, 540x445 (ref x 529–1068, y 259–702), bg `--dg-popup-bg`, border `--dg-popup-border`, radius 8.
  - Header 40px: bold "Recent Files" + checkbox "Show edited only Ctrl+E" at the right. Pressing Ctrl+E again toggles it.
  - Left column (215px): tool windows with their shortcuts (Database Explorer Alt+1, Files Alt+4, Database Output Alt+8, Services, Notifications, …; only the ones that exist), 24px rows. Footer link "Recent Locations Ctrl+Shift+E".
  - Right column: recently activated tabs (MRU order), each row `[icon] title` + grey path or `[data source]`. The **second** entry is preselected so Ctrl+E, Enter switches to the previous tab. The selected row has a split-open icon at its right end (opens in right split, SHELL-03).
  - Bottom strip: full path of the selected entry.
  - Typing starts speed search with an orange match highlight. Esc closes. Arrow keys move, Left/Right switch columns.
  - Ctrl+Tab opens the same list as a hold-to-switch Switcher: release Ctrl to open the selection, Tab/Shift+Tab move.
  - Keep an MRU stack in tabs.ts, including recently closed consoles, which reopen on Enter.
- Files: src/state/tabs.ts (MRU), new src/features/navigate/RecentFiles.tsx (reuse navigate.css list styles and SpeedSearch), src/features/navigate/index.ts (actions `nav.recentFiles` Ctrl+E, `nav.switcher` Ctrl+Tab)

### SHELL-05 No Files tool window, no scratch files, no opening .sql files  — Impact: High  — Effort: L
- Area: tool windows, editor tabs, backend
- DataGrip reference: 125-files-toolwindow-dark.png, 103-run-sql-script-target-chooser-dark.png, GAP-CAPTURES rows 103/125; datagrip-map §9 (Alt+4)
- Ours now: MISSING.
  - TOOL_WINDOWS (src/state/layout.ts) = explorer + output only. `TabKind` = console | table | ddl, so a tab cannot hold a file.
  - The Tauri commands include console CRUD (`list_consoles/read_console/write_console/create_console/delete_console/rename_console`) but no file or scratch commands.
  - There is no File › Open, no Ctrl+Alt+Shift+Insert (New Scratch File), and no Alt+4.
- Should: a Files tool window (Alt+4, toolbar folder button, docks RIGHT of the editor as its own island).
  - Header "Files ⌄" view switcher, plus actions new folder / Select Opened File / Expand All / Collapse All / ⋮ / Hide.
  - Tree: "Scratches and Consoles" › "Database Consoles" › <data source> › `console.sql [ds]` (grey bracket suffix), and "Scratches" › scratch files. Optionally attached directories (File › Open… / Attach Directory).
  - Scratch file = `.sql` file with a dialect and a target data source chosen on first run (the run target chooser is the run-config auditor's item).
  - Opening a file creates a `file` tab kind that uses the console editor (with Ctrl+S / autosave). Status bar path becomes "Scratches › scratch.sql".
  - Backend: list/read/write/create/rename/delete for scratch files under the data dir, plus a native open dialog for arbitrary .sql files.
- Files: src/state/layout.ts, src/state/tabs.ts, new src/features/files/*, src/api/db.ts + src/api/mock.ts, src-tauri/src (new commands), src/components/shell/MainToolbar.tsx

### SHELL-06 No Services tool window (sessions / connections overview)  — Impact: High  — Effort: L
- Area: tool windows
- DataGrip reference: 100-services-toolwindow-dark.png, GAP-CAPTURES row 100
- Ours now: MISSING (manifest: View › Tool Windows lists only Database Explorer and Database Output). The backend already has `connected_data_sources`, `open_session`/`close_session`, `session_state`, `session_tx_status`.
- Should: a Services window (no default shortcut; reachable from "…" More tool windows, View › Tool Windows, Recent Files) opening in the **bottom slot, replacing Database Output** (same slot, one visible at a time).
  - Left: narrow vertical toolbar (open console, data source properties, disconnect in red). Then a toolbar (Tx mode, + add, show/hide eye, open in new tab, expand/collapse).
  - Tree `Database › <data source> › <session "console 30 s 452 ms"> › <console "30 s">`. Data source and session icons carry a green connected dot, and durations are grey.
  - Right pane: data source selected → "Information" pill tab with **Dialect / DBMS / Case sensitivity / Driver** (bold labels). Session selected → that session's output log (reuse LogView).
  - Context menu on a session: Close Session, Disconnect, Commit/Rollback (if in transaction), Jump to Console.
- Files: src/state/layout.ts, new src/features/services/*, src/features/output/LogView.tsx (reuse), src/features/datasource/session.ts

### SHELL-07 Tool-window system is two fixed windows: no "…" more-windows button, no right anchor, no slot sharing, no Move/Resize/Maximize  — Impact: High  — Effort: L
- Area: tool windows in general, main toolbar centre group
- DataGrip reference: 03-crop-main-toolbar-dark.png (5 centre buttons: Explorer, Output, Files, [AI, out of scope], "…"), 127-view-tool-windows-submenu-dark.png, 125 (right dock), 100 (Services swaps with Output in the bottom slot); datagrip-map §1
- Ours now:
  - `ToolWindowAnchor = "left" | "bottom"` with exactly one window per anchor. Shell.tsx hardcodes `explorer` and `output` panels.
  - The toolbar centre shows 2 buttons and no "…" popup.
  - The header ⋮ menu has only "Hide" (`def.options` is never set).
  - There is no maximize (Ctrl+Shift+'), no "Move To", no "Resize", and no drag-to-dock.
- Should:
  - Generalise to anchors left / right / bottom. Each anchor holds N registered windows, and at most one is visible per anchor (showing another hides the current one, as Services ↔ Output).
  - Persist anchor + size per window.
  - Toolbar centre: one 28x30 button per *pinned* window at a 40px pitch, then "…" (More tool windows) opening a list popup of all windows with shortcuts and a pin toggle per row.
  - Header ⋮ menu: Move To › (Left / Right / Bottom), Resize › (Stretch Left/Right/Top/Bottom with Ctrl+Shift+Arrow), Maximize Tool Window Ctrl+Shift+', sep, Hide Shift+Escape.
  - Double-click on a tool-window header maximizes or restores it.
  - A right dock island needs a right splitter (5px gap) in Shell.tsx.
- Files: src/state/layout.ts, src/components/shell/Shell.tsx, src/components/shell/ToolWindowPanel.tsx, src/components/shell/MainToolbar.tsx, src/state/core-actions.ts

---

## Medium

### SHELL-08 Editor tab context menu is a 4-item subset; "Close Other Tabs" enabled with one tab  — Impact: Medium  — Effort: M
- Area: editor tab strip
- DataGrip reference: 113-editor-tab-context-menu-dark.png
- Ours now: docs/ux/app-screens/113-editor-tab-context-menu-dark.png: Close Ctrl+F4 / Close Other Tabs / Close All Tabs / sep / Pin Tab (src/components/shell/EditorArea.tsx `tabMenu`). "Close Other Tabs" has no `enabled` guard, so it is enabled with a single tab, where DataGrip disables it. Right-clicking another tab while a menu is open just closes the menu (backdrop, see SHELL-10).
- Should: same groups and separators as DataGrip, without the AI item:
  - Close Ctrl+F4, Close Other Tabs (disabled when it is the only tab), Close All Tabs
  - Copy Path/Reference… (for a console: file path or `ds.schema.table` for table tabs)
  - Split Right, Split Down (SHELL-03)
  - Pin Tab / Unpin Tab, Configure Editor Tabs… (opens Settings › Editor › General › Editor Tabs)
  - Reopen Closed Tab (keep a closed-tab stack)
  - ✓ Shorten Tab Titles (toggle), Duplicate (console: duplicate into a new console)
  - Export Data to File (console/table tabs)
  - Rename File… (consoles: reuse `rename_console`)
  - Also: Close Tabs to the Left / Right in a "Close Others" submenu, as DataGrip offers.
- Files: src/components/shell/EditorArea.tsx, src/state/tabs.ts

### SHELL-09 Status bar never shows background tasks (introspection, connect, export)  — Impact: Medium  — Effort: S
- Area: status bar
- DataGrip reference: 06-statusbar-introspection-progress-dark.png, datagrip-map §1 Status bar
- Ours now: MISSING. The StatusBar renders `status.task` (title + 100px bar + cancel), but nothing ever sets it (grep `setStatus("task"`: no hits). Introspection, connecting and export run without feedback.
- Should: a small task registry (`startTask(title, {cancel}) → {progress(p), done()}`), shown as `Performing complete introspection (SQLite)` with a 100px bar (`#3871E1` on `#43454A` dark; light from tokens), cancel ⊗ and a `+N` counter when several tasks run. Clicking `+N` opens a list popup of running tasks.
  - Hook it into introspect/refresh (Ctrl+F5), connect, `export_query`/`export_result`, and the Test Connection "Re-ask credentials" step.
- Files: src/state/status.ts, src/components/shell/StatusBar.tsx, src/features/explorer/core.ts, src/features/output/export.ts, src/features/datasource/session.ts

### SHELL-10 Menu bar: hovering another title does not switch menus; clicking one closes the bar  — Impact: Medium  — Effort: S
- Area: main menu bar, popup menus
- DataGrip reference: 126-main-menu-* (standard Swing menu-bar behaviour)
- Ours now: confirmed in the browser build (/tmp/claude-1000/audit-shell/pw/menu-hover-edit-light.png: File stays open with the pointer over Edit). Cause: `MenuHost` renders a full-screen `.dg-menu-backdrop` (z-index 2100) above the toolbar. It eats `mouseenter`/`mousedown` on `.dg-menubar-item`, so the `onMouseEnter` handler in MainToolbar.tsx never fires, and a mousedown only closes. The same backdrop causes "right-click another tab/row while a menu is open only closes it" and manifest bug 9 (first click after Esc).
- Should: when the open menu has `variant: "bar"`, let pointer events reach the menu-bar strip. Exclude `.dg-menubar` from the backdrop by hit-testing in the backdrop's mousemove/mousedown with `document.elementsFromPoint`, or by raising the menubar above the backdrop while open.
  - Hover over another title switches immediately. A click on the open title closes, and a click on another title switches.
  - For context menus: a right-click on the backdrop should close and re-dispatch the `contextmenu` to the element underneath (DataGrip reopens the menu at the new place).
- Files: src/components/ui/Menu.tsx, src/components/shell/MainToolbar.tsx, src/styles/ui.css

### SHELL-11 Keymap is read-only and incomplete  — Impact: Medium  — Effort: L
- Area: Settings › Keymap, global keymap
- DataGrip reference: 97-settings-keymap-dark.png, 94-settings-keymap-execution-dark.png, 95-settings-keymap-database-groups-dark.png; datagrip-map "Settings dialog" (Keymap)
- Ours now:
  - The page header says "Keymap: XWin read-only". There is no keymap combo + gear, no "find action by shortcut" button, and no editing.
  - Groups are derived from the id prefix (`keymap-util.ts groupOf`): 4 flat folders and no Database sub-groups (Execution, Data Editor, Database Explorer…). Commit/Rollback rows are missing.
  - Only actions in the registry appear. Shortcuts implemented inside CodeMirror/grid (Ctrl+D, Ctrl+Y, Alt+Insert, Ctrl+Alt+N, Ctrl+Shift+Enter, Ctrl+J, Alt+Enter, Ctrl+Q in editor…) are invisible and cannot be rebound.
- Should:
  - Editable keymap stored in settings (`keymapOverrides: Record<actionId, string[]>`), applied by `installKeymap` on top of the defaults.
  - Row context menu: Add Keyboard Shortcut (capture dialog showing conflicts: "The shortcut is already assigned to: …"), Remove <shortcut>, Reset Shortcuts. Modified rows in blue (DataGrip shows changed actions in blue).
  - Toolbar: Expand All, Collapse All, search field + "Find Actions by Shortcut" button (records a key and filters).
  - Tree folders as in 95: Editor Actions, Main Menu (sub-folders per menu), Tool Windows, Database › (Execution, Data Editor/Grid, Database Explorer, Transactions…).
  - Register the component-level actions in the registry with a `when` guard so they are listed and rebindable.
  - Footer checkbox "Use national layouts for shortcuts" (optional).
- Files: src/features/settings/KeymapPage.tsx, keymap.ts, keymap-util.ts, src/state/actions.ts, src/state/settings.ts, src/components/grid/DataGrid.tsx, src/components/editor/*.ts

### SHELL-12 Settings has no Editor › Color Scheme page  — Impact: Medium  — Effort: L
- Area: Settings
- DataGrip reference: 130-settings-color-scheme-dark.png, 130b-settings-color-scheme-sql-keyword-dark.png
- Ours now: MISSING (PAGES in src/features/settings/model.ts: Editor › General › Appearance and Font only).
- Should: Editor › Color Scheme with sub-pages General and SQL (Database / Data grid attributes optional).
  - Header: "Scheme:" combo (Islands Dark / Islands Light, "Theme default" suffix) + gear (Duplicate…, Reset, Export/Import optional), and a link "Change IDE Theme…" that jumps to Appearance.
  - The SQL page has an attribute list in DataGrip order (Bad token, Braces, Brackets, Column, Comma, Comment, Database object, Dot, External command, Keyword, Label, Number token, Operator sign, Parameter, Parentheses, Semicolon, String, Synthetic entity, Table alias…).
  - Selecting an attribute shows on the right: Bold, Italic, Foreground (checkbox + swatch), Background, Error stripe mark, Effects (Bordered/Underscored/Wave), "Inherit values from: Keyword (Language Defaults)" link.
  - Below: a live preview editor (DDL/DML sample) where the selected attribute's occurrences blink with a box effect for about 2 s.
  - Overrides are stored in settings and applied as CSS custom properties over the `--dg-editor-*`/syntax tokens, so both themes keep their own values.
- Files: src/features/settings/model.ts, pages.tsx, new ColorSchemePage.tsx, src/state/settings.ts, src/theme/dark.css + light.css (token names used by highlight.ts)

### SHELL-13 Settings › Appearance has only the Theme combo  — Impact: Medium  — Effort: M
- Area: Settings, themes
- DataGrip reference: 97-settings-appearance-dark.png
- Ours now: docs/ux/app-screens/97-settings-appearance-dark.png: a single "Theme:" combo (Islands Dark / Islands Light / Sync with OS).
- Should: add the operative controls, laid out as in the reference (labels at x=17 after the pane, sections with a 1px rule):
  - "Editor color scheme:" combo indented 24px under Theme, with a gear (links to SHELL-12). Default follows the theme.
  - "Use custom font: [Inter ⌄] Size: [13 ⌄]". The UI font size can scale the chrome via a root `--dg-font-ui-size` and, if needed, CSS zoom. Map notes it is not offered today because metrics are fixed px. Offer at least the size.
  - UI Options: "Compact mode" (24px→22px rows/headers), "Use project colors in main toolbar" (toggles the toolbar tint), "Smooth scrolling", "Enable mnemonics in menu", "Display icons in menu items", "Keep popups open for toggle items".
  - Tree Views: "Show indent guides", "Use smaller indents".
  - Leave out Background Image, Main menu placement (requires restart, optional) and Accessibility.
- Files: src/features/settings/pages.tsx, model.ts (keywords), src/state/settings.ts, src/styles/tokens-extra.css, src/components/ui/Tree.tsx, src/components/ui/Menu.tsx

### SHELL-14 Settings tree is missing most in-scope Database and Editor pages  — Impact: Medium  — Effort: L
- Area: Settings
- DataGrip reference: 131-settings-database-general-dark.png (Database index page with links), 131b-settings-database-other-dark.png, 97-settings-database-query-execution-dark.png; datagrip-map "Settings dialog"
- Ours now: the tree is Database (Query Execution, Data Editor and Viewer) / Appearance & Behavior (Appearance) / Keymap / Editor (General › Appearance, Font). The Database root has only 2 links (manifest 131 MISSING). Query Execution has only a "Transactions" section. There is no Editor › General page, no Editor Tabs page and no Code Style.
- Should (operative pages only):
  - **Database** root index page: the DataGrip description text + blue links to children.
  - **Query Execution:** Execute / Execute (2) / Execute (3) list with "When caret inside statement execute" (Smallest / Largest statement / Ask), "When caret outside…", "For selection execute", "Open results in new tab", "Review parameters before execution". Sub-pages **Output and Results** (where results show, "Show results in Services/Output", "Activate Output on execution") and **User Parameters**.
  - **Data Editor and Viewer:** complete Limitations ("Result set prefetch size", "Maximum number of bytes loaded per value", "Show first 10 data rows in preview") and Data Presentation (alternate row colors, boolean as, number/date formats).
  - **Database Explorer** (show/sort options of the tree), **CSV Formats** (extractor formats used by export), **Query Files and Consoles** (console naming, auto-save), **Other** (Modify Object confirmations, Code Generation, Default resolve mode for consoles: Playground/Script).
  - **Editor › General** (soft wraps, scroll offset, virtual space), **Editor › General › Editor Tabs** (tab placement, Tab limit 10, Show close button, Shorten titles; used by SHELL-08/-21), **Editor › Code Style › SQL** (case of keywords, indent; used by Reformat).
  - Add a keyword list for each new page so search works (97-settings-search-font: `font` must also find Data Editor, Appearance, Keymap, Color Scheme).
- Files: src/features/settings/model.ts, pages.tsx, widgets.tsx, src/state/settings.ts

### SHELL-15 Search Everywhere: hidden schemas leak, missing object kinds, no Text tab, no settings/options results  — Impact: Medium  — Effort: M
- Area: Search Everywhere / Go to (Ctrl+N)
- DataGrip reference: 91-search-everywhere-all-dark.png, 90-goto-database-object-ctrl-n-dark.png; datagrip-map §8
- Ours now: docs/ux/app-screens/91-search-everywhere-all-dark.png: `invo` finds only invoices, invoice_seq and invoices_id_seq.
  - `invoice_seq` comes from schema `shop`, which the schema selector hides (manifest bug 7). DataGrip lists only visible schemas.
  - Index, key, FK and trigger entries are absent (DataGrip: invoices_client_id_idx, invoices_client_id_fkey, invoices_pkey). `EntryKind` has no key/index/fk/trigger.
  - There is no "Text" tab (DataGrip finds `FROM sales.invoices` inside consoles/files with file + line on the right). There are no settings options in All/Actions. There is no "Type / to see commands" hint.
  - The footer link reads "Open DDL" instead of "Open In Right Split".
- Should:
  - Filter entries through `src/state/schema-filter.ts`, with an "Include non-project items" checkbox to include hidden schemas.
  - Add kinds index, key (PK gold key icon), foreign key (blue key), check, trigger with qualifier `db.schema.table [ds]`.
  - Add a Text tab that searches console/scratch contents: row = `[sql icon] highlighted line …  file:line` right-aligned grey.
  - In Actions/All, include Settings options (from PAGES keywords) with a right label `Settings > <page>`, opening Settings on that page with the term highlighted.
  - Add a placeholder hint "Type / to see commands" at the right of the field.
  - Footer: grey path of the selection + "Open In Right Split" (Shift+Enter) once SHELL-03 exists.
  - Tab order: All, Database, Files (consoles/scratches), Actions, Text.
- Files: src/features/navigate/sources.ts, SearchPopup.tsx, match.ts, src/state/schema-filter.ts

### SHELL-16 Missing global navigation shortcuts  — Impact: Medium  — Effort: M
- Area: global keymap
- DataGrip reference: datagrip-map §9 and evidence §5 ($default: GotoAction Ctrl+Shift+A, GotoFile Ctrl+Shift+N, Alt+4 Files); IntelliJ defaults below
- Ours now: registered globals are the core actions plus feature actions (see src/state/core-actions.ts and the feature `actions.ts` files). Not bound anywhere (grep):
  - Ctrl+Shift+A (Find Action; the Actions tab exists but has no shortcut)
  - Ctrl+E, Ctrl+Tab, Ctrl+Shift+E (SHELL-04)
  - Alt+4 (SHELL-05)
  - Ctrl+Alt+Left / Ctrl+Alt+Right (Back/Forward navigation history)
  - Ctrl+` (Quick Switch Scheme/Theme)
  - Ctrl+Shift+' (Maximize tool window), F12 (Jump to last tool window)
  - Escape in a tool window (return focus to editor)
  - Ctrl+Shift+N (Go to File)
  - Ctrl+S (Save All)
  - Alt+Shift+. / Alt+Shift+Comma (editor font size)
  - Ctrl+Alt+Shift+Insert (New Scratch File)
- Should:
  - **Ctrl+Shift+A:** open SearchPopup on the Actions tab.
  - **Ctrl+Alt+Left/Right:** a navigation history of (tab, caret/selection) places, pushed on tab switch, F4/Ctrl+B jumps and Search Everywhere opens. Back/Forward restore them.
  - **Ctrl+`:** "Quick Switch Scheme" list popup with numbered items (1 Theme…, 2 Editor Color Scheme…, 3 Keymap…, 4 View Mode…). Theme… opens a numbered list popup "Theme…" with only the in-scope themes (1 Islands Dark, 2 Islands Light, sep, Sync with OS); digits select (96-theme-quick-switch-dark.png).
  - **Escape in a tool window:** focus returns to the active editor, unless a popup, speed search or in-place editor consumes it.
  - **F12:** focus the last active tool window.
  - **Ctrl+Shift+':** toggle maximize of the active tool window (SHELL-07).
  - **Ctrl+S:** flush console autosave (no-op visible).
  - **Alt+Shift+. / Alt+Shift+Comma:** ±1 px on settings.editorFontSize.
  - Also show these in the keymap page.
- Files: src/state/core-actions.ts, src/state/actions.ts, src/state/layout.ts, src/features/navigate/index.ts, new src/state/nav-history.ts

### SHELL-17 Notifications have no history, no tool window and no status-bar bell  — Impact: Medium  — Effort: M
- Area: notifications/balloons, status bar
- DataGrip reference: 81-notification-balloon-info-dark.png, 05-crop-statusbar-dark.png (bell with blue unread dot), 127 (Notifications tool window), 126-main-menu-window (Notifications ›)
- Ours now: docs/ux/app-screens/81-notification-balloon-info-dark.png. The balloon style matches (370px, radius 8). `src/components/ui/Notification.tsx` keeps at most 4 live balloons, auto-hides after 10 s, and loses them afterwards. There is no history, no bell in StatusBar.tsx, and no way to reread an error that expired. The ⌄ at the right only dismisses.
- Should:
  - Keep every notification in a store.
  - Add a status-bar bell widget at the far right (16px icon, blue 6px dot when unread) that toggles a Notifications tool window (right anchor). It lists entries newest first: icon, bold title, body, links, grey timestamp ("12:55"), with "Mark all as read" and "Clear all" in the header.
  - Balloon ⌄ = collapse into the bell (DataGrip "Hide"), × on hover = dismiss.
  - Window › Notifications › Show All / Expire All.
  - Errors stay sticky; info auto-hides after 10 s but stays in the history.
- Files: src/components/ui/Notification.tsx, src/components/shell/StatusBar.tsx, src/state/layout.ts, new src/features/notifications/*

### SHELL-18 Status bar breadcrumbs follow the explorer, not the focused component; stale widgets  — Impact: Medium  — Effort: S
- Area: status bar
- DataGrip reference: 05-crop-statusbar-dark.png ("Database Consoles › postgres@localhost › 🐘 console [postgres@localhost]" while the console is focused), 100 (explorer selection path when explorer focused)
- Ours now: docs/ux/app-screens/05-crop-statusbar-dark.png shows "Database › postgres@localhost › postgres › sales › tables › invoices" (explorer selection) although the console tab is the context.
  - `status.path` is written by explorer selection (features/explorer/core.ts:480) and by tab activation (features/explorer/index.ts:75). The last writer wins, regardless of focus.
  - "No aggregator selected" stays after leaving a grid (manifest bug 6).
  - The read-only lock is drawn even when no editor is active, and there is no bell (SHELL-17).
- Should: choose the path from the **focused** area.
  - Focus in the editor gives the tab's path ("Database Consoles › <ds> › <console>", table tab "Database › ds › schema › tables › table"). Focus in the explorer gives the selected node's path.
  - Recompute on `focusin` of `[data-editor-area]` / `[data-toolwindow]`.
  - Clicking a crumb selects that node in the explorer (DataGrip navigation bar).
  - Clear `aggregator` when the grid loses the active tab.
  - Order of right widgets as in DataGrip: task progress, aggregator, caret `L:C`, LF, UTF-8, `4 spaces`, lock, bell, gaps about 12px.
- Files: src/components/shell/StatusBar.tsx, src/state/status.ts, src/features/explorer/core.ts, src/features/explorer/index.ts, src/components/grid/DataGrid.tsx

### SHELL-19 Gear menu and theme switching: no Keymap…, no "Theme…" quick-switch popup  — Impact: Medium  — Effort: S
- Area: main toolbar gear menu, themes
- DataGrip reference: 92-settings-gear-menu-dark.png, 96-theme-quick-switch-dark.png
- Ours now: 92 shows Settings… / Theme › / Restore Default Layout. 96 shows a 3-item submenu (Follow System Theme / ✓ Islands Dark / Islands Light).
- Should: Settings… Ctrl+Alt+S / sep / Theme… / Keymap… / View Mode… (Full Screen; Presentation/Zen only if built) / sep / Restore Default Layout. Plugins and Backup and Sync are out of scope.
  - "Theme…" opens a centered list popup titled "Theme…" (bold, centered title strip): numbered rows "1 Islands Dark", "2 Islands Light", sep, "3 Sync with OS". The current one is preselected, digits 1–3 pick directly, and hovering previews the theme live (DataGrip applies on Enter).
  - "Keymap…" opens a popup with the single keymap "XWin" (✓) and "Configure Keymap…" → Settings › Keymap.
  - The same popup is reachable via Ctrl+` (SHELL-16).
- Files: src/components/shell/menus.ts, src/state/core-actions.ts, src/components/ui/Menu.tsx (title + numbered list variant already supported via `title`)

---

## Low

### SHELL-20 Menu polish: mnemonics, Alt+letter, bar-menu separator height  — Impact: Low  — Effort: S
- Area: main menu
- DataGrip reference: 93-main-menu-file-dark.png, 126-main-menu-*.png
- Ours now: no underlined mnemonics in the bar (DataGrip: F̲ile E̲dit V̲iew N̲avigate R̲un W̲indow H̲elp) or in items (N̲ew, O̲pen…, Save A̲ll, Ex̲it…). Alt+F/Alt+E do not open menus. Bar-menu separators take 9px (`--dg-menu-separator-height`). DataGrip's Swing bar menus use about 3px: Rename Project at y=189 → Attach Directory at y=218, a 29px pitch versus 26px between rows. Ours is 85→119, a 34px pitch. Context menus correctly keep 9px.
- Should: support `&` in labels (render `<u>`, underline always shown in the bar like the reference). With the bar open, a letter key activates the matching item. With nothing focused, Alt+<letter> opens that top menu (only if not stolen by a registered Alt shortcut: Alt+1/4/8 are digits, no conflict). For `variant: "bar"` set the separator height to 3px (1px line centered, full bleed).
- Files: src/components/ui/Menu.tsx, src/components/shell/menus.ts, src/components/shell/MainToolbar.tsx, src/styles/ui.css (`.dg-menu-bar-menu .dg-menu-sep`)

### SHELL-21 Editor tab strip: no overflow dropdown, no double-click maximize, tab strip shown when empty, empty-state actions  — Impact: Low  — Effort: S
- Area: editor tab strip, empty editor
- DataGrip reference: 130-settings-color-scheme-dark.png (⌄ "Show hidden tabs" before ⋮ when tabs overflow), 00-welcome-empty-project-dark.png
- Ours now: overflowing tabs scroll sideways (wheel) and there is no ⌄ list. The ⋮ menu lists all tabs, which is fine. Double-click on a tab does nothing (DataGrip: Hide All Tool Windows / restore). There is no tab limit, so tabs pile up. With no tabs, the 40px strip with ⋮ is still drawn. DataGrip shows no strip, and the empty editor shows action buttons (in scope: "New Data Source" button, 28px, `--dg-button-bg`, radius 6, icon + text, centered about 64% down). Ours shows 3 shortcut hint rows.
- Should: when tabs overflow, add a ⌄ button before ⋮ opening a list popup of the hidden tabs. Double-click on a tab runs `toolwindow.hideAll` (toggle). Apply the "Tab limit" setting (default 10, close the least recently used unpinned tab). Hide the strip when empty. Empty state: keep the shortcut hints (Search Everywhere Shift Shift, Go to Database Object Ctrl+N, Recent Files Ctrl+E, New Query Console Ctrl+Shift+Q) and add the "New Data Source" button when there are no data sources.
- Files: src/components/ui/Tabs.tsx, src/components/shell/EditorArea.tsx, src/components/shell/Placeholders.tsx, src/state/tabs.ts

### SHELL-22 Hide All Windows (Ctrl+Shift+F12) does not restore the previous set  — Impact: Low  — Effort: S
- Area: tool windows
- DataGrip reference: standard IntelliJ behaviour (second Ctrl+Shift+F12 restores the windows that were visible)
- Ours now: `hideAllToolWindows()` (src/state/layout.ts) hides all windows. The second press shows only the Explorer, so the Output panel is lost.
- Should: remember the set of visible ids on hide-all and restore exactly that set (and sizes) on the next press. Reset the memory if the user opens a window in between.
- Files: src/state/layout.ts

### SHELL-23 Tool-window header actions stay visible after focus leaves  — Impact: Low  — Effort: S
- Area: tool-window header
- DataGrip reference: datagrip-map §1 ("Header actions appear only on hover or focus"), 01-main-window-dark.png (Explorer header shows no actions while the editor is focused)
- Ours now: 01-main-window-dark (ours) shows ⊙ ⌃⌄ ✕ ⋮ — on the Explorer header while the console is the context. CSS `.dg-toolwindow.dg-active .dg-tw-actions { visibility: visible }` and `activeToolWindow` is only cleared on hide, so the last-focused window keeps its actions forever.
- Should: show actions on `:hover` or `:focus-within` only. Keep `dg-active` for Shift+Escape targeting but not for visibility. Alternatively, clear `activeToolWindow` on focus into the editor.
- Files: src/styles/shell.css (lines 205–209), src/state/layout.ts

### SHELL-24 Remaining hard-coded colours outside the theme files  — Impact: Low  — Effort: S
- Area: themes (token-level parity)
- DataGrip reference: docs/ux/theme-tokens.md (`text-success` #6DB083 / #338555; Islands Light vs Dark)
- Ours now: 66 literal colours outside src/theme. Most are per-theme pairs (tokens-extra.css, grid.css light overrides), which is fine. Single values used in both themes:
  - components/editor/editor.css:236 and :346: `.cm-exec-ok` / `.cm-inspect-ok` `#5fb865` (gutter ✓ and inspection ✓). The light theme should be darker green: `--dg-text-success` #338555.
  - editor.css:296/305: stripe `#42bd77` in both themes.
  - output.css:92: `.dg-stop-idle rect #595959` (dark only, light uses a token, OK).
  - styles/shell.css:125: window close hover `#e81123` (acceptable).
  - explorer.css:25: connected dot `#1fd11f` in both themes.
  - grid.css:563 pill border `#404040`.
- Should: replace each literal with a `--dg-*` token defined in both dark.css and light.css: `--dg-icon-success` (#5FB865 dark / #369650 light; verify the light value against the expUI light icon palette in theme-tokens.md), `--dg-stripe-change`, `--dg-ds-connected-dot`, `--dg-pill-border`. Add a lint check (`grep` in CI) that fails on hex literals in component CSS outside `:root[data-theme]` blocks.
- Files: src/components/editor/editor.css, src/features/explorer/explorer.css, src/components/grid/grid.css, src/theme/dark.css, src/theme/light.css

### SHELL-25 Our 136-main-window-light capture does not show the reference state  — Impact: Low  — Effort: S
- Area: evidence (manifest)
- DataGrip reference: 136-main-window-light.png (ux-sample.db › main › tables expanded, 4-line reformatted join, "Result 8")
- Ours now: docs/ux/app-screens/136-main-window-light.png is the same scene as 01-main-window-light (PG invoices console), so it is not comparable. The light rendering itself looks right: sampled window #E9EAEE, islands #FFFFFF, tab pill #E3EBFE, grid header #EFEFEF, all equal to DataGrip.
- Should: recapture 136 in the reference state, with SQLite explorer expanded and the join query and result tab, so the light parity of tree, editor inlays and grid can be compared one-to-one.
- Files: docs/ux/app-screens/136-main-window-light.png, docs/ux/app-screens/MANIFEST.md

---

## Verified OK (no item)
- Theme token sets: dark.css and light.css define the same 299 tokens. Theme switch works for System/Dark/Light (src/state/theme.ts).
- Islands geometry: 43px toolbar, 34px status bar, 7px left margin, 5px gaps, radius 10, project tint gradient. Pixel colours match DataGrip in both themes.
- Tool-window button visible state #393A3E / #D9D9DD and 40px pitch match. Alt+1/Alt+8 three-state behaviour (show+focus → focus → hide) matches IntelliJ.
- Tooltip: 1.2 s delay, grey shortcut after the label (83 matches). Balloon style matches (81).
- Tabs: pill style, focused vs unfocused selected states (ui.css:245–249), middle-click close, drag reorder, pin.
- Settings frame (900x700, tree, breadcrumb, OK/Cancel/Apply, search filtering) renders correctly in light.

## Could not verify
- DataGrip light-theme references exist only for main window, grid, data source dialog, completion and some context menus. Light parity of menus, Search Everywhere and Settings was checked against tokens, not against DataGrip captures.
- Exact DataGrip light value for the gutter success icon (SHELL-24) is not in the captured evidence.
- Ctrl+Tab Switcher layout was not captured in DataGrip. SHELL-04 assumes the standard IntelliJ Switcher (same two-column layout as Recent Files).
