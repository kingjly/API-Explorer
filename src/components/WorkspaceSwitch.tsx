import { Cloud, HardDrive, Network } from "lucide-react";

export type WorkspaceMode = "catalog" | "cloud" | "storage";

export function WorkspaceSwitch({
  mode,
  onChange,
}: {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <div className="workspace-switch" role="tablist" aria-label="工作区">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "catalog"}
        className={mode === "catalog" ? "active" : ""}
        onClick={() => onChange("catalog")}
      >
        <Network size={14} />接口目录
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "cloud"}
        className={mode === "cloud" ? "active" : ""}
        onClick={() => onChange("cloud")}
      >
        <Cloud size={14} />云 AK/SK
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "storage"}
        className={mode === "storage" ? "active" : ""}
        onClick={() => onChange("storage")}
      >
        <HardDrive size={14} />对象存储
      </button>
    </div>
  );
}
