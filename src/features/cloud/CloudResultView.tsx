import { Braces, Copy, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { explainCloudFailure } from "../../lib/explainCloudFailure";
import { formatJson, parseCloudResult, statusToneClass } from "./parseCloudResult";
import type { CloudResultKind } from "./presets";

export function CloudResultView({
  body,
  kind,
  requestUrl,
  httpStatus,
  onCopy,
  onUseValue,
}: {
  body: string;
  kind: CloudResultKind;
  requestUrl?: string;
  httpStatus?: number;
  onCopy: (value: string, message: string) => void;
  onUseValue?: (column: string, value: string) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = useMemo(() => parseCloudResult(body, kind), [body, kind]);
  const pretty = useMemo(() => formatJson(body), [body]);

  useEffect(() => {
    setShowRaw(false);
  }, [body, kind]);

  const failure = useMemo(
    () => (parsed.error || (httpStatus && httpStatus >= 400)
      ? explainCloudFailure({
        code: parsed.error?.code,
        message: parsed.error?.message,
        body,
        httpStatus,
      })
      : null),
    [body, httpStatus, parsed.error],
  );
  const visibleColumns = parsed.columns.filter((column) => parsed.rows.some((row) => row[column.key]));
  const tableText = useMemo(() => {
    if (visibleColumns.length === 0 || parsed.rows.length === 0) return pretty;
    const header = visibleColumns.map((column) => column.label).join("\t");
    const lines = parsed.rows.map((row) => visibleColumns.map((column) => row[column.key] ?? "").join("\t"));
    return [header, ...lines].join("\n");
  }, [parsed.rows, pretty, visibleColumns]);

  return (
    <div className="cloud-result-view">
      <div className="cloud-result-toolbar">
        <strong>{showRaw || !parsed.parsed ? "原始 JSON" : parsed.title}</strong>
        {parsed.rows.length > 0 && !showRaw && <small>{parsed.rows.length} 条</small>}
        {failure && !showRaw && <small className="cloud-result-error-flag">{parsed.error?.code || failure.kind}</small>}
        <div className="cloud-result-toolbar-actions">
          {parsed.parsed && (
            <button className="button secondary" onClick={() => setShowRaw((current) => !current)}>
              {showRaw ? <Table2 size={13} /> : <Braces size={13} />}
              {showRaw ? "结构化" : "原始 JSON"}
            </button>
          )}
          <button className="button secondary" onClick={() => void onCopy(showRaw || !parsed.parsed ? pretty : tableText, "结果已复制")}>
            <Copy size={13} />复制
          </button>
        </div>
      </div>

      {requestUrl && (
        <div className="cloud-result-url">
          <span>请求</span>
          <code title={requestUrl}>{requestUrl}</code>
          <button className="icon-button small" onClick={() => void onCopy(requestUrl, "请求 URL 已复制")} title="复制请求 URL">
            <Copy size={12} />
          </button>
        </div>
      )}

      {failure && (
        <div className={`cloud-result-error ${failure.kind}`} role="status">
          <strong>{failure.title}</strong>
          <span>{failure.hint}</span>
          {(parsed.error?.code || parsed.error?.message) && (
            <small>{[parsed.error.code, parsed.error.message].filter(Boolean).join(" · ")}</small>
          )}
        </div>
      )}

      {showRaw || !parsed.parsed ? (
        <pre className="response-body"><code>{pretty}</code></pre>
      ) : (
        <>
          {parsed.summary.length > 0 && (
            <dl className="cloud-result-summary">
              {parsed.summary.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>
                    <code>{item.value}</code>
                    <button
                      className="icon-button small"
                      onClick={() => void onCopy(item.value, `${item.label} 已复制`)}
                      title={`复制 ${item.label}`}
                    >
                      <Copy size={12} />
                    </button>
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
                          <td
                            key={column.key}
                            title={value ? (onUseValue && (column.key === "name" || column.key === "region") ? `${value}（单击填入 Query）` : `${value}（单击复制）`) : undefined}
                            onClick={() => {
                              if (!value) return;
                              if (onUseValue && (column.key === "name" || column.key === "region")) onUseValue(column.key, value);
                              else void onCopy(value, `${column.label} 已复制`);
                            }}
                          >
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
          ) : !parsed.error ? (
            <div className="response-empty compact">
              <Table2 size={22} />
              <strong>{parsed.summary.length > 0 ? `没有可列出的${parsed.title}` : `没有可展示的${parsed.title}`}</strong>
              <span>{parsed.summary.length > 0 ? "上方摘要来自接口返回，列表为空。" : "接口已返回，但没有解析到列表项。可查看原始 JSON。"}</span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
