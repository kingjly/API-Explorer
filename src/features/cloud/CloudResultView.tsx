import { Braces, Copy, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatJson, parseCloudResult, statusToneClass } from "./parseCloudResult";
import type { CloudResultKind } from "./presets";

export function CloudResultView({
  body,
  kind,
  onCopy,
}: {
  body: string;
  kind: CloudResultKind;
  onCopy: (value: string, message: string) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = useMemo(() => parseCloudResult(body, kind), [body, kind]);

  useEffect(() => {
    setShowRaw(false);
  }, [body, kind]);

  if (showRaw || !parsed.parsed) {
    return (
      <div className="cloud-result-view">
        {parsed.parsed && (
          <div className="cloud-result-toolbar">
            <span>原始 JSON</span>
            <button className="button secondary" onClick={() => setShowRaw(false)}>
              <Table2 size={13} />结构化
            </button>
          </div>
        )}
        <pre className="response-body"><code>{formatJson(body)}</code></pre>
      </div>
    );
  }

  const visibleColumns = parsed.columns.filter((column) => parsed.rows.some((row) => row[column.key]));

  return (
    <div className="cloud-result-view">
      <div className="cloud-result-toolbar">
        <strong>{parsed.title}</strong>
        {parsed.rows.length > 0 && <small>{parsed.rows.length} 条</small>}
        <button className="button secondary" onClick={() => setShowRaw(true)}>
          <Braces size={13} />原始 JSON
        </button>
      </div>

      {parsed.error && (
        <div className="cloud-result-error" role="status">
          <strong>{parsed.error.code}</strong>
          <span>{parsed.error.message || "云接口返回业务错误"}</span>
        </div>
      )}

      {parsed.summary.length > 0 && (
        <dl className="cloud-result-summary">
          {parsed.summary.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                <code>{item.value}</code>
                {item.label.toLowerCase().includes("id") && (
                  <button
                    className="icon-button small"
                    onClick={() => void onCopy(item.value, `${item.label} 已复制`)}
                    title={`复制 ${item.label}`}
                  >
                    <Copy size={12} />
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {visibleColumns.length > 0 && parsed.rows.length > 0 ? (
        <div className="cloud-result-table-wrap">
          <table className="cloud-result-table">
            <thead>
              <tr>
                {visibleColumns.map((column) => <th key={column.key}>{column.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row, index) => (
                <tr key={`${row.id ?? row.name ?? index}-${index}`}>
                  {visibleColumns.map((column) => {
                    const value = row[column.key] ?? "";
                    const isStatus = column.key === "status";
                    return (
                      <td key={column.key} title={value}>
                        {isStatus && value ? (
                          <span className={`cloud-state ${statusToneClass(value)}`}>{value}</span>
                        ) : value || <i>—</i>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !parsed.error && parsed.summary.length === 0 ? (
        <div className="response-empty compact">
          <Table2 size={22} />
          <strong>没有可展示的{parsed.title}</strong>
          <span>接口已返回，但没有解析到列表项。可查看原始 JSON。</span>
        </div>
      ) : null}
    </div>
  );
}
