//! Database core for Prometeo DataGrip (no Tauri dependency).
//!
//! Entry point is [`ConnectionManager`]. See `README.md` for the API overview.

pub mod conn;
pub mod ddl;
pub mod error;
pub mod exec;
pub mod export;
pub mod history;
pub mod import;
pub mod introspect;
pub mod manager;
pub mod model;
pub mod quote;
pub mod split;
pub mod table;
pub mod tx;
pub mod value;

pub use conn::{Conn, Pool};
pub use error::{DbError, Result, ServerError};
pub use export::{export_result, export_to_string, ExportFormat, ExportOptions, Exporter};
pub use history::{HistoryEntry, QueryHistory};
pub use import::{
    ImportFormat, ImportPreview, ImportProgress, ImportRequest, ImportResult, ImportRowError,
};
pub use introspect::IntrospectOptions;
pub use manager::{ConnectionManager, ExecHandle, ExecutionId, SessionId};
pub use model::*;
pub use split::{split_statements, statement_at, statement_at_utf16, Statement};
