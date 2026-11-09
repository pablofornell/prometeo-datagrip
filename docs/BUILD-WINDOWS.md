# Building Prometeo DataGrip on Windows

## Requirements

- Windows 10 (1809 or newer) or Windows 11, 64-bit.
- [Node.js](https://nodejs.org/) 20 LTS or newer (includes npm).
- [Rust](https://rustup.rs/) through `rustup`, version 1.99.0 or newer. Cargo's
  `rust-version` enforces the minimum, CI uses exactly 1.99.0, and `rust-toolchain.toml` adds
  the `rustfmt` / `clippy` components to the active toolchain. Any host triple works (MSVC or
  GNU on Windows); the project does not force one.
- **Visual Studio 2022 Build Tools** with the **Desktop development with C++** workload
  (MSVC compiler and Windows SDK) when using the default MSVC toolchain. The lighter "C++
  build tools" selection is enough; the full IDE is not required. If you use the GNU toolchain
  (`x86_64-pc-windows-gnu`) instead, install MinGW-w64 and skip the Visual Studio workload.
- **WebView2 Runtime**. It ships with Windows 11 and current Windows 10 updates. The
  installers embed the WebView2 bootstrapper, so end users do not have to install it first.
- Optional: Git for Windows (Git Bash) if you want to use the `make` targets.

## Install and run

```powershell
git clone <repository-url> prometeo-datagrip
cd prometeo-datagrip
npm ci
npm run tauri dev
```

`npm ci` installs the exact dependency tree from `package-lock.json`. Use `npm install` only
when you are deliberately changing dependencies. The first Rust build takes several minutes;
later builds are incremental.

## Build the release binary and installers

```powershell
npm run build          # type-check + Vite production bundle into dist/
npm run tauri build    # optimized binary and Windows installers
```

Outputs (the workspace `target/` directory is at the repository root):

| Path | What it is |
|---|---|
| `target\release\prometeo-datagrip.exe` | Standalone release binary |
| `target\release\bundle\nsis\Prometeo DataGrip_0.1.0_x64-setup.exe` | NSIS installer (per user) |
| `target\release\bundle\msi\Prometeo DataGrip_0.1.0_x64_en-US.msi` | MSI installer |

For a binary without installers:

```powershell
npm run tauri build -- --no-bundle
```

The NSIS installer installs for the current user (no administrator prompt) and offers English
and Spanish. `bundle.targets` is `"all"`, which on Windows means NSIS plus MSI; asking Tauri
for Linux-only targets on Windows fails with `InvalidPackageType`.

## Using `make`

The `Makefile` assumes a POSIX shell. Run it from **Git Bash**, not `cmd.exe` or PowerShell,
and have `make` on `PATH` (for example through MSYS2 or Chocolatey). `make build`,
`make bundle` and `make run` append `.exe` automatically on Windows.

```sh
make install   # npm ci when package-lock.json exists
make build     # release binary, no installers
make bundle    # release binary + NSIS and MSI installers
```

## Code signing

No signing certificate is configured in the repository. Unsigned installers work, but Windows
SmartScreen may warn on first launch. For a public release, configure Authenticode signing in
`src-tauri/tauri.conf.json` under `bundle.windows` (`certificateThumbprint`, `digestAlgorithm`,
`timestampUrl`, or a custom `signCommand`) and keep the certificate and its password out of the
repository. The CI workflow only documents the optional updater signing secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; it does not contain any
key material.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- `ubuntu-latest` and `windows-latest`: format check, Clippy with warnings as errors, frontend
  type-check and unit tests, Rust workspace tests (no databases) and the frontend build.
- On `v*` tags it additionally builds the installers on Linux, Windows and macOS, uploads them
  as workflow artifacts and creates a **draft** GitHub release.

Database integration tests need the Docker containers from `make db-up` and are not part of
CI. Run them locally with `make test-all`.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if a build or the app fails.
