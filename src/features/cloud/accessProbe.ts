import { explainCloudFailure, type CloudFailureKind } from "../../lib/explainCloudFailure";
import type { CloudResponse, CommandError } from "../../types";
import { parseCloudResult } from "./parseCloudResult";
import { needsProjectPlaceholder, type CloudPreset } from "./presets";

export type AccessProbeStatus =
  | "pending"
  | "running"
  | "ok"
  | "empty"
  | "denied"
  | "invalid"
  | "expired"
  | "error"
  | "skipped";

export interface AccessProbe {
  id: string;
  product: string;
  label: string;
  status: AccessProbeStatus;
  detail: string;
}

export const FATAL_PROBE_KINDS = new Set<CloudFailureKind>([
  "expired",
  "invalid_key",
  "bad_signature",
  "need_token",
]);

export function createProbe(preset: CloudPreset): AccessProbe {
  if (needsProjectPlaceholder(preset)) {
    return {
      id: preset.id,
      product: preset.product,
      label: preset.label,
      status: "skipped",
      detail: "Endpoint 还缺项目 ID，先查 IAM 项目",
    };
  }
  return {
    id: preset.id,
    product: preset.product,
    label: preset.label,
    status: "pending",
    detail: "",
  };
}

export function probeFromResponse(preset: CloudPreset, result: CloudResponse): AccessProbe {
  const parsed = parseCloudResult(result.body, preset.resultKind);
  const failure = parsed.error || result.status >= 400
    ? explainCloudFailure({
      code: parsed.error?.code,
      message: parsed.error?.message,
      body: result.body,
      httpStatus: result.status,
    })
    : null;
  if (failure) return probeFromFailure(preset, failure.kind, failure.title);
  const count = parsed.rows.length;
  return {
    id: preset.id,
    product: preset.product,
    label: preset.label,
    status: count > 0 ? "ok" : "empty",
    detail: count > 0 ? `${count} 条` : "接口能调，当前列表为空",
  };
}

export function probeFromFailure(preset: CloudPreset, kind: CloudFailureKind, title: string): AccessProbe {
  const status: AccessProbeStatus = kind === "denied" || kind === "wrong_region"
    ? "denied"
    : kind === "expired"
      ? "expired"
      : kind === "invalid_key" || kind === "bad_signature" || kind === "need_token"
        ? "invalid"
        : kind === "cancelled"
          ? "skipped"
          : "error";
  return {
    id: preset.id,
    product: preset.product,
    label: preset.label,
    status,
    detail: title,
  };
}

export function probeFromCommandError(preset: CloudPreset, error: CommandError): AccessProbe {
  const failure = explainCloudFailure(error);
  return probeFromFailure(preset, failure.kind, failure.title);
}

export function markRemainingSkipped(probes: AccessProbe[], reason: string) {
  return probes.map((item) => (
    item.status === "pending" ? { ...item, status: "skipped" as const, detail: reason } : item
  ));
}
