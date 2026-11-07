# Audit: query console, SQL editor, Database Output, results grid, export

Auditor group: **console**. Scope: query console and SQL editor, Query History, the Database Output tool window, the results grid and Export Data.
Method:
- Compared each pair `docs/ux/screens/X.png` (DataGrip) with `docs/ux/app-screens/X.png` (ours). The comparison crops were stacked top/bottom and are in `/tmp/claude-1000/audit-console/cmp/`.
- Read the captured-state notes in `docs/ux/screens/GAP-CAPTURES.md` and the measurements in `datagrip-map.md` §4–6 and §9 and in the evidence §4–5.
- Checked every claim of a missing feature or shortcut in `src/`: the action registry (`registerActions` shortcuts), the CodeMirror keymaps in `SqlEditor.tsx`, `search.ts` and `complete.ts`, and the grid `onKeyDown` in `DataGrid.tsx`.

No code was changed. No new app screenshots were needed: all the states below are already in `docs/ux/app-screens/`.

Ordering: High first, then Medium, then Low. CON = editor and console, GRID = output, grid and export.

---

## High

### CON-01 Editor right-click shows the native WebKit menu instead of an editor context menu  — Impact: High  — Effort: S
- **Area:** SQL editor context menu.
- **DataGrip reference:** `docs/ux/screens/112-editor-context-menu-dark.png` (GAP-CAPTURES 112).
- **Ours now:** `docs/ux/app-screens/112-editor-context-menu-dark.png`.
  - Right-click in the console opens the GTK/WebKit menu: Cut / Copy / Paste / Delete / Select All / Insert Emoji / Insert Unicode Control Character ›.
  - `SqlEditor.tsx` registers no `contextmenu` handler, so this is the only menu.
  - It looks foreign (system font, light separators) and offers nothing SQL-specific.
- **Should:** handle `contextmenu` on the editor host with `preventDefault()`.
  - Move the caret to the click position, unless the click is inside the selection.
  - Open the shared `openMenu` at the pointer (26 px rows, `#26282C` bg, `#33353B` border, radius 8, gray right-aligned shortcuts, 16 px icons on the left). Nothing is preselected.
  - Groups, keeping only actions that exist or that this audit proposes (no dead items):
    1. `Show Context Actions  Alt+Enter` (bulb icon; once CON-03 exists)
    2. `Cut  Ctrl+X` and `Copy  Ctrl+C` (only with a selection), `Paste  Ctrl+V`, `Copy / Paste Special ›` (`Copy Reference  Ctrl+Alt+Shift+C`, `Paste as Plain Text`), `Column Selection Mode  Alt+Shift+Insert`
    3. `Go To ›` (`Declaration or Usages  Ctrl+B` (CON-04), `Line:Column…  Ctrl+G`)
    4. `Reformat Code  Ctrl+Alt+L`, `Duplicate  Ctrl+D`, `Comment with Line Comment  Ctrl+/`
    5. `Explain Plan ›` (only if CON-10 is built), `Execute  Ctrl+Enter` (green run icon), `Execute Script`
  - Leave out: AI "Add to Agent Context", "Send to Workspace Console", Local History, Diagrams, Evaluate Expression, Find Usages and Refactor (not built).
  - The single-line editors (WHERE / ORDER BY filters) get the same menu without groups 3 and 5.
- **Files:** `src/components/editor/SqlEditor.tsx`, `src/components/ui/Menu.tsx`, `src/features/console/actions.ts` (register `sql.copyReference` etc. as actions so the shortcuts show).

### CON-02 No live inspections: syntax errors appear only after execution, unresolved names have no tooltip, the widget stays green  — Impact: High  — Effort: L
- **Area:** inspections and error highlighting.
- **DataGrip reference:** `114-editor-inspection-error-tooltip-dark.png`, `115-editor-unresolved-reference-dark.png` (GAP-CAPTURES 114/115), map §4 "Statement and run decorations".
- **Ours now:** `114-…` and `115-…` in app-screens.
  - `SELECT name, FROM products WHERE;` shows nothing until it is executed. After that, `errors.ts` shows the server message as a red-bg tooltip under the token.
  - `SELECT * FROM custmers;` gets the red `bad` foreground from `semantic.ts`. Hovering it shows no tooltip.
  - The inspection widget at the top right stays a green ✓ (`stripe.ts` counts only `errorsField` entries, which come from execution), and there is no stripe mark.
  - F2 / Shift+F2 (next / previous problem) are not bound.
- **Should:**
  1. **Unresolved references** (the `bad` marks already exist) become problems:
     - Hover tooltip after 1 s: `Unable to resolve table 'custmers'` or `Unable to resolve column 'colour'`. Below the line, left-aligned to the hovered character.
     - Tooltip style: bg `#2B2D30` (≈`#393B40`), radius 6, padding 8×10, Inter 13 `#DFE1E5`, a ⋮ button at the right.
     - Second row of blue links: `More actions…  Alt+Enter`, with the shortcut in gray.
  2. **Syntax inspection**, computed from the existing lexer/splitter on each doc change and debounced 300 ms. At minimum:
     - a dangling comma before `FROM` / `)`
     - an operator or keyword with no operand (`WHERE ;`, `> ;`)
     - an unbalanced `(`
     - Message `<expression> expected, got ';'`, shown as a 1-char red wavy underline at the token, in the same tooltip style.
  3. **Inspection widget:** `❗N ˄ ˅` with the red count when any problem exists (unresolved and syntax). It shows `Paused…` while completion or a live template is active, and ✓ otherwise. The ˄˅ buttons and **F2 / Shift+F2** jump to the next / previous problem.
  4. **Error stripe:** an 8×2 red `#F75464` dash per problem line.
  5. Execution errors (the current `errorsField`) keep working and add to the count.
- **Files:** `src/components/editor/semantic.ts`, `errors.ts`, `stripe.ts`, `highlight.ts`, new `src/components/editor/inspect.ts`, `SqlEditor.tsx` (F2 keys).

### CON-03 Execution running state: no live timer, no gutter spinner, no pending result tab  — Impact: High  — Effort: M
- **Area:** running, cancel and completion feedback.
- **DataGrip reference:** `120-query-running-state-dark.png` (GAP-CAPTURES 120).
- **Ours now:** `120-query-running-state-dark.png`, `SELECT pg_sleep(8)` at 2.5 s.
  - The output header shows a hollow spinner but still the **previous run's "4 ms"**.
  - The previous result grid stays visible.
  - There is no gutter spinner and no elapsed inlay.
  - The Tx combo stays enabled.
  - There is no notice when a long query ends.
- **Should:**
  - Gutter: an animated 16 px spinner on the statement's first line, replacing the ✓ / ! marker.
  - Inlay after the statement: the elapsed time in gray (Inter 11, `#6F737A`). It updates every second (`4 s`) and becomes the final `NNN ms` when done.
  - Output header: `console [postgres@localhost] 1 s 261 ms`, a live timer formatted with `formatDuration`, refreshed every 100 ms while running.
  - The unpinned result tab is replaced **at once**:
    - It takes the statement's tab title and its column header when the column metadata arrives (before that, an empty header).
    - The grid body shows a large centered spinner.
    - The pill reads `0 rows ⌄ | of 0+`.
    - The grid toolbar's red ■ is enabled.
  - Console toolbar while running: red ■ Cancel enabled; Execute and `Tx: Auto` disabled.
  - When a run that took more than 5 s ends while the window is unfocused, or the console is not the active tab: a balloon `console — select pg_sleep(30)... completed.`
- **Files:** `src/features/console/session.ts` (`run`), `src/features/output/model.ts`, `OutputHeader.tsx`, `ResultView.tsx`, `src/components/editor/gutter.ts`, `state.ts` (a `running` exec-mark status), `ConsoleToolbar.tsx`.

### CON-04 Ctrl+B / Ctrl+Click and Ctrl+Q do nothing in the editor  — Impact: High  — Effort: M
- **Area:** navigation and Quick Documentation from SQL.
- **DataGrip reference:** `117-editor-quick-doc-ctrl-q-dark.png` (GAP-CAPTURES 117), map §9 (`Ctrl+B` Go to DDL / Ctrl+Click, `Ctrl+Q`, `Alt+Shift+B` Select in Database Explorer).
- **Ours now:** `117-…` PARTIAL: the popup is only reachable from the explorer.
  - `db.gotoDdl` (Ctrl+B) and `db.quickDoc` (Ctrl+Q) in `src/features/explorer/actions.ts` have `when: explorerFocused`.
  - The editor has no Ctrl+Click handler.
- **Should:** resolve the identifier at the caret with the existing `schemaIndex` / `analyzeStatement` scope (table, view, alias → table, column, routine, sequence).
  - **Ctrl+B / Ctrl+Click:** open the object's DDL tab with the existing `openDdl(ref)`. For a column, open the table DDL with the caret on that column.
  - **Ctrl hover:** underline the identifier and use the pointer cursor (`#589DF6` link color). An unresolved name does nothing.
  - **Ctrl+Q:** a Quick Documentation popup anchored below the word.
    - It must not take focus (the caret stays in the editor); Esc closes it.
    - Content: bold label lines `Data Source: ux-sample.db`, `Schema: main`, `Table: products`, then a darker nested code block with the syntax-highlighted generated DDL (`-- auto-generated definition / create table …`).
    - Footer link `Show table preview`, which opens the table data editor.
    - Reuse `src/features/explorer/QuickDoc.tsx` (extend it with the DDL block).
  - **Alt+Shift+B:** select the object in the Database Explorer and show the explorer.
- **Files:** `src/components/editor/SqlEditor.tsx`, new `src/components/editor/navigate.ts`, `src/features/explorer/QuickDoc.tsx`, `src/features/explorer/actions.ts`, `src/features/console/ConsoleView.tsx` (to pass the ds/ref resolver).

### GRID-01 Grid "Export Data" opens no Export Data dialog (the native save dialog appears straight away)  — Impact: High  — Effort: M
- **Area:** export.
- **DataGrip reference:** `106-export-data-dialog-dark.png` (GAP-CAPTURES 106).
- **Ours now:** `106-export-data-dialog-dark.png` PARTIAL.
  - The grid toolbar ⤓ opens a 2-item menu: `Export to File...` (straight to the GTK save dialog with the current extractor) and `Copy to Clipboard` (`src/features/output/OutputToolbar.tsx`).
  - The explorer path opens `ExportDialog` (`src/features/table/Popups.tsx`): Extractor / Output / NULL text / Write column names. It has no preview and no output path.
- **Should:** one Export Data dialog for both entry points (grid ⤓, explorer `Import/Export › Export Data…`, table editor export).
  - Size about 820×580. No promo banner (out of scope).
  - **Left column:**
    - `Source:`: a read-only field (`main.orders`, or the result title).
    - `Extractor:`: a combo with all extractors (GRID-04). It has the initial focus.
    - Checkboxes `Transpose`, `Add column header` (on by default for CSV/TSV), `Add row header`.
    - Extractor-specific options under them: NULL text and delimiter/quote for CSV, table name and rows per INSERT for SQL.
    - `Output file:`: a text field with a folder button. The default is `~/<source_with_underscores>.<ext>`, and the extension follows the extractor.
  - **Right column:** `Export preview (first 10 rows are shown):`, a read-only `SqlEditor`/text view with line numbers that updates live when the options change.
  - **Footer:** `Export to File` (primary, default button), `Cancel`, `Copy to Clipboard`.
  - The whole result is exported. Reuse `exportQueryToFile` / `exportQueryToString`, which re-run the query when not every row is loaded.
  - Keep the toolbar's quick "Copy to Clipboard" in the Options menu.
- **Files:** `src/features/table/Popups.tsx` (`ExportDialog`), `src/features/table/exportData.tsx`, `src/features/output/export.ts`, `OutputToolbar.tsx`, `src/api/types.ts` (`ExportOptions`: `transpose`, `rowHeader`, `path`).

### GRID-02 Console result toolbar has dead disabled buttons (SQL, Open in Editor Tab, DDL) and shows the edit group on read-only results  — Impact: High  — Effort: S
- **Area:** grid toolbar in Database Output.
- **DataGrip reference:** `51-results-grid-and-console-dark.png` (join, read-only), `53-results-table-query-editable-toolbar-dark.png` (single table), map §5 "Grid toolbar".
- **Ours now:** `51-…` / `53-…`.
  - `ResultToolbar` in `OutputToolbar.tsx` never passes `onSql`, `onOpenInEditor` or `onDDL`. So `SQL`, ⊞ `Open in Editor Tab` and `DDL` are always grayed: dead buttons, which the brief forbids.
  - On a join result the whole edit group (+ − ↶ 👁 ⇧ `Tx: Auto`) and `DDL` are shown grayed. DataGrip shows none of them on a read-only result (`51`: table, chart | ⟳ clock ■ | pin 🔍 filter record coloring geo).
  - Toolbar tooltips are the native `title` (see the TODO at the top of `GridToolbar.tsx`), not the app tooltip with the gray shortcut.
  - The `Table Result Auto Refresh` clock is missing.
- **Should:**
  - `SQL`: opens the existing `SqlPopup` read-only with the statement that produced the result. Its title is `Query`; buttons `Open in Console` (inserts the text at the caret) and `Close`.
  - ⊞ `Open in Editor Tab`: moves the result into its own editor tab `<title> [<ds>]` with the same `DataGrid`, like DataGrip's detached result.
  - `DDL`: enabled when `tab.meta` has a single `tableRef`; opens `openDdl`.
  - Read-only results: render neither the edit group nor `DDL`. Editable results keep them; they are disabled until there are pending changes.
  - Tooltips: use the shared tooltip component. bg `#393B40`, radius 6, Inter 13 `#DFE1E5`, the shortcut gray 8 px after the text, about 1 s delay.
  - Auto Refresh (clock) menu: `Off` / `5 s` / `10 s` / `30 s` / `1 min` / `Custom…`. It re-runs the result's statement on the console session while the tab is visible.
- **Files:** `src/features/output/OutputToolbar.tsx`, `src/components/grid/GridToolbar.tsx`, `src/features/output/model.ts`, `src/features/table/Popups.tsx` (`SqlPopup`).

---

## Medium

### CON-05 Failed statement: no editor error banner, and the Output switches to the log  — Impact: Medium  — Effort: S
- **Area:** error state.
- **DataGrip reference:** `121-query-error-result-dark.png`, `121b-query-error-output-tab-dark.png` (GAP-CAPTURES 121).
- **Ours now:** `121-query-error-result-dark.png`.
  - The error shows as a red tooltip under the statement (`errors.ts`).
  - `session.run` ends with `if (first) out.select("output")`, so the panel always jumps to the Output log, even on a failed SELECT.
  - The log line lacks the vendor code: `[SQLITE_ERROR] …` instead of `[1] [SQLITE_ERROR] …`.
- **Should:**
  - On error, dock a red banner at the **bottom of the editor island**, full width, 32 px. bg `#5E2C2E` (≈ theme `Banner.errorBackground`), 1 px top border `#7A3B3D`.
  - Banner content: the first line of the message (Inter 13, `#DFE1E5`), then a right-aligned blue `Copy` link and ×. It is dismissed on × or on the next run.
  - Keep the previous result tab selected when the run produced no result set **because of an error**. Switch to Output only when the statements succeeded without rows (UPDATE / DDL).
  - Prefix the error with the vendor code when the driver gives one: `[<code>] [<SQLSTATE>] message`. SQLite gives the extended result code, for example `[1] [SQLITE_ERROR]`; PG gives `[42P01] ERROR: relation "x" does not exist`.
  - The inline tooltip stays, on hover only.
- **Files:** `src/features/console/session.ts`, `ConsoleView.tsx` (banner slot), `src/features/console/console.css`, `crates/dbcore/src/exec.rs` (error code in the `error` event).

### CON-06 Alt+Enter intentions and gutter bulb missing  — Impact: Medium  — Effort: M
- **Area:** intentions and quick-fixes.
- **DataGrip reference:** `116-editor-alt-enter-intentions-dark.png` (GAP-CAPTURES 116); a yellow bulb on the caret line is visible in `40-…`, `120-…` and `122-…`.
- **Ours now:** MISSING. Alt+Enter is unbound in the editor and there is no bulb.
- **Should:**
  - **Bulb:** in the 16 px gutter column after the line numbers, on the caret line.
    - Yellow (`#F2C55C`) when intentions exist.
    - Red (`#F75464`) when the caret is on a problem (CON-02).
    - Clicking it opens the popup.
  - **Alt+Enter:** opens the list under the caret.
    - Row and popup style: 24 px rows, popup style of §8, first row preselected with `#2A4371`, speed search by typing, Esc closes.
    - Footer: `Press Ctrl+Q to toggle preview`, only when CON-04 exists.
  - **In-scope intentions:**
    - Unresolved name: `Refresh schema` (re-introspect the ds), `Change to '<closest name>'` (Levenshtein ≤ 2 against `schemaIndex`), `Choose schema ›` (schemas of the ds; sets the console schema).
    - Any identifier: `Quote identifier` / `Unquote identifier`.
    - On `*`: `Expand column list`.
    - On a statement: `Run query in console` (= Execute).
  - **Alt+Shift+Enter:** applies the first fix directly.
  - The CON-02 tooltip links `More actions… Alt+Enter` open the same list.
- **Files:** new `src/components/editor/intentions.ts`, `gutter.ts`, `SqlEditor.tsx`, `src/features/console/session.ts` (Choose schema).

### CON-07 Query parameters (`?`, `:name`, `$1`) are sent as-is: there is no parameter prompt  — Impact: Medium  — Effort: M
- **Area:** execution.
- **DataGrip reference:** map §4 console toolbar `(P) View Parameters`. DataGrip asks for the values before it runs a statement with parameters.
- **Ours now:**
  - `semantic.ts` only colors `param` tokens. `session.run` passes the text unchanged, so the run fails with a server error.
  - There is no (P) button.
- **Should:**
  - Before `execute`, detect the parameters with the lexer: `?`, `:name`, `$1`, `${name}` and `#name#`. Ignore those in strings and comments, and PG `::` casts.
  - If any exist, open a `Parameters` dialog:
    - A 3-column table `Name | Value | Type`. Inline-edited values are remembered per console and name. The value is SQL text: `'abc'`, `42`, `null`.
    - Buttons `Execute` (primary) / `Cancel`.
  - Substitute textually (DataGrip's default "inline" mode) and log the substituted SQL.
  - Toolbar (P) `View Parameters` opens the same table without executing.
- **Files:** `src/features/console/session.ts`, new `src/features/console/params.tsx`, `src/components/editor/lexer.ts`, `ConsoleToolbar.tsx`.

### CON-08 Live templates (Ctrl+J, abbreviation + Tab) do not exist  — Impact: Medium  — Effort: M
- **Area:** editor productivity.
- **DataGrip reference:** `119-editor-parameter-or-live-template-dark.png`, `119b-editor-live-template-variable-dark.png` (GAP-CAPTURES 119).
- **Ours now:** MISSING. Ctrl+J does nothing. `sel` + Tab only completes the keyword `select`.
- **Should:**
  - **Ctrl+J:** opens a list in the completion popup style.
    - Each row: a template icon, the abbreviation on the left, the description right-aligned in gray mono.
    - The first row is preselected and typing filters the list.
  - **Built-in set** (from 119):

    | Abbreviation | Description |
    |---|---|
    | `col` | new column definition |
    | `del` | delete rows from a table |
    | `ins` | insert rows into a table |
    | `joinab` | join two tables |
    | `lim` | limit |
    | `sel` | select all rows from a table → `select *\nfrom $table$;` |
    | `selc` | select count |
    | `selw` | select with where |
    | `tab` | new table definition |
    | `upd` | update rows |
    | `view` | new view definition |

  - **Expansion:**
    - Typing an abbreviation + Tab expands it.
    - The caret goes to the first variable, and table completion opens there (`$table$`).
    - Tab moves to the next variable; Esc leaves template mode.
    - The inspection widget shows `Paused…` during template mode.
  - The abbreviations also appear in normal completion with a template icon.
  - Use CodeMirror `snippet()`/`snippetCompletion`.
- **Files:** `src/components/editor/complete.ts`, new `src/components/editor/templates.ts`, `SqlEditor.tsx`.

### CON-09 Query History is a flat popup, not DataGrip's two-pane list + preview dialog  — Impact: Medium  — Effort: S
- **Area:** Query History (Ctrl+Alt+E).
- **DataGrip reference:** `101-query-history-popup-dark.png` (GAP-CAPTURES 101).
- **Ours now:** `101-query-history-popup-dark.png`.
  - A 760 px popup with an always-visible Search field.
  - The list is newest-first, with timestamps and failed runs in red.
  - The preview is a single wrapped line plus `0 ms, 40 rows`.
  - The footer hint is `Press Enter to insert…`. There are no buttons.
- **Should:** a modal dialog of about 500×520 placed over the editor.
  - **Left pane** (≈145 px, resizable): the entries **oldest at the top, latest at the bottom and preselected**. Mono 13, 24 px rows, truncated, with a horizontal scrollbar.
  - **Right pane:** a read-only `SqlEditor` with the gutter, showing the full syntax-highlighted SQL of the selected entry.
  - **Speed search instead of a permanent field:** typing shows a field with a magnifier and × above the list, filters the list and highlights matches in orange. The first Esc clears the search; the second Esc closes.
  - **Buttons:** `Paste` (primary, default: inserts at the caret) and `Close`.
  - Keep our timestamp and error color as a gray suffix and red text, since they add value without changing the layout.
- **Files:** `src/features/console/history.tsx`, `src/features/console/console.css`.

### CON-10 Explain Plan is absent (toolbar, editor menu, result tab)  — Impact: Medium  — Effort: L
- **Area:** Explain Plan.
- **DataGrip reference:** `135-explain-plan-dark.png` (GAP-CAPTURES 135), console toolbar icon 2 in `04-crop-editor-tabs-and-console-toolbar-dark.png`.
- **Ours now:** MISSING. There is no action and no backend support. Note: `datagrip-map.md` "Omitted" lists Explain Plan as "Not in v1 scope though operative". **Coordinator decision needed.**
- **Should (if accepted):**
  - Console toolbar: a button after ▶ (DB-with-magnifier icon, open-licensed) with a menu `Explain Plan` / `Explain Analyse`. It is also in the editor context menu (CON-01).
  - The backend runs `EXPLAIN (FORMAT JSON)` / `EXPLAIN (ANALYZE, FORMAT JSON)` on PG, `EXPLAIN FORMAT=JSON` on MySQL and `EXPLAIN QUERY PLAN` on SQLite, on the console session.
  - Output gets a `Query Plan` tab (plan icon):
    - a tree-table with columns `Operation | Params | Rows | Total Cost | Startup Cost | Raw Desc`, all nodes expanded, the root preselected
    - a right `Property | Value` pane for the selected node
    - a left vertical toolbar with Copy
- **Files:** `crates/dbcore/src/exec.rs` (+ a new explain module), `src-tauri` command, `src/features/console/ConsoleToolbar.tsx`, `src/features/output/` (new `PlanView.tsx`).

### CON-11 Console toolbar lacks the In-Editor Results toggle and the Playground/Script resolve-mode widget  — Impact: Medium  — Effort: M
- **Area:** console toolbar.
- **DataGrip reference:** `04-crop-editor-tabs-and-console-toolbar-dark.png`, `45-console-file-resolve-mode-menu-dark.png`, map §4 table.
- **Ours now:** `04-…`: ▶ | history, gear | `Tx: Auto ⌄` ■ … schema. `45-…` is MISSING.
  - Our ▶ … gear group uses a 26 px pitch. It matches DataGrip.
- **Should:** DataGrip's toolbar order is ▶, explain (CON-10) | 🕘, (P) (CON-07), ⚙, ▭ In-Editor Results | `Tx: Auto ⌄`, ■ | `Playground ⌄`. Skip the AI glyph.
  - **In-Editor Results (toggle):** results render inline under the statement in the editor, as a block widget (max 10 rows, with its own mini grid toolbar), instead of in Database Output. The state is remembered per console.
  - **`Playground ⌄`:** a menu with section `File Resolve Mode`: `Script` / `✓ Playground`, and the hint `Sequence of statements forming a coherent SQL script` (Script) or `Independent statements…` (Playground).
    - In Script mode, objects created earlier in the file (`CREATE TABLE`, `CREATE VIEW`, CTE-like temp tables) resolve in later statements for completion and inspections.
    - In Playground mode each statement resolves only against the database.
- **Files:** `src/features/console/ConsoleToolbar.tsx`, `src/components/editor/semantic.ts` / `schemaIndex.ts` (script-local objects), `SqlEditor.tsx` (inline results widget).

### CON-12 Editor tabs: no split, no reopen closed tab; tab menu has 4 items  — Impact: Medium  — Effort: M
(May overlap with the shell auditor; it is listed here because it is about console tabs.)
- **Area:** editor tab context menu and split.
- **DataGrip reference:** `113-editor-tab-context-menu-dark.png`, `133-split-editor-dark.png` (GAP-CAPTURES 113/133).
- **Ours now:** `113-…`: Close / Close Other Tabs / Close All Tabs / Pin Tab (`src/components/shell/EditorArea.tsx`). `133-…` MISSING.
- **Should:**
  - **Tab menu groups:**
    1. `Close  Ctrl+F4`, `Close Other Tabs` (disabled with one tab), `Close All Tabs`, `Close Tabs to the Left/Right`
    2. `Copy Path/Reference…`
    3. `Split Right`, `Split Down`
    4. `Pin Tab`, `Configure Editor Tabs…` (only if a settings page exists)
    5. `Reopen Closed Tab  Ctrl+Shift+T`
    6. `Rename File…` (console rename)
  - **Split:** both panes are in **one** editor island, divided by a 1 px `#26282C` line.
    - Each pane has its own tab strip with ⋮ and its own full console toolbar.
    - Both panes share the same document (one CodeMirror state per file, two views).
    - The new pane takes focus. Closing the last tab of a pane removes the split.
    - The timing inlay shows only in the pane where the statement ran.
- **Files:** `src/components/shell/EditorArea.tsx`, `src/state/tabs.ts`, `src/features/console/ConsoleView.tsx`, `src/state/core-actions.ts`.

### GRID-03 Cell context menu misses DataGrip's local-filter, aggregate, SQL-expression and navigation items  — Impact: Medium  — Effort: M
- **Area:** grid cell context menu.
- **DataGrip reference:** `108-grid-cell-context-menu-dark.png` (GAP-CAPTURES 108).
- **Ours now:** `108-…`.
  - Edit Cell, Show Value Editor, Set NULL, Set DEFAULT | Add/Clone/Delete Rows, Revert | Copy, Copy As ›, Paste | Select All | Transpose, Show Record View, Manage Columns…, Reload Page (`DataGrid.tsx` `bodyMenu`).
  - There are no icons.
- **Should:** DataGrip order with separators and icons (open-licensed, same meaning):
  1. `Edit  Enter`
  2. `Show Record View  Ctrl+Shift+Enter`, `Open in Value Editor  Shift+Enter`, `Show Aggregate View` (opens the side panel on the Aggregates tab)
  3. `Revert Selected  Ctrl+Alt+Z`
  4. `Edit as SQL Expression` (the cell editor accepts raw SQL such as `now()`, shown as `fx`), `Set SQL Expression ›` (`NULL  Ctrl+Alt+N`, `DEFAULT  Ctrl+Alt+D`, `now()` / `current_timestamp` for date columns), `Load File…` (text/blob columns only; reads the file into the cell)
  5. `Copy  Ctrl+C`, `Copy As ›` (keep), `Change Data Extractor (CSV) ›`, `Copy Aggregation Result (SUM)  Ctrl+Shift+C`
  6. `Add Row  Alt+Insert`, `Delete Row  Ctrl+Y`, `Clone Row  Ctrl+D`
  7. `Go To ›` (GRID-06)
  8. `Export Table to Clipboard`
  9. `Set Local Filter`, `Local Filter By Cell Value` (filter to rows equal to the active cell's value; same green-dot funnel)
  10. `Quick Documentation  Ctrl+Q` (column doc)
  - Keep `Paste` and `Select All` in group 5. The menu opens at the pointer and is shifted up when it does not fit, never flipped.
- **Files:** `src/components/grid/DataGrid.tsx`, `GridMenu.tsx`, `SidePanel.tsx`, `localFilter.ts`, `aggregates.ts`.

### GRID-04 Column header menu: wrong item set, and right-click selects the whole column  — Impact: Medium  — Effort: M
- **Area:** grid header context menu, sorting.
- **DataGrip reference:** `109-grid-column-header-context-menu-dark.png` (GAP-CAPTURES 109), map evidence §5 (`ColumnSortReset Ctrl+Alt+Shift+Backspace`).
- **Ours now:** `109-…`.
  - Right-click **selects the column** (the email column turns blue).
  - Menu: Sort Ascending / Sort Descending / Clear Sorting | Copy Column Name, Copy, Copy As › | Fit Column Width, Hide Column, Show Hidden Columns ›.
  - Multi-sort is Ctrl/Shift+click (`DataGrid.tsx` line 1835). No sort shortcut exists in `onKeyDown`, and Ctrl+Alt+Shift+Backspace is menu-only.
- **Should:**
  - Right-click keeps the current selection.
  - `Copy Column Name` is preselected (highlighted without hover).
  - Items:
    1. `Copy Column Name`, `Select Column  Ctrl+W`
    2. `Pin Column`, `Pin Columns Up to Here` (frozen columns: sticky at the left after the row-number gutter, 1 px `#393B40` right border)
    3. `Hide Column`, `Hide Other Columns`, `Manage Columns…  Ctrl+F12`
    4. `Fit Columns to Window`, `Reset Columns Width  Ctrl+Alt+Shift+Up`
    5. Section header `ORDER BY` (small gray): `Ascending  Alt+Shift+Up`, `Descending  Alt+Shift+Down`
    6. Section header `Add to ORDER BY`: `Ascending  Alt+Click`, `Descending  Alt+Double Click` (disabled while there is no sort)
    7. `Set Local Filter`
    8. `Clear Sorting  Ctrl+Alt+Shift+Backspace`
  - Multi-sort with **Alt+Click** on the header sort toggle, not Ctrl/Shift.
  - Bind `Alt+Shift+Up/Down` and `Ctrl+Alt+Shift+Backspace` in the grid keydown.
  - Header hover tooltip `status: TEXT` (`name: TYPE`).
- **Files:** `src/components/grid/DataGrid.tsx` (`headerMenu`, header click handler, `onKeyDown`, sticky columns), `grid.css`.

### GRID-05 Data extractor chooser has 5 formats; DataGrip's "Data Extractors" popup has sections and more formats  — Impact: Medium  — Effort: M
- **Area:** extractors (toolbar `CSV ⌄`, Copy As, Export).
- **DataGrip reference:** `110-grid-data-extractor-menu-dark.png` (GAP-CAPTURES 110).
- **Ours now:** `110-…`: a plain menu ✓CSV / TSV / JSON / SQL Inserts / Markdown (`src/features/output/export.ts` `FORMATS`).
- **Should:** a popup titled `Data Extractors`, anchored under the button and right-aligned. The first item is preselected and the current one has ✓.
  - Section `Built-in`: `SQL Inserts`, `SQL Updates` (`UPDATE t SET … WHERE <pk> = …`), `Where Clause` (`WHERE (id, …) IN (…)` / `id = 1 OR …`), then the toggles `✓ Skip Computed Columns` and `Skip Generated Columns`.
  - Section `CSV`: `CSV`, `TSV`, `Pipe-separated`, `Semicolon-separated`, `Configure CSV Formats…` (a small dialog: name, value separator, row separator, quote, NULL text, header line).
  - Section `Other` (our own built-ins in place of DataGrip's Groovy/JS "Scripted" ones): `HTML`, `JSON`, `Markdown`, `One-row`, `Pretty` (aligned text table), `SQL-Insert-Multirow`, `XML`. No "Go to Scripts Directory".
  - The chosen extractor drives Ctrl+C, Copy As, the Export dialog (GRID-01) and the toolbar label (`SQL` for SQL Inserts, as now).
- **Files:** `src/features/output/export.ts`, `crates/dbcore` export (new formats), `src/api/types.ts` (`ExportFormat`), `src/components/grid/copy.ts`.

### GRID-06 No foreign-key navigation from cells (Go To › Related / Referenced rows, F4)  — Impact: Medium  — Effort: M
- **Area:** grid navigation.
- **DataGrip reference:** `108-…` `Go To ›`, map evidence §4.5 (`Related Rows`, `Go to Referenced Result`) and §5 (`NavigateAction F4`).
- **Ours now:** none. `DataGrid.tsx` has no F4 handling and no FK metadata use.
- **Should:**
  - On a cell of an FK column (the column icon already shows FK), **F4** or `Go To › Referenced Row` opens the referenced table filtered to that row: a table data editor with `WHERE id = <value>`, or a new pinned result tab.
  - On a PK cell, `Go To › Related Rows ›` lists each referencing table (`orders.customer_id`). It opens that table filtered with `WHERE customer_id = <value>`.
  - The submenu items show the target `table (column)`.
- **Files:** `src/components/grid/DataGrid.tsx`, `src/features/output/OutputToolbar.tsx` / `ResultView.tsx`, `src/features/table/TableView.tsx` (open with a filter), `src/features/explorer` (FK metadata).

### GRID-07 Date/time and boolean cells have no dedicated editor  — Impact: Medium  — Effort: M
- **Area:** inline editing.
- **DataGrip reference:** `132-grid-date-cell-editor-dark.png`, `132-grid-boolean-cell-dark.png` (GAP-CAPTURES 132).
- **Ours now:** `132-…` PARTIAL. Both are a plain text field (`DataGrid.tsx` cell editor).
- **Should:**
  - **date / timestamp / time:**
    - The in-cell text editor (caret where clicked) gets a `…` button at the cell's right end that opens the value editor.
    - A date/time picker panel attaches below the cell:
      - row 1: day combo, month combo (`November`), year spinner
      - row 2: `HH : mm : ss` spinners
      - The same field and spinner styles as the dialogs (28 px, `#40434A` border, radius 4).
    - Fractional seconds stay in the text and are not shown in the picker.
    - Esc closes without a change; Enter commits.
  - **boolean:**
    - Display `true` with a `•` bullet before it (map §6), centered.
    - Double-click selects the cell and opens a small list under it: `true` / `false` / `default`. `true` is highlighted first. Esc cancels.
    - Space toggles the value.
- **Files:** `src/components/grid/DataGrid.tsx`, new `src/components/grid/DateEditor.tsx`, `grid.css`, `src/components/grid/format.ts`.

### GRID-08 Console results page by infinite scroll; the pill never shows "N+" and its page menu is all disabled  — Impact: Medium  — Effort: S
- **Area:** paging pill.
- **DataGrip reference:** `56-grid-rows-pill-page-size-menu-dark.png`, `120-…` (pill `0 rows ⌄ | of 0+ | ⋮`), map §5 "Paging", evidence §4.2 (`of {0}`).
- **Ours now:**
  - `ResultView.tsx` passes neither `onNextPage` / `onPreviousPage` / `onFirstPage` / `onLastPage` nor `totalRows`. The ⋮ menu (First / Previous / Next / Last Page) is entirely disabled.
  - The label says `500 rows` while more rows exist (more load on scroll).
  - Ctrl+Alt+Up/Down are registered only for the table editor (`table/actions.ts`, `when: focused`).
- **Should:**
  - While `hasMore`, the label is `500 rows ⌄ | of 500+` (gray `of N+` segment). After Count Rows it becomes `of 1,234`.
  - Next / Previous / First / Last Page and Ctrl+Alt+Down / Ctrl+Alt+Up work in console results:
    - next = fetch the next page on the open cursor and show rows 501–1000
    - previous / first = re-run
    - last = `loadAll` then show the last page
  - Keep infinite scroll only when the page size is `All`.
  - The pill must not cover the last row: add a 40 px bottom scroll padding.
- **Files:** `src/features/output/ResultView.tsx`, `model.ts`, `src/components/grid/GridToolbar.tsx` (`GridPagingPill`), `src/features/console/actions.ts` (page actions with `when: inConsoleArea`).

### GRID-09 Status bar shows no aggregator or row:col for console result grids  — Impact: Medium  — Effort: S
- **Area:** status bar while in a result grid.
- **DataGrip reference:** `57-grid-sorted-selected-cell-dark.png`, map §6 last row, `98-grid-aggregates-tab-dark.png` (`SUM: …`).
- **Ours now:** `57-…`: the console tab keeps the editor caret. `TableView.tsx` sets `aggregator`, but `ResultView` / `DataGrid` in Output never call `setStatus`.
- **Should:** when a console result grid has focus, the status bar shows:
  - `No aggregator selected` for a single cell
  - `SUM: <n>` (or the chosen aggregator) for a multi-cell numeric selection; `SUM: Not enough values` otherwise
  - `<row>:<col>` of the active cell
  - When the editor regains focus, restore the editor caret.
  - Clicking the aggregator widget opens the aggregator list (`SUM`, `AVG`, `COUNT`, `MAX`, `MIN`, `MEDIAN` …) and the choice is remembered.
- **Files:** `src/features/output/ResultView.tsx`, `src/components/grid/DataGrid.tsx` (selection callback), `src/state/status.ts`.

---

## Low

### CON-13 Error stripe identifier marks are purple in dark (CSS override bug)  — Impact: Low  — Effort: S
- **Area:** editor right stripe.
- **DataGrip reference:** `40-console-editor-sql-highlighting-dark.png`. The marks for occurrences of `c` are `#5B786A` (sampled 91,120,106).
- **Ours now:** `40-…` marks are `#D0A1FF` (lavender).
  - In `src/components/editor/editor.css` (lines ~298–309), the light override block repeats `.sql-editor .cm-stripe-id { background: #d0a1ff; }` **without** the `:root[data-theme="light"]` prefix. It therefore overrides the dark `#5b786a` in both themes.
  - The duplicated `.cm-stripe-range` light rule is harmless.
- **Should:** prefix the second `.cm-stripe-id` rule with `:root[data-theme="light"]`. Dark `#5B786A`, light `#D0A1FF`.
- **Files:** `src/components/editor/editor.css`.

### CON-14 Tx isolation list: "Read Uncommitted" shown instead of "Database Default"; Tx combo stays active while running  — Impact: Low  — Effort: S
- **Area:** Tx widget.
- **DataGrip reference:** `44-console-tx-mode-menu-dark.png`, evidence §4.4.
- **Ours now:** `44-…`:
  - The isolation list is Read Uncommitted / ✓Read Committed / Repeatable Read / Serializable.
  - The menu is wider than 210 px, and the footer wraps as `…the datab / auto-committed`.
- **Should:**
  - The list is `Database Default` (the session goes back to the server's default level; this is the initial ✓ for a new console), then Read Committed / Repeatable Read / Serializable. Add Read Uncommitted only for MySQL, where it is real.
  - The menu is 210 px wide. The footer hint is wrapped on two lines exactly as `Changes submitted to the` / `database are auto-committed` (gray Inter 12).
  - Disable the combo while a statement runs.
- **Files:** `src/features/console/session.ts` (`ISOLATIONS`, `openTxMenu`), `src/components/ui/Menu.tsx`.

### CON-15 Schema switcher popup: missing hint row and DataGrip's icon  — Impact: Low  — Effort: S
- **Area:** schema switcher.
- **DataGrip reference:** `46-console-schema-switcher-popup-dark.png`.
- **Ours now:** `46-…`: a single `[db icon] postgres ›` row and no hint.
- **Should:**
  - Rows show no leading icon for the database level, as in DataGrip.
  - Add a gray non-selectable hint row `Connect to database (Enter)` below a hairline.
  - The popup's width follows the content (≈230 px) and its left edge aligns with the widget.
- **Files:** `src/features/console/session.ts` (`openSchemaMenu`).

### CON-16 Completion popup details  — Impact: Low  — Effort: S
- **Area:** completion.
- **DataGrip reference:** `42-console-completion-popup-tables-dark.png`, `43-…columns…`, `139-completion-light.png`, map §4 "Completion popup".
- **Ours now:** `42-…` / `43-…` / `139-…`. The look is near 1:1. Differences:
  - The footer has no ⋮ at the right.
  - After `i.` only columns are offered (DataGrip also lists functions after the columns).
  - After `schema.` there is no `cast … CAST('foo' as JSON)` snippet row.
  - Sequences are sorted before `ticket_seq` (DataGrip order: tables, views, sequences in introspection order, then routines, then keywords).
- **Should:**
  - Add a ⋮ to the 24 px footer, opening `Sort by name` / `Show types`.
  - Append function entries (boost below columns) after a qualifier.
  - Keep the `cast` snippet in every expression context.
  - Do not invent other "Next Tip" content (out of scope).
- **Files:** `src/components/editor/complete.ts`, `editor.css`.

### CON-17 Find/Replace bar is missing several controls  — Impact: Low  — Effort: S
- **Area:** Ctrl+F / Ctrl+R.
- **DataGrip reference:** `118-editor-find-replace-bar-dark.png` (GAP-CAPTURES 118).
- **Ours now:** `118-…`: search field with Cc / W / .*, `1/2`, ↑ ↓ ×; replace row with `Replace` / `Replace all`.
- **Should:**
  - **Row 1:**
    - a collapse chevron ⌄ at the left (it toggles the replace row: Ctrl+F ↔ Ctrl+R)
    - the search field with a magnifier + history ⌄ (last 20 queries) and a clear ×
    - toggles `New line` (Ctrl+Shift+Enter inserts \n), `Cc`, `W`, `.*` (pressed `#2E4D89`)
    - the `1/3` counter, ↑ ↓, a funnel (search only in comments / string literals / except them), ⋮
    - the close × **at the far right edge**
  - **Row 2:** the replace field with history, `New line` and `Preserve case (AA)` toggles, buttons `Replace` / `Replace All` / `Exclude`.
  - Esc closes the bar and keeps the current match selected.
  - The status bar shows `1:19 (5 chars)` for a selection.
- **Files:** `src/components/editor/search.ts`, `editor.css`, `src/features/console/ConsoleView.tsx` (selection length in status).

### CON-18 Missing editor shortcuts from the default keymap  — Impact: Low  — Effort: S
- **Area:** keymap (map §9, evidence §5).
- **Ours now:** `SqlEditor.tsx` binds:
  - Ctrl+Enter, Ctrl+/, Ctrl+Shift+/, Ctrl+D, Ctrl+Y, Ctrl+Shift+Z
  - Ctrl+Shift+Up/Down, Alt+Shift+Up/Down
  - Ctrl+Alt+L, Ctrl+W / Ctrl+Shift+W, Ctrl+G
  - Alt+J, Ctrl+Alt+Shift+J, Ctrl+Shift+L
  - Tab / Shift+Tab
  - Ctrl+F / Ctrl+R / F3 (`search.ts`), Ctrl+Space / Tab (`complete.ts`)
  - Not bound: Ctrl+B, Ctrl+Q, Alt+Enter, Ctrl+J, F2 / Shift+F2, Alt+Shift+B, Ctrl+Shift+U, Ctrl+P, Ctrl+Shift+J, Ctrl+Shift+V, Ctrl+Shift+Enter.
- **Should:**
  - The ones with their own items: Ctrl+B and Ctrl+Q (CON-04), Alt+Enter (CON-06), Ctrl+J (CON-08), F2 / Shift+F2 (CON-02), Alt+Shift+B (CON-04).
  - Small editor commands to add:
    - `Ctrl+Shift+U` toggle case of the selection or the word at the caret
    - `Ctrl+P` parameter info for the routine call at the caret (a tooltip with the signature from `functionsFor` / introspected routines)
    - `Ctrl+Shift+J` join lines
    - `Ctrl+Shift+V` paste from history (last 10 clipboard texts)
    - `Ctrl+Shift+Enter` complete statement (add the missing `;` and a newline)
- **Files:** `src/components/editor/SqlEditor.tsx`, `commands.ts`.

### CON-19 No JOIN cardinality inlay hints  — Impact: Low  — Effort: M
- **Area:** inlay hints.
- **DataGrip reference:** `40-console-editor-sql-highlighting-dark.png`. Pills `1<->0..n:` before `ON` (rounded bg `#2B2D30`, 11 px text `#8C8F96`, radius 4, 2 px h-padding).
- **Ours now:** `40-…`: none.
- **Should:**
  - For `JOIN t2 a ON a.fk = b.pk`, when the FK metadata of the two tables links the ON columns, insert the widget `1<->0..n:` (or `0..1<->1:` and the other variants, from FK nullability and uniqueness) before `ON`.
  - Settings toggle: Editor › Inlay Hints › SQL › Join cardinality.
- **Files:** `src/components/editor/semantic.ts`, new `src/components/editor/inlays.ts`, `schemaIndex.ts` (FK info).

### GRID-10 Empty result shows a "No rows" text; Delete and Export stay enabled  — Impact: Low  — Effort: S
- **Area:** empty state.
- **DataGrip reference:** `122-empty-result-dark.png` (GAP-CAPTURES 122).
- **Ours now:** `122-…`: header row, then a gray centered `No rows` (`DataGrid.tsx` `.dgg-empty`), and the pill `0 rows`.
- **Should:**
  - The body stays empty, with no placeholder text.
  - With 0 rows, `Delete Rows` and Export (⤓) are disabled.
  - Keep `Add Row` enabled for editable results.
- **Files:** `src/components/grid/DataGrid.tsx`, `GridToolbar.tsx`, `src/features/output/OutputToolbar.tsx`.

### GRID-11 Output log pane: no layout toggle or print; scrollbar placement  — Impact: Low  — Effort: S
- **Area:** Output tab of Database Output.
- **DataGrip reference:** `52-output-log-pane-dark.png`, `54-output-log-with-update-and-error-dark.png`, map §5 "Output (log) pane".
- **Ours now:** `54-…`:
  - The mini-toolbar is `Tx.` ■ only.
  - The right vertical toolbar is soft-wrap, scroll-to-end, clear. Print is missing.
  - Fetching shows `0 ms` for fast queries. The server time is whole ms, and the client fallback is used only for the total.
- **Should:**
  - Mini-toolbar: `Tx` ▾, ■, and a layout toggle ▭ (`Show Output tab alongside results` / `Output in a separate tab`).
  - Right toolbar: soft-wrap, scroll-to-end, print (the browser print of the log text), clear (trash).
  - Show fetching as `< 1 ms`, never `0 ms`, when execution + fetching < 1 ms. This matches DataGrip's `formatDuration`; a real `0 ms` never appears in its logs.
- **Files:** `src/features/output/OutputToolbar.tsx` (`LogToolbar`), `LogView.tsx`, `format.ts`.

### GRID-12 Manage Columns and header: no drag reorder, pin, or "Show all"  — Impact: Low  — Effort: M
- **Area:** Manage Columns popup and header.
- **DataGrip reference:** `98-grid-manage-columns-dark.png`, `datagrip-map.md` "Grid views › Manage Columns".
- **Ours now:** `98-…`: rows with a checkbox, icon, name and type. There is no drag handle, no pin icon and no `Show all` link. Header columns cannot be dragged to reorder (`DataGrid.tsx` has resize only).
- **Should:**
  - In the popup, hovering a row shows a pin icon and a drag handle (reorder).
  - Footer: `N of M visible` at the left; `Show all` (only when something is hidden) and `Hide all` at the right.
  - Header: drag a column header horizontally to reorder. It shows a 2 px `#3574F0` insertion line and keeps the order per result tab.
  - Pin is shared with GRID-04.
- **Files:** `src/components/grid/ManageColumns.tsx`, `DataGrid.tsx`, `grid.css`.

### GRID-13 Local filter popup footer never shows the match count  — Impact: Low  — Effort: S
- **Area:** column funnel popup.
- **DataGrip reference:** `98-grid-local-filter-popup-dark.png`, `111-grid-column-filter-popup-dark.png`.
- **Ours now:** `98-…` / `111-…`: the footer is always `Select a checkbox to filter rows`.
- **Should:**
  - After the first tick, the footer is `Number of matches N`, where N is the rows matching every active column filter.
  - Typing in the search field filters the values immediately.
  - Esc closes at once and clears the typed text.
- **Files:** `src/components/grid/LocalFilterPopup.tsx`, `localFilter.ts`.

---

## Verified as matching (no item)

These are at or near 1:1:
- Execute statement chooser (`41`): fill, popup and `Customize`.
- Statement frame and identifier boxes (`40`).
- SQL palette in dark and light.
- Timing inlay `NNN ms` after statements; gutter ✓ / ! markers.
- Completion look (`42`).
- Tx Manual commit / rollback buttons.
- Output log wording (`54`), except the code prefix (CON-05).
- Result tab replace / pin.
- Pending-change colors and preview (`59`/`60`).
- Inline cell editor (`58`).
- Transpose, Find, Record View, Value, Aggregates, local filter, view-as (`98-*`, `55`).
- Page-size menu (`56`).
- Light grid selection (`137`).

## Could not verify

- Light-theme colors of the grid find-match fill, the record-view panel and the date picker: no Islands Light references exist.
- The light statement-frame color (`#baa8ff` in our CSS): `40-…-light.png` does not show a framed statement.
- DataGrip's exact parameter dialog layout (CON-07) and the In-Editor Results rendering (CON-11): no reference screenshots. The specs are based on known IntelliJ behavior.
- Whether DataGrip 2026.3 offers Read Uncommitted for MySQL (CON-14): the evidence lists the bundle key, but the only screenshot is PG.
