import { StrictMode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/globals.css";
import App from "./App";
import { QuickAsk } from "./components/QuickAsk";

// The same bundle runs the main window and the quick-ask window.
const isQuick = new URLSearchParams(window.location.search).has("quick");
// Transparent window: only the cards show (styles in globals.css).
if (isQuick) document.documentElement.dataset.quick = "";

// No browser context menu (chat items provide their own).
window.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest("input, textarea, .selectable")) e.preventDefault();
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      {isQuick ? (
        <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
          <QuickAsk />
        </Tooltip.Provider>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
}
