# Query console + Database Output (`src/features/console`, `src/features/output`)

* `console/`: slot `editor.view.console` (`ConsoleView.tsx`: toolbar + `SqlEditor` bound to the console file, debounced
  autosave), `session.ts` (`ConsoleSession`: one DB session per console, execution, Tx mode, schema switcher),
  `history.tsx` (Ctrl+Alt+E), `actions.ts` (`sql.execute`, `sql.executeScript`, `sql.cancel`, `sql.commit`,
  `sql.rollback`, `sql.history`), `title.ts` (result tab names).
* `output/`: slots `output.header|headerActions|toolbar|body`; `model.ts` holds one `ConsoleOutput` (log + result tabs)
  per console tab; `format.ts` is the DataGrip log wording (unit tested).
* Statements the console sends itself (BEGIN, COMMIT, `SET search_path`, `select current_schema()`) end with
  `/*prometeo:internal*/` so the history popup hides them.
* Needs `ensureConnected` from `../explorer/core` (not exported by the explorer index).
