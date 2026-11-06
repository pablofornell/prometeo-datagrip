/** Page tree of the Settings dialog and the search filter (pure logic, no UI). */
export interface PageNode {
  id: string;
  title: string;
  children?: PageNode[];
  /** Labels of the page's controls: the tree search finds the page by them (DataGrip searches the option texts). */
  keywords?: string[];
  /** Text of the link-list page shown for a group (DataGrip shows one for `Editor`). */
  description?: string;
}

/** Operative pages only (no Plugins, account, updates, AI, sync). Order and names follow DataGrip 2026.3. */
export const PAGES: PageNode[] = [
  {
    id: "database",
    title: "Database",
    children: [
      {
        id: "database.query-execution",
        title: "Query Execution",
        keywords: ["Transactions", "Default transaction mode", "Auto", "Manual", "commit", "new query consoles"],
      },
      {
        id: "database.data-editor",
        title: "Data Editor and Viewer",
        keywords: ["Limitations", "Limit page size to", "page size", "rows per page", "Data Presentation", "NULL text", "Display NULL as", "grid"],
      },
    ],
  },
  {
    id: "appearance-behavior",
    title: "Appearance & Behavior",
    children: [
      {
        id: "appearance",
        title: "Appearance",
        keywords: ["Theme", "Islands Dark", "Islands Light", "Sync with OS", "dark", "light", "color scheme"],
      },
    ],
  },
  { id: "keymap", title: "Keymap", keywords: ["Shortcuts", "Actions", "XWin", "key bindings"] },
  {
    id: "editor",
    title: "Editor",
    description:
      "Personalize source code appearance by changing fonts, highlighting styles, indents, etc. Customize the Editor from line numbers, caret placement and tabs to source code inspections, setting up templates and file encodings.",
    children: [
      {
        id: "editor.general",
        title: "General",
        children: [
          {
            id: "editor.general.appearance",
            title: "Appearance",
            keywords: ["Code Structure", "Show line numbers", "line numbers", "gutter"],
          },
        ],
      },
      {
        id: "editor.font",
        title: "Font",
        keywords: ["Font", "Size", "Line height", "font size", "JetBrains Mono", "Preview"],
      },
    ],
  },
];

export function findNode(id: string, nodes: PageNode[] = PAGES): PageNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = n.children && findNode(id, n.children);
    if (c) return c;
  }
  return undefined;
}

/** Titles from the root to the page: the breadcrumb. */
export function pathOf(id: string, nodes: PageNode[] = PAGES, acc: PageNode[] = []): PageNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [...acc, n];
    const c = n.children && pathOf(id, n.children, [...acc, n]);
    if (c) return c;
  }
  return null;
}

const lower = (s: string) => s.toLowerCase();
const has = (text: string, q: string) => lower(text).includes(lower(q));

/** Does the node itself (title or option texts) match the query? */
export function nodeMatches(n: PageNode, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (has(n.title, q)) return true;
  return !!n.keywords?.some((k) => has(k, q));
}

/**
 * The tree reduced to the pages that match: a node stays when it or a descendant matches; when a group's own title
 * matches, all its children stay.
 */
export function filterTree(query: string, nodes: PageNode[] = PAGES): PageNode[] {
  const q = query.trim();
  if (!q) return nodes;
  const out: PageNode[] = [];
  for (const n of nodes) {
    if (n.children?.length) {
      if (has(n.title, q)) out.push(n);
      else {
        const kids = filterTree(q, n.children);
        if (kids.length) out.push({ ...n, children: kids });
        else if (nodeMatches(n, q)) out.push({ ...n, children: [] });
      }
    } else if (nodeMatches(n, q)) out.push(n);
  }
  return out;
}

/** First page (depth first) of the tree that is a leaf, used to select a page after a search. */
export function firstLeaf(nodes: PageNode[]): PageNode | undefined {
  for (const n of nodes) {
    if (n.children?.length) {
      const c = firstLeaf(n.children);
      if (c) return c;
    } else return n;
  }
  return undefined;
}

export interface TreeRow {
  node: PageNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Visible rows of the tree for the given expanded set (everything expanded while searching). */
export function visibleRows(nodes: PageNode[], expanded: (id: string) => boolean, depth = 0, out: TreeRow[] = []): TreeRow[] {
  for (const n of nodes) {
    const has = !!n.children?.length;
    const open = has && expanded(n.id);
    out.push({ node: n, depth, hasChildren: has, expanded: open });
    if (open) visibleRows(n.children!, expanded, depth + 1, out);
  }
  return out;
}
