/**
 * The Image tab of the value viewer: the picture of a PNG / JPEG / GIF / WEBP / BMP / SVG value, fit to the window or
 * at 100 %, with its size in bytes and pixels.
 */
import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { IMAGE_MIME, type ImageKind } from "./magic";
import { formatBytes } from "./bytes";

export function ImageView(props: { bytes: Uint8Array; kind: ImageKind; truncated: boolean }): JSX.Element {
  const [url, setUrl] = createSignal("");
  const [dims, setDims] = createSignal("");
  const [fit, setFit] = createSignal(true);

  createEffect(() => {
    if (props.truncated) return;
    const u = URL.createObjectURL(new Blob([props.bytes as BlobPart], { type: IMAGE_MIME[props.kind] }));
    setUrl(u);
    onCleanup(() => URL.revokeObjectURL(u));
  });

  return (
    <div class="dgg-vx-image">
      <div class="dgg-vx-toolbar">
        <button class="dgg-vx-link" classList={{ on: fit() }} tabIndex={-1} onClick={() => setFit(true)}>
          Fit
        </button>
        <button class="dgg-vx-link" classList={{ on: !fit() }} tabIndex={-1} onClick={() => setFit(false)}>
          100%
        </button>
        <span class="dgg-vx-note">
          {props.kind.toUpperCase()} · {formatBytes(props.bytes.length)}
          {dims() ? ` · ${dims()}` : ""}
        </span>
      </div>
      <Show
        when={!props.truncated}
        fallback={<div class="dgg-vx-note dgg-vx-pad">Only the first {formatBytes(props.bytes.length)} are loaded: load the full value to see the picture.</div>}
      >
        <div class="dgg-vx-scroll dgg-vx-img-box" classList={{ fit: fit() }}>
          <img
            class="dgg-vx-img"
            classList={{ fit: fit() }}
            src={url()}
            alt=""
            onLoad={(e) => {
              const i = e.currentTarget;
              setDims(i.naturalWidth && i.naturalHeight ? `${i.naturalWidth} × ${i.naturalHeight} px` : "");
            }}
          />
        </div>
      </Show>
    </div>
  );
}
