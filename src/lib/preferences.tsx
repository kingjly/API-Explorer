import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "light" | "dark";

const THEME_KEY = "api-explorer:theme";
const ZOOM_KEY = "api-explorer:zoom";
const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;
const ZOOM_DEFAULT = 1;

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : "dark";
}

function readStoredZoom(): number {
  if (typeof window === "undefined") return ZOOM_DEFAULT;
  const stored = Number(window.localStorage.getItem(ZOOM_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return ZOOM_DEFAULT;
  return clampZoom(stored);
}

function clampZoom(value: number) {
  const snapped = Math.round(value * 100) / 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped));
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface PreferencesValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  zoom: number;
  zoomPercent: number;
  setZoom: (zoom: number) => void;
  increaseZoom: () => void;
  decreaseZoom: () => void;
  resetZoom: () => void;
  canIncreaseZoom: boolean;
  canDecreaseZoom: boolean;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);
  const [zoom, setZoomState] = useState<number>(readStoredZoom);
  const runtimeIsTauri = useRef<boolean | null>(null);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (runtimeIsTauri.current === null) {
      runtimeIsTauri.current = isTauriRuntime();
    }
    window.localStorage.setItem(ZOOM_KEY, String(zoom));

    if (runtimeIsTauri.current) {
      let cancelled = false;
      void import("@tauri-apps/api/webview")
        .then((module_) => module_.getCurrentWebview().setZoom(zoom))
        .catch(() => {
          if (!cancelled) document.documentElement.style.zoom = String(zoom);
        });
      return () => {
        cancelled = true;
      };
    }
    document.documentElement.style.zoom = String(zoom);
  }, [zoom]);

  const setZoom = useCallback((next: number) => {
    setZoomState(clampZoom(next));
  }, []);

  const increaseZoom = useCallback(() => {
    setZoomState((current) => clampZoom(current + ZOOM_STEP));
  }, []);

  const decreaseZoom = useCallback(() => {
    setZoomState((current) => clampZoom(current - ZOOM_STEP));
  }, []);

  const resetZoom = useCallback(() => {
    setZoomState(ZOOM_DEFAULT);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo<PreferencesValue>(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      zoom,
      zoomPercent: Math.round(zoom * 100),
      setZoom,
      increaseZoom,
      decreaseZoom,
      resetZoom,
      canIncreaseZoom: zoom < ZOOM_MAX - 1e-6,
      canDecreaseZoom: zoom > ZOOM_MIN + 1e-6,
    }),
    [theme, toggleTheme, zoom, setZoom, increaseZoom, decreaseZoom, resetZoom],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences 必须在 PreferencesProvider 内使用");
  return context;
}
