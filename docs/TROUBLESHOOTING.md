# Troubleshooting

## First: find the logs

**Help > Open Log Folder** opens the folder in the file manager. The same folder is:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\dev.prometeo.datagrip\logs` |
| macOS | `~/Library/Application Support/dev.prometeo.datagrip/logs` |
| Linux | `~/.local/share/dev.prometeo.datagrip/logs` |

`prometeo.YYYY-MM-DD.log` holds the daily log (7 days are kept) and `panic.log` holds panic
messages and backtraces. Logging defaults to `INFO`; to get more detail, close the app, set
`PROMETEO_LOG=debug` (or a full filter such as `info,prometeo_datagrip=debug`) and start it
again. An invalid filter string falls back to `INFO` instead of failing.

When reporting a problem, include the app version, OS, the steps to reproduce and the relevant
log lines. Read the excerpt before sharing it: logs can contain SQL text and connection
details. Never paste passwords.

## The app does not start

1. Check that the WebView2 Runtime is installed (Windows). Windows 11 and current Windows 10
   include it; otherwise install the Evergreen Runtime from Microsoft.
2. Start the app from a terminal to see messages that never reach the log, for example
   `npm run tauri dev` or `target\release\prometeo-datagrip.exe`.
3. If the log folder cannot be created, the app still starts and prints
   `cannot start logging: ...` to stderr. Check the permissions of the data directory.
4. A corrupt settings file does not block startup: the app renames it to
   `<name>.corrupt-<unix seconds>`, starts with defaults and lists the file in the startup
   warnings. Look in the configuration folder (`data-sources.json`, `ui-state.json`).

## Launching again does nothing

This is expected. The app is single-instance: a second launch hands control to the running copy
and restores its main window (unminimize, show, focus). If the window is on another virtual
desktop or behind other windows, check the taskbar before assuming the app is stuck.

## The window is missing or off-screen

The window position, size and maximized state are restored on startup. A saved position that
does not intersect any connected monitor is ignored, but a stale multi-monitor layout can still
leave the window hard to find.

1. Close the app.
2. Delete `.window-state.json` in the configuration folder:
   - Windows: `%APPDATA%\dev.prometeo.datagrip\`
   - macOS: `~/Library/Application Support/dev.prometeo.datagrip/`
   - Linux: `~/.config/dev.prometeo.datagrip/`
3. Start the app again. It opens centered at the default size.

**Window > Layouts > Reset Layout** restores the tool windows and splitters without touching
saved connections.

## A connection fails

- The error message comes from the server or driver and is shown in full. Check host, port,
  database name, user and SSL mode first.
- Use **Test Connection** in the Data Sources dialog to test unsaved settings.
- PostgreSQL: check `pg_hba.conf` and whether the server listens on the expected interface.
- MySQL/MariaDB: check the bind address and user grants for the client host.
- Oracle: the first start of a container or a fresh database can take minutes; wait until it
  accepts connections.
- If the connection drops while a query runs (server restart, `pg_terminate_backend`, `KILL`),
  the app reports a lost connection and marks the session. Reconnect from the explorer; an open
  transaction cannot be recovered and must be repeated.

## A query is slow or the grid is paging forever

The grid fetches rows in pages. Very large results are not loaded at once; use the paging
controls, add a `WHERE` clause, or export the query to a file instead. `Ctrl+F2` cancels the
running statement.

## Saves fail

Console and scratch files are saved automatically. On a failed save the app shows one
notification per file and keeps the tab marked as unsaved; it reports the same file again only
after a later save succeeds. Check that the data directory is writable and that the disk is not
full, then save again with `Ctrl+S`.

## Disk usage grows

- Logs rotate daily and only the last 7 files are kept.
- Query history keeps the newest 5000 entries or 10 MB, whichever comes first.
- Consoles are small `.sql` files under the data directory.

If the folders are much larger, inspect them before deleting anything: they may contain files
you attached to the project.

## Reset the application

Close the app first. To reset the UI only, delete `ui-state.json` and `.window-state.json` in
the configuration folder. To remove everything, rename (do not delete) both the configuration
and data folders listed above; the app recreates them with defaults on the next start. Export
your data sources and settings from **File > Manage IDE Settings** before a full reset if you
want to restore them.

## Build problems

- **`rustc` is older than 1.99**: Cargo's `rust-version` requires 1.99.0 or newer. Run
  `rustup update`, or install exactly the CI compiler with
  `rustup toolchain install 1.99.0 --component rustfmt --component clippy` and select it.
  Make sure no `RUSTUP_TOOLCHAIN` environment variable forces an old toolchain.
- **`link.exe not found` / missing Windows SDK**: install Visual Studio 2022 Build Tools with
  the **Desktop development with C++** workload, or build with the GNU toolchain
  (`rustup toolchain install stable-x86_64-pc-windows-gnu` plus MinGW-w64).
- **`npm ci` refuses to install**: the lockfile and `package.json` disagree. Run `npm install`,
  verify the app still builds, and commit the updated `package-lock.json`.
- **Cargo waits on a lock**: another Cargo process uses the shared `target/` directory. Wait for
  it to finish; do not delete the lock file.
- **`InvalidPackageType` while bundling**: `bundle.targets` is `"all"` and builds only the
  host's package types. Build Linux installers on Linux and Windows installers on Windows.
- **Formatting or Clippy failures in CI**: run `cargo fmt --all` and
  `cargo clippy --workspace --all-targets -- -D warnings` locally with Rust 1.99.0 or newer.
  CI uses exactly 1.99.0.

Database integration tests are not part of CI. Start the containers with `make db-up` and run
`make test-all` locally; the tests skip when their `PROMETEO_*_URL` variables are absent.

## Environment overrides

Useful for demos, tests and portable setups; set them before launching the app:

| Variable | Effect |
|---|---|
| `PROMETEO_CONFIG_DIR` | Configuration folder (`data-sources.json`, `ui-state.json`) |
| `PROMETEO_DATA_DIR` | Data folder (logs, consoles, history, WebView storage) |
| `PROMETEO_LOG` | Log filter (`debug`, or a full `tracing` filter) |
| `PROMETEO_NO_KEYRING=1` | Do not use the OS credential store (tests and headless runs) |

`PROMETEO_CONFIG_DIR` does not move the window state: `.window-state.json` always stays in the OS
application config folder listed under
[The window is missing or off-screen](#the-window-is-missing-or-off-screen), because the window-state
plugin resolves it from the platform config directory and ignores the override.

**Help > Open Log Folder** is scoped to the default data folder. When `PROMETEO_DATA_DIR` points
somewhere else, open `<that folder>/logs` manually in the file manager; everything else (logging,
consoles, history) already uses the override.

See [BUILD-WINDOWS.md](BUILD-WINDOWS.md) for build instructions and
[USER-GUIDE.md](USER-GUIDE.md) for feature usage.
