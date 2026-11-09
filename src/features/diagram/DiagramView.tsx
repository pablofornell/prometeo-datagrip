/**
 * Diagram view (`editor.view.diagram`): a 34px toolbar over a pannable / zoomable SVG of the database diagram.
 * The SVG is generated as a single string by `renderDiagramSvg` and injected via `innerHTML`; interactions (pan,
 * box drag, dblclick / right-click) are handled by event delegation on `data-table-id`. Node positions moved by the
 * user live in a per-tab map keyed by `schema.name` (stale keys are pruned on reload) and are dropped on re-layout or
 * when the column / type options change. Fit zooms to the same padded box the SVG emits as its viewBox.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import type { ObjectRef } from "../../api/types";
import { ActionButton, ToolbarSeparator, type MenuItem, notify, openMenu } from "../../components/ui";
import { theme } from "../../state/theme";
import type { EditorTab } from "../../state/tabs";
import { loadSchemaSnapshot, schemaSnapshotErrorFor, schemaSnapshotFor } from "../explorer";
import { openDdlTab, openTableTab } from "../table/commands";
import { layoutDiagram } from "./layout";
import { buildDiagram, prunePositions, type ColumnsMode, type DiagramOptions } from "./model";
import { resolvePalette } from "./palette";
import { diagramBounds, renderDiagramSvg } from "./svg";
import { MAX_ZOOM, MIN_ZOOM, fitView, type View } from "./view";
import "./diagram.css";

interface DiagramTabData {
  dsId?: string;
  schema?: string | null;
}

const COLUMN_LABEL: Record<ColumnsMode, string> = { all: "All", keys: "Key Columns", none: "None" };

export function DiagramView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = props.tab.data as DiagramTabData | undefined;
  const dsId = data?.dsId;
  if (!dsId) return <div class="dgd-view"><div class="dgd-overlay">This diagram has no data source.</div></div>;
  return <Diagram tab={props.tab} active={props.active} dsId={dsId} schema={data?.schema ?? null} />;
}

function Diagram(props: { tab: EditorTab; active: boolean; dsId: string; schema: string | null }): JSX.Element {
  const [columnsMode, setColumnsMode] = createSignal<ColumnsMode>("all");
  const [showTypes, setShowTypes] = createSignal(true);
  const [selected, setSelected] = createSignal<number | null>(null);
  const [positions, setPositions] = createSignal<Map<string, { x: number; y: number }>>(new Map());
  const [view, setView] = createSignal<View>({ zoom: 1, tx: 24, ty: 24 });
  const [loading, setLoading] = createSignal(true);
  // Bumped when `<html data-theme>` actually changes: the theme memo fires before `apply()` sets the attribute, so
  // reading the CSS variables in that same tick would keep the previous theme's colours.
  const [themeEpoch, setThemeEpoch] = createSignal(0);

  let stage!: HTMLDivElement;
  let didFit = false;
  let drag: null | { mode: "pan"; sx: number; sy: number; tx: number; ty: number } | { mode: "node"; index: number; key: string; ox: number; oy: number; sx: number; sy: number } = null;

  const objects = () => schemaSnapshotFor(props.dsId, props.schema);
  const loadError = () => schemaSnapshotErrorFor(props.dsId, props.schema);
  const options = (): DiagramOptions => ({ columns: columnsMode(), showTypes: showTypes() });
  const model = createMemo(() => buildDiagram(objects(), options()));
  const layout = createMemo(() => layoutDiagram(model()));
  const palette = createMemo(() => {
    theme();
    themeEpoch();
    return resolvePalette();
  });

  const reload = (): void => {
    setLoading(true);
    void loadSchemaSnapshot(props.dsId, props.schema).finally(() => setLoading(false));
  };

  onMount(() => {
    reload();
    const observer = new MutationObserver(() => setThemeEpoch((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!didFit && props.active && fit()) didFit = true;
          });
    ro?.observe(stage);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    onCleanup(() => {
      observer.disconnect();
      ro?.disconnect();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    });
  });

  // New column / type options change node sizes: stale dragged positions are meaningless.
  createEffect(on(() => [columnsMode(), showTypes()], () => setPositions(new Map())));

  // A reloaded snapshot may drop tables: their dragged positions go with them (positions are keyed by schema.name).
  createEffect(() => setPositions((prev) => prunePositions(prev, model().nodes)));

  // Coming back to the tab retries a snapshot that failed while it was hidden.
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active && loadError() !== undefined) reload();
      },
      { defer: true },
    ),
  );

  const applyTransform = (v: View): void => {
    const svg = stage.querySelector("svg");
    if (svg) svg.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:translate(${v.tx}px,${v.ty}px) scale(${v.zoom});`;
  };

  const content = () =>
    renderDiagramSvg(model(), layout(), { columns: columnsMode(), showTypes: showTypes(), selected: selected() }, palette(), positions());

  createEffect(() => {
    const c = content();
    stage.innerHTML = c;
    applyTransform(untrack(view));
  });
  createEffect(() => applyTransform(view()));

  // Fit once, when the tab is first shown with data. A 0x0 stage (a restored tab at startup) fails the fit; the
  // ResizeObserver above retries it, and `didFit` only latches after a fit actually happened.
  createEffect(() => {
    if (didFit || !props.active || layout().nodes.length === 0) return;
    requestAnimationFrame(() => {
      if (!didFit && props.active && fit()) didFit = true;
    });
  });

  /** Fits the padded diagram box (the same box the SVG emits) into the stage; false when the stage is still empty. */
  const fit = (): boolean => {
    if (layout().nodes.length === 0) return false;
    const r = stage.getBoundingClientRect();
    const v = fitView(diagramBounds(layout(), positions()), { width: r.width, height: r.height });
    if (!v) return false;
    setView(v);
    return true;
  };
  const actualSize = (): void => {
    setView({ zoom: 1, tx: 24, ty: 24 });
  };
  const relayout = (): void => {
    setPositions(new Map());
  };

  // ---------------------------------------------------------------- interactions

  const nodeAt = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest?.("[data-table-id]") as HTMLElement | null;
    return el ? Number(el.getAttribute("data-table-id")) : null;
  };

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const index = nodeAt(e);
    if (index === null) {
      setSelected(null);
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, tx: view().tx, ty: view().ty };
      return;
    }
    setSelected(index);
    const node = layout().nodes[index];
    const pos = positions().get(node.key) ?? node;
    drag = { mode: "node", index, key: node.key, ox: pos.x, oy: pos.y, sx: e.clientX, sy: e.clientY };
  }

  function onMouseMove(e: MouseEvent): void {
    if (!drag) return;
    if (drag.mode === "pan") {
      const d = drag;
      setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.sx), ty: d.ty + (e.clientY - d.sy) }));
    } else {
      const d = drag;
      const dx = (e.clientX - d.sx) / view().zoom;
      const dy = (e.clientY - d.sy) / view().zoom;
      const g = stage.querySelector<SVGGElement>(`[data-table-id="${d.index}"]`);
      if (g) g.setAttribute("transform", `translate(${Math.round(d.ox + dx)} ${Math.round(d.oy + dy)})`);
    }
  }

  function onMouseUp(): void {
    if (!drag) return;
    if (drag.mode === "node") {
      const d = drag;
      const g = stage.querySelector<SVGGElement>(`[data-table-id="${d.index}"]`);
      const m = g?.getAttribute("transform") ? /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(g.getAttribute("transform")!) : null;
      if (m) setPositions((prev) => new Map(prev).set(d.key, { x: Number(m[1]), y: Number(m[2]) }));
    }
    drag = null;
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const v = view();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
    const k = zoom / v.zoom;
    setView({ zoom, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k });
  }

  function onDblClick(e: MouseEvent): void {
    const index = nodeAt(e);
    if (index === null) return;
    const node = model().nodes[index];
    void openTableTab(props.dsId, { schema: node.schema, name: node.name, kind: node.kind } as ObjectRef);
  }

  function onContextMenu(e: MouseEvent): void {
    const index = nodeAt(e);
    if (index === null) return;
    e.preventDefault();
    setSelected(index);
    const node = model().nodes[index];
    const ref = { schema: node.schema, name: node.name, kind: node.kind } as ObjectRef;
    openMenu(
      [
        { label: "Open Data", icon: "dg/edit-data", run: () => void openTableTab(props.dsId, ref) },
        { label: "Go to DDL", icon: "dg/table", run: () => void openDdlTab(props.dsId, ref) },
        { type: "separator" } as MenuItem,
        { label: "Copy Name", run: () => void navigator.clipboard?.writeText(node.name).catch(() => {}) },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }

  // ---------------------------------------------------------------- export

  const fileBase = (): string => (props.schema || "diagram").replace(/[^A-Za-z0-9_-]+/g, "_") || "diagram";
  const svgString = () =>
    renderDiagramSvg(model(), layout(), { columns: columnsMode(), showTypes: showTypes(), selected: selected() }, palette(), positions());

  const download = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportSvg = (): void => download(new Blob([svgString()], { type: "image/svg+xml" }), `${fileBase()}.svg`);

  const exportPng = (): void => {
    const url = URL.createObjectURL(new Blob([svgString()], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || Math.max(1, Math.round(layout().width));
      canvas.height = img.naturalHeight || Math.max(1, Math.round(layout().height));
      const ctx = canvas.getContext("2d");
      if (!ctx) return URL.revokeObjectURL(url);
      ctx.fillStyle = palette().background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) download(blob, `${fileBase()}.png`);
        else notify({ kind: "error", title: "Export failed", body: "The browser could not render the diagram as an image." });
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      notify({ kind: "error", title: "Export failed", body: "The browser could not render the diagram as an image." });
    };
    img.src = url;
  };

  const openExportMenu = (anchor: HTMLElement): void =>
    openMenu(
      [
        { label: "Export as SVG", run: exportSvg },
        { label: "Export as PNG", run: exportPng },
      ],
      { anchor },
    );

  const openColumnsMenu = (anchor: HTMLElement): void =>
    openMenu(
      (Object.keys(COLUMN_LABEL) as ColumnsMode[]).map<MenuItem>((m) => ({
        label: COLUMN_LABEL[m],
        checked: columnsMode() === m,
        run: () => setColumnsMode(m),
      })),
      { anchor },
    );

  const isLoading = () => loading() && objects().length === 0;

  return (
    <div class="dgd-view">
      <div class="dgd-toolbar" role="toolbar">
        <button class="dgd-tbtn text" tabindex={-1} title="Columns" onClick={(e) => openColumnsMenu(e.currentTarget)}>
          Columns: {COLUMN_LABEL[columnsMode()]}
          <i class="dgg-i i-chevron" />
        </button>
        <button class="dgd-tbtn text" classList={{ selected: showTypes() }} tabindex={-1} title="Show column types" onClick={() => setShowTypes(!showTypes())}>
          Types
        </button>
        <ToolbarSeparator />
        <ActionButton icon="layout" title="Re-layout" onClick={relayout} />
        <ActionButton icon="locate" title="Fit Diagram" onClick={fit} />
        <ActionButton icon="window-restore" title="Actual Size" onClick={actualSize} />
        <ToolbarSeparator />
        <button class="dgd-tbtn text" tabindex={-1} title="Export the diagram as an image" onClick={(e) => openExportMenu(e.currentTarget)}>
          Export
          <i class="dgg-i i-chevron" />
        </button>
      </div>
      <div class="dgd-body">
        <div class="dgd-stage" ref={stage} onMouseDown={onMouseDown} onWheel={onWheel} onDblClick={onDblClick} onContextMenu={onContextMenu} />
        <Show when={isLoading()}>
          <div class="dgd-overlay">Loading diagram…</div>
        </Show>
        <Show when={!loading() && loadError() !== undefined && objects().length === 0}>
          <div class="dgd-overlay error">
            <div class="dgd-error-text">{loadError()}</div>
            <a class="dgd-retry" onClick={reload}>
              Retry
            </a>
          </div>
        </Show>
        <Show when={!loading() && loadError() === undefined && objects().length === 0}>
          <div class="dgd-overlay">No tables to show.</div>
        </Show>
      </div>
    </div>
  );
}
