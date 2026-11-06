# Prometeo DataGrip

A DataGrip (New UI) clone built with Rust, Tauri 2, SolidJS and CodeMirror 6.
See `docs/PLAN.md` for the architecture contract.

## Requirements

- Rust stable (`rustup`), Node 20+, npm
- Linux: webkit2gtk-4.1 and the usual Tauri system libraries
  (see https://v2.tauri.app/start/prerequisites/)

## Run

```sh
npm install
npm run tauri dev      # desktop app with hot reload
npm run dev            # frontend only, in a browser at http://localhost:1420
                       # (Tauri commands fall back to mocks in src/api/tauri.ts)
```

## Build

```sh
npm run build          # type-check (tsc) + Vite production bundle into dist/
npm run tauri build    # release binary and bundles
cargo build -p prometeo-datagrip   # backend only
cargo clippy -p prometeo-datagrip
```

## Layout

- `src-tauri/` Tauri app (commands, app state)
- `crates/dbcore/` database core library (no Tauri dependency)
- `src/` SolidJS UI (`api/` command wrappers, `styles/` shell CSS, `theme/` tokens)

## Make targets

Run `make help` to see all targets. The most used:

| Target | What it does |
|---|---|
| `make install` | Install the frontend dependencies |
| `make run` | Build the release binary (if changed) and start the app |
| `make dev` | Run the app in development mode |
| `make build` | Build the release binary (`target/release/prometeo-datagrip`) |
| `make check` | Type-check, clippy, Rust format check and unit tests (no databases needed) |
| `make db-up` | Start the PostgreSQL (54329) and MySQL (33069) test containers |
| `make test-all` | All tests, including the database integration tests |
| `make ci` | Lint, all tests and the frontend build |

`make lint` (and so `check` and `ci`) also runs `make fmt-check`: run `make fmt` before you commit Rust changes.
