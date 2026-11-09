# Prometeo DataGrip: user guide

Prometeo DataGrip is a desktop SQL client for PostgreSQL, MySQL/MariaDB, SQLite and Oracle.
It follows the DataGrip (New UI) layout: Database Explorer on the left, editor tabs in the
middle, results and Database Output at the bottom, and the status bar along the bottom edge.

## First start

The app opens with an empty workspace. Create a data source before running any SQL:

1. Open **File > Data Sources…** (`Ctrl+Alt+Shift+S`).
2. Add a data source, choose the driver and fill in host, port, database and credentials.
3. Use **Test Connection** to check the settings, then save.
4. Double-click the data source in the Database Explorer to connect and browse it.

Data sources are stored per user, outside the repository. Passwords are handled by the OS
credential store where one is available; see [SECURITY.md](SECURITY.md) for the details of
credential storage and what to do when the keyring is unavailable.

## Database Explorer

The explorer loads its children lazily as you expand a data source: databases, schemas, tables,
views, routines, sequences, then columns, keys, indexes and foreign keys. Use the toolbar and
the context menu to refresh (`Ctrl+F5`), open a table's data, view its DDL (`Ctrl+B`), create a
console, or start **Import Data from File(s)…** on a table.

The speed-search field filters the tree as you type. `Escape` returns the keyboard focus to the
editor.

## Query consoles

- **File > New > Query Console** or `Ctrl+Shift+Q` opens a console for the selected data source.
- `Ctrl+Enter` executes the statement at the caret.
- **Run > Execute Script** executes the whole editor content.
- `Ctrl+F2` cancels the running statement.
- **Run > Explain Plan** shows the plan; **Explain Analyse** also executes it (not available on
  SQLite and Oracle).
- `Ctrl+Alt+Shift+Enter` commits, **Run > Rollback** rolls back.
- `Ctrl+Alt+E` opens query history.

Consoles are saved automatically as you type. If a save fails, the app shows one notification
for that file and does not repeat it until a later save succeeds. The tab keeps its unsaved
state so nothing is lost silently.

## Results and the data grid

Query results appear in the Database Output. The grid virtualizes rows and columns, so large
result sets stay responsive; further pages are fetched on demand.

- Edit a cell and press `Ctrl+Enter` to submit the pending changes, or `Ctrl+Alt+Z` to revert
  them. Inserted and deleted rows go through the same submit/revert cycle.
- Page through a result with the grid toolbar; page changes are blocked while edits are pending.
- Copy cells as TSV/CSV, or use **Export Data to File** to write CSV, JSON or SQL `INSERT`
  output. Exports stream all rows to a file chosen in the Save dialog.
- The value editor opens long values; `NULL` is rendered distinctly from an empty string.

## Files and scratches

Open SQL files with **File > Open** and run them with `Ctrl+Shift+F10`. Scratch files
(**File > New > Scratch File**) live inside the app data directory and need no project on disk.
`Ctrl+S` saves all modified files, and **File > Reload All from Disk** (`Ctrl+Alt+Y`) reloads
them after an external change. Recent files are available with `Ctrl+E`.

## Query history

Every executed statement is recorded per data source. Browse or search it with `Ctrl+Alt+E`,
and clear it from the same dialog. To keep the history file bounded, the app keeps the newest
**5000 entries or 10 MB**, whichever limit is reached first; older entries are dropped
automatically. The history file is compacted in place without blocking the UI.

## Settings, themes and layout

- **File > Settings…** (`Ctrl+Alt+S`) changes the theme, editor font and keymap.
- **View > Appearance** switches between system, dark and light themes.
- **Window > Layouts > Reset Layout** restores the default tool-window arrangement.
- The window size, position and maximized state are restored on the next start. A saved
  position that no longer intersects a monitor is ignored, so the window stays reachable.
- Settings and data sources can be exported and imported from **File > Manage IDE Settings**.

## Logs and diagnostics

The app writes a daily log to its data directory:

| OS | Log folder |
|---|---|
| Windows | `%APPDATA%\dev.prometeo.datagrip\logs` |
| macOS | `~/Library/Application Support/dev.prometeo.datagrip/logs` |
| Linux | `~/.local/share/dev.prometeo.datagrip/logs` |

Files are named `prometeo.YYYY-MM-DD.log`; the last 7 days are kept. **Help > Open Log Folder**
opens the folder in the file manager. Panics are written to `panic.log` in the same folder,
flushed before the process exits.

Logging defaults to `INFO`. Set the `PROMETEO_LOG` environment variable before launching the app
to change it, for example `PROMETEO_LOG=debug` or
`PROMETEO_LOG=info,prometeo_datagrip=debug`. Invalid filter strings fall back to `INFO`.

## Single instance

Only one copy of the app runs at a time. Launching it again does not open a second window: the
existing window is restored (unminimized, shown and focused). This also applies when the app was
started from a file association.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+Shift+S` | Data Sources dialog |
| `Ctrl+Shift+Q` | New query console |
| `Ctrl+Enter` | Execute statement at caret / submit grid edits |
| `Ctrl+F2` | Cancel running statements |
| `Ctrl+Alt+E` | Query history |
| `Ctrl+Alt+Shift+Enter` | Commit |
| `Ctrl+N` | Go to database object |
| `Ctrl+Shift+N` | Go to file |
| `Ctrl+E` | Recent files |
| `Ctrl+Shift+A` | Find action |
| `Ctrl+Alt+S` | Settings |
| `Ctrl+Alt+L` | Reformat code |
| `Ctrl+/` | Toggle line comment |
| `Ctrl+S` | Save all files |
| `Ctrl+Shift+F10` | Run file |
| `Ctrl+F4` | Close tab |
| `Ctrl+Shift+F12` | Hide all tool windows |

Shortcuts can be reviewed and changed in **File > Settings > Keymap**.
