# Shell, slot API and UI kit (read this first if you plug a component into the main window)

The shell (`src/App.tsx`, `src/components/shell/*`) renders the Islands window: 43px main toolbar, the
tool window islands around the editor island (left, right and bottom docks; Database Explorer, Files, Database
Output, Services), the 34px status bar and the splitters between the islands. It owns **no** database logic:
everything else is plugged in through **slots**, **actions** and small **stores** in `src/state/`.

## 1. Slots: replace a placeholder

```ts
import { registerSlot } from "../../state/slots";
const dispose = registerSlot("explorer.body", ExplorerTree);   // call once at module load / app start
```

Registering the same id again replaces the component (the latest wins); `dispose()` clears it. Until a slot is
registered the shell shows a placeholder (the explorer one is a small Tree demo). Slot components get no props
unless noted.

| slot id | where | props |
|---|---|---|
| `explorer.body` | Database Explorer body (tree) | - |
| `explorer.toolbar` | 34px toolbar under the explorer header (use `ActionButton`, `ToolbarSeparator`, class `dg-toolbar dg-tw-toolbar`) | - |
| `explorer.headerActions` | header buttons left of the built-in ⋮ and — (locate, expand all, collapse all); shown on hover/focus | - |
| `explorer.header` | content right of the "Database Explorer" title | - |
| `files.body` | Files tool window body (placeholder: `FilesToolWindow` of `src/features/files`) | - |
| `services.body` | Services tool window body (`src/features/services`) | - |
| `<id>.header` / `.headerActions` / `.toolbar` | same slots for every window id (`explorer`, `files`, `output`, `services`) | - |
| `output.body` | Database Output body (results grid / log) | - |
| `output.header` | next to the "Database Output" title: `Tabs variant="result"` (Output + result tabs) | - |
| `output.headerActions` | right side of the output header (source + duration, open in editor), before ⋮ and — | - |
| `output.toolbar` | optional 34px toolbar under the output header | - |
| `editor.view.console` / `.table` / `.ddl` | content of an editor tab of that kind | `{ tab: EditorTab, active: boolean }` |
| `editor.empty` | shown when no editor tab is open | - |

* Every open editor tab keeps its view **mounted** (hidden with `display:none` when inactive), so CodeMirror/grid
  state survives tab switches. Use the `active` prop to focus when the tab becomes active.
* A tool window body is mounted the first time the window is shown, then kept alive.
* Give the element that should receive focus when the tool window is activated (Alt+1, Alt+8) the attribute
  `data-focus-target` (the `Tree` already has it).
* Header actions are only visible while the tool window is hovered or has focus (DataGrip behaviour).

## 2. Actions and shortcuts (`src/state/actions.ts`)

```ts
import { registerAction } from "../../state/actions";
registerAction({ id: "sql.execute", title: "Execute", shortcut: "Ctrl+Enter", icon: "run",
                 enabled: () => hasConsole(), when: () => editorFocused(), run: () => execute() });
```

Menus, toolbars (`<ActionButton action="sql.execute" />`) and the global keymap all use this registry.
`src/state/core-actions.ts` registers the shell's own actions plus **stubs** (no `run` → shown disabled) for the
operative ones other modules implement; register the same id with a `run` to enable it. Stub ids:
`db.newConsole db.dataSources db.refresh db.editData db.gotoDdl db.jumpToConsole nav.gotoObject
nav.searchEverywhere sql.execute sql.cancel sql.history sql.commit sql.rollback grid.export app.settings
edit.undo edit.redo edit.cut edit.copy edit.paste edit.selectAll edit.find edit.replace code.complete
code.reformat code.comment`. The main menu structure is `menus.ts` (add a menu entry there if you add an action).
When two actions share a shortcut (Ctrl+Enter), give them a `when()` guard; guarded ones win. A key already
handled (`preventDefault`) by a focused component (CodeMirror, Tree) is not dispatched again.

## 3. State stores (`src/state/`)

* `tabs.ts`: `openTab({ id, title, kind: "console"|"table"|"ddl", icon?, closeable?, pinned?, data? })`
  (activates an existing tab with the same id), `closeTab`, `activateTab`, `updateTab`, `setPinned`, `moveTab`,
  `tabs()`, `activeTab()`. Persisted (id, title, icon, kind, pinned, data: keep `data` JSON).
* `layout.ts`: `showToolWindow(id)`, `hideToolWindow(id)`, `toggleToolWindow(id)`, `layout.visible`, sizes
  (persisted via `saveUiState`; backend `get_ui_state` / `set_ui_state` with key `shell.layout`, localStorage mirror).
  Tool windows are declared in `TOOL_WINDOWS` (`explorer` Alt+1, `files` Alt+4, `output` Alt+8, `services`): each has a
  default anchor (`left` / `right` / `bottom`), size and toolbar pin; the user's anchor, size and pins are persisted
  per window. At most one window is visible per anchor (showing `services` hides `output`). Also in `layout.ts`:
  `moveToolWindow`, `stretchToolWindow`, `toggleMaximizeToolWindow`, `hideAllToolWindows` (second call restores the
  set), `toolWindowMenuItems()` (entries of View › Tool Windows). The panels stay at a fixed place in the DOM and
  `Shell` lays them out as a CSS grid (`data-anchor`), so moving a window keeps its body mounted.
* `status.ts`: `setStatus({ path: [{label, icon}], caret: {line, col}, lineSeparator, encoding, readOnly, txMode, task })`
  feeds the status bar. Set `caret` from the editor, `path` from the explorer selection.
* `theme.ts`: `theme()` ("dark"|"light"), `themePref()` ("dark" default), `setThemePref()`; sets `<html data-theme>`.
* `notify({ title, body, kind, actions })` (ui kit) shows a balloon bottom-right.

## 4. UI kit (`src/components/ui`, barrel `index.ts`)

`Icon` (by name, theme-aware: `<Icon name="dg/table" />`; names = path in `src/assets/icons` without extension),
`ActionButton` (22px toolbar button; `action`, `icon`, `title`, `shortcut`, `selected`, `dropdown`),
`Button`, `TextField`, `Checkbox`, `ComboBox`, `Tabs` (`variant` editor | result | dialog), `Splitter`,
`openMenu(items, { x, y } | { anchor })` (context menus, dropdowns, submenus, `title` + `compact` list popups),
`tip(text, shortcut)` (tooltip attributes, delegated), `notify`, `Dialog`, `createSpeedSearch`/`Highlighted`,
`Tree` (virtualized, speed search with the funnel filter mode (`controller.filterMode/setFilterMode`); `roots`, async `loadChildren`, `onActivate(item, "enter"|"f4"|"dblclick")`, `onContextMenu`,
controller via `ref`: expand/collapse/expandAll/collapseAll/select/refresh/getExpanded).

Dev only: `npm run dev` then open `/?demo=1&output` for demo tabs and status; `?notify` shows a balloon.
