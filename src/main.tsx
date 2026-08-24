import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PreferencesProvider } from "./lib/preferences";
import { SessionCredentialsProvider } from "./lib/sessionCredentials";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreferencesProvider>
      <SessionCredentialsProvider>
        <App />
      </SessionCredentialsProvider>
    </PreferencesProvider>
  </StrictMode>,
);
