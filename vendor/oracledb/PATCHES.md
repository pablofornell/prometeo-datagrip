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
| `src/metadata.rs` | `Metadata::declared_data_type()`: CLOB / BLOB / NCLOB columns fetched as string / bytes are described as `LONG` / `LONG RAW` by `data_type()` (the driver redefines them); this returns the declared type. |

The server of the test container (`sqlnet.ora` with `DISABLE_OOB=ON`, `BREAK_POLL_SKIP=1000`) only notices a
break while it sends result packets or reads: a call that just burns CPU or sleeps (`dbms_session.sleep`) is
interrupted when it ends. Queries that scan or stream are cancelled at once.
