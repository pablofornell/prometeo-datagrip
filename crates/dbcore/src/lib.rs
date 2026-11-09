//! Database core for Prometeo DataGrip (no Tauri dependency).
//!
//! Entry point is [`ConnectionManager`]. See `README.md` for the API overview.

pub mod cell;
pub mod compare;
pub mod conn;
pub mod ddl;
pub mod dump;
pub mod error;
pub mod exec;
pub mod explain;
pub mod export;
pub mod fsutil;
pub mod history;
pub mod import;
pub mod introspect;
pub mod manager;
pub mod model;
pub mod oracle;
pub mod quote;
pub mod script;
pub mod split;
pub mod table;
pub mod tx;
pub mod usages;
pub mod value;

pub use conn::{Conn, Pool};
pub use dump::{DumpOptions, DumpProgress, DumpResult};
pub use error::{DbError, Result, ServerError};
pub use explain::{ExplainPlan, PlanNode, PlanProp};
pub use export::{
    export_result, export_result_with, export_to_string, EncodingWriter, ExportEncoding,
    ExportFormat, ExportOptions, ExportProgress, ExportReport, Exporter,
};
pub use history::{HistoryEntry, QueryHistory};
pub use import::{
    ImportFormat, ImportPreview, ImportProgress, ImportRequest, ImportResult, ImportRowError,
};
pub use introspect::IntrospectOptions;
pub use manager::{ConnectionManager, ExecHandle, ExecutionId, SessionId};
pub use model::*;
pub use oracle::{OraBind, OraConn, OraPool, OraTx};
pub use script::{ScriptError, ScriptOptions, ScriptProgress, ScriptSummary};
pub use split::{split_statements, statement_at, statement_at_utf16, Statement};
pub use usages::{Usage, UsageKind};
