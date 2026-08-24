import type { WorkspaceMode } from "../components/WorkspaceSwitch";
import type { StorageOperation, StorageProvider } from "../types";

const KEY = "api-explorer:workspace-memory";

export interface WorkspaceMemory {
  mode: WorkspaceMode;
  cloudPresetId: string;
  cloudEndpoint: string;
  cloudRegion: string;
  cloudQuery: string;
  storageProvider: StorageProvider;
  storageOperation: StorageOperation;
  storageRegion: string;
  storageBucket: string;
  storageObjectKey: string;
  storagePrefix: string;
  catalogAppId: number | null;
  catalogGroupId: number | null;
  catalogFunctionId: number | null;
}

const EMPTY: WorkspaceMemory = {
  mode: "catalog",
  cloudPresetId: "",
  cloudEndpoint: "",
  cloudRegion: "",
  cloudQuery: "",
  storageProvider: "alibabaOss",
  storageOperation: "listBuckets",
  storageRegion: "",
  storageBucket: "",
  storageObjectKey: "",
  storagePrefix: "",
  catalogAppId: null,
  catalogGroupId: null,
  catalogFunctionId: null,
};

const STORAGE_PROVIDERS: StorageProvider[] = ["alibabaOss", "tencentCos", "baiduBos"];
const STORAGE_OPERATIONS: StorageOperation[] = [
  "listBuckets",
  "listObjects",
  "uploadObject",
  "downloadObject",
  "presignGet",
  "presignPut",
];

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === "catalog" || value === "cloud" || value === "storage";
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function id(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readWorkspaceMemory(): WorkspaceMemory {
  if (typeof window === "undefined") return EMPTY;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (!stored) return EMPTY;
    const parsed = JSON.parse(stored) as Partial<WorkspaceMemory>;
    return {
      mode: isWorkspaceMode(parsed.mode) ? parsed.mode : "catalog",
      cloudPresetId: text(parsed.cloudPresetId),
      cloudEndpoint: text(parsed.cloudEndpoint),
      cloudRegion: text(parsed.cloudRegion),
      cloudQuery: text(parsed.cloudQuery),
      storageProvider: STORAGE_PROVIDERS.includes(parsed.storageProvider as StorageProvider)
        ? (parsed.storageProvider as StorageProvider)
        : "alibabaOss",
      storageOperation: STORAGE_OPERATIONS.includes(parsed.storageOperation as StorageOperation)
        ? (parsed.storageOperation as StorageOperation)
        : "listBuckets",
      storageRegion: text(parsed.storageRegion),
      storageBucket: text(parsed.storageBucket),
      storageObjectKey: text(parsed.storageObjectKey),
      storagePrefix: text(parsed.storagePrefix),
      catalogAppId: id(parsed.catalogAppId),
      catalogGroupId: id(parsed.catalogGroupId),
      catalogFunctionId: id(parsed.catalogFunctionId),
    };
  } catch {
    return EMPTY;
  }
}

export function patchWorkspaceMemory(patch: Partial<WorkspaceMemory>) {
  if (typeof window === "undefined") return;
  const next = { ...readWorkspaceMemory(), ...patch };
  window.localStorage.setItem(KEY, JSON.stringify({
    mode: next.mode,
    cloudPresetId: next.cloudPresetId,
    cloudEndpoint: next.cloudEndpoint,
    cloudRegion: next.cloudRegion,
    cloudQuery: next.cloudQuery,
    storageProvider: next.storageProvider,
    storageOperation: next.storageOperation,
    storageRegion: next.storageRegion,
    storageBucket: next.storageBucket,
    storageObjectKey: next.storageObjectKey,
    storagePrefix: next.storagePrefix,
    catalogAppId: next.catalogAppId,
    catalogGroupId: next.catalogGroupId,
    catalogFunctionId: next.catalogFunctionId,
  }));
}
