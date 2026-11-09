/**
 * Find Usages (Alt+F7): the objects that refer to the table, view, routine, column or synonym at the SQL caret or
 * selected in the Database Explorer (menus: Explorer > Navigation, editor context menu), grouped by kind, and the lines
 * of the SQL files that name it. Importing this module registers the action `db.findUsages`.
 */
import { registerAction } from "../../state/actions";
import { startFindUsages } from "./find";

const dispose = registerAction({
  id: "db.findUsages",
  title: "Find Usages",
  shortcut: "Alt+F7",
  run: (ctx) => startFindUsages(ctx),
});

if (import.meta.hot) import.meta.hot.dispose(dispose);
