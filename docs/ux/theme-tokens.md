# Theme tokens - IntelliJ New UI / DataGrip "Islands"

Extracted from `intellij-community` (checkout `e20bd8bd`, build 271.SNAPSHOT, read-only) and cross-checked
against the installed DataGrip 2026.3 (build 263.7307.216). CSS implementation: `src/theme/dark.css`,
`src/theme/light.css`, `src/theme/metrics.css`, `src/theme/fonts.css`.

All theme paths below are relative to `intellij-community/platform/platform-resources/src/themes/`
unless noted. `IslandsDark` = `islands/ManyIslandsDark.theme.json`, `IslandsLight` =
`islands/ManyIslandsLight.theme.json`, `expUI_dark` = `expUI/expUI_dark.theme.json`, `darcula` =
`darcula.theme.json`, `intellijlaf` = `intellijlaf.theme.json`.

## 1. Which theme DataGrip actually uses

- DataGrip 2026.3 ships the **Islands** look as the platform default. `platform/platform-impl/src/com/intellij/openapi/wm/impl/EarlyProjectFrame.kt:194`
  says "the platform default theme is Islands Dark", and the user's own DataGrip config
  (`~/.config/JetBrains/DataGrip2026.3/options/colors.scheme.xml`) uses the editor scheme `Islands Dark`.
- Themes are registered in `platform/platform-impl/resources/intellij.platform.ide.impl.xml:994-1003`:
  `ExperimentalDark` (= classic New UI "Dark", `expUI_dark`), `ExperimentalLight`, `Islands Dark`, `Islands Light`.
- Parent chains (child keys override parent keys):
  - **Islands Dark**: `darcula` -> `expUI_dark` -> `IslandsDark`; editor scheme `Islands Dark`
    (`islands/IslandSchemeDark.xml`, parent `Darcula` in `../DefaultColorSchemesManager.xml:1562`, parent `Default` at `:2`).
  - **Islands Light**: `darcula` -> `intellijlaf` -> `expUI_light` -> `expUI/expUI_light_with_light_header.theme.json` -> `IslandsLight`;
    editor scheme `Light` (`expUI/expUI_lightScheme.xml`, parent `Default`).
- Resolution rules emulated (from `platform/platform-impl/src/com/intellij/ide/ui/UIThemeBean.kt:248-322,490-512`
  and `UITheme.kt:92-115`): nested JSON objects flatten with `.`; `os.linux` wins over `os.default`;
  values that name a key of the `colors` map resolve (recursively) to its hex; parent-only keys are
  applied first, then the child's keys in file order, so a child `"*": {"background": ...}` wildcard
  overrides every `*.background` key inherited from parents, and later explicit child keys override the wildcard.
  `.compact` keys (compact mode) are ignored here.
- Islands runtime specifics (`platform/platform-impl/src/com/intellij/openapi/application/impl/islands/IslandsUICustomization.kt`):
  - Every tool window and the editor are "islands" painted on `MainWindow.background`. Each island is inset by
    `Island.borderWidth / 2` = 3 px (`:951`), so the gap between two islands is 6 px, and corners are drawn with a
    quadratic curve of size `Island.arc / 2` = **10 px** (`:941-960`). Use `border-radius: 10px`.
  - Components inside tool windows whose background is `Panel.background` are repainted with `ToolWindow.background` (`:266-287`).
    So trees in the Database Explorer use the tool window colour (dark `#191A1C`, light `#FFFFFF`), not `Tree.background`.
  - `ToolWindow.Header.background` is not painted by the bundled Islands themes (only by custom themes, `:336-358`): the
    header is transparent over `ToolWindow.background`.
  - Editor/common/debugger tabs use `IslandsTabPainter` (`IslandsTabPainter.kt:170-282`): no underline. Each tab is a
    rounded **pill 28 px high** (vertically centred in the 40 px tab row, min 8 px vertical offset), inset 4 px left/right,
    radius `MainToolbar.Button.arc` 12 / 2 = 6 px. Selected+focused: fill `EditorTabs.underlinedTabBackground`, 1 px border
    `EditorTabs.underlinedBorderColor`; selected, editor not focused: `inactiveUnderlinedTabBackground` / `inactiveUnderlinedTabBorderColor`;
    hovered: `EditorTabs.hoverBackground`, no border; normal: no fill. Unselected tab text uses `EditorTabs.unselectedAlpha` 0.75.
- Icons: `IslandsDark` remaps the dark icon stroke `#CED0D6` -> `icon-default-stroke` `#C3C5CB` (`IslandsDark:1802-1806`).
  The copied `*_dark.svg` files already have this applied. Light icons keep `#6C707E`.
- For reference, the classic New UI "Dark" (`ExperimentalDark`) differs: `*.background #2B2D30`, editor `#1E1F22`,
  `MainToolbar.background #2B2D30`, `*.selectionBackground #2E436E`, `*.selectionInactiveBackground #43454A`,
  editor tabs with a 4 px `#3574F0` underline (`EditorTabs.underlineHeight` 4, arc 4). Not used by our tokens.

## 2. The 20 values that define the look

| what | Islands Dark | Islands Light | token |
|---|---|---|---|
| window background (gaps, toolbar, stripes, status bar) | `#26282C` | `#E9EAEE` | `--dg-window-bg` |
| island / tool window / editor background | `#191A1C` | `#FFFFFF` | `--dg-island-bg` |
| dialog / panel background | `#191A1C` | `#F7F8F9` | `--dg-panel-bg` |
| popup / menu background | `#26282C` | `#FFFFFF` | `--dg-popup-bg` |
| popup border | `#33353B` | `#D1D3D9` | `--dg-popup-border` |
| border / divider | `#26282C` | `#E9EAEE` | `--dg-border` |
| default text | `#D1D3D9` | `#000000` | `--dg-text` |
| secondary text | `#73767C` | `#73767C` | `--dg-text-secondary` |
| accent (primary button, focus, selected stripe button) | `#3871E1` | `#3871E1` | `--dg-accent` |
| tree/list selection, focused | `#2A4371` | `#D0DFFE` | `--dg-tree-selection-bg` |
| tree/list selection, unfocused | `#33353B` | `#E9EAEE` | `--dg-tree-selection-inactive-bg` |
| row hover | `#FFFFFF10` | `#00000008` | `--dg-row-hover-bg` |
| icon-button hover / pressed | `#FFFFFF17` / `#FFFFFF29` | `#00000012` / `#00000020` | `--dg-hover-bg` |
| selected editor tab fill / border | `#233558` / `#2E4D89` | `#E3EBFE` / `#A7C5FF` | `--dg-tab-selected-*` |
| editor text / background | `#BCBEC4` / `#191A1C` | `#080808` / `#FFFFFF` | `--dg-editor-fg/bg` |
| editor caret row | `#1F2024` | `#F5F8FE` | `--dg-editor-caret-row` |
| editor selection | `#214283` | `#A6D2FF` | `--dg-editor-selection-bg` |
| keyword | `#CF8E6D` | `#0033B3` | `--dg-editor-keyword` |
| string / number | `#6AAB73` / `#2AACB8` | `#067D17` / `#1750EB` | `--dg-editor-string/number` |
| comment | `#7A7E85` | `#8C8C8C` italic | `--dg-editor-line-comment` |

## 3. Fonts

| what | value | source |
|---|---|---|
| UI font | **Inter 13 px** (all OSes except macOS where the system font is used) | `platform/platform-impl/src/com/intellij/ide/ui/laf/LafManagerImpl.kt:171-172` (`INTER_NAME`, `INTER_SIZE = 13`), `:895-899` |
| UI size scale | small 11, medium 12, regular 13, h4 14 bold, h3 16, h2 18, h1 22 bold, h0 25 bold | `platform/util/ui/src/com/intellij/util/ui/JBFont.java:169-176` |
| Editor font | **JetBrains Mono 13 px**, line spacing **1.2** | `platform/editor-ui-api/src/com/intellij/openapi/editor/colors/FontPreferences.java:20-24,96-99` |
| Editor line height | 21 px (= ceil(font height 17 * 1.2); derived, verify in browser) | `EditorImpl` line height formula |
| Data grid font | editor font; row height = ceil(fontHeight * lineSpacing) + rowMargin = ~22 px | `intellij-community/grid/impl/src/run/ui/treetable/GridTreeTable.java:100,141` |
| Tool window header font | label font, `ToolWindow.Header.font.size.offset` 0 | `IslandsDark:1164` |
| Popup advertiser font | label - 1 (`Popup.Advertiser.fontSizeOffset` -1) | `IslandsDark:915` |

Font files: Inter 4.000 and JetBrains Mono 2.304 are bundled in
`intellij-community/platform/jewel/int-ui/int-ui-standalone/src/main/resources/fonts/{inter,jetbrains-mono}/`;
Regular/Italic/Medium/SemiBold/Bold (Inter) and Regular/Italic/Bold/BoldItalic (JetBrains Mono) are copied to
`src/theme/fonts/` (SIL OFL 1.1). Other weights are available in the same folders.

## 4. Metrics (px, scale 1.0)

IntelliJ `arc` values are diameters (`RoundRectangle2D`), so CSS `border-radius = arc / 2`.

| metric | value | source |
|---|---|---|
| Main toolbar / title bar height | 40 (compact 32) | `platform/platform-impl/src/com/intellij/openapi/wm/impl/customFrameDecorations/header/CustomHeader.kt:70-72` |
| Main toolbar button | 30x30, icon 20 | `platform/util/ui/src/com/intellij/util/ui/JBUI.java:1275-1294` |
| Main toolbar button/dropdown hover radius | 6 (arc 12) | `JBUI.java:1396-1398,1425-1427` |
| Main toolbar dropdown insets | 5,10,5,6 (t,l,b,r); max width 350 | `JBUI.java:1389`, `IslandsDark:1221` |
| Main toolbar icon insets | 6,5,4,5 | `IslandsDark:1217` |
| Stripe button | 37x40, icon 20, radius 6 (`Button.ToolWindow.arc` 12) | `IslandsDark:1194`, `JBUI.java:1335-1344,1368` |
| Tool window header height | 41 | `JBUI.java:1179-1189` (`ToolWindow.Header.height` not set by any theme) |
| Tool window header label insets | 0,12,0,16; toolbar insets 0,12,0,8; header tab insets 0,12 | `JBUI.java:1139-1140,1191-1197` |
| Editor tab row height | 40 = 28 - (tabInsets top+bottom -6-6) | `platform/platform-api/src/com/intellij/ui/tabs/impl/SingleHeightTabs.kt:15`, `platform/platform-impl/src/com/intellij/openapi/fileEditor/impl/EditorTabbedContainer.kt:917-923`, `IslandsDark:708` |
| Editor tab pill | 28 high, 4 inset, radius 6 | `IslandsTabPainter.kt:170-201,269-276` |
| Editor tab insets | -6,8,-6,8; close-button gap 0,4,0,2 | `IslandsDark:708,712` |
| Classic underline (not Islands) | height 4, arc 4 | `IslandsDark:694-695` |
| Island corner radius / gap | 10 / 6 (3 per side) | `IslandsDark:416-424`, `IslandsUICustomization.kt:941-960` |
| Status bar height | 28 = label 16 + widget insets 6,8 (x2) | `platform/platform-impl/src/com/intellij/openapi/wm/impl/status/IdeStatusBarImpl.kt:1244`, `JBUI.java:1026-1040` |
| Status bar widget hover insets | 3,4,1,4 | `JBUI.java:994` |
| Tree row height | 24 | `IslandsDark:1235` |
| Tree insets | 4,12,4,12 | `IslandsDark:1237` |
| Tree indent | leftChildIndent 7 + rightChildIndent 11 = 18 | `darcula:740,743` |
| Tree/List selection radius | 4 (arc 8) | `JBUI.java:2518`, `:1646` |
| List row height / insets | 24 / 4,0,4,0 | `IslandsDark:755,757` |
| Popup corner radius | 8 (`PopupMenu.borderCornerRadius`, OS window radius) | `darcula:495`, `platform/platform-impl/src/com/intellij/ide/ui/laf/intellij/IdeaPopupMenuUI.java:32`, `platform/platform-impl/src/com/intellij/ui/WindowRoundedCornersManager.java:126-132` |
| Popup border width | 1 | `JBUI.java:1596` |
| Popup selection | radius 4, inner insets 0,8 | `JBUI.java:1646-1650` |
| Popup header insets | 12,10,10,10 | `JBUI.java:1575-1577` |
| Popup separator insets | 4,8 | `JBUI.java:1624` |
| Popup advertiser insets | 8,12,8,12 | `IslandsDark:916` |
| Popup shadow | 16 px soft shadow (`Ide.Shadow.borderInsets`) | `IslandsDark:799` |
| Popup menu | insets 6,1,6,1; selection radius 4, inner 0,6, outer 1,7; separator height 9 | `darcula:494,501`, `JBUI.java:1677-1685` |
| Button | min 72x28, radius 4 (arc 8), horizontal padding 14 | `IslandsDark:512,521`, `platform/platform-impl/src/com/intellij/ide/ui/laf/darcula/ui/DarculaButtonUI.java:71` |
| Text field / combo | min height 28; radius 4 (`Component.arc` 8); focus ring width 2 | `IslandsDark:676,1095,561`, `darcula:212` |
| Combo box | padding 1,9,1,6; arrow area 28 | `IslandsDark:563,678` |
| Checkbox / radio | 24 px icon, 16 px box, radius 3, text gap 4 | `IslandsDark:542-544`, `expUI/icons/dark/checkBox.svg` |
| Toolbar action button | 22x22 min (16 px icon) | `platform/editor-ui-api/src/com/intellij/openapi/actionSystem/ActionToolbar.java:79` |
| Scrollbar | 10 thick (opaque), overlay 10 -> 14 on hover; thumb fully rounded | `platform/platform-api/src/com/intellij/ui/components/DefaultScrollBarUI.kt:54-56`, `ScrollBarPainter.java:250-260` |
| Tooltip radius | 6 (multiline 8) | `IslandsDark:1105-1106` |
| Help tooltip insets | 12,16,16,16 (small 8,12,9,12) | `JBUI.java:2279-2283` |
| Notification balloon radius | 6 (arc 12) | `platform/platform-impl/src/com/intellij/ui/NotificationBalloonRoundShadowBorderProvider.kt:33,53` |
| Banner radius | 6 (arc 12) | `IslandsDark:489` |
| Swing table | row 20, cell padding 2,3; header height 25 (light 28) | `darcula:657,662,670`, `intellijlaf` |
| Validation tooltip max width | 384 | `darcula:753` |

## 5. Data grid (DataGrip result/table editor)

The grid module is open source (`intellij-community/grid/`). Its colours come from the **editor colour scheme**,
not from the UI theme (`grid/impl/src/run/ui/grid/GridColorSchemeUtil.java:13-40`, `grid/impl/src/editor/DataGridColors.java:12-21`,
`grid/impl/src/run/ui/TableResultPanel.java:1064-1071`, `grid/impl/src/datagrid/CellColors.java:10-15`):

| element | rule | Islands Dark | Light |
|---|---|---|---|
| background | scheme default background | `#191A1C` | `#FFFFFF` |
| text | scheme default foreground | `#BCBEC4` | `#080808` |
| grid lines | `INDENT_GUIDE` | `#323438` | `#EBECF0` |
| selection | `SELECTION_BACKGROUND` | `#214283` | `#A6D2FF` |
| current row | `CARET_ROW_COLOR` | `#1F2024` | `#F5F8FE` |
| stripes (when enabled) | `GRID_STRIPE_COLOR`, else `CARET_ROW_COLOR` | `#1F2024` | `#F5F8FE` |
| hover row | `Table.hoverBackground` | `#FFFFFF10` | `#00000008` |
| row numbers / current | `LINE_NUMBERS_COLOR` / `LINE_NUMBER_ON_CARET_ROW_COLOR` | `#4B5059` / `#A1A3AB` | `#AEB3C2` / `#767A8A` |
| `<null>` | `GRID_NULL_VALUE` -> `DEFAULT_LINE_COMMENT` | `#7A7E85` | `#8C8C8C` italic |
| error value | `GRID_ERROR_VALUE` -> `ERRORS_ATTRIBUTES` | wave `#FA6675` | wave `#FF0000` |
| pending update / insert / delete | `DIFF_MODIFIED` / `DIFF_INSERTED` / `DIFF_DELETED` | `#385570` / `#294436` / `#484A4A` | `#C2D8F2` / `#BEE6BE` / `#D6D6D6` |
| image/result values | `FOLDED_TEXT_ATTRIBUTES` | fg `#868991` bg `#393B40` | fg `#414D41` bg `#E9F5E6` |
| row header bg | table bg (or hover/stripe) | `#191A1C` | `#FFFFFF` |
| sort icons | `Table.ascendingSortIcon` = `AllIcons.General.ArrowUp` (-> expui `general/up.svg`) | | |

## 6. SQL highlighting

No `SQL_*` keys exist in the community schemes. DataGrip's SQL keys and their fallbacks were read from
the installed `plugins/DatabaseTools/lib/modules/intellij.database.sql.jar!com/intellij/sql/editor/SqlColors.class`
(constant pool; mapping order inferred) plus `intellij.database.sql.core.impl.jar!colorSchemes/SqlDarcula.xml` and `SqlDefault.xml`:

| SQL key | falls back to | Islands Dark | Light |
|---|---|---|---|
| `SQL_KEYWORD` (and `SQL_TYPE`) | `DEFAULT_KEYWORD` | `#CF8E6D` | `#0033B3` |
| `SQL_STRING` | `DEFAULT_STRING` | `#6AAB73` | `#067D17` |
| `SQL_NUMBER` | `DEFAULT_NUMBER` | `#2AACB8` | `#1750EB` |
| `SQL_COMMENT` | `DEFAULT_LINE_COMMENT` | `#7A7E85` | `#8C8C8C` italic |
| `SQL_IDENT`, `SQL_IDENT_DELIMITED` | `TEXT` | `#BCBEC4` | `#080808` |
| `SQL_TABLE` | `DEFAULT_CLASS_NAME` -> identifier | `#BCBEC4` | `#000000` |
| `SQL_COLUMN` | `DEFAULT_INSTANCE_FIELD` | `#C77DBB` | `#871094` |
| `SQL_SCHEMA`, `SQL_DATABASE_OBJECT` | identifier (inferred) | `#BCBEC4` | `#000000` |
| `SQL_PROCEDURE` (function/procedure calls) | `DEFAULT_STATIC_METHOD` | `#57AAF7` italic | `#00627A` italic |
| `SQL_PARAMETER` | `DEFAULT_PARAMETER` -> identifier | `#BCBEC4` | `#000000` |
| `SQL_VARIABLE` | `DEFAULT_GLOBAL_VARIABLE` -> identifier | `#BCBEC4` | `#000000` |
| `SQL_LOCAL_ALIAS` | `DEFAULT_LOCAL_VARIABLE` -> identifier | `#BCBEC4` | `#000000` |
| `SQL_LABEL` | `DEFAULT_LABEL` | bold, underline `#808080` | underline `#808080` |
| `SQL_SYNTHETIC_ENTITY` | `DEFAULT_PREDEFINED_SYMBOL`; SqlDarcula sets fg | `#FFC66D` | italic only |
| `SQL_OUTER_QUERY_COLUMN` | SqlDarcula / SqlDefault | `#9876AA` + underline | `#660E7A` bold + underline |
| `SQL_SEMICOLON/COMMA/DOT/PARENS/BRACKETS/BRACES` | corresponding `DEFAULT_*` | `#BCBEC4` | `#080808` |
| `SQL_BAD_CHARACTER` | `BAD_CHARACTER` | fg `#F75464` wave | bg `#FFCCCC` |
| `SQL_EXTERNAL_TOOL` | `INJECTED_LANGUAGE_FRAGMENT` | bg `#293C40` | bg `#EDFCED` |
| statement-to-execute frame | `CONSOLE_RANGE_TO_EXECUTE` | border `#3D7A49` | not set in community (gap) |

Effect types (`EFFECT_TYPE`): 1 = underline, 2 = wave underline, 3 = strikeout, 5 = bold dotted line; `FONT_TYPE` 1 = bold, 2 = italic.

## 7. Editor colour scheme (Islands Dark / Light)

Generated from `islands/IslandSchemeDark.xml` -> Darcula -> Default and `expUI/expUI_lightScheme.xml` -> Default.
A child scheme replaces a whole attribute; "(not set -> fallback)" means the key inherits its
`TextAttributesKey` fallback (usually `DEFAULT_IDENTIFIER` or `TEXT`). Light hex values written without
leading zeros in the XML (e.g. `33b3`) are shown zero-padded.

| color key | Islands Dark | Light | dark source | light source |
|---|---|---|---|---|
| `CARET_COLOR` | `#CED0D6` | `#000000` | IslandSchemeDark.xml:10 | DefaultColorSchemesManager.xml:24 |
| `CARET_ROW_COLOR` | `#1F2024` | `#F5F8FE` | IslandSchemeDark.xml:11 | expUI_lightScheme.xml:15 |
| `SELECTION_BACKGROUND` | `#214283` | `#A6D2FF` | DefaultColorSchemesManager.xml:1611 | expUI_lightScheme.xml:35 |
| `SELECTION_BACKGROUND_INACTIVE` | `#4C4F56` | `#B5B7BD` | DefaultColorSchemesManager.xml:1612 | DefaultColorSchemesManager.xml:10 |
| `SELECTION_FOREGROUND` | `(empty)` | `(empty)` | DefaultColorSchemesManager.xml:1613 | expUI_lightScheme.xml:36 |
| `EDITOR_GUTTER_BACKGROUND` | `(empty)` | `-` | IslandSchemeDark.xml:18 | not set |
| `GUTTER_BACKGROUND` | `#313335` | `#FFFFFF` | DefaultColorSchemesManager.xml:1598 | expUI_lightScheme.xml:20 |
| `LINE_NUMBERS_COLOR` | `#4B5059` | `#AEB3C2` | IslandSchemeDark.xml:47 | expUI_lightScheme.xml:26 |
| `LINE_NUMBER_ON_CARET_ROW_COLOR` | `#A1A3AB` | `#767A8A` | IslandSchemeDark.xml:48 | expUI_lightScheme.xml:27 |
| `INDENT_GUIDE` | `#323438` | `#EBECF0` | IslandSchemeDark.xml:42 | expUI_lightScheme.xml:24 |
| `SELECTED_INDENT_GUIDE` | `#4E5157` | `#AEB3C2` | IslandSchemeDark.xml:58 | expUI_lightScheme.xml:34 |
| `VISUAL_INDENT_GUIDE` | `#2B2D30` | `#DAE6FD` | IslandSchemeDark.xml:66 | expUI_lightScheme.xml:43 |
| `RIGHT_MARGIN_COLOR` | `#323438` | `#EBECF0` | IslandSchemeDark.xml:57 | expUI_lightScheme.xml:33 |
| `WHITESPACES` | `#6F737A` | `#ADADAD` | IslandSchemeDark.xml:67 | DefaultColorSchemesManager.xml:14 |
| `METHOD_SEPARATORS_COLOR` | `#43454A` | `#DFE1E5` | IslandSchemeDark.xml:51 | expUI_lightScheme.xml:30 |
| `TEARLINE_COLOR` | `#555555` | `#D4D4D4` | DefaultColorSchemesManager.xml:1614 | expUI_lightScheme.xml:37 |
| `ADDED_LINES_COLOR` | `#549159` | `#7FC784` | IslandSchemeDark.xml:7 | expUI_lightScheme.xml:12 |
| `MODIFIED_LINES_COLOR` | `#375FAD` | `#88ADF7` | IslandSchemeDark.xml:52 | expUI_lightScheme.xml:31 |
| `DELETED_LINES_COLOR` | `#868A91` | `#767A8A` | IslandSchemeDark.xml:13 | expUI_lightScheme.xml:16 |
| `DOCUMENTATION_COLOR` | `#27282B` | `#FFFFFF` | IslandSchemeDark.xml:15 | expUI_lightScheme.xml:18 |
| `LOOKUP_COLOR` | `#27282B` | `#FFFFFF` | IslandSchemeDark.xml:49 | expUI_lightScheme.xml:28 |
| `ERROR_HINT` | `#402929` | `#FFE8E8` | IslandSchemeDark.xml:19 | expUI_lightScheme.xml:45 |
| `NOTIFICATION_BACKGROUND` | `#25324D` | `#FFF8E3` | IslandSchemeDark.xml:53 | expUI_lightScheme.xml:32 |
| `CONSOLE_BACKGROUND_KEY` | `#191A1C` | `#FFFFFF` | IslandSchemeDark.xml:12 | DefaultColorSchemesManager.xml:46 |
| `FILESTATUS_MODIFIED` | `#70AEFF` | `#0033B3` | IslandSchemeDark.xml:29 | expUI_lightScheme.xml:60 |

| attribute | Islands Dark | Light | dark source | light source |
|---|---|---|---|---|
| `TEXT` | fg=#BCBEC4 bg=#191A1C | fg=#080808 bg=#FFFFFF | IslandSchemeDark.xml:778 | expUI_lightScheme.xml:449 |
| `DEFAULT_KEYWORD` | fg=#CF8E6D | fg=#0033B3 font=None | IslandSchemeDark.xml:302 | expUI_lightScheme.xml:205 |
| `DEFAULT_STRING` | fg=#6AAB73 font=None | fg=#067D17 font=None | IslandSchemeDark.xml:363 | expUI_lightScheme.xml:246 |
| `DEFAULT_VALID_STRING_ESCAPE` | fg=#CF8E6D | fg=#0037A6 | IslandSchemeDark.xml:379 | expUI_lightScheme.xml:255 |
| `DEFAULT_INVALID_STRING_ESCAPE` | fg=#CF8E6D effect=#FA6675 effectType=2 | fg=#067D17 bg=#FFCCCC font=None | IslandSchemeDark.xml:295 | expUI_lightScheme.xml:198 |
| `DEFAULT_NUMBER` | fg=#2AACB8 | fg=#1750EB font=None | IslandSchemeDark.xml:317 | expUI_lightScheme.xml:228 |
| `DEFAULT_LINE_COMMENT` | fg=#7A7E85 | fg=#8C8C8C font=2 | IslandSchemeDark.xml:307 | expUI_lightScheme.xml:217 |
| `DEFAULT_BLOCK_COMMENT` | fg=#7A7E85 | fg=#8C8C8C font=2 | IslandSchemeDark.xml:208 | expUI_lightScheme.xml:129 |
| `DEFAULT_DOC_COMMENT` | fg=#5F826B font=2 | fg=#8C8C8C font=2 | IslandSchemeDark.xml:239 | expUI_lightScheme.xml:141 |
| `DEFAULT_IDENTIFIER` | fg=#BCBEC4 | fg=#000000 | IslandSchemeDark.xml:279 | DefaultColorSchemesManager.xml:174 |
| `DEFAULT_FUNCTION_CALL` | baseAttributes=DEFAULT_IDENTIFIER | (empty: inherits fallback) | IslandSchemeDark.xml:267 | expUI_lightScheme.xml:185 |
| `DEFAULT_FUNCTION_DECLARATION` | fg=#56A8F5 | fg=#00627A | IslandSchemeDark.xml:268 | expUI_lightScheme.xml:188 |
| `DEFAULT_STATIC_METHOD` | fg=#57AAF7 font=2 | fg=#00627A font=2 | IslandSchemeDark.xml:357 | expUI_lightScheme.xml:240 |
| `DEFAULT_INSTANCE_METHOD` | fg=#57AAF7 | (not set -> fallback) | IslandSchemeDark.xml:290 | not set |
| `DEFAULT_PARAMETER` | (not set -> fallback) | (not set -> fallback) | not set | not set |
| `DEFAULT_LOCAL_VARIABLE` | (not set -> fallback) | (not set -> fallback) | not set | not set |
| `DEFAULT_GLOBAL_VARIABLE` | (not set -> fallback) | (not set -> fallback) | not set | not set |
| `DEFAULT_CLASS_NAME` | (not set -> fallback) | (not set -> fallback) | not set | not set |
| `DEFAULT_INSTANCE_FIELD` | fg=#C77DBB font=None | fg=#871094 | IslandSchemeDark.xml:284 | expUI_lightScheme.xml:193 |
| `DEFAULT_STATIC_FIELD` | fg=#C77DBB font=2 | fg=#871094 font=2 | IslandSchemeDark.xml:351 | expUI_lightScheme.xml:234 |
| `DEFAULT_CONSTANT` | fg=#C77DBB font=2 | fg=#871094 font=2 | IslandSchemeDark.xml:233 | expUI_lightScheme.xml:135 |
| `DEFAULT_PREDEFINED_SYMBOL` | font=2 | font=2 | DefaultColorSchemesManager.xml:224 | DefaultColorSchemesManager.xml:224 |
| `DEFAULT_LABEL` | font=1 effectType=1 effect=#808080 | effect=#808080 effectType=1 | DefaultColorSchemesManager.xml:217 | expUI_lightScheme.xml:211 |
| `DEFAULT_METADATA` | fg=#B3AE60 | fg=#9E880D | IslandSchemeDark.xml:312 | expUI_lightScheme.xml:223 |
| `DEFAULT_OPERATION_SIGN` | fg=#BCBEC4 | (not set -> fallback) | IslandSchemeDark.xml:322 | not set |
| `DEFAULT_PARENTHS` | fg=#BCBEC4 | (not set -> fallback) | IslandSchemeDark.xml:327 | not set |
| `DEFAULT_BRACES` | fg=#BCBEC4 | (not set -> fallback) | IslandSchemeDark.xml:213 | not set |
| `DEFAULT_BRACKETS` | fg=#BCBEC4 | (not set -> fallback) | IslandSchemeDark.xml:218 | not set |
| `DEFAULT_COMMA` | fg=#BCBEC4 | (empty: inherits fallback) | IslandSchemeDark.xml:228 | DefaultColorSchemesManager.xml:191 |
| `DEFAULT_DOT` | fg=#BCBEC4 | (not set -> fallback) | IslandSchemeDark.xml:262 | not set |
| `DEFAULT_SEMICOLON` | fg=#BCBEC4 | (empty: inherits fallback) | IslandSchemeDark.xml:346 | DefaultColorSchemesManager.xml:234 |
| `BAD_CHARACTER` | fg=#F75464 effectType=2 | fg=None bg=#FFCCCC effect=None | IslandSchemeDark.xml:79 | DefaultColorSchemesManager.xml:850 |
| `ERRORS_ATTRIBUTES` | effect=#FA6675 stripe=#D64D5B effectType=2 | fg=None bg=None effect=#FF0000 effectType=2 font=None stripe=#CF5B56 | IslandSchemeDark.xml:409 | DefaultColorSchemesManager.xml:390 |
| `WRONG_REFERENCES_ATTRIBUTES` | fg=#F75464 effect=None effectType=None font=None | fg=#F50000 effect=None effectType=None font=None | IslandSchemeDark.xml:854 | expUI_lightScheme.xml:487 |
| `WARNING_ATTRIBUTES` | effect=#F2C55C stripe=#C29E4A effectType=2 bg=None | bg=#FCF4D4 stripe=#F2BF57 effectType=1 | IslandSchemeDark.xml:833 | expUI_lightScheme.xml:474 |
| `INFO_ATTRIBUTES` | effect=#857042 effectType=2 | fg=None bg=None effect=#CCCCCC effectType=2 stripe=#D9CFAD | IslandSchemeDark.xml:487 | DefaultColorSchemesManager.xml:479 |
| `TYPO` | effect=#7EC482 effectType=2 | effect=#B0D1AB effectType=2 | IslandSchemeDark.xml:815 | DefaultColorSchemesManager.xml:1055 |
| `RUNTIME_ERROR` | effect=#F2C55C stripe=#D64D5B effectType=5 | effect=#F49810 stripe=#CF5B56 effectType=5 | IslandSchemeDark.xml:747 | DefaultColorSchemesManager.xml:407 |
| `NOT_USED_ELEMENT_ATTRIBUTES` | fg=#6F737A | fg=#808080 bg=None effect=None stripe=#EBC700 | IslandSchemeDark.xml:706 | DefaultColorSchemesManager.xml:541 |
| `DEPRECATED_ATTRIBUTES` | effect=#BCBEC4 effectType=3 | fg=None bg=None effect=#404040 effectType=3 | IslandSchemeDark.xml:384 | DefaultColorSchemesManager.xml:961 |
| `MARKED_FOR_REMOVAL_ATTRIBUTES` | effect=#F75464 effectType=3 | effect=#FF0000 effectType=3 | IslandSchemeDark.xml:684 | DefaultColorSchemesManager.xml:969 |
| `TEXT_SEARCH_RESULT_ATTRIBUTES` | bg=#114957 effect=#165E70 stripe=#72D6D6 | fg=#000000 bg=#FCD47E stripe=#C47233 | IslandSchemeDark.xml:784 | expUI_lightScheme.xml:455 |
| `SEARCH_RESULT_ATTRIBUTES` | bg=#2D543F stripe=#42BD77 | fg=None bg=#CCCCFF effect=None stripe=#8E8EB2 | IslandSchemeDark.xml:754 | DefaultColorSchemesManager.xml:685 |
| `WRITE_SEARCH_RESULT_ATTRIBUTES` | bg=#66313F stripe=#FA7DB1 | fg=None bg=#FFCDFF effect=None stripe=#B28FB2 | IslandSchemeDark.xml:848 | DefaultColorSchemesManager.xml:721 |
| `IDENTIFIER_UNDER_CARET_ATTRIBUTES` | bg=#373B39 stripe=#5B786A effectType=1 | bg=#EDEBFC stripe=#D0A1FF | IslandSchemeDark.xml:467 | expUI_lightScheme.xml:379 |
| `WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES` | bg=#402F33 stripe=#BA6387 effectType=1 | bg=#FCE8F4 stripe=#F0A8D2 | IslandSchemeDark.xml:841 | expUI_lightScheme.xml:481 |
| `MATCHED_BRACE_ATTRIBUTES` | bg=#43454A font=1 | bg=#93D9D9 | IslandSchemeDark.xml:690 | expUI_lightScheme.xml:416 |
| `UNMATCHED_BRACE_ATTRIBUTES` | fg=#F75464 | fg=None bg=#FFDCDC effect=None | IslandSchemeDark.xml:821 | DefaultColorSchemesManager.xml:795 |
| `FOLDED_TEXT_ATTRIBUTES` | fg=#868991 bg=#393B40 | fg=#414D41 bg=#E9F5E6 effectType=1 | IslandSchemeDark.xml:421 | expUI_lightScheme.xml:266 |
| `HYPERLINK_ATTRIBUTES` | fg=#548AF7 effect=#548AF7 effectType=1 | fg=#006DCC effect=#006DCC effectType=1 | IslandSchemeDark.xml:460 | expUI_lightScheme.xml:372 |
| `INJECTED_LANGUAGE_FRAGMENT` | bg=#293C40 | bg=#EDFCED font=0 effect=None effectType=0 | IslandSchemeDark.xml:493 | DefaultColorSchemesManager.xml:759 |
| `INLAY_DEFAULT` | fg=#868A91 bg=#393B40 | fg=#7A7A7A bg=#EDEDED | IslandSchemeDark.xml:498 | DefaultColorSchemesManager.xml:575 |
| `INLINE_PARAMETER_HINT` | fg=#858A94 bg=#393B40 | fg=#7A7A7A bg=#EDEDED | IslandSchemeDark.xml:509 | DefaultColorSchemesManager.xml:557 |
| `TODO_DEFAULT_ATTRIBUTES` | fg=#8BB33D font=2 stripe=#73AD2B | fg=#008DDE font=2 stripe=#54AAE3 | IslandSchemeDark.xml:803 | expUI_lightScheme.xml:462 |
| `LIVE_TEMPLATE_ATTRIBUTES` | effect=#467FF2 | fg=None bg=None effect=#0055FF effectType=0 | IslandSchemeDark.xml:605 | DefaultColorSchemesManager.xml:704 |
| `CONSOLE_RANGE_TO_EXECUTE` | effect=#3D7A49 | (not set -> fallback) | IslandSchemeDark.xml:134 | not set |
| `CONSOLE_NORMAL_OUTPUT` | fg=#BCBEC4 | fg=#000000 | IslandSchemeDark.xml:129 | DefaultColorSchemesManager.xml:992 |
| `CONSOLE_ERROR_OUTPUT` | fg=#F75464 font=None | fg=#7F0000 font=None | IslandSchemeDark.xml:123 | DefaultColorSchemesManager.xml:997 |
| `CONSOLE_SYSTEM_OUTPUT` | fg=#BCBEC4 | fg=#00007F | IslandSchemeDark.xml:139 | DefaultColorSchemesManager.xml:1040 |
| `CONSOLE_USER_INPUT` | fg=#6AAB73 font=2 | fg=#007F00 font=2 | IslandSchemeDark.xml:144 | DefaultColorSchemesManager.xml:1034 |
| `LOG_INFO_OUTPUT` | fg=#E0BB65 | fg=#00CD00 | IslandSchemeDark.xml:626 | DefaultColorSchemesManager.xml:1013 |
| `LOG_WARNING_OUTPUT` | fg=None | fg=#A66F00 | IslandSchemeDark.xml:621 | DefaultColorSchemesManager.xml:1018 |
| `LOG_ERROR_OUTPUT` | fg=#F75464 font=None | fg=#CD0000 font=None | IslandSchemeDark.xml:615 | DefaultColorSchemesManager.xml:1023 |
| `DIFF_INSERTED` | bg=#294436 stripe=#447152 | fg=None bg=#BEE6BE effect=None stripe=#AADEAA | DefaultColorSchemesManager.xml:2267 | DefaultColorSchemesManager.xml:507 |
| `DIFF_MODIFIED` | bg=#385570 stripe=#43698D | bg=#C2D8F2 stripe=#B6D2F2 | DefaultColorSchemesManager.xml:2273 | expUI_lightScheme.xml:260 |
| `DIFF_DELETED` | bg=#484A4A stripe=#656E76 | fg=None bg=#D6D6D6 effect=None stripe=#C8C8C8 | DefaultColorSchemesManager.xml:2261 | DefaultColorSchemesManager.xml:498 |
| `DIFF_CONFLICT` | bg=#45302B stripe=#8F5247 | fg=None bg=#FFD5CC effect=None stripe=#FFC8BD | DefaultColorSchemesManager.xml:2255 | DefaultColorSchemesManager.xml:489 |
| `BREADCRUMBS_DEFAULT` | fg=#9DA0A8 | fg=#6C707E | IslandSchemeDark.xml:96 | expUI_lightScheme.xml:78 |
| `BREADCRUMBS_CURRENT` | fg=#DFE1E5 bg=#2B2D30 | fg=#000000 bg=#EBECF0 | IslandSchemeDark.xml:90 | expUI_lightScheme.xml:72 |
| `BREADCRUMBS_HOVERED` | fg=#DFE1E5 bg=#2B2D30 | fg=#000000 bg=#EBECF0 | IslandSchemeDark.xml:101 | expUI_lightScheme.xml:83 |

## 8. UI theme keys (resolved)

Every value below is the effective value after the parent chain and wildcard rules of section 1. "(wildcard *.x)" means the key is not set explicitly and takes the global `*` value. `(color)` rows are entries of the theme `colors` map (Islands semantic palette).

### Semantic palette (Islands named colors)

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `main-window-bg` (color) | `#26282C` | `#E9EAEE` | IslandsDark:218 | IslandsLight:218 |
| `tool-window-bg` (color) | `#191A1C` | `#FFFFFF` | IslandsDark:213 | IslandsLight:213 |
| `dialog-bg` (color) | `#191A1C` | `#F7F8F9` | IslandsDark:201 | IslandsLight:201 |
| `editor-bg` (color) | `#191A1C` | `#FFFFFF` | IslandsDark:208 | IslandsLight:208 |
| `popup-bg` (color) | `#26282C` | `#FFFFFF` | IslandsDark:204 | IslandsLight:204 |
| `layer-1-bg` (color) | `#26282C` | `#F7F8F9` | IslandsDark:168 | IslandsLight:168 |
| `layer-2-bg` (color) | `#33353B` | `#FFFFFF` | IslandsDark:172 | IslandsLight:172 |
| `text-default` (color) | `#D1D3D9` | `#000000` | IslandsDark:152 | IslandsLight:152 |
| `text-secondary` (color) | `#73767C` | `#73767C` | IslandsDark:154 | IslandsLight:154 |
| `text-muted` (color) | `#9FA2A8` | `#5F6269` | IslandsDark:153 | IslandsLight:153 |
| `text-disabled` (color) | `#4C4F56` | `#9FA2A8` | IslandsDark:155 | IslandsLight:155 |
| `text-link` (color) | `#71A1FE` | `#2F5EB9` | IslandsDark:158 | IslandsLight:158 |
| `text-error` (color) | `#F57E84` | `#C54E58` | IslandsDark:159 | IslandsLight:159 |
| `text-warning` (color) | `#D59637` | `#A56906` | IslandsDark:160 | IslandsLight:160 |
| `text-success` (color) | `#6DB083` | `#338555` | IslandsDark:161 | IslandsLight:161 |
| `control-bg` (color) | `#191A1C` | `#FFFFFF` | IslandsDark:222 | IslandsLight:222 |
| `control-bg-raised` (color) | `#26282C` | `#FFFFFF` | IslandsDark:224 | IslandsLight:224 |
| `control-border` (color) | `#40434A` | `#D1D3D9` | IslandsDark:225 | IslandsLight:225 |
| `control-brand-bg` (color) | `#3871E1` | `#3871E1` | IslandsDark:232 | IslandsLight:232 |
| `accent-brand-bg` (color) | `#3871E1` | `#3871E1` | IslandsDark:177 | IslandsLight:177 |
| `selection-bg-active` (color) | `#2A4371` | `#D0DFFE` | IslandsDark:269 | IslandsLight:269 |
| `selection-bg-inactive` (color) | `#33353B` | `#E9EAEE` | IslandsDark:271 | IslandsLight:271 |
| `selection-bg-active-muted` (color) | `#233558` | `#E3EBFE` | IslandsDark:270 | IslandsLight:270 |
| `selection-bg-hovered` (color) | `#FFFFFF10` | `#00000008` | IslandsDark:272 | IslandsLight:272 |
| `toolbar-bg-hovered` (color) | `#FFFFFF17` | `#00000012` | IslandsDark:243 | IslandsLight:243 |
| `toolbar-bg-pressed` (color) | `#FFFFFF29` | `#00000020` | IslandsDark:244 | IslandsLight:244 |
| `toolbar-border` (color) | `#FFFFFF21` | `#00000020` | IslandsDark:245 | IslandsLight:245 |
| `popup-border` (color) | `#33353B` | `#E9EAEE` | IslandsDark:206 | IslandsLight:206 |
| `tool-window-border` (color) | `#26282C` | `#E9EAEE` | IslandsDark:216 | IslandsLight:216 |
| `editor-border` (color) | `#26282C` | `#E9EAEE` | IslandsDark:210 | IslandsLight:210 |
| `icon-default-stroke` (color) | `#C3C5CB` | `#73767C` | IslandsDark:312 | IslandsLight:312 |
| `icon-disabled` (color) | `#5F6269` | `#C3C5CB` | IslandsDark:313 | IslandsLight:313 |
| `search-match-bg` (color) | `#BA9752` | `#FEE6B1` | IslandsDark:309 | IslandsLight:309 |
| `tree-indent-guide-border` (color) | `#33353B` | `#E9EAEE` | IslandsDark:310 | IslandsLight:310 |

### Global wildcards

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `*.background` | `#191A1C` | `#F7F8F9` | IslandsDark:380 | IslandsLight:381 |
| `*.foreground` | `#D1D3D9` | `#000000` | IslandsDark:379 | intellijlaf:70 |
| `*.borderColor` | `#26282C` | `#E9EAEE` | IslandsDark:381 | IslandsLight:382 |
| `*.selectionBackground` | `#2A4371` | `#D0DFFE` | IslandsDark:389 | IslandsLight:390 |
| `*.selectionInactiveBackground` | `#33353B` | `#E9EAEE` | IslandsDark:393 | IslandsLight:392 |
| `*.selectionForeground` | `#D1D3D9` | `#000000` | IslandsDark:391 | IslandsLight:393 |
| `*.lightSelectionBackground` | `#233558` | `#E3EBFE` | IslandsDark:390 | IslandsLight:391 |
| `*.hoverBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:397 | IslandsLight:396 |
| `*.infoForeground` | `#73767C` | `#73767C` | IslandsDark:399 | IslandsLight:398 |
| `*.disabledForeground` | `#4C4F56` | `#9FA2A8` | IslandsDark:384 | IslandsLight:385 |
| `*.focusColor` | `#3871E1` | `#3871E1` | IslandsDark:406 | IslandsLight:406 |
| `*.separatorColor` | `#33353B` | `#E9EAEE` | IslandsDark:408 | IslandsLight:408 |
| `*.underlineColor` | `#3871E1` | `#3871E1` | IslandsDark:403 | IslandsLight:403 |
| `*.inactiveUnderlineColor` | `#40434A` | `#DDDFE4` | IslandsDark:404 | IslandsLight:404 |

### Window, borders, separators

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `MainWindow.background` | `#26282C` | `#E9EAEE` | IslandsDark:442 | IslandsLight:442 |
| `Borders.color` | `#26282C` | `#E9EAEE` | IslandsDark:506 | IslandsLight:504 |
| `Borders.ContrastBorderColor` | `#26282C` | `#E9EAEE` | IslandsDark:507 | IslandsLight:505 |
| `OnePixelDivider.background` | `#26282C` | `#E9EAEE` | IslandsDark:873 | IslandsLight:1203 |
| `Separator.separatorColor` | `#33353B` | `#E9EAEE` | IslandsDark:1007 | IslandsLight:408 (via *.separatorColor) |
| `Island.arc` | `20` | `20` | IslandsDark:416 | IslandsLight:416 |
| `Island.borderWidth` | `6` | `6` | IslandsDark:420 | IslandsLight:420 |
| `Island.borderColor` | `#191A1C` | `#FFFFFF` | IslandsDark:422 | IslandsLight:422 |

### Main toolbar

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `MainToolbar.background` | `#26282C` | `#E9EAEE` | IslandsDark:1210 | IslandsLight:1179 |
| `MainToolbar.inactiveBackground` | `#26282C` | `#E9EAEE` | IslandsDark:1211 | IslandsLight:1180 |
| `MainToolbar.separatorColor` | `#FFFFFF21` | `#00000020` | IslandsDark:1213 | IslandsLight:1183 |
| `MainToolbar.Icon.hoverBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:397 (via *.hoverBackground) | IslandsLight:1186 |
| `MainToolbar.Icon.pressedBackground` | `#FFFFFF29` | `#00000020` | IslandsDark:1216 | IslandsLight:1187 |
| `MainToolbar.Icon.insets` | `6,5,4,5` | `6,5,4,5` | IslandsDark:1217 | IslandsLight:1188 |
| `MainToolbar.Dropdown.maxWidth` | `350` | `350` | IslandsDark:1221 | IslandsLight:1196 |
| `toolbar-run-bg` (color) | `#338555` | `#4E9D6C` | IslandsDark:249 | IslandsLight:249 |
| `toolbar-stop-bg` (color) | `#C54E58` | `#E4656E` | IslandsDark:251 | IslandsLight:251 |
| `toolbar-selected-bg` (color) | `#2E4D89` | `#D0DFFE` | IslandsDark:246 | IslandsLight:246 |

### Tool window & stripe

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `ToolWindow.background` | `#191A1C` | `#FFFFFF` | IslandsDark:1159 | IslandsLight:1127 |
| `ToolWindow.Header.background` | `#191A1C` | `#F7F8F9` | IslandsDark:380 (via *.background) | IslandsLight:381 (via *.background) |
| `ToolWindow.Header.inactiveBackground` | `#191A1C` | `#FFFFFF` | IslandsDark:1163 | IslandsLight:1131 |
| `ToolWindow.Header.borderColor` | `#26282C` | `#E9EAEE` | IslandsDark:1162 | IslandsLight:1130 |
| `ToolWindow.Stripe.background` | `#26282C` | `#E9EAEE` | IslandsDark:1180 | IslandsLight:1149 |
| `ToolWindow.Stripe.separatorColor` | `#FFFFFF21` | `#00000020` | IslandsDark:1182 | IslandsLight:1151 |
| `ToolWindow.Button.foreground` | `#9FA2A8` | `#5F6269` | IslandsDark:1170 | IslandsLight:1139 |
| `ToolWindow.Button.selectedBackground` | `#3871E1` | `#3871E1` | IslandsDark:1172 | IslandsLight:1141 |
| `ToolWindow.Button.selectedForeground` | `#FFFFFF` | `#FFFFFF` | IslandsDark:1171 | IslandsLight:1140 |
| `StripeToolbar.Button.size` | `37,40` | `37,40` | IslandsDark:1194 | IslandsLight:1163 |
| `ToolWindow.HeaderTab.hoverInactiveBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:1167 | IslandsLight:1136 |

### Editor tabs

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `EditorTabs.background` | `#191A1C` | `#FFFFFF` | IslandsDark:698 | IslandsLight:673 |
| `EditorTabs.underTabsBorderColor` | `#26282C` | `#E9EAEE` | IslandsDark:702 | IslandsLight:677 |
| `EditorTabs.hoverBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:699 | IslandsLight:674 |
| `EditorTabs.underlinedTabBackground` | `#233558` | `#E3EBFE` | IslandsDark:704 | IslandsLight:679 |
| `EditorTabs.underlinedBorderColor` | `#2E4D89` | `#A7C5FF` | IslandsDark:703 | IslandsLight:678 |
| `EditorTabs.inactiveUnderlinedTabBackground` | `#26282C` | `#E9EAEE` | IslandsDark:706 | IslandsLight:681 |
| `EditorTabs.inactiveUnderlinedTabBorderColor` | `#40434A` | `#D1D3D9` | IslandsDark:705 | IslandsLight:680 |
| `EditorTabs.underlineColor` | `#3871E1` | `#3871E1` | IslandsDark:403 (wildcard *.underlineColor) | IslandsLight:403 (via *.underlineColor) |
| `EditorTabs.underlineHeight` | `4` | `4` | IslandsDark:695 | IslandsLight:670 |
| `EditorTabs.underlineArc` | `4` | `4` | IslandsDark:694 | IslandsLight:669 |
| `EditorTabs.unselectedAlpha` | `0.75` | `0.75` | IslandsDark:696 | IslandsLight:671 |
| `EditorTabs.tabInsets` | `-6,8,-6,8` | `-6,8,-6,8` | IslandsDark:708 | IslandsLight:683 |
| `EditorTabs.tabContentActionsRightInsets` | `0,4,0,2` | `0,4,0,2` | IslandsDark:712 | IslandsLight:687 |

### Tree & list

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `Tree.background` | `#191A1C` | `#F7F8F9` | IslandsDark:380 (via *.background) | IslandsLight:381 (via *.background) |
| `Tree.foreground` | `#D1D3D9` | `#000000` | IslandsDark:379 (via *.foreground) | intellijlaf:1022 |
| `Tree.selectionBackground` | `#2A4371` | `#D0DFFE` | IslandsDark:389 (wildcard *.selectionBackground) | IslandsLight:390 (wildcard *.selectionBackground) |
| `Tree.selectionInactiveBackground` | `#33353B` | `#E9EAEE` | IslandsDark:393 (wildcard *.selectionInactiveBackground) | IslandsLight:392 (wildcard *.selectionInactiveBackground) |
| `Tree.selectionForeground` | `#D1D3D9` | `#000000` | IslandsDark:391 (wildcard *.selectionForeground) | IslandsLight:393 (wildcard *.selectionForeground) |
| `Tree.hoverBackground` | `#FFFFFF10` | `#00000008` | IslandsDark:1240 | IslandsLight:1227 |
| `Tree.hash` | `#33353B` | `#E9EAEE` | IslandsDark:1239 | IslandsLight:1223 |
| `Tree.rowHeight` | `24` | `24` | IslandsDark:1235 | IslandsLight:1221 |
| `Tree.border` | `4,12,4,12` | `4,12,4,12` | IslandsDark:1237 | IslandsLight:1224 |
| `Tree.leftChildIndent` | `7` | `7` | darcula:740 | intellijlaf:1015 |
| `Tree.rightChildIndent` | `11` | `11` | darcula:743 | intellijlaf:1017 |
| `Tree.expandedIcon` | `/expui/general/chevronDown.svg` | `/expui/general/chevronDown.svg` | IslandsDark:1232 | IslandsLight:1218 |
| `Tree.collapsedIcon` | `/expui/general/chevronRight.svg` | `/expui/general/chevronRight.svg` | IslandsDark:1230 | IslandsLight:1216 |
| `List.rowHeight` | `24` | `24` | IslandsDark:755 | IslandsLight:741 |
| `List.border` | `4,0,4,0` | `4,0,4,0` | IslandsDark:757 | IslandsLight:743 |
| `List.hoverBackground` | `#FFFFFF10` | `#00000008` | IslandsDark:753 | IslandsLight:739 |
| `List.selectionBackground` | `#2A4371` | `#D0DFFE` | IslandsDark:389 (wildcard *.selectionBackground) | IslandsLight:390 (wildcard *.selectionBackground) |
| `SpeedSearch.background` | `#191A1C` | `#FFFFFF` | IslandsDark:1037 | IslandsLight:1008 |
| `SpeedSearch.borderColor` | `#40434A` | `#D1D3D9` | IslandsDark:1038 | IslandsLight:1009 |
| `SpeedSearch.errorForeground` | `#F57E84` | `#C54E58` | IslandsDark:1039 | IslandsLight:1010 |

### Popup, menu, completion

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `Popup.background` | `#26282C` | `#FFFFFF` | IslandsDark:907 | IslandsLight:915 |
| `Popup.borderColor` | `#33353B` | `#D1D3D9` | IslandsDark:909 | IslandsLight:916 |
| `Popup.inactiveBorderColor` | `#33353B` | `#ABABAB` | IslandsDark:910 | intellijlaf:645 |
| `Popup.Header.activeBackground` | `#26282C` | `#FFFFFF` | IslandsDark:919 | IslandsLight:925 |
| `Popup.Header.inactiveForeground` | `#73767C` | `#73767C` | IslandsDark:921 | IslandsLight:927 |
| `Popup.Advertiser.background` | `#26282C` | `#F7F8F9` | IslandsDark:913 | IslandsLight:919 |
| `Popup.Advertiser.foreground` | `#73767C` | `#73767C` | IslandsDark:912 | IslandsLight:918 |
| `Popup.Advertiser.borderInsets` | `8,12,8,12` | `8,12,8,12` | IslandsDark:916 | IslandsLight:922 |
| `PopupMenu.background` | `#26282C` | `#FFFFFF` | IslandsDark:926 | IslandsLight:765 |
| `PopupMenu.borderCornerRadius` | `8` | `8` | darcula:495 | intellijlaf:653 |
| `PopupMenu.borderInsets` | `6,1,6,1` | `6,1,6,1` | darcula:494 | intellijlaf:652 |
| `Menu.borderColor` | `#33353B` | `#E9EAEE` | IslandsDark:784 | IslandsLight:759 |
| `MenuItem.acceleratorForeground` | `#73767C` | `#73767C` | IslandsDark:400 (via *.acceleratorForeground) | IslandsLight:399 (via *.acceleratorForeground) |
| `CompletionPopup.matchForeground` | `#538AF9` | `#2F5EB9` | IslandsDark:951 | IslandsLight:941 |
| `CompletionPopup.selectionBackground` | `#2A4371` | `#D0DFFE` | IslandsDark:389 (via *.selectionBackground) | IslandsLight:390 (via *.selectionBackground) |
| `Ide.Shadow.borderInsets` | `16,16,16,16` | `16,16,16,16` | IslandsDark:799 | IslandsLight:807 |
| `Ide.Shadow.top1Color` | `#00000020` | `#00000010` | IslandsDark:801 | IslandsLight:809 |

### Buttons

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `Button.arc` | `8` | `8` | IslandsDark:512 | IslandsLight:510 |
| `Button.minimumSize` | `72,28` | `72,28` | IslandsDark:521 | IslandsLight:515 |
| `Button.startBackground` | `#191A1C00` | `#FFFFFF` | IslandsDark:514 | intellijlaf:159 |
| `Button.startBorderColor` | `#40434A` | `#D1D3D9` | IslandsDark:516 | IslandsLight:512 |
| `Button.focusedBorderColor` | `#191A1C` | `#F7F8F9` | IslandsDark:518 | IslandsLight:514 |
| `Button.default.startBackground` | `#3871E1` | `#3871E1` | IslandsDark:526 | IslandsLight:521 |
| `Button.default.startBorderColor` | `#3871E1` | `#3871E1` | IslandsDark:528 | IslandsLight:523 |
| `Button.default.foreground` | `#FFFFFF` | `#FFFFFF` | IslandsDark:524 | IslandsLight:519 |
| `Button.default.focusedBorderColor` | `#191A1C` | `#F7F8F9` | IslandsDark:530 | IslandsLight:525 |
| `Button.disabledText` | `#4C4F56` | `#9FA2A8` | IslandsDark:383 (via *.disabledText) | IslandsLight:384 (via *.disabledText) |
| `Button.disabledBorderColor` | `#33353B` | `#DDDFE4` | IslandsDark:387 (via *.disabledBorderColor) | IslandsLight:388 (via *.disabledBorderColor) |
| `ActionButton.hoverBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:445 | IslandsLight:445 |
| `ActionButton.pressedBackground` | `#FFFFFF29` | `#00000020` | IslandsDark:447 | IslandsLight:447 |
| `ActionButton.focusedBorderColor` | `#3871E1` | `#3871E1` | IslandsDark:449 | IslandsLight:449 |

### Text field, combo box, checkbox

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `Component.arc` | `8` | `8` | IslandsDark:676 | IslandsLight:595 |
| `Component.focusWidth` | `2` | `2` | darcula:212 | intellijlaf:254 |
| `Component.focusColor` | `#3871E1` | `#3871E1` | IslandsDark:406 (via *.focusColor) | IslandsLight:406 (via *.focusColor) |
| `Component.borderColor` | `#40434A` | `#D1D3D9` | IslandsDark:679 | IslandsLight:598 |
| `Component.focusedBorderColor` | `#191A1C` | `#F7F8F9` | IslandsDark:680 | IslandsLight:599 |
| `Component.errorFocusColor` | `#C54E58` | `#E4656E` | IslandsDark:681 | IslandsLight:600 |
| `Component.inactiveErrorFocusColor` | `#6D3136` | `#FFC4C5` | IslandsDark:682 | IslandsLight:601 |
| `Component.warningFocusColor` | `#A56906` | `#C28013` | IslandsDark:683 | IslandsLight:602 |
| `Component.arrowAreaWidth` | `28` | `28` | IslandsDark:678 | IslandsLight:597 |
| `TextField.background` | `#191A1C` | `#FFFFFF` | IslandsDark:1093 | IslandsLight:1062 |
| `TextField.minimumSize` | `49,28` | `49,28` | IslandsDark:1095 | IslandsLight:1064 |
| `TextField.disabledBackground` | `#191A1C` | `#F7F8F9` | IslandsDark:386 (via *.disabledBackground) | IslandsLight:387 (via *.disabledBackground) |
| `ComboBox.nonEditableBackground` | `#26282C` | `#FFFFFF` | IslandsDark:566 | intellijlaf:224 |
| `ComboBox.background` | `#26282C` | `#FFFFFF` | IslandsDark:565 | IslandsLight:549 |
| `ComboBox.ArrowButton.background` | `#191A1C` | `#FFFFFF` | IslandsDark:556 | IslandsLight:557 |
| `ComboBox.ArrowButton.iconColor` | `#9A9DA1` | `#6E6E6E` | darcula:140 | intellijlaf:218 |
| `ComboBox.padding` | `1,9,1,6` | `1,9,1,6` | IslandsDark:563 | IslandsLight:554 |
| `ComboBox.minimumSize` | `49,28` | `49,28` | IslandsDark:561 | IslandsLight:552 |
| `CheckBox.iconSize` | `24` | `24` | IslandsDark:543 | IslandsLight:537 |
| `CheckBox.textIconGap` | `4` | `4` | IslandsDark:544 | IslandsLight:538 |
| `CheckBox.borderInsets` | `4,4,4,4` | `4,4,4,4` | IslandsDark:542 | IslandsLight:536 |
| `toggle-on-bg` (color) | `#3871E1` | `#3871E1` | IslandsDark:292 | IslandsLight:292 |
| `toggle-off-bg` (color) | `#FFFFFF3B` | `#00000030` | IslandsDark:293 | IslandsLight:293 |

### Scrollbars

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `ScrollBar.thumbColor` | `#80808059` | `#73737333` | IslandsDark:981 | intellijlaf:721 |
| `ScrollBar.thumbBorderColor` | `#26262659` | `#59595933` | IslandsDark:980 | intellijlaf:720 |
| `ScrollBar.hoverThumbColor` | `#8080808C` | `#73737347` | IslandsDark:978 | intellijlaf:718 |
| `ScrollBar.hoverThumbBorderColor` | `#2626268C` | `#59595947` | IslandsDark:977 | intellijlaf:717 |
| `ScrollBar.trackColor` | `#80808000` | `#80808000` | IslandsDark:982 | intellijlaf:722 |
| `ScrollBar.hoverTrackColor` | `#80808000` | `#80808000` | IslandsDark:979 | intellijlaf:719 |
| `ScrollBar.Transparent.thumbColor` | `#80808059` | `#73737333` | IslandsDark:988 | intellijlaf:749 |
| `ScrollBar.Transparent.hoverThumbColor` | `#8080808C` | `#73737347` | IslandsDark:985 | intellijlaf:746 |
| `ScrollBar.Transparent.hoverTrackColor` | `#8080801A` | `#8080801A` | IslandsDark:986 | intellijlaf:747 |

### Tooltips

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `ToolTip.background` | `#33353B` | `#FFFFFF` | IslandsDark:1103 | IslandsLight:1072 |
| `ToolTip.foreground` | `#D1D3D9` | `#000000` | IslandsDark:1107 | IslandsLight:1075 |
| `ToolTip.borderColor` | `#33353B` | `#D1D3D9` | IslandsDark:1104 | IslandsLight:1079 |
| `ToolTip.infoForeground` | `#9FA2A8` | `#5F6269` | IslandsDark:1108 | IslandsLight:1076 |
| `ToolTip.shortcutForeground` | `#9FA2A8` | `#73767C` | IslandsDark:1109 | IslandsLight:1077 |
| `ToolTip.borderCornerRadius` | `6` | `6` | IslandsDark:1105 | IslandsLight:1073 |
| `ToolTip.multilineBorderCornerRadius` | `8` | `8` | IslandsDark:1106 | IslandsLight:1074 |
| `Editor.ToolTip.background` | `#26282C` | `#FFFFFF` | IslandsDark:724 | IslandsLight:700 |
| `Editor.ToolTip.border` | `#33353B` | `#D1D3D9` | IslandsDark:725 | IslandsLight:701 |
| `Editor.ToolTip.errorBackground` | `#56272B` | `#FFF6F5` | IslandsDark:726 | IslandsLight:702 |
| `Editor.ToolTip.errorBorder` | `#80383E` | `#FFC4C5` | IslandsDark:727 | IslandsLight:703 |
| `Editor.ToolTip.warningBackground` | `#44321D` | `#FFF6E9` | IslandsDark:730 | IslandsLight:706 |
| `Editor.ToolTip.warningBorder` | `#694820` | `#F4CD9A` | IslandsDark:731 | IslandsLight:707 |

### Notifications, banners, validation

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `Notification.background` | `#33353B` | `#FFFFFF` | IslandsDark:838 | IslandsLight:846 |
| `Notification.borderColor` | `#33353B` | `#D1D3D9` | IslandsDark:839 | IslandsLight:847 |
| `Notification.foreground` | `#D1D3D9` | `#000000` | IslandsDark:840 | IslandsLight:848 |
| `Notification.linkForeground` | `#71A1FE` | `#2F5EB9` | IslandsDark:841 | IslandsLight:849 |
| `Notification.Button.background` | `#33353B` | `#FFFFFF` | IslandsDark:844 | IslandsLight:852 |
| `Notification.Button.borderColor` | `#FFFFFF3B` | `#00000030` | IslandsDark:845 | IslandsLight:853 |
| `Notification.ToolWindow.errorBackground` | `#56272B` | `#FFF6F5` | IslandsDark:857 | IslandsLight:865 |
| `Notification.ToolWindow.errorBorderColor` | `#80383E` | `#FFC4C5` | IslandsDark:858 | IslandsLight:866 |
| `Notification.ToolWindow.warningBackground` | `#44321D` | `#FFF6E9` | IslandsDark:859 | IslandsLight:867 |
| `Notification.ToolWindow.warningBorderColor` | `#694820` | `#F4CD9A` | IslandsDark:860 | IslandsLight:868 |
| `Notification.Shadow.top1Color` | `#00000010` | `#80808010` | IslandsDark:820 | IslandsLight:828 |
| `Banner.infoBackground` | `#233558` | `#F7F8FF` | IslandsDark:481 | IslandsLight:479 |
| `Banner.infoBorderColor` | `#2E4D89` | `#BDD3FF` | IslandsDark:482 | IslandsLight:480 |
| `Banner.errorBackground` | `#56272B` | `#FFF6F5` | IslandsDark:475 | IslandsLight:473 |
| `Banner.warningBackground` | `#44321D` | `#FFF6E9` | IslandsDark:477 | IslandsLight:475 |
| `Banner.successBackground` | `#203B2A` | `#F5FAF3` | IslandsDark:479 | IslandsLight:477 |
| `Banner.arc` | `12` | `12` | IslandsDark:489 | IslandsLight:487 |
| `ValidationTooltip.errorBackground` | `#56272B` | `#FFF6F5` | IslandsDark:1150 | IslandsLight:1118 |
| `ValidationTooltip.errorBorderColor` | `#80383E` | `#FFC4C5` | IslandsDark:1151 | IslandsLight:1119 |
| `ValidationTooltip.warningBackground` | `#44321D` | `#FFF6E9` | IslandsDark:1153 | IslandsLight:1121 |
| `ValidationTooltip.warningBorderColor` | `#694820` | `#F4CD9A` | IslandsDark:1154 | IslandsLight:1122 |
| `ValidationTooltip.maxWidth` | `384` | `384` | darcula:753 | intellijlaf:1036 |

### Status bar

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `StatusBar.background` | `#26282C` | `#E9EAEE` | IslandsDark:1048 | IslandsLight:1019 |
| `StatusBar.borderColor` | `#191A1C00` | `#FFFFFF00` | IslandsDark:1049 | IslandsLight:1020 |
| `StatusBar.topBorderWidth` | `0` | `0` | IslandsDark:1050 | IslandsLight:1021 |
| `StatusBar.Widget.foreground` | `#9FA2A8` | `#5F6269` | IslandsDark:1052 | IslandsLight:1023 |
| `StatusBar.Widget.hoverForeground` | `#D1D3D9` | `#000000` | IslandsDark:1053 | IslandsLight:1024 |
| `StatusBar.Widget.hoverBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:1054 | IslandsLight:1025 |
| `StatusBar.Widget.pressedBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:1055 | IslandsLight:1026 |
| `StatusBar.Breadcrumbs.foreground` | `#9FA2A8` | `#5F6269` | IslandsDark:1058 | IslandsLight:1029 |
| `StatusBar.Breadcrumbs.hoverBackground` | `#FFFFFF17` | `#00000012` | IslandsDark:1060 | IslandsLight:1031 |

### Links, labels, misc

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `Link.activeForeground` | `#71A1FE` | `#2F5EB9` | IslandsDark:744 | IslandsLight:730 |
| `Link.hoverForeground` | `#71A1FE` | `#2F5EB9` | IslandsDark:745 | IslandsLight:731 |
| `Link.visitedForeground` | `#71A1FE` | `#2F5EB9` | IslandsDark:747 | IslandsLight:733 |
| `Link.focusedBorderColor` | `#3871E1` | `#3871E1` | IslandsDark:749 | IslandsLight:735 |
| `Label.errorForeground` | `#F57E84` | `#C54E58` | IslandsDark:738 | IslandsLight:724 |
| `Label.warningForeground` | `#D59637` | `#A56906` | IslandsDark:739 | IslandsLight:725 |
| `Label.successForeground` | `#6DB083` | `#338555` | IslandsDark:740 | IslandsLight:726 |
| `Counter.background` | `#73767C` | `#8B8E94` | IslandsDark:600 | IslandsLight:607 |
| `Counter.foreground` | `#000000` | `#FFFFFF` | IslandsDark:601 | IslandsLight:608 |
| `ProgressBar.progressColor` | `#3871E1` | `#3871E1` | IslandsDark:960 | IslandsLight:950 |
| `ProgressBar.trackColor` | `#40434A` | `#DDDFE4` | IslandsDark:967 | IslandsLight:957 |
| `Toolbar.Floating.background` | `#33353B` | `#E9EAEE` | IslandsDark:1100 | IslandsLight:1069 |

### Swing tables

| key | Islands Dark | Islands Light | dark source | light source |
|---|---|---|---|---|
| `Table.background` | `#191A1C` | `#F7F8F9` | IslandsDark:380 (via *.background) | IslandsLight:381 (via *.background) |
| `Table.gridColor` | `#26282C` | `#E9EAEE` | IslandsDark:1078 | IslandsLight:1050 |
| `Table.stripeColor` | `#212326` | `#FFFFFF` | IslandsDark:1079 | IslandsLight:1051 |
| `Table.alternativeRowBackground` | `#212326` | `#FFFFFF` | IslandsDark:1082 | intellijlaf:872 |
| `Table.hoverBackground` | `#FFFFFF10` | `#00000008` | IslandsDark:1080 | IslandsLight:1052 |
| `Table.selectionBackground` | `#2A4371` | `#D0DFFE` | IslandsDark:389 (wildcard *.selectionBackground) | IslandsLight:390 (wildcard *.selectionBackground) |
| `Table.rowHeight` | `20` | `20` | darcula:662 | intellijlaf:887 |
| `Table.cellNoFocusBorder` | `2,3,2,3` | `2,3,2,3` | darcula:657 | intellijlaf:875 |
| `TableHeader.background` | `#191A1C` | `#F7F8F9` | IslandsDark:380 (via *.background) | IslandsLight:381 (via *.background) |
| `TableHeader.height` | `25` | `28` | darcula:670 | intellijlaf:899 |
| `TableHeader.separatorColor` | `#26282C` | `#E9EAEE` | IslandsDark:1087 | IslandsLight:408 (via *.separatorColor) |
| `TableHeader.bottomSeparatorColor` | `#26282C` | `#E9EAEE` | IslandsDark:1086 | IslandsLight:1055 |
| `Table.ascendingSortIcon` | `AllIcons.General.ArrowUp` | `AllIcons.General.ArrowUp` | darcula:656 | intellijlaf:873 |

## 9. Gaps and caveats

- Values are read from source, not measured from screenshots: derived numbers (editor line height 21, grid row height 22, status bar 28, label line 16) depend on font metrics and should be checked against a DataGrip screenshot at 100% scale.
- `ToolWindow.Header.height` is not set by any theme, so the JBUI default 41 is used.
- Light-theme checkbox colours come from the `Checkbox.*` ColorPalette ids in `IslandsLight:1747-1757`; dark uses the colours baked into `expUI/icons/dark/checkBox*.svg`.
- `CONSOLE_RANGE_TO_EXECUTE` (DataGrip statement highlight frame) has no Light/Default value in community; DataGrip may define it in closed code.
- `SqlColors` fallback pairs were inferred from the class constant pool order; `SQL_SCHEMA` and `SQL_DATABASE_OBJECT` have no obvious fallback and are treated as identifier colour.
- There is no dedicated "View" icon in DataGrip `DatabaseIcons`; `AllIcons.Nodes.DataTables` (`data-tables.svg`) is the closest platform icon. No transaction-mode icon exists (DataGrip shows a "Tx: Auto/Manual" text combo).
- Compact mode (`*.compact` keys) and the `alt.*` (alternative main-window colour) variants are not tokenised.
