# Icon index

Naming: `<name>.svg` = light theme variant, `<name>_dark.svg` = dark theme variant, `@20x20` = 20px tool-window-stripe / main-toolbar size (others are 16px).

- Top-level icons and `checkbox/`: from JetBrains intellij-community (Apache-2.0), New UI `expui` set.
- `dg/`: extracted from the installed DataGrip 2026.3 (`/snap/datagrip/current/plugins/DatabaseTools/lib/modules/intellij.database.jar`, path `icons/expui/`). Proprietary JetBrains artwork, NOT covered by Apache-2.0 - **needs license review before distribution** (see NOTICE). Prefer the top-level equivalent where one exists.
- Modification: in every `*_dark.svg` the stroke/fill `#CED0D6` was replaced with `#C3C5CB`, which is what the Islands Dark theme does at runtime (`ManyIslandsDark.theme.json` -> `icons.ColorPalette {"#CED0D6": "icon-default-stroke"}`). Light icons are verbatim (`#6C707E`).
- Usage: the SVGs carry hard-coded colors; render them with `<img>` / CSS `background-image`, picking `_dark` under `[data-theme=dark]`. Icons drawn on a selected/accent background (e.g. stripe button selected) are recolored to white in the IDE (`iconColorsOnSelection`).

| name | source | variants | purpose |
|---|---|---|---|
| `run` | `intellij-community/platform/icons/src/expui/run/run` | light+dark | Execute statement / run (main toolbar, console toolbar) |
| `stop` | `intellij-community/platform/icons/src/expui/run/stop` | light+dark | Cancel running query |
| `rerun` | `intellij-community/platform/icons/src/expui/run/rerun` | light+dark | Rerun / re-execute query |
| `refresh` | `intellij-community/platform/icons/src/expui/general/refresh` | light+dark | Refresh tree / reload data |
| `add` | `intellij-community/platform/icons/src/expui/general/add` | light+dark | Add (new data source, add row) |
| `remove` | `intellij-community/platform/icons/src/expui/general/remove` | light+dark | Remove (minus) |
| `delete` | `intellij-community/platform/icons/src/expui/general/delete` | light+dark | Delete row / object (trash) |
| `edit` | `intellij-community/platform/icons/src/expui/general/edit` | light+dark | Edit (pencil) |
| `settings` | `intellij-community/platform/icons/src/expui/general/settings` | light+dark | Settings gear 16px |
| `settings@20x20` | `intellij-community/platform/icons/src/expui/general/settings@20x20` | light+dark | Settings gear 20px (main toolbar) |
| `search` | `intellij-community/platform/icons/src/expui/general/search` | light+dark | Search 16px |
| `search@20x20` | `intellij-community/platform/icons/src/expui/general/search@20x20` | light+dark | Search 20px (main toolbar) |
| `close` | `intellij-community/platform/icons/src/expui/general/close` | light+dark | Close (generic, 16px) |
| `close-small` | `intellij-community/platform/icons/src/expui/general/closeSmall` | light+dark | Editor tab close button |
| `close-small-hovered` | `intellij-community/platform/icons/src/expui/general/closeSmallHovered` | light+dark | Editor tab close button, hovered |
| `chevron-down` | `intellij-community/platform/icons/src/expui/general/chevronDown` | light+dark | Tree expanded / dropdown arrow |
| `chevron-right` | `intellij-community/platform/icons/src/expui/general/chevronRight` | light+dark | Tree collapsed |
| `chevron-up` | `intellij-community/platform/icons/src/expui/general/chevronUp` | light+dark | Collapse / up |
| `chevron-left` | `intellij-community/platform/icons/src/expui/general/chevronLeft` | light+dark | Back / left |
| `chevron-down-large` | `intellij-community/platform/icons/src/expui/general/chevronDownLarge` | light+dark | Main toolbar dropdown arrow |
| `collapse-all` | `intellij-community/platform/icons/src/expui/general/collapseAll` | light+dark | Collapse all (tree toolbar) |
| `expand-all` | `intellij-community/platform/icons/src/expui/general/expandAll` | light+dark | Expand all (tree toolbar) |
| `filter` | `intellij-community/platform/icons/src/expui/general/filter` | light+dark | Filter |
| `export` | `intellij-community/platform/icons/src/expui/general/export` | light+dark | Export data |
| `import` | `intellij-community/platform/icons/src/expui/general/import` | light+dark | Import data |
| `download` | `intellij-community/platform/icons/src/expui/general/download` | light+dark | Download / dump |
| `upload` | `intellij-community/platform/icons/src/expui/general/upload` | light+dark | Upload |
| `checkmark` | `intellij-community/platform/icons/src/expui/actions/checked` | light+dark | Checkmark (selected item, commit/submit fallback) |
| `green-checkmark` | `intellij-community/platform/icons/src/expui/general/greenCheckmark` | light+dark | Green checkmark (success state) |
| `revert` | `intellij-community/platform/icons/src/expui/vcs/revert` | light+dark | Revert changes |
| `history` | `intellij-community/platform/icons/src/expui/general/history` | light+dark | Query history |
| `folder` | `intellij-community/platform/icons/src/expui/nodes/folder` | light+dark | Folder / group node |
| `sql-file` | `intellij-community/platform/icons/src/expui/fileTypes/sql` | light+dark | SQL file type |
| `text-file` | `intellij-community/platform/icons/src/expui/fileTypes/text` | light+dark | Plain text file |
| `json-file` | `intellij-community/platform/icons/src/expui/fileTypes/json` | light+dark | JSON file type |
| `csv-file` | `intellij-community/platform/icons/src/expui/fileTypes/csv` | light+dark | CSV file type |
| `menu` | `intellij-community/platform/icons/src/expui/general/menu` | light+dark | Hamburger menu 16px |
| `menu@20x20` | `intellij-community/platform/icons/src/expui/general/windowsMenu@20x20` | light+dark | Hamburger main menu 20px (main toolbar, Linux/Windows) |
| `more-vertical` | `intellij-community/platform/icons/src/expui/general/moreVertical` | light+dark | More (vertical dots) - tool window header options |
| `more-horizontal` | `intellij-community/platform/icons/src/expui/general/moreHorizontal` | light+dark | More (horizontal dots) |
| `project` | `intellij-community/platform/icons/src/expui/toolwindows/project` | light+dark | Project/Files tool window 16px |
| `project@20x20` | `intellij-community/platform/icons/src/expui/toolwindows/project@20x20` | light+dark | Project/Files tool window stripe 20px |
| `services` | `intellij-community/platform/icons/src/expui/toolwindows/services` | light+dark | Services tool window 16px |
| `services@20x20` | `intellij-community/platform/icons/src/expui/toolwindows/services@20x20` | light+dark | Services tool window stripe 20px |
| `notifications` | `intellij-community/platform/icons/src/expui/toolwindows/notifications` | light+dark | Notifications (bell) 16px |
| `notifications@20x20` | `intellij-community/platform/icons/src/expui/toolwindows/notifications@20x20` | light+dark | Notifications (bell) stripe 20px |
| `structure@20x20` | `intellij-community/platform/icons/src/expui/toolwindows/structure@20x20` | light+dark | Structure tool window stripe 20px |
| `find@20x20` | `intellij-community/platform/icons/src/expui/toolwindows/find@20x20` | light+dark | Find tool window stripe 20px |
| `bookmarks@20x20` | `intellij-community/platform/icons/src/expui/toolwindows/bookmarks@20x20` | light+dark | Bookmarks tool window stripe 20px |
| `problems@20x20` | `intellij-community/platform/icons/src/expui/toolwindows/problems@20x20` | light+dark | Problems tool window stripe 20px |
| `pin` | `intellij-community/platform/icons/src/expui/general/pin` | light+dark | Pin tab |
| `pin-hovered` | `intellij-community/platform/icons/src/expui/general/pinHovered` | light+dark | Pin tab, hovered |
| `pin-selected` | `intellij-community/platform/icons/src/expui/general/pinSelected` | light+dark | Pinned tab |
| `pin-selected-hovered` | `intellij-community/platform/icons/src/expui/general/pinSelectedHovered` | light+dark | Pinned tab, hovered |
| `sort-ascending` | `intellij-community/platform/icons/src/expui/general/up` | light+dark | Sort ascending arrow (Table.ascendingSortIcon = General.ArrowUp -> expui up) |
| `sort-descending` | `intellij-community/platform/icons/src/expui/general/down` | light+dark | Sort descending arrow |
| `sort-by` | `intellij-community/platform/icons/src/expui/general/sortBy` | light+dark | Sort menu |
| `page-first` | `intellij-community/platform/icons/src/expui/actions/playFirst` | light+dark | Paging: first page |
| `page-prev` | `intellij-community/platform/icons/src/expui/actions/playBack` | light+dark | Paging: previous page |
| `page-next` | `intellij-community/platform/icons/src/expui/actions/playForward` | light+dark | Paging: next page |
| `page-last` | `intellij-community/platform/icons/src/expui/actions/playLast` | light+dark | Paging: last page |
| `pagination` | `intellij-community/platform/icons/src/expui/table/pagination` | light+dark | Page size / pagination control |
| `layout` | `intellij-community/platform/icons/src/expui/general/layout` | light+dark | Layout / view options |
| `info` | `intellij-community/platform/icons/src/expui/status/info` | light+dark | Info status |
| `info-outline` | `intellij-community/platform/icons/src/expui/status/infoOutline` | light+dark | Info status outline |
| `warning` | `intellij-community/platform/icons/src/expui/status/warning` | light+dark | Warning status |
| `warning-outline` | `intellij-community/platform/icons/src/expui/status/warningOutline` | light+dark | Warning status outline |
| `error` | `intellij-community/platform/icons/src/expui/status/error` | light+dark | Error status |
| `error-outline` | `intellij-community/platform/icons/src/expui/status/errorOutline` | light+dark | Error status outline |
| `success` | `intellij-community/platform/icons/src/expui/status/success` | light+dark | Success status |
| `information-dialog` | `intellij-community/platform/icons/src/expui/general/informationDialog` | light+dark | Info, dialog size (32px) |
| `warning-dialog` | `intellij-community/platform/icons/src/expui/general/warningDialog` | light+dark | Warning, dialog size (32px) |
| `error-dialog` | `intellij-community/platform/icons/src/expui/general/errorDialog` | light+dark | Error, dialog size (32px) |
| `question-dialog` | `intellij-community/platform/icons/src/expui/general/questionDialog` | light+dark | Question, dialog size (32px) |
| `copy` | `intellij-community/platform/icons/src/expui/general/copy` | light+dark | Copy |
| `paste` | `intellij-community/platform/icons/src/expui/general/paste` | light+dark | Paste |
| `undo` | `intellij-community/platform/icons/src/expui/general/undo` | light+dark | Undo |
| `redo` | `intellij-community/platform/icons/src/expui/general/redo` | light+dark | Redo |
| `locate` | `intellij-community/platform/icons/src/expui/general/locate` | light+dark | Select opened object in tree |
| `show` | `intellij-community/platform/icons/src/expui/general/show` | light+dark | Show / view |
| `hide` | `intellij-community/platform/icons/src/expui/general/hide` | light+dark | Hide tool window |
| `help` | `intellij-community/platform/icons/src/expui/general/help` | light+dark | Help |
| `open-new-tab` | `intellij-community/platform/icons/src/expui/general/openNewTab` | light+dark | Open in new tab |
| `split-vertically` | `intellij-community/platform/icons/src/expui/general/splitVertically` | light+dark | Split editor vertically |
| `split-horizontally` | `intellij-community/platform/icons/src/expui/general/splitHorizontally` | light+dark | Split editor horizontally |
| `balloon` | `intellij-community/platform/icons/src/expui/general/balloon` | light+dark | Notification balloon |
| `data-column` | `intellij-community/platform/icons/src/expui/nodes/dataColumn` | light+dark | Column node (platform equivalent, AllIcons.Nodes.DataColumn) |
| `data-schema` | `intellij-community/platform/icons/src/expui/nodes/dataSchema` | light+dark | Schema node (platform equivalent, AllIcons.Nodes.DataSchema) |
| `data-tables` | `intellij-community/platform/icons/src/expui/nodes/dataTables` | light+dark | View node / table group (AllIcons.Nodes.DataTables; DataGrip uses it for VIEW) |
| `find-forward` | `intellij-community/platform/icons/src/expui/actions/findForward` | light+dark | Find next |
| `find-backward` | `intellij-community/platform/icons/src/expui/actions/findBackward` | light+dark | Find previous |
| `inline-close` | `intellij-community/platform/icons/src/expui/inline/inlineClose` | light+dark | Inline clear (search field) |
| `match-case` | `intellij-community/platform/icons/src/expui/inline/matchCase` | light+dark | Search option: match case |
| `regex` | `intellij-community/platform/icons/src/expui/inline/regex` | light+dark | Search option: regex |
| `exact-words` | `intellij-community/platform/icons/src/expui/inline/exactWords` | light+dark | Search option: words |
| `window-minimize` | `intellij-community/platform/icons/src/expui/windows/minimize` | light+dark | Window control: minimize |
| `window-minimize-inactive` | `intellij-community/platform/icons/src/expui/windows/minimizeInactive` | light+dark | Window control: minimize (inactive window) |
| `window-maximize` | `intellij-community/platform/icons/src/expui/windows/maximize` | light+dark | Window control: maximize |
| `window-maximize-inactive` | `intellij-community/platform/icons/src/expui/windows/maximizeInactive` | light+dark | Window control: maximize (inactive window) |
| `window-restore` | `intellij-community/platform/icons/src/expui/windows/restore` | light+dark | Window control: restore |
| `window-restore-inactive` | `intellij-community/platform/icons/src/expui/windows/restoreInactive` | light+dark | Window control: restore (inactive window) |
| `window-close` | `intellij-community/platform/icons/src/expui/windows/close` | light+dark | Window control: close |
| `window-close-active` | `intellij-community/platform/icons/src/expui/windows/closeActive` | light | Window control: close, hovered (white on red) |
| `window-close-inactive` | `intellij-community/platform/icons/src/expui/windows/closeInactive` | light+dark | Window control: close (inactive window) |
| `column-filter` | `intellij-community/grid/core-impl/resources/icons/expui/columnFilter` | light+dark | Grid: column filter |
| `sort-history` | `intellij-community/grid/core-impl/resources/icons/expui/sortHistory` | light+dark | Grid: ORDER BY history |
| `filter-history` | `intellij-community/grid/core-impl/resources/icons/expui/filterHistory` | light+dark | Grid: WHERE history |
| `single-record-view` | `intellij-community/grid/core-impl/resources/icons/expui/singleRecordView` | light+dark | Grid: transpose / single record view |
| `statistics-panel` | `intellij-community/grid/core-impl/resources/icons/expui/statisticsPanel` | light+dark | Grid: statistics panel |
| `table-heatmap` | `intellij-community/grid/core-impl/resources/icons/expui/tableHeatmap` | light+dark | Grid: heatmap coloring |
| `clear-outputs` | `intellij-community/grid/core-impl/resources/icons/expui/clearOutputs` | light+dark | Grid: clear outputs |
| `checkbox/checkBox_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBox.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxFocused_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxFocused.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxDisabled_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxDisabled.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxSelected_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxSelected.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxSelectedFocused_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxSelectedFocused.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxSelectedDisabled_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxSelectedDisabled.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxIndeterminateSelected_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxIndeterminateSelected.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxIndeterminateSelectedFocused_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxIndeterminateSelectedFocused.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/checkBoxIndeterminateSelectedDisabled_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/checkBoxIndeterminateSelectedDisabled.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/radio_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/radio.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/radioFocused_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/radioFocused.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/radioDisabled_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/radioDisabled.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/radioSelected_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/radioSelected.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/radioSelectedFocused_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/radioSelectedFocused.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `checkbox/radioSelectedDisabled_dark` | `intellij-community/platform/platform-resources/src/themes/expUI/icons/dark/radioSelectedDisabled.svg` | dark | New UI checkbox/radio (24x24 canvas, 16px box). Light: recolor via Islands Light ColorPalette, see theme-tokens.md |
| `dg/dbms` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/dbms` | light+dark | Database tool window icon 16px / data source (DatabaseIcons.Dbms, mapped from toolWindowDatabase) |
| `dg/dbms@20x20` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/dbms@20x20` | light+dark | Database Explorer tool window stripe icon 20px |
| `dg/database` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/database` | light+dark | Database node |
| `dg/schema` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/schema` | light+dark | Schema node |
| `dg/table` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/table` | light+dark | Table node |
| `dg/view-virtual` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/virtualView` | light+dark | Virtual view node (no plain View icon in DatabaseIcons; DataGrip uses AllIcons.Nodes.DataTables for VIEW -> see ../data-tables.svg) |
| `dg/materialized-view` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/materializedView` | light+dark | Materialized view node |
| `dg/column` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/column` | light+dark | Column node |
| `dg/column-gold-key` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/columnGoldKey` | light+dark | Primary-key column |
| `dg/column-blue-key` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/columnBlueKey` | light+dark | Foreign-key column |
| `dg/column-gold-blue-key` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/columnGoldBlueKey` | light+dark | PK + FK column |
| `dg/column-index` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/columnIndex` | light+dark | Indexed column |
| `dg/column-dot` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/columnDot` | light+dark | NOT NULL column (dot overlay) |
| `dg/gold-key` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/goldKey` | light+dark | Primary key node |
| `dg/blue-key` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/blueKey` | light+dark | Foreign key node |
| `dg/grey-key` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/greyKey` | light+dark | Unique / alternate key |
| `dg/index` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/index` | light+dark | Index node |
| `dg/index-unique` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/indexUnique` | light+dark | Unique index node |
| `dg/check-constraint` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/checkConstraint` | light+dark | Check constraint |
| `dg/trigger` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/trigger` | light+dark | Trigger |
| `dg/function` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/function` | light+dark | Function node |
| `dg/procedure` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/procedure` | light+dark | Procedure node |
| `dg/routine` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/routine` | light+dark | Routine (generic) |
| `dg/sequence` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/sequence` | light+dark | Sequence node |
| `dg/package` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/package` | light+dark | Package |
| `dg/role` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/role` | light+dark | Role |
| `dg/user` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/user` | light+dark | User |
| `dg/database-objects-group` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/databaseObjectsGroup` | light+dark | Database objects group |
| `dg/server-objects-group` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/serverObjectsGroup` | light+dark | Server objects group |
| `dg/console` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/console` | light+dark | Query console |
| `dg/console-run` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/consoleRun` | light+dark | Run console |
| `dg/tool-window-console` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/toolWindowConsole` | light+dark | Console tool window 16px |
| `dg/tool-window-console@20x20` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/toolWindowConsole@20x20` | light+dark | Console tool window 20px |
| `dg/sql` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/sql` | light+dark | SQL |
| `dg/sql-script` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/sqlScript` | light+dark | SQL script |
| `dg/commit` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/commit` | light+dark | Commit transaction |
| `dg/rollback` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/rollback` | light+dark | Rollback transaction |
| `dg/submit` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/submitDB` | light+dark | Submit grid changes (DataGrip Ctrl+Enter) |
| `dg/preview-changes` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/previewChanges` | light+dark | Preview pending changes |
| `dg/edit-data` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/editData` | light+dark | Edit table data |
| `dg/manage-data-sources` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/manageDataSources` | light+dark | Data Sources and Drivers |
| `dg/ddl-dbms` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/ddlDbms` | light+dark | DDL data source |
| `dg/database-changes` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/databaseChanges` | light+dark | Database changes tool window |
| `dg/database-output@20x20` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/toolWindowDatabaseOutput@20x20` | light+dark | Database output tool window 20px |
| `dg/kill-process` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/killDataSourceProcess` | light+dark | Kill data source process |
| `dg/go-to-table` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/goToTable` | light+dark | Go to table |
| `dg/funnel` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/funnelRegular` | light+dark | Grid filter funnel |
| `dg/editor-output` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/editorOutput` | light+dark | Output in editor |
| `dg/dbms-output` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/dbmsOutput` | light+dark | DBMS output |
| `dg/locked` | `DataGrip 2026.3 intellij.database.jar!/icons/expui/locked` | light+dark | Read-only / locked |
| `explain-plan` | original artwork (Prometeo DataGrip) | light+dark | Query Plan result tab (Explain Plan) |
