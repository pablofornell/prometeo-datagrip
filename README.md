# Prometeo DataGrip

A DataGrip (New UI) clone built with Rust, Tauri 2, SolidJS and CodeMirror 6.
See `docs/PLAN.md` for the architecture contract.

## Requirements

- Rust through `rustup`. Cargo's `rust-version` requires 1.99.0 or newer, CI builds with
  exactly 1.99.0, and `rust-toolchain.toml` adds the `rustfmt` / `clippy` components.
- Node 20+ and npm.
- Windows: Visual Studio 2022 Build Tools (Desktop development with C++) and the WebView2
  Runtime. See `docs/BUILD-WINDOWS.md` for the full setup.
- Linux: webkit2gtk-4.1 and the usual Tauri system libraries
  (see https://v2.tauri.app/start/prerequisites/).
- macOS: Xcode command line tools. The minimum supported version is 10.15.

## Run

```sh
npm ci
npm run tauri dev      # desktop app with hot reload
npm run dev            # frontend only, in a browser at http://localhost:1420
                       # (Tauri commands fall back to mocks in src/api/tauri.ts)
```

## Build

```sh
npm run build          # type-check (tsc) + Vite production bundle into dist/
npm run tauri build    # release binary and installers for the host OS
cargo build -p prometeo-datagrip   # backend only
cargo clippy -p prometeo-datagrip
```

Bundles are written to `target/release/bundle/` (NSIS and MSI on Windows, deb and AppImage on
Linux, dmg on macOS). `npm run tauri build -- --no-bundle` builds only the binary.

## Documentation

- [User guide](docs/USER-GUIDE.md): data sources, consoles, grid, history, shortcuts.
- [Building on Windows](docs/BUILD-WINDOWS.md): prerequisites, installers, signing, CI.
- [Troubleshooting](docs/TROUBLESHOOTING.md): logs, window state, connections, resets.
- [Architecture contract](docs/PLAN.md).
- [Security](docs/SECURITY.md): credential storage and threat model.

## Layout

- `src-tauri/` Tauri app (commands, app state)
- `crates/dbcore/` database core library (no Tauri dependency)
- `src/` SolidJS UI (`api/` command wrappers, `styles/` shell CSS, `theme/` tokens)

## Make targets

Run `make help` to see all targets. The most used:

| Target | What it does |
|---|---|
| `make install` | Install the frontend dependencies (`npm ci` when a lockfile exists) |
| `make run` | Build a fast-release binary (`target/fast-release/`, only if something changed) and start the app |
| `make dev` | Run the app in development mode |
| `make build` | Build the release binary (`target/release/prometeo-datagrip`) |
| `make bundle` | Build the release binary and the installers for the host OS |
| `make check` | Type-check, clippy, Rust format check and unit tests (no databases needed) |
| `make db-up` | Start the PostgreSQL (54329), MySQL (33069) and Oracle (15219) test containers |
| `make test-all` | All tests, including the database integration tests |
| `make ci` | Lint, all tests and the frontend build |

`make lint` (and so `check` and `ci`) also runs `make fmt-check`: run `make fmt` before you
commit Rust changes.

## Tests and CI

```sh
make test        # frontend + Rust unit tests, no databases needed
make test-all    # everything, including the Docker-backed database tests
```

`.github/workflows/ci.yml` runs the format check, Clippy, type-check, unit tests and frontend
build on Linux and Windows. Pushing a `v*` tag also builds installers on Linux, Windows and
macOS and creates a draft release.

## Logs and diagnostics

The app keeps daily logs in `<data dir>/logs` (`prometeo.YYYY-MM-DD.log`, 7 days) plus
`panic.log`. **Help > Open Log Folder** opens the folder. Set `PROMETEO_LOG=debug` (or a full
`tracing` filter) before launching for more detail. The app is single-instance: launching it
again focuses the existing window. `PROMETEO_CONFIG_DIR` and `PROMETEO_DATA_DIR` override the
default per-user folders; see `docs/TROUBLESHOOTING.md`.
