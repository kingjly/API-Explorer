import { invoke } from "@tauri-apps/api/core";
import type {
  ApiResponse,
  Catalog,
  CloudRequest,
  CloudResponse,
  CommandError,
  ExecuteRequest,
  FunctionDetails,
  ParameterEntry,
  StorageRequest,
  StorageResponse,
} from "../types";

export const api = {
  loadCatalog: () => invoke<Catalog>("load_catalog"),
  getFunction: (functionId: number) =>
    invoke<FunctionDetails>("get_function", { functionId }),
  saveParameters: (functionId: number, parameters: ParameterEntry[]) =>
    invoke<FunctionDetails>("save_parameters", { functionId, parameters }),
  executeRequest: (request: ExecuteRequest) =>
    invoke<ApiResponse>("execute_request", { request }),
  executeCloudRequest: (request: CloudRequest) =>
    invoke<CloudResponse>("execute_cloud_request", { request }),
  previewCloudSignature: (request: CloudRequest) =>
    invoke<CloudResponse["signature"]>("preview_cloud_signature", { request }),
  executeObjectStorageRequest: (request: StorageRequest) =>
    invoke<StorageResponse>("execute_object_storage_request", { request }),
  previewObjectStorageSignature: (request: StorageRequest) =>
    invoke<StorageResponse["signature"]>("preview_object_storage_signature", { request }),
  cancelRequest: (requestId: string) =>
    invoke<boolean>("cancel_request", { requestId }),
  base64Encode: (value: string) => invoke<string>("base64_encode", { value }),
};

export function normalizeError(error: unknown): CommandError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<CommandError>;
    if (typeof candidate.message === "string") {
      return {
        code: typeof candidate.code === "string" ? candidate.code : "unknown",
        message: candidate.message,
      };
    }
  }
  return {
    code: "unknown",
    message: typeof error === "string" ? error : "发生未知错误",
  };
}
