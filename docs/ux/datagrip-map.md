# DataGrip 2026.3: pixel-level UX map for the Prometeo rebuild

Reference build: **DataGrip 2026.3** (snap rev 326), Linux/X11, **New UI** with the default theme **"Islands Dark"** (also checked: "Islands Light"), keymap **XWin** (Linux default, same IDs as `$default`).

## How this was captured

- DataGrip ran on a private display (Xvfb `:8`, 1920x1080, 24-bit) under a private i3. The main window was a fixed **1600x1000**, at 0,0, with no window-manager border.
- The UI font was Inter 13 at scale 1.0 (no HiDPI), so **1 screenshot px = 1 CSS px**.
- Colors were sampled from screenshot pixels with PIL.
  - Solid fills (backgrounds, selections, borders) are exact.
  - Text colors are less reliable. Java renders text with LCD sub-pixel antialiasing, so sampled text colors are approximate (marked `~`).
  - For text, use the theme/scheme values in the evidence section at the end. They were extracted from DataGrip's own jars and agree with every solid fill I sampled.
- Test data:
  - SQLite `/tmp/claude-1000/ux-sample.db`: categories, products, customers, orders, order_items, a view, 3 indexes, a trigger and a check constraint; about 250 rows.
  - PostgreSQL 16 container with schemas `sales` and `inventory`: tables, a view, a function and sequences.
- Marked **(guess)** = estimated, not measured.
- All screenshots are in `screens/`. Names starting with `NN-crop-…` are zoomed detail crops (x2/x3 means nearest-neighbour upscale).

> **Big 2026.3 differences from older DataGrip** (screens you may know from 2023/2024):
> 1. **Islands layout.** Every tool window and the editor is a separate rounded "island" (`#191A1C`) floating on a darker window background (`#26282C`) with gaps of about 5–7px.
> 2. **No left/right stripe column in the default layout.** The tool-window buttons live in the **center of the main toolbar**: Database Explorer, Database Output, Files, Agent Sessions, and "…" for more tool windows.
> 3. **Query results moved from "Services" to a new "Database Output" tool window.** It has an *Output* tab plus result tabs. Session management stays in Services.
> 4. **Paging moved** from a "1-500 of 500" toolbar widget to a **floating pill "18 rows ⌄"** at the bottom center of the grid.
> 5. The **filter field lives in each column header** (funnel icon). A table data editor still has the classic **WHERE / ORDER BY** bar.

---

## 1. Main window shell

Screens: `01-main-window-dark.png`, `01-main-window-light.png`, `02-main-after-adding-sources-introspecting-dark.png`, `03-crop-main-toolbar-dark.png`, `03b-…x3`, `03c-…x3`, `05-crop-statusbar-dark.png`, `06-statusbar-introspection-progress-dark.png`, `00-welcome-empty-project-dark.png`.

### Layout geometry (window 1600x1000)

| Region | Measured |
|---|---|
| Window background (behind the islands, toolbar, status bar) | `#26282C` dark / `#E9EAEE` light |
| Main toolbar | y **0–42 (43px)**, full width, no bottom border. A project-color gradient tint fades from the left (green-olive for project "default": about `#3D472F` at x=0 to `#26282C` near x≈700). Light: a pale green tint. |
| Islands (tool windows, editor) | background `#191A1C` dark / `#FFFFFF` light. Corner radius about **10–12px visually** (theme `Island.arc`=20, which is a diameter). |
| Island outer margins | left **7px** (x 0–6 is window bg), top starts at y=**43**, bottom island edge at y≈965 |
| Gap between islands | **5px** horizontal (e.g. x 498–502) and about 5px vertical between the editor and the bottom panel (y≈478–483). Theme `Island.borderWidth`=6. |
| Status bar | y **966–999 (34px)**, bg = window bg `#26282C`, no top border |
| Splitters | invisible: the gap between islands is the splitter (drag anywhere in the 5px gap). Cursor changes to resize. |

### Main toolbar (left to right)

- **Hamburger "Main Menu"** at x≈8–33, a 22x22 icon in a 30x30 hit area. Tooltip `Main Menu Alt+\`. Clicking it *expands the menu bar inline* into `File Edit View Navigate Run VCS Window Help` and opens File (`93-main-menu-file-dark.png`).
- **Project widget**: a 20x20 rounded square with the project initial (`D`, white on green `#8EA859`, radius 4), then the text `default` and a chevron ⌄. Text is Inter 13, about `#DFE1E5`.
- **`Version Control ⌄`** widget. Text only, same style.
- **Center: tool-window buttons.** 30x30 each, icon 16–20px, pitch **40px** (centers x=722, 762, 802, 842, 882).
  - The buttons: Database Explorer `Alt+1`, Database Output `Alt+8`, Files `Alt+4`, Agent Sessions `Alt+2`, More tool windows `…`.
  - A **visible/active** tool window's button has a filled rounded rect `#393A3E` (radius 6).
  - Hover is `#FFFFFF17` over the bg (≈`#2D2E2F` on islands, `#393A3E` on the toolbar).
- **Right side**:
  - `✳ New Session ⌄`: AI agent, out of scope.
  - **Search** 🔍 at x≈1540. Tooltip `Search Everywhere Shift Shift`.
  - **Gear** at x≈1580 (`IDE and Project Settings`). It opens a menu: `Settings… Ctrl+Alt+S`, `Plugins…`, `Backup and Sync… Off`, `Theme…`, `Keymap…`, `View Mode…`, `Customize Main Toolbar ›` (`92-settings-gear-menu-dark.png`).
- **Window controls.** None are drawn on Linux under a tiling WM. With a normal WM, JetBrains draws min/max/close at the far right in the toolbar, as 40x40 buttons (`TitlePane.Button.preferredSize 40,40`) **(guess)**.

### Left/right tool-window stripes

- **Not present** in the 2026.3 Islands default: the buttons are in the main toolbar (see above).
- If the rebuild wants classic stripes, use these values from the theme jar **(not observed)**:
  - stripe button 37x40, icon 20px
  - selected button: solid `#3871E1` with a white icon

### Tool-window header (Database Explorer, Database Output)

- Height **40px** (y 43–82). A 1px bottom border `#26282C` follows at y=83.
- Title is bold-ish Inter 13 (`Database Explorer`, about `#DFE1E5`), at x=19, baseline about y 68.
- Header actions appear **only on hover or focus** of the tool window. Each is 22x22, at 26px pitch, right-aligned:
  - Select Opened File (crosshair)
  - Expand All
  - Collapse All
  - Options (⋮)
  - Hide (—, `Shift+Escape`)

### Status bar

- Left: **navigation breadcrumbs**, Inter 12 about `#9A9DA3`, separated by `›`, with object icons. Example: `Database › postgres@localhost › postgres › sales › tables › ▦ invoices`.
- Right, items about 12px apart:
  - Aggregator text in the grid (`No aggregator selected`)
  - Caret position `8:10`
  - `LF`, `UTF-8`, `4 spaces`
  - AI icon, read-only lock, notifications bell (a blue dot when unread)
  - `Trial` pill (license, out of scope)
- **Background task**: `Performing complete introspection (SQLite)`, a 100px blue progress bar (`#3871E1` on `#43454A`), a cancel ⊗ and `+4` (`06-…`).

---

## 2. Database Explorer tool window

Screens: `12-dbexplorer-tree-sqlite-expanded-focused-dark.png`, `13-…unfocused…`, `14-dbexplorer-tree-postgres-expanded-dark.png`, `19-crop-dbexplorer-header-toolbar-x2-dark.png`, `19b-crop-dbexplorer-tree-rows-x2-dark.png`, `10-…new-menu`, `11-…new-datasource-submenu`, `15/16/17-…context-menu…`, `18-dbexplorer-speed-search-dark.png`, `20/21-…schema-selector…`.

### Toolbar (y 84–118, 34px tall, under the header)

Icons are 16px, at a 26px pitch starting at x≈20. Groups are split by 1px vertical separators `#323438`, about 16px tall. The icons, in order:

| # | Icon | Tooltip (exact) |
|---|---|---|
| 1 | `+` with a small dropdown triangle | `New` (opens the New popup) |
| 2 | DB cylinder with gear | `Data Sources… Ctrl+Alt+Shift+S` |
| | separator | |
| 3 | circular arrows | `Refresh Ctrl+F5` |
| 4 | red square in a window | `Deactivate Ctrl+F2` (red when connected) |
| | separator | |
| 5 | console `>_` | `Jump to Query Console… Ctrl+Shift+F10` |
| 6 | grid | `Edit Data F4` |
| 7 | text `DDL` | `Go to DDL` |
| 8 | arrows ⇄ | `Compare Schema Structure Ctrl+D` |
| | separator | |
| 9 | eye | `View Options` |
| 10 | AI glyph | `Explore or work with selected database objects using Air (Double Ctrl)`. Out of scope. |

Disabled icons are drawn at about 40% opacity.

### "New" popup (`+`)

- Popup title is centered: `New`.
- Items:
  - `Data Source ›`
  - `Data Source from Cloud Provider ›`
  - `Data Source Templates`
  - `Workspace Data Source [New]`
  - `Data Source from File/Folder`
  - `Data Source from URL`
  - `DDL Data Source`
  - `Import from Clipboard`
  - separator
  - `Folder`
  - `Driver`
- The `Data Source ›` submenu has a section header `Complete Support`, then the DBMS list alphabetically with brand icons: Amazon Aurora MySQL, …, MySQL, Oracle, PostgreSQL, Redis, SQLite, Snowflake, …. Typing filters the list (speed search).

### Empty state (no data sources)

- Small gray section labels: `Create Data Source`, `Connect to Cloud Provider`, `Explore Demo Databases`.
- Each entry is a full-width rounded button:
  - 34px tall, radius 6
  - bg `#26282C`-ish (about 10% lighter than the island)
  - 16px icon, label Inter 13
  - e.g. `PostgreSQL`, `MySQL`, `Microsoft SQL Server`, `All Data Sources ›`
- The editor area shows three large buttons (`New Agent Session`, `New Data Source`, `Online Help`), each 48px tall and radius 8. Below them, a bottom row: `Plugins`, `Theme: Islands Dark ⌄`, `Keymap: XWin ⌄`, `DataGrip on YouTube`.

### Tree rows (measured)

| Property | Value |
|---|---|
| Row height | **24px** |
| Font | Inter 13 regular, text about `#D1D3D9` (theme `Tree.foreground`) |
| Indent per level | **19px** (chevrons at x=23, 42, 61, 81; icons at 42, 60, 79, 98) |
| Chevron | 8x6 px glyph (`›` collapsed, `⌄` expanded), gray about `#9DA0A8`, centered in a 16px box left of the icon |
| Icon | 16x16 box, glyph about 13–15px |
| Icon → text gap | 4–5px |
| Selection (focused) | `#2A4371`. A rounded rect (radius about 4) spanning x **19 → 485**: inset 12px from the island's left edge and about 12px from the right. Text stays the same color. |
| Selection (unfocused) | `#33353B` dark / `#E9EAEE` light |
| Hover | no visible row hover (theme `#FFFFFF10`, effectively invisible) |
| Hint text (column type, counts, signatures) | Inter **11–12px**, `~#6F737A`, 6–8px after the name |

Hint text by node:

- Tables folder: `tables 6`
- Column: `INTEGER` / `integer = nextval('sales.inv…)` (default after `=`)
- Routine: `(cid: integer): numeric`
- FK: `(customer_id) → customers (id)`
- Index: `(customer_id)`
- Check: `(status IN ('new',…)`

Badges after a data-source or database name:

- `1` is a box with a 1px gray border `#43454A`, radius 3, 11px text, 2–4px padding. It means "1 of N schemas shown"; click it to open the schema selector.
- `3 of 5` uses the same style.

### Node hierarchy and icons (as rendered; SVG paths in the evidence section)

- **Data source**: DBMS brand icon (PostgreSQL elephant, SQLite feather). A small green dot is drawn on the icon when connected. A spinner replaces the icon while introspecting.
  - Data source name, e.g. `postgres@localhost`. A new data source is named `<user>@<host>`, or after the file for SQLite.
- **Database** (PG): `postgres 3 of 5`, with a blue cylinder-outline icon.
- **Schema**: `main`, `public`, `sales`, `inventory`. Schema icon (4 small squares and a line).
- **Folders**: blue folder icon (`#548AF7`-ish). Names in lowercase: `tables N`, `views N`, `routines N`, `sequences N`, `columns N`, `keys N`, `foreign keys N`, `indexes N`, `checks N`, `triggers N`.
- **Table**: grid icon. **View**: grid with an eye/link. **Virtual views**: purple folder.
- **Column**: rectangle-with-column icon. Variants:
  - PK = gold key badge
  - FK = blue key badge
  - indexed = small "i" marker
  - NOT NULL = dot
- **Key**: `key #1 (id)` with a gold key icon. Tree names are lowercase and auto-numbered for unnamed SQLite keys. PG shows real names like `invoices_pkey`.
- **Foreign key**: `foreign-key #1 (customer_id) → customers (id)` with a blue key.
- **Index**: `idx_orders_customer (customer_id)` with a thin blue "i" icon.
- **Check**: `check #1 (status IN ('new',…)` with a checklist icon.
- **Routine**: a circled "F" icon (blue), then `client_total (cid: integer): numeric`.
- **Sequence**: a "123" icon, then `clients_id_seq integer`.
- **Server Objects / Database Objects**: folder with a small DB badge.

### Behavior

- Single click selects.
- **Double click on a table or view opens the table data editor.** Double click on a folder or schema toggles it.
- `→` / `←` expand and collapse. `F4` = Edit Data. `Ctrl+B` = Go to DDL. `Shift+Enter` = properties.
- **Speed search** (`18-…`): typing while the tree has focus turns the toolbar row into a search field.
  - The field has a 🔍 icon, the typed text, and a funnel (filter-mode) toggle on the right. Field bg is `#191A1C` with a 1px `#3871E1` focus border, radius 4.
  - Matches get a **yellow-orange highlight** behind the matched letters (`~#A0742B` bg, text white-ish).
  - Non-matching rows stay visible unless filter mode is on.
- **Schema selector popup** (`20/21`): opened by clicking the `1` badge.
  - Toolbar: refresh, expand, collapse, —. The header reads `0 connections`.
  - A tree of checkboxes:
    - `All databases` (with `add pattern`)
    - `Default database (postgres)`
    - `postgres (Default database)`
      - `All schemas`
      - `Default schema (public)`
      - `information_schema ⚡`
      - `inventory`
      - `pg_catalog ⚡`
      - `public (Default schema)`
      - `sales`
  - Footer: `Press Enter or click outside the list to apply`.
  - Checkboxes are 14px, radius 3. Checked = `#3871E1` fill with a white check; a dash = partial.

### Context menus (`15/16/17`)

Popup and menu look:

- bg `#26282C`, 1px border `#33353B`, radius about 8
- item height **26px**; text Inter 13 `~#DFE1E5`; 16px icon column at x+14; text at x+36
- shortcut right-aligned, `~#6F737A`
- separators: 1px `#33353B` with 4px vertical margin
- hover/selected item: `#2A4371` rounded rect, inset 6px
- submenu arrow `›` at the right

**On a table** (exact order):

- `New ›`
- `Modify Table… Ctrl+F6`
- `Copy/Paste ›`
- `Edit Data F4`
- `Refresh Ctrl+F5`
- `Join Across Data Sources… [New]`
- separator
- `Rename… Shift+F6`
- `Set Color ›`
- separator
- `Quick Documentation Ctrl+Q`
- `Compare Schema Structure With… Ctrl+D`
- `Navigation ›`
- `Find Usages Alt+F7`
- separator
- `Introspection Level ›`
- separator
- `SQL Scripts ›`
- `Object Actions ›`
- `Tools ›`
- `Import/Export ›`
- `Diagrams ›`
- separator
- `Diagnostics ›`
- separator
- `Drop… Delete`

**On a data source**:

- `Properties Ctrl+Alt+Shift+S`
- separator
- `New ›`
- `Copy/Paste ›`
- `Refresh Ctrl+F5`
- `Deactivate Ctrl+F2`
- separator
- `Rename… Shift+F6`
- `Move ›`
- `Set Color ›`
- separator
- `Quick Documentation Ctrl+Q`
- `Compare Schema Structure Ctrl+D` (disabled)
- `Navigation ›`
- separator
- `Introspection Level ›`
- separator
- `SQL Scripts ›`
- `Object Actions ›`
- `Tools ›`
- `Import/Export ›`
- `Diagrams ›`
- `DDL Mapping ›`
- separator
- `Diagnostics ›`
- separator
- `Remove Data Source… Delete`

**On a schema**, the `New ›` submenu:

- `Query Console Ctrl+Shift+Q`
- `Query File… Ctrl+Alt+Shift+Q`
- separator
- `Table`, `Materialized View`, `View`, `Operator`, `Sequence`, `Collation`, `Schema`, `Language`, `Database`, `Role`, `User`
- separator
- `Virtual View`
- separator
- `Data Source ›`, `Data Source from Cloud Provider ›`, `Data Source Templates`, `Workspace Data Source`, `Data Source from File/Folder`, `Data Source from URL`, `DDL Data Source`
- separator
- `Driver`

Underlined mnemonics are shown (e.g. `Rename…` with R underlined).

---

## 3. Data Sources and Drivers dialog

Screens: `30-datasource-sqlite-general-dark.png`, `31-…driver-not-downloaded…`, `32-…sqlite-test-connection-succeeded…`, `33-…tab-options`, `34-…tab-ssh-ssl`, `35-…tab-schemas`, `36-…tab-advanced`, `37-datasource-postgresql-general-{dark,light}.png`, `38-…test-succeeded-{dark,light}`, `39-…test-failed-dark.png`.

- Dialog title: `Data Sources and Drivers`. The dialog was captured at 1000x720; its natural size was about 980x710.
- Body bg `#191A1C`. Footer bg is the same, with a 1px top border `#26282C`.

### Layout

- **Far-left vertical icon rail** (x 0–45), 5 icons at 28px pitch:
  - Data Sources (selected: `#2E436E` rounded bg)
  - Drivers
  - Cloud
  - Import
  - DDL Mappings
- **Left list pane** (x 46–300):
  - Header `Data Sources` (bold) with ← → navigation arrows.
  - Toolbar: `+` (add, with a DB type popup), `—` (remove), duplicate, gear (driver), go-to (↗).
  - Group label `Project Data Sources` in gray Inter 12.
  - List rows are 24px with the DBMS icon. Selected row: `#2A4371`.
  - **New, not-yet-applied data sources are shown in green text** (`~#5FB865`).
  - Separator, then `Problems` (with a red count badge `1` when invalid).
- **Right pane**:
  - `Name:` field (with a `Color ⌄` dropdown inside the field, on the right) and an `Add comment` link.
  - Below that, a tab strip: `General` `Options` `SSH/SSL` `Schemas` `Advanced`, with `Save as Template` (link) on the right.
  - Tabs are segmented pills, 26px high. The selected tab has bg `#233558`, a 1px `#2E4D89` border and radius 6.

### General tab, SQLite

| Field | Contents |
|---|---|
| `Driver:` | `[SQLite icon] SQLite ⌄` combo. When the driver is missing, it reads `SQLite Not downloaded` and a `Download` link appears on the right. |
| `Connection type:` | segmented `default` / `In-memory` / `URL only` |
| `File:` | text field with a folder-browse icon |
| `URL:` | `jdbc:sqlite:/tmp/claude-1000/ux-sample.db` (the path part is underlined as a link), with an expand ↗ icon. Hint below: `Overrides settings above`. |

Typing a file auto-renames the data source to the file name (`identifier.sqlite` became `ux-sample.db`).

### General tab, PostgreSQL

| Field | Contents |
|---|---|
| Driver | `PostgreSQL` |
| `Connection type:` | `default` / `URL only` |
| `Host:` | `localhost` |
| `Port:` | `5432`, a small field on the right |
| `Authentication:` | `User & Password ⌄` |
| `User:` | text field |
| `Password:` | placeholder `<hidden>`, with `Save: Forever ⌄` |
| `Database:` | `postgres ⌄` |
| `URL:` | `jdbc:postgresql://localhost:5432/postgres` |

Field geometry:

- Labels sit in a column at x+12, Inter 13. Fields start at x+133 (about 120px label column).
- Fields: height 28, radius 4, bg `#191A1C`, 1px border `#43454A`.
- Focus: 2px `#3871E1` ring.

### Footer

- Left: `Test Connection` link (blue `#548AF7`), then a status icon, then the gray driver/version text (`SQLite 3.51.1`, `PostgreSQL 16.15`).
- `?` help circle at the bottom-left.
- Buttons on the right, 28px high, radius 6: **`OK`** (primary, solid `#3574F0`, white), `Cancel`, `Apply` (outlined `#43454A`).
- `Enter` = OK. **`Escape` cancels the whole dialog** and discards unapplied sources.

### Test Connection result

A balloon popup anchored above the link with a pointer. bg `#26282C`, border `#33353B`, radius 8, padding 16. Monospace is not used; it is Inter 13.

Success:

```
Succeeded                                       Copy
DBMS: PostgreSQL (ver. 16.15 (Debian 16.15-1.pgdg13+2)) ✎
Case sensitivity: plain=lower, delimited=exact
Driver: PostgreSQL JDBC Driver (ver. 42.7.13, JDBC4.2)

Ping: 30 ms
SSL: no
```

- `Succeeded` is green `~#5FB865`. A green ✓ appears next to the link afterwards.
- SQLite shows `DBMS: SQLite (ver. 3.51.1)`, `Case sensitivity: plain=mixed, delimited=mixed`, `Driver: SQLite JDBC (ver. 3.51.1.0, JDBC4.2)` and `Ping: 59 ms`.

Failure:

- `Failed` in red `~#F75464`.
- Links: `Copy`, `Search Error`, `Troubleshooting`.
- The DBMS info is grayed, then the message: `Connection to localhost:55499 refused. Check that the hostname and port are correct and that the postmaster is accepting TCP/IP connections.`
- A red ! icon appears next to the link.

### Other tabs

- **Options** (`33`), in sections with a header and a hairline rule:
  - **Connection**:
    - `Read-only` checkbox
    - `Transaction control: Auto ⌄`
    - `Switch schema: Automatic ⌄`
    - `Run keep-alive query each [60] sec.`
    - `Auto-disconnect after [300] sec.`
    - `Session control: Dedicated sessions ⌄ (?)`
    - `Startup script:` (multi-line field)
  - **Introspection**:
    - `Auto sync`
    - `Load sources for: All excl. system schemas ⌄`
    - `Use session template: None ⌄`
    - `Warn when editing outdated DDL`
    - `Track databases/schemas creation and deletion`
    - `Use pre-introspected objects…`
- **Schemas** (`35`):
  - Toolbar: refresh, expand, collapse, —, and a search field.
  - Checkbox tree: `All schemas add pattern` / `Default schema (main)` / `main (Default schema)`.
  - Bottom fields: `Schema pattern:` and `Object filter:`.
- **SSH/SSL** (`34`) and **Advanced** (`36`; a driver-properties table): see the screenshots.

---

## 4. Query console

Screens: `40-console-editor-sql-highlighting-{dark,light}.png`, `40b-crop-editor-sql-x1-dark.png`, `40c-crop-editor-gutter-sql-x3-dark.png`, `41-console-execute-statement-chooser-popup-dark.png`, `42-console-completion-popup-tables-dark.png`, `42-…-light.png`, `42b-crop-completion-x2-dark.png`, `43-…columns…`, `44-console-tx-mode-menu-dark.png`, `45-console-file-resolve-mode-menu-dark.png`, `46-console-schema-switcher-popup-dark.png`, `47-console-postgres-result-dark.png`, `04-crop-editor-tabs-and-console-toolbar-dark.png`.

### Editor tabs (y 43–82, 40px strip; 1px bottom border `#26282C` at y=83)

- Each tab is a **pill**:
  - 28px tall (y 49–76), radius 6
  - horizontal padding 8 + 16px icon + 6 + text + 6 + close ×
  - tabs about 8–12px apart
- **Selected tab, editor focused**: bg `#233558`, 1px border `#2E4D89`. Text white-ish `#DFE1E5`.
- **Selected tab, editor not focused**: bg `#26282C`, border `#40434A` (measured `#383B41`).
- Unselected: no bg; text `~#9CA0A8` (unselected alpha 0.75). Hover: bg `#FFFFFF17` (≈`#2D2E2F`).
- The **close ×** shows on the selected tab and on hover. It is 16px, gray, with a hover bg circle.
- Tab titles are Inter 13:
  - `console [postgres@localhost]` (DBMS icon)
  - `clients [postgres@localhost]` (table icon: table data editor)
  - `invoices (DDL) [postgres@localhost]`
- The ⋮ at the far right of the strip is the tab list/options.
- Modified marker: consoles autosave, so I saw no `*`. **(guess)** JetBrains uses a bullet/asterisk and italic for unsaved files only.

### Console toolbar (y 84–118, 34px; bottom border `#26282C`)

Icons are 16px at a 26px pitch, with separators between groups:

| Icon | Tooltip |
|---|---|
| ▶ green `#5FB865` | `Execute Ctrl+Enter` |
| explain (DB with magnifier) | `Explain Plan` |
| clock | `Browse Query History Ctrl+Alt+E` |
| (P) | `View Parameters` |
| gear | `Open Query Execution Settings…` |
| panel icon | `In-Editor Results` |
| `Tx: Auto ⌄` | text dropdown, 11px |
| ■ | `Cancel Running Statements Ctrl+F2` (gray when idle) |
| `Playground ⌄` | file resolve mode |
| AI glyph | `Write, Explain, or Improve SQL with AIR (Double Ctrl)`. Out of scope. |
| far right: `[schema icon] postgres.public ⌄` | `Switch current schema`. Shows `<schema>` before connecting, then `main` / `postgres.public`. |

The dropdowns:

- **Tx menu** (`44`):
  - Section `Transaction Mode`: `✓ Auto`, `Manual`
  - Section `Transaction Isolation`: `Database Default`, `✓ Read Committed`, `Repeatable Read`, `Serializable`
  - Footer hint: `Changes submitted to the database are auto-committed`
- **Playground menu** (`45`): section `File Resolve Mode` with `Script` / `✓ Playground`. Hint: `Sequence of statements forming a coherent SQL script`.
- **Schema switcher** (`46`): a list `postgres ›` with the hint `Connect to database (Enter)`.

### Gutter and editor

| Property | Value |
|---|---|
| Editor bg | `#191A1C` dark / `#FFFFFF` light |
| Font | **JetBrains Mono 13**. Char advance **8px**. **Line pitch 22px** (measured: caret row y 119–140; lines at 130/152/174…). |
| Gutter | x 503–566, same bg as the editor. A 1px `#323438` vertical separator at x=566 (right of the gutter). Line numbers are right-aligned at about x 524, JetBrains Mono 12. |
| Line number color | `#4B5059`. On the caret line: `#A1A3AB`, bright. |
| Caret line | `#1F2024` full width (light: `#F5F8FE`) |
| Caret | 2px, `#CED0D6` |
| Text selection | `#214283` (light `#A6D2FF`) |
| Right margin guide | 1px `#323438` at about column 120 (x≈1529) |
| Indent guides | 1px `#323438` |
| Right edge | Error stripe / scrollbar marks: small 8x2 colored dashes. Top-right inspection widget: green ✓ (no problems), or a red ! with count `!1 ˄ ˅`. |

### SQL colors (Islands Dark; sampled values ≈ scheme values)

| Token | Color | Style |
|---|---|---|
| Keyword (`SELECT FROM WHERE JOIN AS ON LIMIT`, types) | `#CF8E6D` | normal |
| String `'cancelled'` | `#6AAB73` | |
| Number `50`, `10.5` | `#2AACB8` | |
| Comment `-- …`, `/* … */` | `#7A7E85` | normal in dark; *italic* in light |
| Function call `COUNT`, `ROUND`, `SUM` | `#57AAF7` | *italic* |
| Column reference `first_name`, `paid` | `#C77DBB` | |
| Table / alias / schema identifiers | `#BCBEC4` (plain text) | |
| Operators, punctuation | `#BCBEC4` | |
| Unresolved reference `no_such_table` | `#F75464` | red text; plus a red wavy underline on error |

Light theme: keywords `#0033B3`, strings `#067D17`, numbers `#1750EB`, columns `#871094`, functions `#00627A` italic.

### Statement and run decorations

- **Current statement range**: when the caret is in a statement, a **1px green border `#3D7A49`** box surrounds the statement's text extent. This is not a fill (`40-…`).
- **Execute highlight** (`41`): pressing `Ctrl+Enter` when several candidate ranges exist opens a **`Statements` chooser popup** listing:
  - `SELECT c.id, c.first_name, …`
  - `-- Top customers by revenue SELECT …` (statement plus leading comment)
  - `Customize` link

  While it is open, the chosen range is **filled with translucent green (`#3D7A49` at about 40%)**. Selecting text first and pressing `Ctrl+Enter` runs it directly.
- **After execution**:
  - a green ✓ in the gutter on the statement's first line (red ! on error)
  - an **inline gray hint after the statement end**: `994 ms` (Inter 11, `~#6F737A`)
- **Identifier under caret**: other occurrences get a boxed bg `#373B39`. In `c.id`, every `c` is boxed.
- **Inlay hints**: JOIN cardinality pills `1<->0..n:` (gray rounded bg `#2B2D30`, 11px text) before `ON`.
- **Error** on a statement:
  - a red border box around the unresolved identifier
  - red text `#F75464`
  - a red ! gutter icon
  - the inspection widget shows `!1`
  - in the Output log the error line is red (see §5)

### Completion popup (`42`, `43`)

- Opens automatically after `.` or while typing an identifier. `Ctrl+Space` forces it.
- Look:
  - bg `#27282B` (LOOKUP_COLOR), 1px border `#33353B`, radius 6
  - row height **24px**
  - font **JetBrains Mono 13**
  - selected row bg `#33353B` (popup unfocused-style; it turns `#2A4371`-ish when navigated) **(partly guess)**
  - min width about 575px
- Row anatomy: `[16px icon] name (gray context in parens) ………… right-aligned gray type/source`. For example:
  - `▦ clients (postgres.sales) … postgres@localhost`
  - `123 ticket_seq (postgres.sales)`
  - `ⓕ client_total(cid integer) … numeric`
  - `cast … CAST('foo' as JSON)`
  - `[pk-col] id (i) … integer`
  - `paid (i) … boolean`
- Matched prefix letters are bold/bright.
- Footer (24px, separated by a hairline): `Press Enter to insert, Tab to replace` then the `Next Tip` link, and ⋮ on the right.

---

## 5. Database Output tool window (results panel)

Screens: `50-results-first-run-database-output-dark.png` (shows the one-time "moved" tip), `51-results-grid-and-console-dark.png`, `52-output-log-pane-dark.png`, `53-results-table-query-editable-toolbar-dark.png`, `54-output-log-with-update-and-error-dark.png`, `55-grid-view-as-menu-dark.png`, `56-grid-rows-pill-page-size-menu-dark.png`.

### Header (40px)

- Left: `Database Output` (bold), then tabs:
  - `[console icon] Output`
  - one result tab per result, e.g. `[grid icon] Top customers by revenue ×` (named from the leading comment) or `main.customers ×` (single-table query)
- Result tabs are 26px pills. Selected: `#233558` bg + `#2E4D89` border (focused) or `#26282C` (unfocused).
- **A new execution replaces the unpinned result tab.** "Pin Tab" keeps it.
- Right side:
  - `[icon] console [ux-sample.db] 994 ms ⌄` (source and last duration)
  - `Open Client in Editor` (crosshair)
  - `Options ⋮`
  - `Hide Shift+Escape` (—)
- With nothing run: `No Output ⌄`, and the body says `Run a query to see its output here`. The empty Output tab shows the centered gray text `Console output`.

### Grid toolbar (34px, under the tabs)

| Icon | Tooltip |
|---|---|
| grid (toggle, selected bg) | `Switch to Table` |
| chart | `Switch to Chart` |
| ⟳ | `Reload Page Ctrl+F5` |
| clock | `Table Result Auto Refresh` |
| ■ | `Cancel Running Statements Ctrl+F2` |
| `+` | `Add Row Alt+Insert` |
| `—` | `Delete Rows Ctrl+Y` |
| ↶ | `Revert Selected Ctrl+Alt+Z` |
| eye | `Preview Pending Changes` |
| ⇧ (green when changes pending) | `Submit Ctrl+Enter` |
| `Tx: Auto ⌄` | transaction mode (only for editable results) |
| `DDL` | `Go to DDL` |
| pin | `Pin Tab` |
| 🔍 | `Find on Current Page Ctrl+F` |
| filter-grid | `Table Result Local Filter` |
| record | `Record View` |
| paint bucket | `Table Coloring Options` |
| globe | `Show Geo Viewer` |
| right: `SQL` | `Show the query that produced this result set` |
| ⊞ | `Open in Editor Tab` |
| `CSV ⌄` | extractor format |
| ⤓ | `Export Data…` |
| ⤒ | `Copy to Database…` |
| ⇄ | `Compare Data` |
| columns | `Manage Columns… Ctrl+F12` |
| eye | `View as` (menu: `Transpose` / `✓ Table` / `Tree` / `Text`) |
| gear | `Show Options Menu` |

- The edit group (+ — ↶ 👁 ⇧ Tx) is grayed for read-only results (joins/aggregates, `51`) and enabled for single-table results (`53`).

### Paging

- A **floating pill at the bottom center of the grid**:
  - `18 rows ⌄ | ⋮`
  - 32px tall, radius 8
  - bg `#26282C`, 1px border `#33353B`
  - text Inter 12
- `⌄` opens a menu (`56`):
  - `Count Rows`
  - section `Page Size`: `10`, `100`, `250`, `✓ 500 Default`, `1,000`, `All`
- Default page size is 500. The table editor queries `LIMIT 501` to detect more rows.
- Classic text such as "1-500 of 500" was **not shown** in 2026.3. The theme strings still contain `of {0}` for when the count is known.

### Output (log) pane (`52`, `54`)

- Left mini-toolbar (34px): `Tx` (with a ▾ marker), ■ stop, a layout toggle.
- Right vertical toolbar: soft-wrap, scroll-to-end, print, clear (trash).
- Font **JetBrains Mono 13**, line pitch 22px. Text `#BCBEC4`. Echoed SQL is syntax-highlighted. Error lines are red `#F75464` (whole line, including the timestamp).
- **Exact wording** (timestamp format `[yyyy-MM-dd HH:mm:ss:SSS]`):

```
[2026-11-06 13:38:46:367] Connected
[2026-11-06 13:38:46:429] main> SELECT c.id, c.first_name, ...        (multi-line SQL, continuation lines indented under the SQL start)
[2026-11-06 13:38:47:330] 18 rows retrieved starting from 1 in 902 ms (execution: 21 ms, fetching: 881 ms)
[2026-11-06 13:39:50:142] main> UPDATE products SET stock = stock WHERE id < 3
[2026-11-06 13:39:50:146] 2 rows affected in 4 ms
[2026-11-06 13:39:54:524] main> SELECT * FROM no_such_table
[2026-11-06 13:39:54:534] [1] [SQLITE_ERROR] SQL error or missing database (no such table: no_such_table)
[2026-11-06 13:43:30:898] postgres.public> SELECT * FROM sales.invoices i WHERE i.paid = false
[2026-11-06 13:43:31:475] 54 rows retrieved starting from 1 in 577 ms (execution: 9 ms, fetching: 568 ms)
```

- The prompt prefix is the current schema: `main>` or `postgres.public>`.
- The echoed SQL drops the trailing `;`.

---

## 6. Data grid

Screens: `51`, `53`, `57-grid-sorted-selected-cell-dark.png`, `58-grid-inline-cell-editor-dark.png`, `59-grid-pending-changes-insert-update-delete-dark.png`, `60-grid-preview-pending-changes-popup-dark.png`, `61-crop-grid-header-rows-x2-dark.png`.

| Property | Measured |
|---|---|
| Font (cells and headers) | **JetBrains Mono 13** |
| Header row | **27px** (y 557–583), bg `#1F2024`. A column whose cells are selected gets a lighter header `#292A2C`. Light: `#EFEFEF`. |
| Header content | `[16px column icon] name ……… [funnel ▽] [sort ⇕]`. Name is left-aligned after the icon. The funnel opens the per-column filter. The ⇕ sort toggle becomes `^` (asc) or `⌄` (desc) when active, with the sort-order number if multi-sort. |
| Column icons | plain column; PK = column + gold key; FK = column + blue key; also shown in the tree |
| Row height | **27px** (26 content + 1px grid line `#323438`; light `#EBECF0`) |
| Grid lines | horizontal 1px `#323438` and vertical 1px `#323438` between columns |
| Row-number column | x 8–39 (**32px**), numbers right-aligned, gray `#4B5059` (like line numbers), no bg difference; separated by a 1px `#323438` line |
| Cell padding | about 4px left/right **(guess ±1)** |
| Alternating rows | **none** (no zebra) |
| Numbers | right-aligned |
| Text, dates | left-aligned |
| Booleans | centered (`false`, `true`); the table editor shows `• true` with a dot glyph |
| NULL | `<null>`, color `#7A7E85` (comment color); italic in light |
| Selected cell | fill `#214283`. **The row-number cell of the selected row is also highlighted**; the row gets no full highlight (current row `#1F2024` only on the row number / subtle). |
| Multi-cell / row selection | `#214283` (light: `#A6D2FF`-ish, measured `#B3D5FF` area) |
| Inline cell editor (`58`) | Double-click, `Enter` or `F2`. The cell becomes a text field with a **1px `#3871E1` border**, editor bg, caret. `Enter` commits; `Esc` cancels. |
| Modified cell | bg **`#385570`** (the row-number cell is tinted as well) |
| Inserted row | full row bg **`#294436`**. New cells show `<null>`. Inserted at the **top** (row 1). |
| Deleted row | full row bg **`#484A4A`** (gray). Text stays. |
| Preview pending changes (`60`) | A popup with SQL (`DELETE FROM customers WHERE id = 16;` / `UPDATE customers SET city = 'Valencia' WHERE id = 35;` / `INSERT INTO customers (id, …) VALUES (null, …);`) and `Submit` (primary) / `Cancel` buttons. |
| Status bar while in the grid | `No aggregator selected` and `row:col` (e.g. `3:5`) |

### Table data editor WHERE / ORDER BY bar (`70`, `71`, `72`)

- One 30px row under the toolbar, split in half by a vertical hairline:
  - left: `[funnel icon] WHERE` placeholder
  - right: `[sort icon] ORDER BY` placeholder
- The labels are gray monospace. Typed text is SQL-highlighted (`WHERE active = false`, `ORDER BY name DESC`) with completion.
- An `×` at the right of each half clears it. `Enter` applies.

---

## 7. Table data editor and DDL view

- **Double-click a table** (or `F4`) opens the editor tab `clients [postgres@localhost]` (`70-table-data-editor-{dark,light}.png`).
  - Toolbar: reload, auto-refresh, cancel, + — ↶ 👁 ⇧, `Tx: Auto ⌄`, `DDL`, 🔍, filter, record view, coloring, geo, chart; on the right `SQL`, `CSV ⌄`, export, copy, compare, columns, view-as, gear.
  - Then the WHERE/ORDER BY bar, then the grid, and the rows pill at the bottom center.
  - Opening it logs `SELECT t.* FROM sales.clients t LIMIT 501` in Output.
- **DDL view** (`Ctrl+B` on a tree node, or `DDL` in the toolbars; `73-ddl-view-{dark,light}.png`).
  - Tab `invoices (DDL) [postgres@localhost]`, with a 34px toolbar (reload ⟳, open data ▦).
  - The editor shows generated SQL in lowercase keywords:

```
-- auto-generated definition
create table invoices
(
    id        serial
        primary key,
    client_id integer
        references clients,
    amount    numeric(12, 2),
    issued    date,
    paid      boolean
);

alter table invoices
    owner to postgres;

create index invoices_client_id_idx
    on invoices (client_id);
```

  - The column names are aligned in a column, and constraints are indented on the next line.
  - The DDL editor is editable (it is an SQL file); typing marks errors.

---

## 8. Popups, tooltips, notifications

- **Search Everywhere** (`91-search-everywhere-all-dark.png`). Opened with the toolbar 🔍 or `Shift Shift`.
  - Popup 700x600, centered horizontally, top at about y=195. bg `#26282C`, border `#33353B`, radius 8.
  - Tabs `All` `Database` `Files` `Code` `Actions` `Text`; the selected tab is a pill `#2E436E`.
  - Right of the tabs: `☐ Include non-project items`, and filter/preview icons.
  - Search field: 32px, 🔍 with a dropdown, the hint `Type / to see commands` on the right, and a `#3871E1` 1px border.
  - Result rows are 24px: `[icon] name  gray qualifier [data source]`, e.g. `invoices postgres.sales [postgres@localhost]`. The matched prefix is highlighted orange.
  - Footer: the gray object path and an `Open In Right Split` link.
- **Ctrl+N** (`90-goto-database-object-ctrl-n-dark.png`) opens the same popup on the **`Database`** tab, with `All Data Sources ⌄` scope and filter icons.
- **Tooltips** (`83-tooltip-with-shortcut-dark.png`):
  - bg `#2B2D30`-ish (`~#393B40`), no border visible, radius 6, padding 8x10
  - text Inter 13 `#DFE1E5`, plus the **shortcut in gray** after 8px (`Add Row  Alt+Insert`)
  - appears after about 1.2s hover, placed below the cursor
  - multi-line tooltips are supported (`Search Everywhere Shift Shift` / `Searches for: - Classes - Files …`)
- **Notification balloons** (`80`, `81`): bottom-right, 16px from the edges, width about 370px.
  - bg `#26282C`, border `#33353B`, radius 8, padding 16
  - `[i] bold title` + body text + links, e.g. `Default SQL dialect — You can set PostgreSQL as default SQL dialect for this project or configure SQL dialects.` and `Introspection Level Selected for postgres@local / In database: postgres / Level 3: public… / Introspection Level Help`
  - a collapse ⌄ at the right
  - auto-hide after about 10s **(guess)**
- **"Got It" tips** (`82`): blue `#2E55A3` balloon, white text, `Got It` outlined button. Onboarding; out of scope.
- **Editor banner** (`48-editor-banner-no-datasource-light.png`): a yellow strip on top of the editor: `⚠ No data sources are configured to run this SQL…` with `Configure data source`, `Dismiss` and a gear.

---

## 9. Keyboard shortcuts (in scope)

These were confirmed in Settings › Keymap (`94-settings-keymap-execution-dark.png`, `95-…`) and in the binary keymaps (evidence §5). The keymap is XWin, which is identical to `$default` for these.

| Action | Shortcut |
|---|---|
| Execute statement at caret / selection | **Ctrl+Enter** (opens the Statements chooser if ambiguous) |
| Cancel running statements | **Ctrl+F2** |
| Commit (manual tx) / submit and commit | Ctrl+Alt+Shift+Enter |
| New query console | **Ctrl+Shift+Q** |
| Jump to query console | Ctrl+Shift+F10 |
| Query history | Ctrl+Alt+E |
| Code completion | **Ctrl+Space** |
| Go to DDL | **Ctrl+B** (or Ctrl+Click) |
| Edit data (open table) | **F4** |
| Data source properties | Shift+Enter (explorer) / Ctrl+Alt+Shift+S (dialog) |
| Refresh | Ctrl+F5 |
| Deactivate (disconnect) | Ctrl+F2 (explorer) |
| Grid: submit / revert selected | **Ctrl+Enter** / **Ctrl+Alt+Z** |
| Grid: add row / clone row / delete rows | **Alt+Insert** / Ctrl+D / **Ctrl+Y** |
| Grid: edit cell / value editor / record view | Enter or F2 / Shift+Enter / Ctrl+Shift+Enter |
| Grid: set NULL | Ctrl+Alt+N |
| Grid: next / previous page | Ctrl+Alt+Down / Ctrl+Alt+Up |
| Grid: reload page | Ctrl+F5 |
| Grid: find on page | Ctrl+F |
| Grid: manage columns | Ctrl+F12 |
| Search Everywhere | **Shift Shift** |
| Go to database object | **Ctrl+N** |
| Quick documentation | Ctrl+Q |
| Tool windows | Alt+1 Database Explorer, Alt+8 Database Output, Alt+4 Files |
| Hide active tool window | Shift+Escape |
| Settings | Ctrl+Alt+S |
| Main menu | Alt+\ |
| Close tab | Ctrl+F4 |

---

## Omitted (out of scope)

UI elements in operative screens that belong to features the rebuild leaves out (see `PLAN.md`, "Out of scope"):

- **AI / agents.**
  - Main toolbar: `✳ New Session ⌄` and the `Agent Sessions Alt+2` tool-window button.
  - Explorer toolbar: the AI glyph ("…using Air (Double Ctrl)").
  - Console toolbar: AIR glyph ("Write, Explain, or Improve SQL with AIR").
  - Welcome button `New Agent Session`.
  - Status bar AI icon.
- **Licensing / trial**: the status-bar `Trial` pill and the "Free trial has started… Manage Licenses…" balloon (`80-…`).
- **Plugins / marketplace**: gear menu `Plugins…`; welcome `Plugins`; Keymap page "Get more keymaps in Settings | Plugins".
- **Settings sync**: gear menu `Backup and Sync… Off`.
- **Tips / onboarding**: blue "Got It" balloons (`82-…`, "Query results moved to Database Output", "Cloud Database Import"); completion footer `Next Tip`; welcome `DataGrip on YouTube` / `Online Help`.
- **Cloud providers**: `Data Source from Cloud Provider`, `Connect to Cloud Provider` (Google Cloud, AWS, Azure) in the explorer empty state, and the dialog rail cloud icon.
- **VCS**: the `Version Control ⌄` toolbar widget.
- **Not in v1 scope though operative**: Explain Plan, Chart view, Geo viewer, Compare Data/Schema, Diagrams, Join Across Data Sources, Workspace/DDL data sources. They are visible in toolbars and menus; keep them disabled or hidden.

---

## What makes it feel like DataGrip (prioritized)

1. **Islands geometry.** Dark `#26282C` frame, rounded `#191A1C` panels, 5–7px gaps, no visible splitter lines, 40px panel headers with a 1px `#26282C` underline.
2. **Two fonts, strictly split.** Inter 13 for all chrome (trees, menus, tabs, dialogs). JetBrains Mono 13 for the editor, **grid cells and headers**, the Output log and completion.
3. **24px tree rows, 19px indent, inset rounded selection `#2A4371`** (unfocused `#33353B`). Gray inline hints (types, counts, signatures) in smaller text right after names.
4. **Correct per-object icons** (PK gold key, FK blue key, index "i", routine ⓕ, sequence 123, blue folders with counts), plus the DBMS brand icon and a connected dot on data sources.
5. **Ctrl+Enter semantics**: green statement outline at the caret, the Statements chooser when ambiguous, a gutter ✓ or ! and an inline `NNN ms` hint after the statement.
6. **Darcula-family SQL palette**: orange keywords `#CF8E6D`, green strings, cyan numbers, magenta columns `#C77DBB`, italic blue function calls, gray comments. Tables stay plain.
7. **Output log wording and format**, exactly: `[yyyy-MM-dd HH:mm:ss:SSS] N rows retrieved starting from 1 in X ms (execution: Y ms, fetching: Z ms)`, `schema> SQL`, `N rows affected in X ms`, red error lines with `[code] [STATE] message`.
8. **Grid look**: 27px rows, 1px `#323438` lines, 32px gray row-number column, right-aligned numbers, centered booleans, gray `<null>`, no zebra striping, header with column-kind icon + funnel + sort toggle.
9. **Pending-change colors**: modified `#385570`, inserted `#294436` (new row at the top), deleted `#484A4A`. Submit with Ctrl+Enter, revert with Ctrl+Alt+Z, plus the SQL preview popup.
10. **The floating "N rows ⌄" pill** with the page-size menu (10/100/250/500 Default/1,000/All, Count Rows), instead of a paging bar.
11. **Pill tabs** (28px, radius 6, selected `#233558` with a `#2E4D89` border when focused) for editor tabs *and* result tabs. Close × only on selected or hovered tabs.
12. **Dense icon toolbars**: 16px icons at a 26px pitch, hairline group separators, tooltips with gray shortcuts after about 1s.
13. **Popup styling**: `#26282C` bg, `#33353B` border, radius 8, 26px menu rows, right-aligned gray shortcuts, section headers in small gray text, ✓ for the current choice.
14. **Data source dialog structure**: icon rail, list (new items green), segmented tabs, a label/field grid with a 28px field height, a `Test Connection` link with a rich Succeeded/Failed balloon showing DBMS/driver/ping lines.
15. **Table editor WHERE | ORDER BY bar**, with SQL highlighting and completion inside the filter fields.
16. **Keyboard-first behavior**: speed search in every tree and list (orange match highlight), F4 / Ctrl+B / Ctrl+N / Shift Shift, and Escape closing popups (but Escape *cancels* dialogs).
17. **Status bar breadcrumbs** of the selected object, plus caret position and background-task progress (`Performing complete introspection (SQLite)`).

---

## Evidence from DataGrip binaries

The section below was produced by a sub-investigation of the installed jars (`/snap/datagrip/current/lib`, `plugins/DatabaseTools`), unzipped read-only under `/tmp/claude-1000/dg-jars/`.

- The requested REA tool (`npx rea-agents`, v6.8.0) **could not run**. It requires Node ≥ 22.23 and the machine has Node v20.20.2. It fails with `SyntaxError: … 'node:zlib' does not provide an export named 'zstdDecompress'`.
- The values were therefore extracted with unzip/grep and a small class-file constant reader.

Every solid color I sampled from screenshots matches these values: `#26282C`, `#191A1C`, `#2A4371`, `#1F2024`, `#214283`, `#385570`, `#294436`, `#484A4A`, `#3D7A49`, `#33353B`, `#27282B`.

Known discrepancies, where my screenshot measurements win:

- The DataGrip grid row and header are **27px**. The generic `Table.rowHeight` 20 and `TableHeader.height` 25 do not apply to the data grid.
- The main toolbar measures **43px** to the island top.

### (evidence file) DataGrip 2026.3 — binary evidence for a pixel-perfect web rebuild

Source install: `/snap/datagrip/current` (read-only). `product-info.json`: DataGrip **2026.3**, build **DB-263.7307.216**, majorVersionReleaseDate 20261104.
Working copies were extracted only into `/tmp/claude-1000/dg-jars/`. Helper scripts are in `/tmp/claude-1000/rea/scripts/`.

### 0. Method and tooling

**REA (`npx rea-agents`) did not run.** I ran `npx -y rea-agents --help` from `/tmp/claude-1000/rea`. npm installed `rea-agents@6.8.0` and warned `EBADENGINE ... required: { node: '^22.23.4 || ^24.22.1 || >=26.12.1' }, current: { node: 'v20.20.2' }`. The CLI then crashed at import:
```
SyntaxError: The requested module 'node:zlib' does not provide an export named 'zstdDecompress'
    at .../node_modules/rea-agents/dist/cli-runtime/cli.js:95
```
The only Node on the host is `/usr/bin/node` v20.20.2 (there is no nvm). No REA analysis command ever ran, and I did not run `setup`.

**What I used instead:**
- `unzip -Z1` over all 466 `lib/*.jar` files and all plugin jars, giving a 418k-entry index.
- Python scripts:
  - `theme.py` resolves the theme parent chain, named colors and `"*"` wildcards.
  - `scheme.py` resolves the editor-scheme parent chain plus the `TextAttributesKey` fallback chain.
  - `cls.py` is a minimal class-file constant-pool and bytecode reader. The JBR ships without `javap`, so I wrote this to read string, int and field operands.
  - `keys.py` and `menu.py` parse keymaps, action XML and bundles.

**Conventions in this file:**
- `[X]` after a value names the theme or scheme layer that defines it.
- `via *` means the value comes from a `"*": {...}` wildcard in that theme. A wildcard in theme X overrides every `Component.<prop>` key with the same suffix that a parent theme set. That mirrors how IntelliJ applies `*`, but my resolver models it, so treat `via *` values as **inferred**.
- **Inferred** marks anything not literally present in the binaries.

---

### 1. UI themes (`*.theme.json`)

**Jar:** `lib/intellij.platform.resources.jar`

| Theme `name` | Path in jar | parentTheme | editorScheme |
|---|---|---|---|
| Islands Dark (default) | `themes/islands/ManyIslandsDark.theme.json` | ExperimentalDark | `Islands Dark` |
| Islands Light | `themes/islands/ManyIslandsLight.theme.json` | ExperimentalLightWithLightHeader | `Light` |
| Islands Darcula | `themes/islands/ManyIslandsDarcula.theme.json` | ExperimentalDark | Darcula |
| Dark (expUI) | `themes/expUI/expUI_dark.theme.json` | Darcula | `Dark` |
| Light (expUI) | `themes/expUI/expUI_light.theme.json` | IntelliJ | `Light` |
| Light with Light Header | `themes/expUI/expUI_light_with_light_header.theme.json` | ExperimentalLight | Light |
| Darcula / IntelliJ (base) | `themes/darcula.theme.json`, `themes/intellijlaf.theme.json` | – / Darcula | – |

**Inheritance chains:**
- Islands Dark → expUI_dark → darcula.
- Islands Light → expUI_light_with_light_header → expUI_light → intellijlaf → darcula.

The key documentation (with `since`) is in `themes/metadata/IntelliJPlatform.themeMetadata.json`. It marks the Island keys as `since 2026.1`.

### 1.1 Semantic color tokens (Islands `colors` block)

| Token | Islands Dark | Islands Light |
|---|---|---|
| text-default | gray-130 `#D1D3D9` | black `#000000` |
| text-muted | gray-100 `#9FA2A8` | gray-70 `#5F6269` |
| text-secondary | gray-80 `#73767C` | gray-80 `#73767C` |
| text-disabled | gray-60 `#4C4F56` | gray-100 `#9FA2A8` |
| text-link | blue-100 `#71A1FE` | blue-70 `#2F5EB9` |
| text-error / warning / success | `#F57E84` / `#D59637` / `#6DB083` | `#C54E58` / `#A56906` / `#338555` |
| editor-text | `#BCBEC4` | `#080808` |
| layer-0-bg (dialog, editor, tool-window bg in Dark) | gray-10 `#191A1C` | gray-150 `#E9EAEE` (main-window-bg in Light) |
| layer-1-bg | gray-30 `#26282C` (main-window / popup bg) | gray-160 `#F7F8F9` (dialog-bg) |
| layer-2-bg | gray-40 `#33353B` (feedback / tooltip / notification) | white `#FFFFFF` (editor / tool-window / popup bg) |
| main-window-bg | `#26282C` | `#E9EAEE` |
| tool-window-bg | `#191A1C` | `#FFFFFF` |
| editor-bg | `#191A1C` | `#FFFFFF` |
| popup-bg / popup-border | `#26282C` / `#33353B` | `#FFFFFF` / `#E9EAEE` (`popup-border-windows` `#D1D3D9`) |
| dialog-bg / dialog-border | `#191A1C` / `#26282C` | `#F7F8F9` / `#E9EAEE` |
| tool-window-border / editor-border | `#26282C` | `#E9EAEE` |
| tool-window-bg-alt / main-window-bg-alt | gray-20 `#212326` / gray-40 `#33353B` | `#F7F6F8` / `#E8E8EB` |
| selection-bg-active | blue-50 `#2A4371` | blue-140 `#D0DFFE` |
| selection-bg-active-muted | blue-40 `#233558` | blue-150 `#E3EBFE` |
| selection-bg-inactive | gray-40 `#33353B` | gray-150 `#E9EAEE` |
| selection-bg-hovered | `#FFFFFF10` | `#00000008` |
| core-bg-transparent-hovered (toolbar/tab hover) | `#FFFFFF17` | `#00000012` |
| core-bg-transparent-pressed | `#FFFFFF29` | `#00000020` |
| core-border-transparent (toolbar-border / separators) | `#FFFFFF21` | `#00000020` |
| accent-brand-bg (control-brand, focus, default button) | blue-80 `#3871E1` | blue-80 `#3871E1` |
| tab-selected-bg-active / -border-active | `#233558` / `#2E4D89` | `#E3EBFE` / `#A7C5FF` |
| tab-selected-bg-inactive / -border-inactive | `#26282C` / `#40434A` | `#E9EAEE` / `#D1D3D9` |
| control-border | gray-50 `#40434A` | gray-130 `#D1D3D9` |
| control-bg | `#191A1C` | `#FFFFFF` |
| control-bg-small | `#40434A` | `#DDDFE4` |
| search-match-bg | `#BA9752` | `#FEE6B1` |
| tree-indent-guide-border | gray-40 `#33353B` | `#E9EAEE` |
| icon-default-stroke | gray-120 `#C3C5CB` | gray-80 `#73767C` |
| popup-completion-match-text | blue-90 `#538AF9` | blue-70 `#2F5EB9` |

**Gray ramp in Islands Dark:**
gray-10 `#191A1C`, gray-20 `#212326`, gray-30 `#26282C`, gray-40 `#33353B`, gray-50 `#40434A`, gray-60 `#4C4F56`, gray-70 `#5F6269`, gray-80 `#73767C`, gray-90 `#8B8E94`, gray-100 `#9FA2A8`, gray-110 `#B5B7BD`, gray-120 `#C3C5CB`, gray-130 `#D1D3D9`, gray-140 `#DDDFE4`, gray-150 `#E9EAEE`, gray-160 `#F7F8F9`.

**Blue ramp:**
blue-10 `#131A28`, blue-20 `#182337`, blue-30 `#1B283F`, blue-40 `#233558`, blue-50 `#2A4371`, blue-60 `#2E4D89`, blue-70 `#2F5EB9`, blue-80 `#3871E1`, blue-90 `#538AF9`, blue-100 `#71A1FE`, blue-110 `#92B7FF`, blue-120 `#A7C5FF`, blue-130 `#BDD3FF`, blue-140 `#D0DFFE`, blue-150 `#E3EBFE`, blue-160 `#F7F8FF`.

The Islands Light file uses the same ramp names.

### 1.2 Island-specific keys

The `ui.Island` and `ui.alt` blocks are identical in both Islands themes.

| Key | Value |
|---|---|
| `Islands` | `1` (enables Islands mode) |
| `Island.arc` / `.compact` | **20** / 16 (corner radius of islands) |
| `Island.borderWidth` / `.compact` | **6** / 4. This is the island border, i.e. the gap between islands (gap use is **inferred**). |
| `Island.borderArcLength` / `.compact` | 14 / 10 |
| `Island.borderColor` | tool-window-bg: Dark `#191A1C`, Light `#FFFFFF` |
| `Island.inactiveAlpha` | 0.56 |
| `Island.toolWindowAlpha` | 0.2 |

The `ui.alt.*` block holds an alternate palette (for example `MainWindow.background` = main-window-bg-alt). The theme does not say when it applies.

### 1.3 Window chrome, toolbar, stripes, tool windows

| Key | Islands Dark | Islands Light |
|---|---|---|
| MainWindow.background | `#26282C` | `#E9EAEE` |
| MainToolbar.background / inactiveBackground | `#26282C` | `#E9EAEE` |
| MainToolbar.separatorColor | `#FFFFFF21` | `#00000020` |
| MainToolbar.borderColor | transparent | transparent |
| MainToolbar.Icon.insets | `6,5,4,5` | `6,5,4,5` |
| MainToolbar.Icon.hoverBackground / pressedBackground | `#FFFFFF17` (via *) / `#FFFFFF29` | `#00000012` / `#00000020` |
| MainToolbar.Dropdown.maxWidth | 350 | 350 |
| MainToolbar.Button.arc.compact | 8 | – |
| TitlePane.Button.preferredSize | `40,40` | `40,40` |
| ToolWindow.background | `#191A1C` | `#FFFFFF` |
| ToolWindow.Header.background | `#191A1C` (via *) | `#F7F8F9` (via *, inferred) |
| ToolWindow.Header.inactiveBackground | `#191A1C` | `#FFFFFF` |
| ToolWindow.Header.borderColor | `#26282C` | `#E9EAEE` |
| ToolWindow.Header.font.size.offset | 0 | 0 |
| ToolWindow.HeaderTab.hoverInactiveBackground | `#FFFFFF17` | `#00000012` |
| ToolWindow.Stripe.background | `#26282C` | `#E9EAEE` |
| ToolWindow.Stripe.separatorColor | `#FFFFFF21` | `#00000020` |
| ToolWindow.Stripe.borderColor | transparent | transparent |
| ToolWindow.Button.selectedBackground (stripe selected) | `#3871E1` | `#3871E1` |
| ToolWindow.Button.selectedForeground | `#FFFFFF` | `#FFFFFF` |
| ToolWindow.Button.foreground | `#9FA2A8` | `#5F6269` |
| ToolWindow.Button.hoverBackground | `#FFFFFF17` (inferred, from *.hoverBackground) | `#00000012` (via *) |
| StripeToolbar.Button.size | **37,40** | 37,40 |
| StripeToolbar.Button.leftStripeIcon.padding | `5,5,5,2` | same |
| StripeToolbar.Button.rightStripeIcon.padding | `5,2,5,5` | same |
| StripeToolbar.Button.left/rightStripeIconWithName.padding | `4,6,4,2` / `4,2,4,6` | same |
| StripeToolbar.Button.left/rightStripeTextOffset | 2 / -2 | same |
| StatusBar.background | `#26282C` | `#E9EAEE` |
| StatusBar.borderColor / topBorderWidth | transparent / 0 | transparent / 0 |
| StatusBar.Breadcrumbs.foreground / hoverForeground | `#9FA2A8` / `#D1D3D9` | `#5F6269` / `#000000` |
| StatusBar.Breadcrumbs.hoverBackground | `#FFFFFF17` | `#00000012` |
| StatusBar.Breadcrumbs.chevronInset | 0 | 0 |
| Window.undecorated.border | `1,1,1,1,#5A5D63` | `1,1,1,1,#5A5D6B` |
| MainWindow.Tab.background / selectedBackground | `#131314` / `#191A1C` | – |
| MainWindow.Tab.foreground / selectedForeground | `#9FA2A8` / `#D1D3D9` | – |

**Code defaults (non-compact), from `JBUI$CurrentTheme$*` classes**

Jar: `lib/intellij.platform.util.ui.jar`. Values come from bytecode constants.

| Getter | Theme key | Code default |
|---|---|---|
| `Toolbar.defaultExperimentalToolbarButtonSize` | `MainToolbar.Button.size` | **30×30** (no Islands override) |
| `Toolbar.defaultExperimentalToolbarButtonIconSize` | `MainToolbar.Button.iconSize` | 20 |
| `Toolbar.defaultStripeToolbarButtonSize` | `StripeToolbar.Button.size` | 40×40 (Islands overrides to 37,40) |
| `Toolbar.defaultStripeToolbarButtonIconSize` | `StripeToolbar.Button.iconSize` | 20 |
| `Toolbar.stripeButtonArc` | `Button.ToolWindow.arc` | 8 (old UI) / **12** (new UI) |
| `Toolbar.horizontal/verticalToolbarInsets` | `ToolBar.*ToolbarInsets` | new UI insets(5,7) |
| `Toolbar.toolbarButtonInsets` | `Toolbar.Button.buttonInsets` | insets(1,2) |
| `ToolWindow.defaultHeaderHeight` | `ToolWindow.Header.height` | **41** (compact 31 from darcula json) |
| `ToolWindow.headerTabUnderlineArc` | `ToolWindow.HeaderTab.underlineArc` | 4 |
| `ToolWindow.headerTabLeftRightInsets` | – | new UI insets(0,12) |
| `ToolWindow.headerLabelLeftRightInsets` | – | insets(0,12,0,16) |
| `ToolWindow.headerToolbarLeftRightInsets` | – | insets(0,12,0,8) |
| `DefaultTabs.UNDERLINE_HEIGHT` | `DefaultTabs.underlineHeight` | 3 |
| `StatusBar.hoverInsets` | `StatusBar.Widget.hoverInsets` | insets(3,4,1,4) |
| `Popup.Selection.arc` / `leftRightInset` / `innerInsets` | – | 8 / 8 / insets(0,8) |
| `PopupMenu.Selection.arc` / `innerInsets` / `outerInsets` | – | 8 / new UI insets(0,6) / insets(1,7) |
| `Tree.Selection.arc` | – | 8 |
| `Popup.borderWidth` | – | 1.0 |
| `Popup.Body.*Inset*` | – | 8 |
| `Popup.separatorInsets` / `separatorLabelInsets` | – | (4,8) / (3,16) |
| `Popup.SearchField.borderInsets` / `inputInsets` | – | (4,12) / (4,8,8,2) |

I found no `MainToolbar.height` key. A main-toolbar height of **40** is **inferred** from `TitlePane.Button.preferredSize 40,40`.

### 1.4 Editor tabs

| Key | Islands Dark | Islands Light |
|---|---|---|
| EditorTabs.background | `#191A1C` | `#FFFFFF` |
| EditorTabs.underlineHeight | **4** (compact 3) | 4 |
| EditorTabs.underlineArc | **4** | 4 |
| EditorTabs.underlineColor | not set; falls to `*.underlineColor` `#3871E1` (inferred) | `#3871E1` (via *) |
| EditorTabs.underlinedTabBackground (selected) | `#233558` | `#E3EBFE` |
| EditorTabs.underlinedBorderColor (selected) | `#2E4D89` | `#A7C5FF` |
| EditorTabs.inactiveUnderlinedTabBackground | `#26282C` | `#E9EAEE` |
| EditorTabs.inactiveUnderlinedTabBorderColor | `#40434A` | `#D1D3D9` |
| EditorTabs.hoverBackground / hoverInactiveBackground | `#FFFFFF17` | `#00000012` |
| EditorTabs.underTabsBorderColor | `#26282C` | `#E9EAEE` |
| EditorTabs.unselectedAlpha / unselectedBlend | 0.75 / 0.7 | 0.75 / 0.9 |
| EditorTabs.tabInsets / .compact | `-6,8,-6,8` / `-2,6,-2,4` | same |
| EditorTabs.tabContentActionsRightInsets | `0,4,0,2` | same |
| EditorTabs.inactiveColoredFileBackground | `#1E1F2280` | `#FFFFFF80` |
| TabbedPane.tabHeight / .compact | **40** / 36 | 40 |
| TabbedPane.focusColor / hoverColor | `#233558` / `#FFFFFF17` | `#E3EBFE` / `#00000012` |
| TabbedPane.tabSelectionHeight | 3 | 3 |
| TabbedPane.contentAreaColor | `#26282C` | `#E9EAEE` |

The non-Islands expUI tab values are listed in §1.11.

### 1.5 Tree, List, Table

| Key | Islands Dark | Islands Light |
|---|---|---|
| Tree.rowHeight / .compact | **24** / 22 | 24 / 22 |
| Tree.border / .compact | `4,12,4,12` / `2,8,2,8` | same |
| Tree.leftChildIndent / rightChildIndent | **7 / 11** [Darcula] | 7 / 11 |
| Tree.background | `#191A1C` (via *) | `#F7F8F9` (via *, inferred; the tool window itself is `#FFFFFF`) |
| Tree.foreground | `#D1D3D9` (via *) | `#000000` |
| Tree.selectionBackground (focused) | `#2A4371`; not a Tree key, falls to `*.selectionBackground` | `#D0DFFE` |
| Tree.selectionForeground | `#D1D3D9` (`*.selectionForeground`) | `#000000` |
| Tree.selectionInactiveBackground (unfocused) | `#33353B` (`*.selectionInactiveBackground`) | `#E9EAEE` |
| Tree.hoverBackground / hoverInactiveBackground | `#FFFFFF10` | `#00000008` |
| Tree.hash (indent guides) | `#33353B` | `#E9EAEE` |
| Tree.paintLines | false | false |
| Tree.expandedIcon / collapsedIcon | `/expui/general/chevronDown.svg` / `/expui/general/chevronRight.svg` | same |
| Tree.forceFocusedSelectionForeground | false | false |
| List.rowHeight / .compact | 24 / 22 | 24 / 22 |
| List.border | `4,0,4,0` | same |
| List.hoverBackground | `#FFFFFF10` | `#00000008` |
| List.Button.leftRightInset / separatorInset | 8 / 4 | same |
| Table.rowHeight | **20** [Darcula] | 20 |
| Table.background | `#191A1C` (via *) | `#F7F8F9` (via *) |
| Table.foreground | `#D1D3D9` (via *) | `#000000` |
| Table.selectionBackground / InactiveBackground | `#2A4371` / `#33353B` (via *) | `#D0DFFE` / `#E9EAEE` |
| Table.gridColor | `#26282C` | `#E9EAEE` |
| Table.stripeColor / alternativeRowBackground | `#212326` | `#FFFFFF` |
| Table.hoverBackground | `#FFFFFF10` | `#00000008` |
| Table.cellNoFocusBorder | `2,3,2,3` | same |
| TableHeader.height | 25 [Darcula] | 25; `TableHeader.height.os.linux` 28 [IntelliJ] |
| TableHeader.background | `#191A1C` (via *) | `#F7F8F9` (via *) |
| TableHeader.bottomSeparatorColor / separatorColor | `#26282C` | `#E9EAEE` / `#d9d9d9` |

**Code fallbacks** (`JBUI$CurrentTheme$Tree/Table/List$Selection`): `Tree.selectionBackground` defaults to `DEFAULT_RENDERER_SELECTION_BACKGROUND`, and `Tree.selectionInactiveBackground` defaults to `DEFAULT_RENDERER_SELECTION_INACTIVE_BACKGROUND`.

### 1.6 Popup, menu, separator, borders

| Key | Islands Dark | Islands Light |
|---|---|---|
| Popup.background / PopupMenu.background / Menu.background / MenuItem.background | `#26282C` | `#FFFFFF` |
| Popup.borderColor / inactiveBorderColor | `#33353B` | `#D1D3D9` / `#ababab` |
| Popup.paintBorder | true | – |
| Popup.Header.activeBackground | `#26282C` | `#FFFFFF` |
| Popup.Header.inactiveForeground | `#73767C` | `#73767C` |
| Popup.Advertiser.background / foreground | `#26282C` / `#73767C` | `#F7F8F9` / `#73767C` |
| Popup.Advertiser.borderInsets / fontSizeOffset | `8,12,8,12` / -1 | same |
| PopupMenu.borderCornerRadius | 8 | 8 |
| PopupMenu.borderInsets | `6,1,6,1` | same |
| PopupMenuSeparator.height / stripeIndent / stripeWidth | 9 / 4 / 1 | same |
| Menu.borderColor / separatorColor | `#33353B` | `#E9EAEE` (os.default) |
| CompletionPopup.foreground / matchForeground | `#BCBEC4` / `#538AF9` | `#080808` / `#2F5EB9` |
| CompletionPopup.selectionBackground | `#2A4371` (via *) | `#D0DFFE` |
| SearchEverywhere.Tab.selectedBackground | `#233558` | `#E3EBFE` |
| SearchEverywhere.List.settingsBackground | `#26282C` | `#FFFFFF` |
| SearchEverywhere.Header.insets | `2,4,0,9` | same |
| Separator.separatorColor | `#33353B` | `#E9EAEE` |
| *.separatorColor | `#33353B` | `#E9EAEE` |
| Borders.color / Borders.ContrastBorderColor / OnePixelDivider.background | `#26282C` | `#E9EAEE` |
| ToolBar.separatorColor | `#FFFFFF21` | `#00000020` |
| Toolbar.Floating.background | `#33353B` | `#E9EAEE` |

### 1.7 Buttons, fields, controls

| Key | Islands Dark | Islands Light |
|---|---|---|
| Button.arc / Component.arc | **8** / **8** | 8 / 8 |
| Button.minimumSize | `72,28` | same |
| Button.startBackground / endBackground | transparent | `#FFFFFF` |
| Button.startBorderColor / endBorderColor | `#40434A` | `#D1D3D9` |
| Button.focusedBorderColor | `#191A1C` | `#F7F8F9` |
| Button.default.startBackground / endBackground / borders | `#3871E1` | `#3871E1` |
| Button.default.foreground | `#FFFFFF` | `#FFFFFF` |
| Button.default.focusedBorderColor | `#191A1C` | `#F7F8F9` |
| Component.focusColor | `#3871E1` | `#3871E1` |
| Component.focusWidth | 2 | 2 |
| Component.borderColor | `#40434A` | `#D1D3D9` |
| Component.arrowAreaWidth | 28 | 28 |
| Component.errorFocusColor / warningFocusColor | `#C54E58` / `#A56906` | `#E4656E` / `#C28013` |
| TextField.background | `#191A1C` | `#FFFFFF` |
| TextField.minimumSize | `49,28` | same |
| TextField.border | `DarculaTextBorderNew` | same |
| ComboBox.background / nonEditableBackground | `#26282C` | `#FFFFFF` |
| ComboBox.minimumSize / padding | `49,28` / `1,9,1,6` | same |
| ActionButton.hoverBackground / pressedBackground | `#FFFFFF17` / `#FFFFFF29` | `#00000012` / `#00000020` |
| ActionButton.focusedBorderColor | `#3871E1` | `#3871E1` |
| ProgressBar.progressColor / trackColor | `#3871E1` / `#40434A` | `#3871E1` / `#DDDFE4` |
| Counter.background / foreground | `#73767C` / `#000000` | `#8B8E94` / `#FFFFFF` |
| SpeedSearch.background / borderColor | `#191A1C` / `#40434A` | `#FFFFFF` / `#D1D3D9` |
| SearchMatch.start/endBackground | `#BA9752` | `#FEE6B1` |
| Banner.arc | 12 | 12 |
| Banner.info / error / warning / success Background | `#233558` / `#56272B` / `#44321D` / `#203B2A` | `#F7F8FF` / `#FFF6F5` / `#FFF6E9` / `#F5FAF3` |

### 1.8 Tooltip, notification, scrollbar

| Key | Islands Dark | Islands Light |
|---|---|---|
| ToolTip.background / borderColor | `#33353B` / `#33353B` | `#FFFFFF` / `#D1D3D9` |
| ToolTip.foreground / infoForeground / shortcutForeground | `#D1D3D9` / `#9FA2A8` / `#9FA2A8` | `#000000` / `#5F6269` / `#73767C` |
| Editor.ToolTip.background / border | `#26282C` / `#33353B` | `#FFFFFF` / `#D1D3D9` |
| Notification.background / borderColor | `#33353B` / `#33353B` | `#FFFFFF` / `#D1D3D9` |
| Notification.foreground / linkForeground | `#D1D3D9` / `#71A1FE` | `#000000` / `#2F5EB9` |
| Notification.Button.background / borderColor | `#33353B` / `#FFFFFF3B` | `#FFFFFF` / `#00000030` |
| Notification.ToolWindow.error/warning Background | `#56272B` / `#44321D` | `#FFF6F5` / `#FFF6E9` |
| Notification.Shadow.borderInsets | `5,5,5,5` | same |
| Notification.Shadow.*1Color | `#00000010` | `#80808010` |
| ValidationTooltip.errorBackground / errorBorderColor | `#56272B` / `#80383E` | `#FFF6F5` / `#FFC4C5` |
| ScrollBar.thumbColor / thumbBorderColor | `#80808059` / `#26262659` | `#73737333` / `#59595933` [IntelliJ] |
| ScrollBar.hoverThumbColor / hoverThumbBorderColor | `#8080808C` / `#2626268C` | `#73737347` / `#59595947` |
| ScrollBar.Transparent.thumbColor | `#80808059` | `#73737333` |
| ScrollBar.trackColor / hoverTrackColor | `#80808000` / `#80808000` | `#80808000` |
| ScrollBar.background | `#191A1C` (via *) | `#F7F8F9` (via *) |

### 1.9 Wildcard (`*`) defaults

These apply to any component without its own value.

| Key | Islands Dark | Islands Light |
|---|---|---|
| *.background | `#191A1C` | `#F7F8F9` |
| *.foreground | `#D1D3D9` | `#000000` |
| *.borderColor | `#26282C` | `#E9EAEE` |
| *.selectionBackground | `#2A4371` | `#D0DFFE` |
| *.selectionInactiveBackground | `#33353B` | `#E9EAEE` |
| *.selectionForeground / selectionInactiveForeground | `#D1D3D9` | `#000000` |
| *.lightSelectionBackground | `#233558` | `#E3EBFE` |
| *.hoverBackground | `#FFFFFF17` | `#00000012` |
| *.focusColor | `#3871E1` | `#3871E1` |
| *.underlineColor / inactiveUnderlineColor | `#3871E1` / `#40434A` | `#3871E1` / `#DDDFE4` |
| *.infoForeground / acceleratorForeground / shortcutForeground | `#73767C` | `#73767C` |
| *.disabledForeground | `#4C4F56` | `#9FA2A8` |
| *.modifiedItemForeground | `#71A1FE` | `#2F5EB9` |

### 1.10 Labels and links

| Key | Islands Dark | Islands Light |
|---|---|---|
| Label.foreground | `#D1D3D9` (via *) | `#000000` |
| Label.errorForeground / warningForeground / successForeground | `#F57E84` / `#D59637` / `#6DB083` | `#C54E58` / `#A56906` / `#338555` |

### 1.11 Classic New UI (expUI) "Dark" / "Light" core values, for comparison

| Key | expUI Dark | expUI Light |
|---|---|---|
| *.background | `#2B2D30` (Gray2) | `#F7F8FA` (Gray13) |
| *.foreground | `#DFE1E5` | `#000000` |
| *.selectionBackground / InactiveBackground | `#2E436E` / `#43454A` | `#D4E2FF` / `#DFE1E5` |
| MainToolbar.background | `#2B2D30` | `#27282E` (dark header) |
| EditorTabs.background / underlinedTabBackground | `#1E1F22` | `#FFFFFF` |
| EditorTabs.underlineHeight | 4 | 4 |
| ToolWindow.Button.selectedBackground / Button.default.startBackground | `#3574F0` | `#3574F0` |
| Popup.borderColor | `#43454A` | `#B9BDC9` |
| Borders.color | `#1E1F22` | `#EBECF0` |
| ToolTip.background | `#393B40` | `#FFFFFF` |
| Tree.rowHeight | 24 | 24 |

---

### 2. Editor color schemes

### 2.1 Where the schemes live

| Scheme | Source path | parent_scheme |
|---|---|---|
| **Islands Dark** (editor scheme of the Islands Dark theme) | `lib/intellij.platform.resources.jar!themes/islands/IslandSchemeDark.xml` | Darcula |
| Dark (expUI) | `…resources.jar!themes/expUI/expUI_darkScheme.xml` | Darcula |
| **Light** (editor scheme of Islands Light and expUI Light) | `…resources.jar!themes/expUI/expUI_lightScheme.xml` | Default |
| IntelliJ Light | `…resources.jar!themes/Light.xml` | Default |
| Default, Darcula | `…resources.jar!DefaultColorSchemesManager.xml` (two `<scheme>` blocks) | – / Default |

**SQL and database add-ons:**
- `plugins/DatabaseTools/lib/modules/intellij.database.sql.core.impl.jar!colorSchemes/SqlDarcula.xml` and `SqlDefault.xml`
- `plugins/DatabaseTools/lib/modules/intellij.database.impl.jar!colorSchemes/DatabaseDarcula.xml` and `DatabaseDefault.xml`

**No `font` element appears in any bundled scheme.** The fonts come from code; see §6.

### 2.2 SQL attribute fallback chain

Source: `intellij.database.sql.jar!com/intellij/sql/editor/SqlColors.class` `<clinit>` (bytecode).

| SQL key | Falls back to |
|---|---|
| SQL_KEYWORD | DEFAULT_KEYWORD |
| SQL_TYPE | SQL_KEYWORD |
| SQL_STRING | DEFAULT_STRING |
| SQL_NUMBER | DEFAULT_NUMBER |
| SQL_COMMENT (line and block) | DEFAULT_LINE_COMMENT |
| SQL_IDENT / SQL_IDENT_DELIMITED | TEXT |
| SQL_TABLE / SQL_SCHEMA / SQL_DATABASE_OBJECT | DEFAULT_CLASS_NAME |
| SQL_COLUMN | DEFAULT_INSTANCE_FIELD |
| SQL_OUTER_QUERY_COLUMN | SQL_COLUMN |
| SQL_PROCEDURE (routine/function call) | DEFAULT_STATIC_METHOD |
| SQL_PARAMETER | DEFAULT_PARAMETER |
| SQL_VARIABLE | DEFAULT_GLOBAL_VARIABLE |
| SQL_LOCAL_ALIAS | DEFAULT_LOCAL_VARIABLE |
| SQL_LABEL | DEFAULT_LABEL |
| SQL_SYNTHETIC_ENTITY | DEFAULT_PREDEFINED_SYMBOL |
| SQL_EXTERNAL_TOOL | INJECTED_LANGUAGE_FRAGMENT |
| SQL_SEMICOLON / COMMA / DOT / PARENS / BRACKETS / BRACES | DEFAULT_* equivalents |
| SQL_BAD_CHARACTER | BAD_CHARACTER |

There are no `SQL_FUNCTION` or `SQL_ROUTINE` keys; routine and function calls use SQL_PROCEDURE. The secondary DEFAULT_* fallbacks (CLASS_NAME, PARAMETER, LOCAL/GLOBAL_VARIABLE, INSTANCE_FIELD → DEFAULT_IDENTIFIER) are platform behaviour, **inferred** from `DefaultLanguageHighlighterColors`.

### 2.3 Resolved syntax colors

FONT_TYPE: 1 = bold, 2 = italic. Hex values are zero-padded here; the XML stores, for example, `33b3` for `#0033B3`.

| Attribute | **Islands Dark** | **Light** (Islands Light) |
|---|---|---|
| TEXT (editor fg / **bg**) | `#BCBEC4` / **`#191A1C`** | `#080808` / **`#FFFFFF`** |
| DEFAULT_KEYWORD → SQL_KEYWORD, SQL_TYPE | `#CF8E6D` | `#0033B3` |
| DEFAULT_STRING → SQL_STRING | `#6AAB73` | `#067D17` |
| DEFAULT_NUMBER → SQL_NUMBER | `#2AACB8` | `#1750EB` |
| DEFAULT_LINE_COMMENT → SQL_COMMENT | `#7A7E85` | `#8C8C8C` italic |
| DEFAULT_BLOCK_COMMENT | `#7A7E85` | `#8C8C8C` italic |
| DEFAULT_IDENTIFIER → SQL_TABLE / SCHEMA / DATABASE_OBJECT / PARAMETER / VARIABLE / LOCAL_ALIAS | `#BCBEC4` (from DEFAULT_IDENTIFIER) | `#000000` [Default] |
| DEFAULT_INSTANCE_FIELD → **SQL_COLUMN** | `#C77DBB` | `#871094` |
| DEFAULT_STATIC_METHOD → **SQL_PROCEDURE** (function call) | `#57AAF7` italic | `#00627A` italic |
| DEFAULT_FUNCTION_CALL | base DEFAULT_IDENTIFIER, `#BCBEC4` | (empty) |
| DEFAULT_OPERATION_SIGN | `#BCBEC4` | – |
| DEFAULT_METADATA | `#B3AE60` | `#9E880D` |
| SQL_SYNTHETIC_ENTITY | `#FFC66D` [Darcula/SqlDarcula.xml] | italic [Default] |
| SQL_OUTER_QUERY_COLUMN | `#9876AA` + underline (EFFECT_TYPE 1) [SqlDarcula.xml] | `#660E7A` bold + underline [SqlDefault.xml] |

Note: in the Darcula-based Islands Dark scheme, plain identifiers, tables and schemas all render in the editor text color `#BCBEC4`. Only columns (`#C77DBB`) and routines (`#57AAF7` italic) are highlighted.

### 2.4 Editor chrome colors (`<colors>`)

| Key | Islands Dark | Light |
|---|---|---|
| CARET_ROW_COLOR | `#1F2024` | `#F5F8FE` |
| CARET_COLOR | `#CED0D6` | `#000000` [Default] |
| SELECTION_BACKGROUND | `#214283` [Darcula] | `#A6D2FF` |
| SELECTION_FOREGROUND | (empty: keep syntax colors) | (empty) |
| LINE_NUMBERS_COLOR | `#4B5059` | `#AEB3C2` |
| LINE_NUMBER_ON_CARET_ROW_COLOR | `#A1A3AB` | `#767A8A` |
| GUTTER_BACKGROUND | `#313335` [inherited from Darcula; the Islands gutter likely paints editor bg (**inferred**)] | `#FFFFFF` |
| INDENT_GUIDE / SELECTED_INDENT_GUIDE | `#323438` / `#4E5157` | `#EBECF0` / `#AEB3C2` |
| RIGHT_MARGIN_COLOR | `#323438` | `#EBECF0` |
| WHITESPACES | `#6F737A` | `#ADADAD` |
| METHOD_SEPARATORS_COLOR | `#43454A` | `#DFE1E5` |
| TEARLINE_COLOR | `#555555` [Darcula] | `#D4D4D4` |
| CONSOLE_BACKGROUND_KEY | `#191A1C` | `#FFFFFF` |
| LOOKUP_COLOR / DOCUMENTATION_COLOR | `#27282B` | `#FFFFFF` |
| ADDED / MODIFIED / DELETED_LINES_COLOR | `#549159` / `#375FAD` / `#868A91` | `#7FC784` / `#88ADF7` / `#767A8A` |
| FOLDED_TEXT_BORDER_COLOR | `#2B2D30` | `#ADD9C7` |

**Reference:** expUI "Dark" uses CARET_ROW `#26282E`, CONSOLE_BACKGROUND `#1E1F22`, INDENT_GUIDE `#313438` and LOOKUP `#2B2D30`.

### 2.5 Highlighting attributes

EFFECT_TYPE codes, **inferred** from the platform serializer: 0 = boxed, 1 = underline, 2 = wave, 3 = strikeout.

| Attribute | Islands Dark | Light |
|---|---|---|
| ERRORS_ATTRIBUTES | wave (2) `#FA6675`, stripe `#D64D5B` | wave `#FF0000`, stripe `#CF5B56` [Default] |
| WARNING_ATTRIBUTES | wave `#F2C55C`, stripe `#C29E4A` | bg `#FCF4D4`, underline (1), stripe `#F2BF57` |
| WRONG_REFERENCES_ATTRIBUTES | fg `#F75464` | fg `#F50000` |
| NOT_USED_ELEMENT_ATTRIBUTES | fg `#6F737A` | fg `#808080` |
| DEPRECATED_ATTRIBUTES | strikeout (3) `#BCBEC4` | strikeout `#404040` |
| INFO_ATTRIBUTES | wave `#857042` | wave `#CCCCCC` |
| IDENTIFIER_UNDER_CARET_ATTRIBUTES | bg `#373B39`, stripe `#5B786A` | bg `#EDEBFC`, stripe `#D0A1FF` |
| WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES | bg `#402F33`, stripe `#BA6387` | bg `#FCE8F4` |
| SEARCH_RESULT_ATTRIBUTES | bg `#2D543F`, stripe `#42BD77` | bg `#CCCCFF` [Default] |
| TEXT_SEARCH_RESULT_ATTRIBUTES (find) | bg `#114957`, effect `#165E70`, stripe `#72D6D6` | fg `#000000`, bg `#FCD47E`, stripe `#C47233` |
| MATCHED_BRACE_ATTRIBUTES | bg `#43454A` bold | bg `#93D9D9` |
| FOLDED_TEXT_ATTRIBUTES | fg `#868991`, bg `#393B40` | fg `#414D41`, bg `#E9F5E6` |
| INJECTED_LANGUAGE_FRAGMENT | bg `#293C40` | bg `#EDFCED` |
| HYPERLINK_ATTRIBUTES | `#548AF7` underline | `#006DCC` underline |
| CONSOLE_NORMAL / ERROR / SYSTEM / USER_INPUT | `#BCBEC4` / `#F75464` / `#BCBEC4` / `#6AAB73` italic | `#000000` / `#7F0000` / `#00007F` / `#007F00` italic |

### 2.6 Database and data-grid keys

**Key definitions** (bytecode):
- `intellij.grid.impl.jar!com/intellij/database/editor/DataGridColors.class`
- `intellij.database.core.impl.jar!com/intellij/database/editor/DatabaseColors.class`
- `intellij.grid.impl.jar!com/intellij/database/datagrid/CellColors.class`
- `…/database/diff/TableDiffColors.class`

| Grid key | Defined as | Islands Dark | Light |
|---|---|---|---|
| GRID_NULL_VALUE (`<null>` text) | fallback DEFAULT_LINE_COMMENT | `#7A7E85` | `#8C8C8C` italic |
| GRID_ERROR_VALUE | fallback ERRORS_ATTRIBUTES | wave `#FA6675` | wave `#FF0000` |
| GRID_IMAGE_VALUE / GRID_RESULT_VALUE | fallback FOLDED_TEXT_ATTRIBUTES | fg `#868991` / bg `#393B40` | fg `#414D41` / bg `#E9F5E6` |
| GRID_UPLOAD_VALUE | fallback DEFAULT_METADATA | `#B3AE60` | `#9E880D` |
| GRID_SELECTION_BACKGROUND | = editor SELECTION_BACKGROUND | `#214283` | `#A6D2FF` |
| GRID_SELECTION_FOREGROUND | = SELECTION_FOREGROUND | (empty) | (empty) |
| GRID_CURRENT_ROW | = CARET_ROW_COLOR | `#1F2024` | `#F5F8FE` |
| GRID_STRIPE_COLOR | ColorKey with code fallback | only Default defines it, `#F5F8FE`; no dark value in any scheme (**dark stripe value unknown**) | `#F5F8FE` |
| STRUCTURE_HIDDEN_COLUMN | fallback DEPRECATED_ATTRIBUTES | strikeout `#BCBEC4` | strikeout `#404040` |
| Modified cell (TDIFF_MODIFIED → DIFF_MODIFIED) | CellColors | bg `#385570` [Darcula] | bg `#C2D8F2` [Light] |
| Inserted row (TDIFF_INSERTED → DIFF_INSERTED) | CellColors | bg `#294436` [Darcula] | bg `#BEE6BE` [Default] |
| Deleted row (TDIFF_DELETED → DIFF_DELETED) | CellColors | bg `#484A4A` [Darcula] | bg `#D6D6D6` [Default] |
| CONSOLE_RANGE_TO_EXECUTE | DatabaseColors | effect `#3D7A49` (Islands Dark) | boxed (0) `#BAA8FF` [DatabaseDefault.xml] |
| CONSOLE_PARAMETER | fallback SQL_PARAMETER | `#BCBEC4` | `#000000` |
| CONSOLE_SELECTED_PARAMETER | fallback SEARCH_RESULT_ATTRIBUTES | bg `#2D543F` | bg `#CCCCFF` |

**Settings page names:** `DataGridBundle` `DataGridColorSettingsPage.configurable.name.database=Data Editor and Viewer` and `attribute.descriptor.data.grid.null.data=Data Grid//Null data`.

---

### 3. DatabaseTools node icons

**Icon jar:** `plugins/DatabaseTools/lib/modules/intellij.database.jar`.
- `icons/expui/*.svg` holds the New UI icons; each has a `*_dark.svg` sibling.
- `icons/*.svg` holds the classic icons.
- `DatabaseIconMappings.json` maps classic → expui.

**Mapping sources:**
- Node kind → icon: `intellij.database.core.impl.jar!com/intellij/database/psi/DbPresentationCore*.class`.
- Field → path: `icons/DatabaseIcons.class` `<clinit>`. Each call passes the expui path and then the classic path.

Every expui icon `X.svg` below has a dark variant `X_dark.svg` next to it.

| Node | ObjectKind → field | New UI SVG (light; dark is `_dark.svg`) | Classic SVG |
|---|---|---|---|
| Data source (generic) | `DatabaseIcons.Dbms` | `icons/expui/dbms.svg` (+ `dbms@20x20.svg`) | `icons/dbms.svg` |
| Database tool-window icon | `ToolWindowDatabase` | `icons/expui/dbms.svg` | `icons/toolWindowDatabase.svg` |
| Data source per DBMS kind | `AllIcons.Providers.*` | `lib/intellij.platform.icons.jar!providers/<name>.svg`, e.g. `postgresql.svg` (+`_dark`), `mysql.svg` (+`_dark`), `sqlite.svg` (+`_dark`), `sqlServer.svg` (+`_dark`), `oracle.svg`, `clickHouse.svg`, `mariadb.svg`, `snowflake.svg`, `redis.svg`, `mongoDB.svg`, `duckDB.svg`, `bigQuery.svg`, `cassandra.svg`, `DB2.svg`, `h2.svg`, `redshift.svg`, `trino.svg` and 60 more | (no expui variant) |
| Database | DATABASE → `Database` | `icons/expui/database.svg` | `icons/database.svg` |
| Schema | SCHEMA → `Schema` | `icons/expui/schema.svg` | `icons/schema.svg` |
| Table | TABLE → `Table` | `icons/expui/table.svg` | `icons/table.svg` |
| **View** | VIEW → `AllIcons.Nodes.DataSchema` | `lib/intellij.platform.icons.jar!expui/nodes/dataSchema.svg` (+`_dark`) | `nodes/dataSchema.svg` |
| Materialized view | MAT_VIEW → `MaterializedView` | `icons/expui/materializedView.svg` | `icons/materializedView.svg` |
| Virtual view | `VirtualView` | `icons/expui/virtualView.svg` | `icons/virtualView.svg` |
| Column | COLUMN → `Col` | `icons/expui/column.svg` | `icons/col.svg` |
| PK column | `ColGoldKey` | `icons/expui/columnGoldKey.svg` | `icons/colGoldKey.svg` |
| FK column | `ColBlueKey` | `icons/expui/columnBlueKey.svg` | `icons/colBlueKey.svg` |
| PK+FK column | `ColGoldBlueKey` | `icons/expui/columnGoldBlueKey.svg` | `icons/colGoldBlueKey.svg` |
| Unique-key column | `ColGreyKey` | `icons/expui/columnGreyKey.svg` | `icons/colGreyKey.svg` |
| NOT NULL column (dot variants) | `ColDot`, `ColGoldKeyDot`, … | `icons/expui/columnDot.svg`, `columnGoldKeyDot.svg`, `columnBlueKeyDot.svg`, `columnGoldBlueKeyDot.svg` (+`…Index`, `…DotIndex` variants) | `icons/colDot.svg` … |
| Indexed column | `ColIndex` etc. | `icons/expui/columnIndex.svg`, `columnDotIndex.svg` | – |
| Primary key | KEY → `GoldKeyAlt` | `icons/expui/greyKey.svg` | `icons/goldKeyAlt.svg` |
| Gold key (PK glyph) | `GoldKey` | `icons/expui/goldKey.svg` | `icons/goldKey.svg` |
| Foreign key | FOREIGN_KEY → `BlueKey` | `icons/expui/blueKey.svg` | `icons/blueKey.svg` |
| Virtual FK | `VirtualForeignKey` | `icons/expui/virtualForeignKey.svg` | – |
| Index | INDEX → `Index` | `icons/expui/index.svg` | `icons/index.svg` |
| Unique / cluster / function index | `IndexUnique`, `IndexCluster`, `IndexFun`, `IndexUniqueFun` | `icons/expui/indexUnique.svg`, `indexCluster.svg`, `indexFun.svg`, `indexFunUnique.svg` | `icons/indexUnique.svg` … |
| Check constraint | CHECK → `CheckConstraint` | `icons/expui/checkConstraint.svg` | `icons/checkConstraint.svg` |
| Routine | ROUTINE → `Routine` | `icons/expui/routine.svg` | `icons/routine.svg` |
| Function | `Function` | `icons/expui/function.svg` | `icons/function.svg` |
| Procedure | `Procedure` | `icons/expui/procedure.svg` | `icons/procedure.svg` |
| Routines group | `ProcGroup` | `icons/expui/procedureGroup.svg` | `icons/procGroup.svg` |
| Argument | ARGUMENT → `Argument` | `icons/expui/argument.svg` | `icons/argument.svg` |
| Sequence | SEQUENCE → `Sequence` | `icons/expui/sequence.svg` | `icons/sequence.svg` |
| Trigger | TRIGGER → `Trigger` | `icons/expui/trigger.svg` | `icons/trigger.svg` |
| Package | PACKAGE → `Package` | `icons/expui/package.svg` | `icons/package.svg` |
| Synonym | SYNONYM → `Synonym` | `icons/expui/synonym.svg` | `icons/synonym.svg` |
| Role / user | ROLE → `Role`; USER → `AllIcons.General.User` | `icons/expui/role.svg`; `icons/expui/user.svg` (USER_MAPPING) | `icons/role.svg` |
| Tablespace | TABLESPACE → `Tablespace` | `icons/expui/tablespace.svg` | `icons/tablespace.svg` |
| Collation | `Collation` | `icons/expui/collation.svg` | `icons/collation.svg` |
| Folder (user folder in explorer) | `Folder` | `icons/expui/folder.svg` | – |
| Object-kind group node ("tables", "columns" …) | `ObjectGroup` | `icons/expui/objectGroup.svg` | `icons/objectGroup.svg` |
| Database objects group | `DatabaseObjGroup` | `icons/expui/databaseObjectsGroup.svg` | `icons/databaseObjGroup.svg` |
| Virtual folder | – | `icons/expui/virtualFolder.svg` | – |
| Query console | `Console` / `ToolWindowConsole` | `icons/expui/console.svg`, `toolWindowConsole.svg` | – |
| Object/table type | TABLE_TYPE / OBJECT_TYPE → `AllIcons.Nodes.Type` | `lib/intellij.platform.icons.jar!expui/nodes/type.svg` | – |

The Database tool window is declared in `plugin.xml` as `<toolWindow id="Database" anchor="right" icon="DatabaseIcons.ToolWindowDatabase">` (`xmls/database-plugin/META-INF/plugin.xml:1593`). DataGrip's layout may place it on the left; that is **not verified**.

---

### 4. Resource bundle messages

**Bundle locations:**
- `DatabaseBundle` = `plugins/DatabaseTools/lib/modules/intellij.database.jar!messages/DatabaseBundle.properties` (3620 lines).
- `DataGridBundle` = `plugins/grid-plugin/lib/modules/intellij.grid.core.impl.jar!messages/DataGridBundle.properties`.

### 4.1 Console output and timing

| Key | Text |
|---|---|
| `notification.content.choice.row.rows.retrieved.starting.from.in` | `{1, choice, 0#1 row\|1#{0} rows} retrieved starting from {2} in {3}` |
| `notification.content.rows.retrieved.in` | `0 rows retrieved in {0}` |
| `notification.content.choice.row.rows.affected.in` | `{1, choice, 0#1 row\|1#{0} rows} affected in {2}` |
| `0.row.s.affected.in.1` | `{0,number,#} row(s) affected in {1}` |
| `completed.in` | `completed in {0}` |
| `notification.content.summary.choice.statements.executed…aborted` | `Summary: {0}{2, choice, 0#\|1# of {1}} statements executed{4, choice, 0#, {3} failed\|1#} in {5}{7, choice, 0#\|1# ({6} symbols in file)}{8, choice, 0# (aborted!)\|1#}` |
| `notification.content.transaction.choice.committed.rolled.back` | `transaction {0, choice, 0#committed\|1#rolled back}{1}` |
| `notification.content.transaction.mode.on` | `{0} transaction mode ON` |
| `notification.content.session.changed.from.to` | `session changed from ''{0}'' to ''{1}''` |
| `notification.content.query.yielded.result.sets.only.were.retrieved` | `The query yielded {0} result sets, only {1} were retrieved.` |
| `notification.content.disconnected` | `Disconnected` |
| `console.default` | `Default Query Console` |

The timing suffix is hardcoded, not a bundle message. `intellij.database.connectivity.jar!com/intellij/database/run/audit/MeasuringDataAuditor.class` contains the string constants `" (execution: "` and `", fetching: "` and calls `StringUtil.formatDuration`. The rendered `{3}` is therefore `<total> (execution: <x>, fetching: <y>)`, where durations look like `123 ms` or `1 s 234 ms`. The closing `)` and the duration format are **inferred** from `formatDuration`.

### 4.2 Paging and grid

| Key | Text |
|---|---|
| `count.rows.action.of.text` | `of {0}` |
| `action.Console.TableResult.ChangePageSize.row` / `.rows` | `row` / `rows` |
| `action.Console.TableResult.ChangePageSize.querying` | `Querying…` |
| `action.ChangePageSize.text.all` / `.default` | `All` / `Default` |
| `separator.page.size` / `dialog.title.change.page.size` | `Page Size` / `Change Page Size` |
| `action.SetDefaultPageSize.text` | `Set as Default` |
| `TablePositionWidgetHelper.row` | `{0,choice, 0#rows\|1#row\|2#rows}` |
| `Console.TableResult.n.bytes.of.m.bytes.loaded` | `{0} of {1}` |
| `action.Console.TableResult.ColumnsList.description.hidden` | `{0} of {1} columns shown` |
| `grid.delete.selected.rows.action.confirmation` | `%s rows selected.\nAre you sure you want to delete the selected rows?` |

Cell placeholders come from string constants in `intellij.grid.core.impl.jar!com/intellij/database/run/ReservedCellValue.class` (enum NULL, DEFAULT, GENERATED, COMPUTED, UNSET): **`<null>`**, `<default>`, `<generated>`, `<computed>`, `<unset>`.

### 4.3 Test connection and data source info

| Key | Text |
|---|---|
| `test.connection.status.succeeded` / `.failed` | `Succeeded` / `Failed` |
| `test.connection.status.in.progress` | `In progress…` |
| `test.connection.status.keep.alive.fail` | `Keep-alive query failed` |
| `test.connection.status.database.returned.warning` | `Database returned warning` |
| `test.connection.action.copy` / `.search.error` / `.cancel` | `Copy` / `Search Error` / `Cancel` |
| `DataSourceTestConnectionPanel.test.connection` | `Test Connection` |
| `dataSource.quickInfo.dbmsPhrase` | `DBMS: {0}{2, choice, 0# (no ver.)\|1# (ver. {1})}` |
| `dataSource.quickInfo.driverPhrase` | `Driver: {0} (ver. {1}, JDBC{2})` |
| `dataSource.quickInfo.caseSensitivity2Phrase` | `Case sensitivity: plain={0}, delimited={1}` |
| `dataSource.quickInfo.effectiveVersion` | `Effective version: {0} (ver. {1})` |
| `text.ping.choice.keep.alive.query.results.in.error.choice.ssl` | `\nPing: {0}{1, choice, 0# (keep-alive query results in error)\|1#}{3, choice, 0#\nSSL: {2}\|1#}` |
| `connecting.to.database.ellipsis` / `connection.failed` | `Connecting to database…` / `Connection failed` |

### 4.4 Transaction mode

| Key | Text |
|---|---|
| `action.tx.text` (toolbar widget) | `Tx: {0}` |
| `action.tx.mode.text` / `action.tx.isolation.text` | `Tx Mode ({0})` / `Tx Isolation ({0})` |
| `transaction.mode` | `Transaction Mode` |
| `transaction.mode.auto` / `.manual` | **`Auto`** / **`Manual`** |
| `transaction.mode.auto.description` | `<html>Changes submitted to the <br>database are auto-committed</html>` |
| `transaction.mode.manual.description` | `<html>Manually commit changes <br>submitted to the database</html>` |
| `transaction.mode.database.default` / `.read.uncommitted` / `.read.committed` / `.repeatable.read` / `.serializable` | `Database Default` / `Read Uncommitted` / `Read Committed` / `Repeatable Read` / `Serializable` |
| `action.Console.Transaction.Commit.text` / `Rollback` / `RevertAndRollback` | `Commit` / `Roll back` / `Roll Back` |

### 4.5 Grid toolbar

The toolbar is `Console.TableResult.NavigationAndEditing.Group`, defined in `intellij.grid.impl.jar!intellij.grid.impl.xml`. Its contents, in order:

1. Pagination group: `First Page` [Console.TableResult.FirstPage], `Previous Page`, `Change Page Size`, `Count Rows`, `Next Page`, `Last Page`
2. separator
3. `Reload Page` [Console.TableResult.Reload]
4. separator
5. `Add Row`, `Delete Selected Rows`, `Revert Selected`

`intellij.database.grid.impl.xml` adds:
- `Export Data…` (ShowDumpDialogAction)
- SQL-expression toggle, `EditOrdering`, `Find`
- the ChangeSampleSize group
- the JdbcCancel group (`Cancel Running Statements`)
- AutoRefresh
- the "Last" group with `PreviewDml`
- `Submit`, `Submit and Commit`

**Other grid action texts:** `Show Row Filter`, `Edit Filter Criteria`, `Transpose`, `View as: Table / Tree / Text`, `Pin Column`, `Clone Row`, `Clone Column`, `Copy Column Name`, `Show Record View`, `Show Value Editor`, `Compare Cells…`, `Show/Hide Columns`, `Clear Sorting`, `View Query`, `NULL` (SetNull), `Set DEFAULT`, `Related Rows` (NavigateAction), `Go to Referenced Result`, `Find on Current Page`, `Clear Field`, `Load File…`.

The shortcuts are in §5.

### 4.6 Database Explorer context menu

Group `DatabaseViewPopupMenu`, from `intellij.database.impl.jar!intellij.database.impl.xml`. The texts come from `DatabaseBundle` / `ActionsBundle`; `_` marks the mnemonic.

```
Fix | --- | Data Source Properties | ---
New ▸ (Add ▸, ---, Import Data Sources…)
Copy/Paste ▸ (Copy Data Source, Copy Reference, Cut Data Source, Paste Data Source, Duplicate)
Edit Data | Refresh | Refresh Selected Object | Deactivate | Join Across Data Sources… | ---
Rename… | Move ▸ (Up, To Upper Level, To Lower Level, Down, ---, To Top Level, To Folder…)
Set Color ▸ (…, Share through VCS, Apply to Children, ---, Database Color Settings…) | ---
Open the List | Quick Documentation | Compare Schema Structure
Navigation ▸ (Go to DDL, Go to Files, Related Symbol…, Jump to Query Console…)
Find Usages | Refactor ▸ | --- | Introspection Level ▸ | --- | Run Routine… | ---
SQL Scripts ▸ (SQL Generator…, ---, Request and Copy Original DDL, Generate DDL to Clipboard,
               Generate DDL to Query Console, ---, Run SQL Script…)
Object Actions ▸ (Refresh Materialized View, Enable/Disable triggers/constraints, Modify Comment…, ---,
                  Truncate…, Drop Primary Key, Drop Foreign Key)
Tools ▸ (Manage Shown Schemas…, Set Color…, ---, Submit, Roll back, ---, Hide Schemas, Configure Layout,
         Edit External Objects File, ---, Scripted Extensions ▸)
Import/Export ▸ (Dump to DDL Data Source, …) | Diagrams ▸ | DDL Mapping ▸ | Linked Data Sources ▸ | ---
Diagnostics ▸ (Dump Metadata Model, …, Force Refresh, Forget This Schema Cache, Forget All Cached Schemas, …)
```

Other modules add items through `add-to-group` (for example Drop…, Import Data from File(s)…, Export); they are not expanded here.

The explorer toolbar is `DatabaseViewToolbar`:
`New ▸` | `Data Source Properties` | --- | `Refresh` | `Deactivate` | --- | `Jump to Query Console…` | `Edit Data` | `Go to DDL` | `Compare Schema Structure` | --- | `View Options ▸ (Filter, Database View Settings)`.

---

### 5. Default keymap bindings

**Sources:**
- `lib/intellij.platform.resources.jar!keymaps/$default.xml`.
- Plugin `<keyboard-shortcut keymap="$default">` entries and `use-shortcut-of` chains in `plugins/DatabaseTools/lib/database-plugin.jar!META-INF/plugin.xml`, `intellij.grid.impl.xml` and `intellij.database.grid.impl.xml`.

`Default for XWin.xml` and `Default for GNOME.xml` (parent `$default`) do **not** override any of the IDs below.

| Purpose | Action id | Keystroke ($default, Linux/Win) | Origin |
|---|---|---|---|
| Execute statement | `Console.Jdbc.Execute` | **Ctrl+Enter** | use-shortcut-of `Console.Execute.Multiline` ($default.xml:1132) |
| Execute (2) / (3) / Selection as single statement | `Console.Jdbc.Execute.2` / `.3` / `.Selection` | none | – |
| Execute in console (single line) | `Console.Execute` | Enter | $default.xml:1131 |
| Cancel running statements | `Console.Jdbc.Cancel` | **Ctrl+F2** | use-shortcut-of `Stop` |
| Explain plan | `Console.Jdbc.ExplainPlan` | none | – |
| New query console | `Jdbc.OpenConsole.New` | **Ctrl+Shift+Q** | plugin.xml |
| Query file | `Jdbc.OpenConsole.New.InPath` | Ctrl+Alt+Shift+Q | plugin.xml |
| Jump to query console | `Jdbc.OpenConsole.Any` | Ctrl+Shift+F10 | use-shortcut-of `Console.Open` |
| Go to DDL | `Jdbc.OpenEditor.DDL` | **Ctrl+B** / Ctrl+Click | use-shortcut-of `GotoDeclaration` |
| Edit data (table data editor) | `Jdbc.OpenEditor.Data` | **F4** | use-shortcut-of `EditSource` |
| Open console from object | `Jdbc.OpenEditor.Console` | F4 | use-shortcut-of `EditSource` |
| Jump to source | `EditSource` | F4 | $default |
| Submit grid changes | `Console.TableResult.Submit` | **Ctrl+Enter** | use-shortcut-of `Console.Jdbc.Execute` |
| Submit and commit | `Console.TableResult.SubmitAndCommit` | Ctrl+Alt+Shift+Enter | plugin.xml |
| Commit transaction | `Console.Transaction.Commit` | Ctrl+Alt+Shift+Enter | plugin.xml |
| Roll back | `Console.Transaction.Rollback` | none | – |
| Revert selected | `Console.TableResult.RevertSelected` | **Ctrl+Alt+Z** | use-shortcut-of `ChangesView.Revert` |
| Add row | `Console.TableResult.AddRow` | **Alt+Insert** | use-shortcut-of `Generate` |
| Clone row | `Console.TableResult.CloneRow` | Ctrl+D | use-shortcut-of `EditorDuplicate` |
| Delete rows | `Console.TableResult.DeleteRows` | **Ctrl+Y** | use-shortcut-of `EditorDeleteLine` |
| Reload page | `Console.TableResult.Reload` | Ctrl+F5 | use-shortcut-of `Refresh` |
| Next / previous page | `Console.TableResult.NextPage` / `PreviousPage` | Ctrl+Alt+Down / Ctrl+Alt+Up | grid xml |
| First / last page, Count rows | `…FirstPage` / `…LastPage` / `…CountRows` | none | – |
| Edit cell | `Console.TableResult.EditValue` | Enter / Alt+Enter / F2 | grid xml |
| Value editor | `Console.TableResult.EditValueMaximized` | Shift+Enter / Alt+Shift+Enter | grid xml |
| Record view | `Console.TableResult.ShowRecordView` | Ctrl+Shift+Enter | grid xml |
| Set NULL / Set DEFAULT | `Console.TableResult.SetNull` / `SetDefault` | Ctrl+Alt+N / Ctrl+Alt+D | database grid xml |
| Select row / column | `Console.TableResult.SelectRow` / `SelectColumn` | Shift+Space / Ctrl+Space | database grid xml |
| Related rows | `Console.TableResult.NavigateAction` | F4 | use-shortcut-of `EditSource` |
| Edit filter criteria | `Console.TableResult.EditFilterCriteria` | Ctrl+Alt+Shift+F | database grid xml |
| Compare cells | `Console.TableResult.CompareCells` | Ctrl+Shift+D | grid xml |
| Clear sorting | `Console.TableResult.ColumnSortReset` | Ctrl+Alt+Shift+Backspace | grid xml |
| Show/hide columns | `Console.TableResult.ColumnVisibility` | Space | grid xml |
| Copy | `Console.TableResult.Copy` | Ctrl+C / Ctrl+Insert | use-shortcut-of `$Copy` |
| Code completion | `CodeCompletion` / `SmartTypeCompletion` | **Ctrl+Space** / Ctrl+Shift+Space | $default |
| Search Everywhere | `SearchEverywhere` | **Double Shift** (`keyboard-gesture-shortcut "shift SHIFT" dblClick`) | $default.xml:11 |
| Go to class / database object | `GotoClass` | **Ctrl+N** | $default |
| Go to symbol / file / action | `GotoSymbol` / `GotoFile` / `GotoAction` | Ctrl+Alt+Shift+N / Ctrl+Shift+N / Ctrl+Shift+A | $default |
| Quick documentation | `QuickJavaDoc` | **Ctrl+Q** (Alt+middle-click) | $default |
| Quick definition | `QuickImplementations` | Ctrl+Shift+I | $default |
| Data source properties | `DatabaseView.PropertiesAction` | **Shift+Enter** | plugin.xml |
| Refresh (explorer) | `DatabaseView.Refresh` | **Ctrl+F5** | use-shortcut-of `Refresh` |
| Refresh selected object | `DatabaseView.RefreshFragment` | none | – |
| Synchronize | `Synchronize` | Ctrl+Alt+Y | $default |
| Generate DDL to clipboard | `DatabaseView.CopyDdlAction` | Ctrl+Alt+Shift+G, Ctrl+Shift+C | plugin.xml |
| Generate DDL to console | `DatabaseView.OpenDdlInConsole` | Ctrl+Alt+Shift+B | plugin.xml |
| SQL generator | `DatabaseView.SqlGenerator` | Ctrl+Alt+G | plugin.xml |
| Drop | `DatabaseView.DropAction` | Delete | use-shortcut-of `$Delete` |
| Modify object | `DatabaseView.Ddl.AlterObject` | Ctrl+F6 | use-shortcut-of `ChangeSignature` |
| Select in Database Explorer | `sql.SelectInDatabaseView` | Alt+Shift+B | plugin.xml |
| Full-text search | `DatabaseView.FullTextSearch` | Ctrl+Alt+Shift+F | fulltextsearch xml |
| Query history | `Console.Jdbc.BrowseHistory` | Ctrl+Alt+E | use-shortcut-of `Console.History.Browse` |
| Rename / Reformat / Comment line / Intentions | `RenameElement` / `ReformatCode` / `CommentByLineComment` / `ShowIntentionActions` | Shift+F6 / Ctrl+Alt+L / Ctrl+/ / Alt+Enter | $default |
| Database tool window | `ActivateDatabaseToolWindow` | not found in any bundled keymap | – |

---

### 6. Fonts

**Bundled font files** are in `/snap/datagrip/current/jbr/lib/fonts/`:
- `Inter-Regular.otf`, `Inter-Italic.otf`, `Inter-SemiBold.otf`, `Inter-SemiBoldItalic.otf`
- `JetBrainsMono-{Thin,ExtraLight,Light,Regular,Medium,SemiBold,Bold,ExtraBold}` plus their Italic variants (`.ttf`)
- FiraCode (Light/Regular/Medium/Bold/Retina), SourceCodePro, Inconsolata, Droid Sans/Serif/Mono, Roboto Light/Thin

The jars also hold `lib/intellij.platform.resources.jar!fonts/Roboto-Light.ttf`.

| Fact | Value | Evidence |
|---|---|---|
| **UI font (New UI)** | **Inter, 13.0 pt** (scaled by `JBUIScale.scaleFontSize`) | `intellij.platform.ide.impl.jar!com/intellij/ide/ui/laf/LafManagerImpl.class` `getDefaultInterFont`: `'Inter' 0 13.0 JBUIScale.scaleFontSize`. `LafManagerImplKt.useInterFont`: used when `isNewUI && isJetBrainsJvm` (or registry `ide.ui.font.force.use.inter.font`), and not for zh/ko/ja locales. |
| System default font size (fallback) | 12.0 | `JBUIScale.class` `DEF_SYSTEM_FONT_SIZE` = 12.0. On macOS without Inter: `.SF NS Text` 13. |
| **Editor font** | **JetBrains Mono**, **13** | `intellij.platform.editor.ui.jar!com/intellij/openapi/editor/colors/FontPreferences.class` `<clinit>`: `'JetBrains Mono' … DEFAULT_FONT_NAME … 13 12`. The size is 13 when the name is JetBrains Mono; 12 is the alternative branch. |
| Editor line spacing | 1.2 | **inferred**; the float constant was not extracted |
| Console font | Same as the editor font (JetBrains Mono 13) by default | **inferred**: `ConsoleFontOptions` / `AppConsoleFontConfigurable` exist and no bundled scheme has a `console-font` element |
| Font size offsets | `ToolWindow.Header.font.size.offset` 0; `Popup.Advertiser.fontSizeOffset` -1; `*.fontSizeOffset.compact` -1 | theme json |
