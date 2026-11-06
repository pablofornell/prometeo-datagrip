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
