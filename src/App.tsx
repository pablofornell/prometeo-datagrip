import { onCleanup, onMount, type Component } from "solid-js";
import { AboutDialog } from "./components/shell/AboutDialog";
import { MainToolbar } from "./components/shell/MainToolbar";
import { Shell } from "./components/shell/Shell";
import { StatusBar } from "./components/shell/StatusBar";
import { MenuHost } from "./components/ui/Menu";
import { NotificationHost } from "./components/ui/Notification";
import { TooltipHost } from "./components/ui/Tooltip";
import { installKeymap } from "./state/actions";
import { registerCoreActions } from "./state/core-actions";
import { hydrateLayout } from "./state/layout";
import { loadDemo } from "./demo";

const App: Component = () => {
  const disposeActions = registerCoreActions();
  onMount(() => {
    const uninstall = installKeymap();
    void hydrateLayout();
    if (import.meta.env.DEV) loadDemo();
    onCleanup(() => {
      uninstall();
      disposeActions();
    });
  });

  return (
    <div class="dg-app">
      <MainToolbar />
      <Shell />
      <StatusBar />
      <MenuHost />
      <TooltipHost />
      <NotificationHost />
      <AboutDialog />
    </div>
  );
};

export default App;
