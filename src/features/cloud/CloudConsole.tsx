import {
  AlertCircle,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Eye,
  EyeOff,
  FileKey2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  Play,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PreferenceControls } from "../../components/PreferenceControls";
import { WorkspaceSwitch, type WorkspaceMode } from "../../components/WorkspaceSwitch";
import { api, normalizeError } from "../../lib/ipc";
import type {
  CloudProvider,
  CloudRequest,
  CloudResponse,
  CloudSignaturePreview,
  CommandError,
} from "../../types";
import { CloudResultView } from "./CloudResultView";
import { findPreset, groupPresetsByProvider, PRESETS, PROVIDERS, presetMatchesQuery, type CloudPreset } from "./presets";

type ResultTab = "body" | "headers" | "signature";

function statusTone(status: number) {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect";
  return "error";
}

export function CloudConsole({
  active,
  workspaceMode,
  onWorkspaceChange,
}: {
  active: boolean;
  workspaceMode: WorkspaceMode;
  onWorkspaceChange: (mode: WorkspaceMode) => void;
}) {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [form, setForm] = useState<CloudPreset>(PRESETS[0]);
  const [expandedProviders, setExpandedProviders] = useState<Set<CloudProvider>>(() => new Set([PRESETS[0].provider]));
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [securityToken, setSecurityToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("http://127.0.0.1:8080");
  const [allowInvalidCertificates, setAllowInvalidCertificates] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [response, setResponse] = useState<CloudResponse | null>(null);
  const [signature, setSignature] = useState<CloudSignaturePreview | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("body");
  const [error, setError] = useState<CommandError | null>(null);
  const [notice, setNotice] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");

  const selectedPreset = useMemo(() => findPreset(presetId), [presetId]);
  const providerGroups = useMemo(() => groupPresetsByProvider(PRESETS), []);
  const visibleGroups = useMemo(() => {
    if (!catalogQuery.trim()) return providerGroups;
    return providerGroups
      .map((group) => {
        const presets = group.presets.filter((item) => presetMatchesQuery(item, catalogQuery));
        return {
          ...group,
          presets,
          products: group.products
            .map((product) => ({
              ...product,
              presets: product.presets.filter((item) => presetMatchesQuery(item, catalogQuery)),
            }))
            .filter((product) => product.presets.length > 0),
        };
      })
      .filter((group) => group.presets.length > 0);
  }, [catalogQuery, providerGroups]);
  const provider = PROVIDERS[form.provider];
  const usesActionVersion = ["alibabaAcs3", "tencentTc3", "volcengineHmac"].includes(form.provider);
  const usesService = ["tencentTc3", "volcengineHmac"].includes(form.provider);
  const usesRegion = ["tencentTc3", "volcengineHmac"].includes(form.provider);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const buildRequest = useCallback((requestId = crypto.randomUUID()): CloudRequest => ({
    requestId,
    provider: form.provider,
    method: form.method,
    endpoint: form.endpoint,
    service: form.service,
    action: form.action,
    version: form.version,
    region: form.region,
    query: form.query,
    body: form.body,
    contentType: form.contentType,
    credentials: { accessKeyId, accessKeySecret, securityToken },
    proxyUrl: proxyEnabled ? proxyUrl : undefined,
    allowInvalidCertificates,
  }), [accessKeyId, accessKeySecret, allowInvalidCertificates, form, proxyEnabled, proxyUrl, securityToken]);

  const previewSignature = useCallback(async () => {
    setError(null);
    try {
      const result = await api.previewCloudSignature(buildRequest());
      setSignature(result);
      setResultTab("signature");
      setNotice("已在本机生成签名，未发送网络请求");
    } catch (reason) {
      setError(normalizeError(reason));
    }
  }, [buildRequest]);

  const sendRequest = useCallback(async () => {
    if (requesting) return;
    const requestId = crypto.randomUUID();
    setRequesting(true);
    setActiveRequestId(requestId);
    setError(null);
    try {
      const result = await api.executeCloudRequest(buildRequest(requestId));
      setResponse(result);
      setSignature(result.signature);
      setResultTab("body");
    } catch (reason) {
      setError(normalizeError(reason));
    } finally {
      setRequesting(false);
      setActiveRequestId(null);
    }
  }, [buildRequest, requesting]);

  const cancelRequest = useCallback(async () => {
    if (activeRequestId) await api.cancelRequest(activeRequestId);
  }, [activeRequestId]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void sendRequest();
      }
      if (event.key === "Escape" && activeRequestId) void cancelRequest();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, activeRequestId, cancelRequest, sendRequest]);

  const applyPreset = (preset: CloudPreset) => {
    setPresetId(preset.id);
    setForm(preset);
    setExpandedProviders((current) => new Set(current).add(preset.provider));
    setResponse(null);
    setSignature(null);
    setError(null);
  };

  const toggleProvider = (id: CloudProvider) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const update = <K extends keyof CloudPreset>(key: K, value: CloudPreset[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const copy = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(message);
  };

  return (
    <div className={`cloud-shell ${active ? "" : "workspace-pane-hidden"}`} aria-hidden={!active}>
      <aside className="cloud-sidebar" aria-label="云 API 导航">
        <header className="sidebar-header">
          <div className="brand-mark"><Network size={20} /></div>
          <div><h1>API Explorer</h1><span>Desktop 3.5</span></div>
        </header>
        <WorkspaceSwitch mode={workspaceMode} onChange={onWorkspaceChange} />

        <div className="search-field">
          <Search size={15} />
          <input
            value={catalogQuery}
            onChange={(event) => setCatalogQuery(event.target.value)}
            placeholder="筛选接口"
            aria-label="筛选云 API 模板"
          />
          {catalogQuery && (
            <button className="icon-button small" onClick={() => setCatalogQuery("")} aria-label="清除筛选">
              <X size={14} />
            </button>
          )}
        </div>
        <span className="field-label cloud-nav-label">按服务商 · {PRESETS.length} 个模板</span>
        <nav className="cloud-presets" aria-label="云服务商模板">
          {visibleGroups.length === 0 && (
            <div className="empty-tree">没有匹配的接口</div>
          )}
          {visibleGroups.map((group) => {
            const expanded = catalogQuery.trim().length > 0 || expandedProviders.has(group.provider);
            return (
              <section className="tree-group" key={group.provider}>
                <button
                  type="button"
                  className={`group-button ${form.provider === group.provider ? "active" : ""}`}
                  onClick={() => toggleProvider(group.provider)}
                  aria-expanded={expanded}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className={`cloud-provider-dot ${group.provider}`} />
                  <span>{group.meta.name}</span>
                  <small>{group.presets.length}</small>
                </button>
                {expanded && (
                  <div className="function-list">
                    {group.products.map((product) => (
                      <div key={product.product}>
                        <span className="cloud-product-label">{product.product}</span>
                        {product.presets.map((preset) => (
                          <button
                            type="button"
                            key={preset.id}
                            className={`function-button ${preset.id === presetId ? "active" : ""}`}
                            onClick={() => applyPreset(preset)}
                            title={preset.description}
                          >
                            <span className={`method method-${preset.method.toLowerCase()}`}>{preset.method}</span>
                            <span>{preset.label}</span>
                            {preset.risk === "write" && <small className="cloud-write-flag">写</small>}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </nav>

        <div className="cloud-security-note">
          <ShieldCheck size={16} />
          <div><strong>本机签名</strong><span>SK 只进入 Rust 内存，不落库、不回显。</span></div>
        </div>
      </aside>

      <main className="cloud-workspace">
        <header className="workspace-header cloud-workspace-header">
          <div className="breadcrumbs">
            <span>云服务商</span><span>/</span>
            <span>{provider.name}</span><span>/</span>
            <strong>{form.product} · {form.label}</strong>
          </div>
          <div className="header-actions"><span className="shortcut-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 发送</span><PreferenceControls /><span className="cloud-algorithm">{provider.algorithm}</span></div>
        </header>

        <div className="cloud-scroll">
          <section className="cloud-panel credentials-panel">
            <div className="cloud-panel-heading">
              <KeyRound size={16} />
              <div><strong>临时凭据</strong><span>仅当前窗口内存态；支持长期 AK/SK 与 STS 临时 Token</span></div>
              <button
                className="button secondary"
                onClick={() => { setAccessKeyId(""); setAccessKeySecret(""); setSecurityToken(""); }}
                disabled={!accessKeyId && !accessKeySecret && !securityToken}
              ><RotateCcw size={14} />清空</button>
            </div>
            <div className="cloud-fields credentials-fields">
              <label><span>AccessKey ID</span><input value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
              <label className="secret-field"><span>AccessKey Secret</span><div><input type={showSecret ? "text" : "password"} value={accessKeySecret} onChange={(event) => setAccessKeySecret(event.target.value)} autoComplete="new-password" spellCheck={false} /><button className="icon-button small" onClick={() => setShowSecret((current) => !current)} aria-label={showSecret ? "隐藏密钥" : "显示密钥"}>{showSecret ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></label>
              <label><span>Security Token（可选）</span><input type="password" value={securityToken} onChange={(event) => setSecurityToken(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            </div>
          </section>

          <section className="cloud-panel request-panel">
            <div className="cloud-panel-heading">
              <TerminalSquare size={16} />
              <div><strong>签名请求</strong><span>Endpoint 仅允许匹配厂商官方 HTTPS 域名</span></div>
              <div className="cloud-preset-select select-wrap">
                <select value={selectedPreset.id} onChange={(event) => applyPreset(findPreset(event.target.value))} aria-label="选择云 API 模板">
                  {providerGroups.map((group) => (
                    <optgroup key={group.provider} label={group.meta.name}>
                      {group.presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.product} · {preset.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select><ChevronDown size={14} />
              </div>
            </div>

            <div className="cloud-endpoint-line">
              <select value={form.method} onChange={(event) => update("method", event.target.value)} aria-label="请求方法"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
              <input value={form.endpoint} onChange={(event) => update("endpoint", event.target.value)} spellCheck={false} aria-label="Endpoint" />
              {requesting ? <button className="button danger" onClick={cancelRequest}><Ban size={15} />取消</button> : <button className="button primary" onClick={() => void sendRequest()}><Send size={15} />签名并发送</button>}
            </div>

            <div className="cloud-fields request-meta-fields">
              <label><span>Provider</span><select value={form.provider} onChange={(event) => update("provider", event.target.value as CloudProvider)}><option value="alibabaAcs3">阿里云 ACS3</option><option value="tencentTc3">腾讯云 TC3</option><option value="huaweiSdkHmac">华为云 SDK-HMAC</option><option value="volcengineHmac">火山引擎 HMAC</option><option value="baiduBceV1">百度智能云 BCE V1</option></select></label>
              <label><span>Service</span><input value={form.service} onChange={(event) => update("service", event.target.value)} spellCheck={false} disabled={!usesService} placeholder={usesService ? "服务代码" : "当前协议不使用"} /></label>
              <label><span>Action</span><input value={form.action} onChange={(event) => update("action", event.target.value)} spellCheck={false} disabled={!usesActionVersion} placeholder={usesActionVersion ? "接口操作" : "由 Endpoint path 表示"} /></label>
              <label><span>Version</span><input value={form.version} onChange={(event) => update("version", event.target.value)} spellCheck={false} disabled={!usesActionVersion} placeholder={usesActionVersion ? "API 版本" : "当前协议不使用"} /></label>
              <label><span>Region</span><input value={form.region} onChange={(event) => update("region", event.target.value)} spellCheck={false} disabled={!usesRegion} placeholder={usesRegion ? "地域代码" : "由 Endpoint 表示"} /></label>
            </div>

            <div className="cloud-editors">
              <label><span>Query <small>原始 key=value&amp;key2=value2</small></span><textarea value={form.query} onChange={(event) => update("query", event.target.value)} spellCheck={false} /></label>
              <label><span>Body <small>按原始字节参与 SHA-256</small></span><textarea value={form.body} onChange={(event) => update("body", event.target.value)} spellCheck={false} /></label>
            </div>

            <div className="cloud-options">
              <label className="wide-field"><span>Content-Type</span><input value={form.contentType} onChange={(event) => update("contentType", event.target.value)} spellCheck={false} /></label>
              <label className="switch-field"><input type="checkbox" checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} /><span className="switch" /><span>代理</span></label>
              <input className="proxy-input" value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} disabled={!proxyEnabled} aria-label="代理地址" />
              <label className="switch-field warning-option"><input type="checkbox" checked={allowInvalidCertificates} onChange={(event) => setAllowInvalidCertificates(event.target.checked)} /><span className="switch" /><span>允许无效证书</span></label>
              <button className="button secondary preview-button" onClick={() => void previewSignature()} disabled={requesting}><FileKey2 size={15} />只生成签名</button>
            </div>
          </section>

          {error && <div className={`error-banner cloud-error ${error.code === "cancelled" ? "neutral" : ""}`} role="alert"><AlertCircle size={17} /><div><strong>云 API 操作失败</strong><span>{error.message}</span></div><button className="icon-button small" onClick={() => setError(null)}><X size={14} /></button></div>}

          <section className="cloud-panel cloud-result-panel">
            <div className="tabs-toolbar">
              <div className="tabs" role="tablist">
                <button className={resultTab === "body" ? "active" : ""} onClick={() => setResultTab("body")}><Code2 size={15} />结果</button>
                <button className={resultTab === "headers" ? "active" : ""} onClick={() => setResultTab("headers")}><SlidersHorizontal size={15} />响应头 {response && <small>{response.headers.length}</small>}</button>
                <button className={resultTab === "signature" ? "active" : ""} onClick={() => setResultTab("signature")}><LockKeyhole size={15} />签名诊断</button>
              </div>
              {response && <div className="response-meta"><span className={`status-pill ${statusTone(response.status)}`}>{response.status} {response.statusText}</span><span><Clock3 size={13} />{response.elapsedMs} ms</span></div>}
            </div>
            <div className="cloud-result-content">
              {requesting ? <div className="response-empty"><LoaderCircle className="spin" size={24} /><strong>正在等待云服务响应</strong><span>按 Esc 可取消</span></div>
                : resultTab === "signature" ? signature ? <div className="signature-diagnostics">
                  <div className="signature-summary"><span>{signature.algorithm}</span><span>{signature.timestamp}</span><span>{signature.signedHeaders}</span>{signature.redacted && <i>已脱敏</i>}</div>
                  {[["Canonical Request", signature.canonicalRequest], ["String to Sign", signature.stringToSign], ["Authorization", signature.authorization]].map(([label, value]) => <section key={label}><header><strong>{label}</strong><button className="icon-button small" onClick={() => void copy(value, `${label} 已复制`)}><Copy size={14} /></button></header><pre><code>{value}</code></pre></section>)}
                </div> : <div className="response-empty"><FileKey2 size={24} /><strong>还没有签名诊断</strong><span>点击“只生成签名”不会发送网络请求</span></div>
                : resultTab === "headers" ? response ? <div className="headers-table">{response.headers.map((header, index) => <div className="header-row" key={`${header.name}-${index}`}><span>{header.name}</span><code>{header.value}</code></div>)}</div> : <div className="response-empty"><Network size={24} /><strong>还没有响应头</strong></div>
                : response ? <CloudResultView body={response.body} kind={form.resultKind} onCopy={copy} />
                : <div className="response-empty"><Play size={24} /><strong>准备就绪</strong><span>先用“只生成签名”检查结果，再发送真实请求</span></div>}
            </div>
          </section>
        </div>

        <footer className="status-bar"><span className="connected"><i />Rust Cloud Signer 就绪</span><span>{provider.name}官方域名 · {provider.domain}</span><span className="status-path"><ShieldCheck size={12} />凭据不持久化</span></footer>
      </main>
      {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    </div>
  );
}
