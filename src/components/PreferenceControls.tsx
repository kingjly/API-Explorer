import { Minus, Moon, Plus, Sun } from "lucide-react";
import { usePreferences } from "../lib/preferences";

export function PreferenceControls() {
  const {
    theme,
    toggleTheme,
    zoomPercent,
    increaseZoom,
    decreaseZoom,
    resetZoom,
    canIncreaseZoom,
    canDecreaseZoom,
  } = usePreferences();

  return (
    <div className="pref-controls" role="group" aria-label="外观与显示设置">
      <button
        className="icon-button"
        onClick={decreaseZoom}
        disabled={!canDecreaseZoom}
        title="缩小界面"
        aria-label="缩小界面"
      >
        <Minus size={13} />
      </button>
      <button
        className="zoom-value"
        onClick={resetZoom}
        title="重置为 100%"
        aria-label="重置界面缩放为 100%"
      >
        {zoomPercent}%
      </button>
      <button
        className="icon-button"
        onClick={increaseZoom}
        disabled={!canIncreaseZoom}
        title="放大界面"
        aria-label="放大界面"
      >
        <Plus size={13} />
      </button>
      <span className="pref-divider" aria-hidden="true" />
      <button
        className="icon-button"
        onClick={toggleTheme}
        title={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}
        aria-label={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}
      >
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </div>
  );
}
