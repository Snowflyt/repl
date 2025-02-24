import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import { show } from "./show";

import "./styles.css";

// Make `show` accessible for user to use
(globalThis as any).show = show;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
