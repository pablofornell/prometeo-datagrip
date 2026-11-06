import { type JSX, Show, createResource } from "solid-js";
import { appInfo } from "../../api/tauri";
import { aboutOpen, setAboutOpen } from "../../state/ui";
import { Dialog } from "../ui/Dialog";

export function AboutDialog(): JSX.Element {
  return (
    <Show when={aboutOpen()}>
      <AboutContent />
    </Show>
  );
}

function AboutContent(): JSX.Element {
  const [info] = createResource(() => appInfo().catch(() => undefined));
  const close = () => setAboutOpen(false);
  return (
    <Dialog title="About" width={380} onClose={close} buttons={[{ label: "OK", primary: true, run: close }]}>
      <div style={{ "line-height": "20px" }}>
        <div style={{ "font-weight": 600, "font-size": "16px", "margin-bottom": "6px" }}>Prometeo DataGrip</div>
        <div>Version {info()?.version ?? "…"}</div>
        <div style={{ color: "var(--dg-text-secondary)", "margin-top": "8px" }}>A lightweight database client.</div>
      </div>
    </Dialog>
  );
}
