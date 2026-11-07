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
import { initTheme } from "./state/theme";

initTheme(); // sets <html data-theme> before the first paint
import "./features";

render(() => <App />, document.getElementById("root") as HTMLElement);
