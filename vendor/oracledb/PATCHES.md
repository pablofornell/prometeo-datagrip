# Changes to the vendored `oracledb` crate

Upstream: https://github.com/oracle/rust-oracledb, version 26.0.0-beta.5, licence `UPL-1.0 OR Apache-2.0`
(`LICENSE.txt`, `NOTICE.txt`, `README.md` are the upstream files). Only the library is vendored: the user
guide (`doc/`), tests, examples and helper binaries of the upstream crate were left out, and `Cargo.toml` is
trimmed accordingly. The crate is a path dependency of `crates/dbcore` and is **not** a workspace member
(`exclude = ["vendor"]` in the root `Cargo.toml`), so `cargo clippy --workspace` does not lint it.

Why: Prometeo DataGrip needs to cancel a running statement (the console's Stop button), and the public API of
the crate has no way to do it from another thread.

| file | change |
|---|---|
| `src/cancel.rs` (new) | `CancelHandle`: writes the in-band break marker (packet type MARKER, `MARKER_TYPE_INTERRUPT`) to a clone of the connection's TCP socket. Does nothing when no call is running. |
| `src/client/mod.rs` | `BreakState` shared with the handle (a call is running / a break was sent and is not answered yet); `perform_round_trip` marks the call; a break that arrives after the call finished leaves a marker packet in the socket, which is consumed before the next call (otherwise ORA-01013 would hit it); `reset()` accepts a reset marker that was already received (the server answers a break with the reset marker itself, the original code always waited for a second one and hung). `Client::cancel_handle()`, `Client::in_transaction()`. |
| `src/connection/conn_impl.rs`, `src/connection/mod.rs` | `Connection::cancel_handle()` (fails for TLS connections: a marker cannot be injected into the TLS stream) and `Connection::in_transaction()` (the "transaction in progress" flag the server sets in every response). |
| `src/transport.rs` | `Transport::cancel_socket()`. |
| `src/lib.rs` | `mod cancel; pub use cancel::CancelHandle;`; the `guide` module (it includes the not vendored `doc/` files) is removed. |
| `src/messages/auth.rs`, `src/constants.rs`, `src/error.rs`, `Cargo.toml` (`sha1`) | Logon with **11G password verifiers** (upstream only knew 12C and panicked on the missing `AUTH_PBKDF2_VGEN_COUNT`, seen as "connection has been closed" / ORA-01017 on old accounts). Same algorithm as python-oracledb thin mode: the verifier type is the flags of the `AUTH_VFR_DATA` pair; 11G hash = SHA1(password ‖ vfr_data) + 4 zero bytes (AES-192); a 48-byte session key gives combo key = XOR of bytes 16..40; no speedy key. Other verifier types (10G) and missing / malformed auth values return `ErrorKind::UnsupportedPasswordVerifier` / `InvalidAuthResponse` instead of panicking. The stored combo key is a `Vec<u8>` (24 or 32 bytes). |
| `src/messages/mod.rs`, `src/messages/fast_auth.rs`, `src/client/mod.rs` | `Message::pre_process` returns `Result` (auth errors propagate); `change_password` without a combo key is `NotConnected` instead of a panic. |
| `src/metadata.rs` | `Metadata::declared_data_type()`: CLOB / BLOB / NCLOB columns fetched as string / bytes are described as `LONG` / `LONG RAW` by `data_type()` (the driver redefines them); this returns the declared type. |

The server of the test container (`sqlnet.ora` with `DISABLE_OOB=ON`, `BREAK_POLL_SKIP=1000`) only notices a
break while it sends result packets or reads: a call that just burns CPU or sleeps (`dbms_session.sleep`) is
interrupted when it ends. Queries that scan or stream are cancelled at once.

The 11G logon is tested by `logon_with_11g_password_verifier` in `crates/dbcore/tests/oracle.rs`
(`PROMETEO_ORACLE_11G_URL`). It needs `SQLNET.ALLOWED_LOGON_VERSION_SERVER=11` in the server's `sqlnet.ora`
and an account whose `dba_users.password_versions` is `11G` only.
