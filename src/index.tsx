/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./theme/fonts.css";
import "./theme/metrics.css";
import "./theme/dark.css";
import "./theme/light.css";
import "./styles/tokens-extra.css";
import "./styles/app.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./theme/appearance.css";
import { installNativeMenuGuard } from "./state/nativeMenu";
import { initTheme } from "./state/theme";

installNativeMenuGuard(import.meta.env.PROD); // no webview menu ("Reload") on a dialog backdrop or any plain area
initTheme(); // sets <html data-theme> before the first paint
import "./features";

render(() => <App />, document.getElementById("root") as HTMLElement);
