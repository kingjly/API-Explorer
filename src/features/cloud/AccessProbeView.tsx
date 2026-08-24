import { ListChecks } from "lucide-react";
import type { AccessProbe } from "./accessProbe";

const STATUS_LABEL: Record<AccessProbe["status"], string> = {
  pending: "等待",
  running: "探测中",
  ok: "能查",
  empty: "能查 · 空",
  denied: "无权限",
  invalid: "密钥无效",
  expired: "已过期",
  error: "失败",
  skipped: "未测",
};

export function AccessProbeView({
  probes,
  probing,
  onOpen,
}: {
  probes: AccessProbe[];
  probing: boolean;
  onOpen: (presetId: string) => void;
}) {
  if (probes.length === 0) {
    return (
      <div className="response-empty">
        <ListChecks size={24} />
        <strong>还没有权限探测</strong>
        <span>只打当前厂商的只读模板，不是完整 IAM。密钥无效会立刻停。</span>
      </div>
    );
  }

  const allowed = probes.filter((item) => item.status === "ok" || item.status === "empty").length;
  const denied = probes.filter((item) => item.status === "denied").length;

  return (
    <div className="access-probe">
      <div className="access-probe-summary">
        <strong>{probing ? "正在探测只读接口" : "当前密钥在本工具里的只读能力"}</strong>
        <span>能查 {allowed} · 无权限 {denied} · 共 {probes.length}。点「能查」可打开该接口。</span>
      </div>
      <div className="cloud-result-table-wrap">
        <table className="cloud-result-table access-probe-table">
          <thead>
            <tr>
              <th>产品</th>
              <th>接口</th>
              <th>判定</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {probes.map((probe) => {
              const canOpen = probe.status === "ok" || probe.status === "empty";
              return (
                <tr
                  key={probe.id}
                  className={canOpen ? "access-probe-open" : undefined}
                  onClick={() => { if (canOpen) onOpen(probe.id); }}
                >
                  <td>{probe.product}</td>
                  <td>{probe.label}</td>
                  <td><span className={`access-probe-flag ${probe.status}`}>{STATUS_LABEL[probe.status]}</span></td>
                  <td>{probe.detail || <i>—</i>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
