export { SqlEditor, default } from "./SqlEditor";
export type {
  Dialect,
  EditorError,
  ExecMark,
  ExecuteRequest,
  Range,
  SchemaColumn,
  SchemaNode,
  SchemaRoutine,
  SchemaSnapshot,
  SchemaTable,
  SqlEditorHandle,
  SqlEditorProps,
  TableKind,
} from "./types";
export { splitStatements, statementAt, type Statement } from "./split";
export { formatScript, formatStatement } from "./format";
export { setCompletionExtrasProvider, type CompletionExtras, type ExtrasProvider, type ExtrasQuery } from "./extras";
