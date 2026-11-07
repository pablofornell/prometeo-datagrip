/**
 * The `Query Plan` tab (Explain Plan / Explain Analyse): a tree-table (Operation | Params | Rows | Total Cost |
 * Startup Cost | Raw Desc), the `Property | Value` pane of the selected node on the right and a vertical toolbar.
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { PlanNode } from "../../api/types";
import { ActionButton, Icon, notify } from "../../components/ui";
import { copyText } from "./export";
import type { PlanTab } from "./model";

interface Row {
  path: string;
  node: PlanNode;
  depth: number;
}

const num = (n: number | null): string => (n == null ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** Operations that read a table: shown with the table icon. */
const isScan = (n: PlanNode): boolean => /^(Full Scan|Index (Scan|Search|Lookup|Range)|Unique Index|Constant Lookup|Table scan|Index scan|Single-row)/i.test(n.operation) || /\(\w*Scan\)/.test(n.operation);

/** The plan as indented text (what the Copy button puts on the clipboard). */
export function planText(root: PlanNode): string {
  const lines: string[] = [];
  const walk = (n: PlanNode, depth: number) => {
    const bits = [n.operation, n.params, n.rows != null ? `rows=${num(n.rows)}` : "", n.totalCost != null ? `cost=${num(n.totalCost)}` : ""].filter(Boolean);
    lines.push("  ".repeat(depth) + bits.join("  "));
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return lines.join("\n") + "\n";
}

export function PlanView(props: { tab: PlanTab }): JSX.Element {
  const root = () => props.tab.plan.root;
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  let tree!: HTMLDivElement;

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (node: PlanNode, path: string, depth: number) => {
      out.push({ path, node, depth });
      if (collapsed().has(path)) return;
      node.children.forEach((c, i) => walk(c, path ? `${path}.${i}` : String(i), depth + 1));
    };
    walk(root(), "", 0);
    return out;
  });
  const selectedRow = () => rows().find((r) => r.path === props.tab.selected()) ?? rows()[0];
  const toggle = (path: string, open?: boolean) =>
    setCollapsed((s) => {
      const n = new Set(s);
      const isOpen = !n.has(path);
      if (open === undefined ? isOpen : !open) n.add(path);
      else n.delete(path);
      return n;
    });
  const allPaths = (): string[] => {
    const out: string[] = [];
    const walk = (n: PlanNode, p: string) => {
      if (n.children.length) out.push(p);
      n.children.forEach((c, i) => walk(c, p ? `${p}.${i}` : String(i)));
    };
    walk(root(), "");
    return out;
  };

  const onKey = (e: KeyboardEvent) => {
    const list = rows();
    const i = Math.max(0, list.findIndex((r) => r.path === selectedRow()?.path));
    const cur = list[i];
    const go = (k: number) => {
      props.tab.select(list[Math.min(list.length - 1, Math.max(0, k))].path);
      queueMicrotask(() => tree.querySelector(".dgo-plan-row.sel")?.scrollIntoView({ block: "nearest" }));
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "ArrowRight") {
      if (cur.node.children.length && collapsed().has(cur.path)) toggle(cur.path, true);
      else go(i + 1);
    } else if (e.key === "ArrowLeft") {
      if (cur.node.children.length && !collapsed().has(cur.path)) toggle(cur.path, false);
      else {
        const up = cur.path.includes(".") ? cur.path.slice(0, cur.path.lastIndexOf(".")) : "";
        const k = list.findIndex((r) => r.path === up);
        if (k >= 0 && cur.path) go(k);
      }
    } else return;
    e.preventDefault();
  };

  const copy = async () => {
    await copyText(planText(root()));
    notify({ kind: "info", title: "Copied to the clipboard", body: "Query plan" });
  };

  return (
    <div class="dgo-plan">
      <div class="dgo-vtb">
        <ActionButton icon="copy" title="Copy Plan" onClick={() => void copy()} />
        <ActionButton icon="expand-all" title="Expand All" onClick={() => setCollapsed(new Set())} />
        <ActionButton icon="collapse-all" title="Collapse All" onClick={() => setCollapsed(new Set(allPaths()))} />
      </div>
      <div class="dgo-plan-main">
        <div class="dgo-plan-tree" ref={tree} tabindex={0} data-focus-target onKeyDown={onKey}>
          <div class="dgo-plan-head dgo-plan-cols">
            <div>Operation</div>
            <div>Params</div>
            <div class="r">Rows</div>
            <div class="r">Total Cost</div>
            <div class="r">Startup Cost</div>
            <div>Raw Desc</div>
          </div>
          <For each={rows()}>
            {(r) => (
              <div class="dgo-plan-row dgo-plan-cols" classList={{ sel: r.path === selectedRow()?.path }} onMouseDown={() => props.tab.select(r.path)}>
                <div class="dgo-plan-op" style={{ "padding-left": `${r.depth * 18 + 4}px` }}>
                  <Show when={r.node.children.length} fallback={<span class="dgo-plan-chev" />}>
                    <Icon
                      class="dgo-plan-chev"
                      name={collapsed().has(r.path) ? "chevron-right" : "chevron-down"}
                      size={16}
                      style={{ cursor: "default" }}
                    />
                  </Show>
                  <Show when={isScan(r.node)}>
                    <Icon name="dg/table" size={16} />
                  </Show>
                  <span class="dgo-plan-text">{r.node.operation}</span>
                </div>
                <div class="dgo-plan-text">{r.node.params}</div>
                <div class="r">{num(r.node.rows)}</div>
                <div class="r">{num(r.node.totalCost)}</div>
                <div class="r">{num(r.node.startupCost)}</div>
                <div class="dgo-plan-text" title={r.node.raw}>
                  {r.node.raw}
                </div>
              </div>
            )}
          </For>
        </div>
        <div class="dgo-plan-props">
          <div class="dgo-plan-head dgo-plan-kv">
            <div>Property</div>
            <div>Value</div>
          </div>
          <For each={selectedRow()?.node.props ?? []}>
            {(p) => (
              <div class="dgo-plan-kv dgo-plan-krow">
                <div class="dgo-plan-text">{p.name}</div>
                <div class="dgo-plan-text" title={p.value}>
                  {p.value}
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
