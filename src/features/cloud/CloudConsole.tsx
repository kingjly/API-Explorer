import {
  AlertCircle,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Activity,
  Clock3,
  Code2,
  Copy,
  FileKey2,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Network,
  Play,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CredentialBar } from "../../components/CredentialBar";
import { PreferenceControls } from "../../components/PreferenceControls";
import { WorkspaceSwitch, type WorkspaceMode } from "../../components/WorkspaceSwitch";
import { api, normalizeError } from "../../lib/ipc";
import { explainCloudFailure } from "../../lib/explainCloudFailure";
import { describeCredentialMode, expirationStatus, useSessionCredentials } from "../../lib/sessionCredentials";
import { extractEzvizToken } from "./parseCloudResult";
import { patchWorkspaceMemory, readWorkspaceMemory } from "../../lib/workspaceMemory";
import type {
  CloudProvider,
  CloudRequest,
  CloudResponse,
  CloudSignaturePreview,
  CommandError,
} from "../../types";
import { AccessProbeView } from "./AccessProbeView";
import {
  createProbe,
  FATAL_PROBE_KINDS,
  markRemainingSkipped,
  probeFromCommandError,
  probeFromResponse,
  type AccessProbe,
} from "./accessProbe";
import { CloudResultView } from "./CloudResultView";
import { applyRegionToPreset, enumerationPresets, findPreset, groupPresetsByProvider, PRESETS, PROVIDERS, presetMatchesQuery, REGION_OPTIONS, replaceQueryValue, type CloudPreset } from "./presets";

type ResultTab = "body" | "headers" | "signature" | "history" | "access";

interface CloudHistoryEntry {
  id: string;
  label: string;
  method: string;
  timestamp: Date;
  response?: CloudResponse;
  error?: CommandError;
}

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
  const [presetId, setPresetId] = useState(() => findPreset(readWorkspaceMemory().cloudPresetId).id);
  const [form, setForm] = useState<CloudPreset>(() => {
    const remembered = readWorkspaceMemory();
    const preset = findPreset(remembered.cloudPresetId);
    if (remembered.cloudPresetId !== preset.id) return preset;
    return {
      ...preset,
      endpoint: remembered.cloudEndpoint || preset.endpoint,
      region: remembered.cloudRegion || preset.region,
      query: remembered.cloudQuery || preset.query,
    };
  });
  const [expandedProviders, setExpandedProviders] = useState<Set<CloudProvider>>(
    () => new Set([findPreset(readWorkspaceMemory().cloudPresetId).provider]),
  );
  const [history, setHistory] = useState<CloudHistoryEntry[]>([]);
  const { credentials, setCredentials } = useSessionCredentials();
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
  const [requestOpen, setRequestOpen] = useState(false);
  const [probes, setProbes] = useState<AccessProbe[]>([]);
  const [probing, setProbing] = useState(false);
  const probeAbort = useRef(false);

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
  const queryRegion = form.query.match(/(?:^|&)RegionId=([^&]*)/)?.[1] ?? "";
  const regionValue = form.region || queryRegion;
  const showRegion = Boolean(REGION_OPTIONS[form.provider]?.length) || usesRegion || Boolean(queryRegion);
  const regionChoices = Array.from(new Set([...(REGION_OPTIONS[form.provider] ?? []), regionValue].filter(Boolean)));
  const isEzviz = form.provider === "ezvizLapp";
  const isTianditu = form.provider === "tiandituTk";
  const isQiniu = form.provider === "qiniuMac";
  const canSign = Boolean(credentials.accessKeyId.trim() && (isTianditu || credentials.accessKeySecret.trim()));
  const probeById = useMemo(() => new Map(probes.map((item) => [item.id, item])), [probes]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const signedFields = useCallback(() => ({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      securityToken: credentials.securityToken,
    },
    proxyUrl: proxyEnabled ? proxyUrl : undefined,
    allowInvalidCertificates,
  }), [allowInvalidCertificates, credentials, proxyEnabled, proxyUrl]);

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
    ...signedFields(),
  }), [form, signedFields]);

  const buildPresetRequest = useCallback((preset: CloudPreset, requestId = crypto.randomUUID()): CloudRequest => ({
    requestId,
    provider: preset.provider,
    method: preset.method,
    endpoint: preset.endpoint,
    service: preset.service,
    action: preset.action,
    version: preset.version,
    region: preset.region,
    query: preset.query,
    body: preset.body,
    contentType: preset.contentType,
    ...signedFields(),
  }), [signedFields]);

  useEffect(() => {
    setProbes([]);
  }, [credentials.accessKeyId]);

  const applyRegion = (region: string) => {
    setForm((current) => {
      const next = {
        ...current,
        region,
        query: /(?:^|&)RegionId=/.test(current.query) ? replaceQueryValue(current.query, "RegionId", region) : current.query,
      };
      patchWorkspaceMemory({ cloudRegion: next.region, cloudQuery: next.query });
      return next;
    });
  };

  const rememberEzvizToken = (body: string) => {
    const extracted = extractEzvizToken(body);
    if (!extracted) return "";
    setCredentials({ securityToken: extracted.accessToken, expiration: extracted.expiration });
    return extracted.accessToken;
  };

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
    if (requesting || !canSign) return;
    if (expirationStatus(credentials.expiration).kind === "expired") {
      if (isEzviz) setCredentials({ securityToken: "", expiration: "" });
      else {
        setError({ code: "expired", message: "临时凭据已过期，请重新粘贴 STS JSON。" });
        return;
      }
    }
    const requestId = crypto.randomUUID();
    setRequesting(true);
    setActiveRequestId(requestId);
    setError(null);
    try {
      let token = isEzviz && expirationStatus(credentials.expiration).kind === "expired" ? "" : credentials.securityToken;
      if (isEzviz && !token.trim() && form.id !== "ezviz-token-get") {
        const tokenRequestId = crypto.randomUUID();
        setActiveRequestId(tokenRequestId);
        const tokenResult = await api.executeCloudRequest(buildPresetRequest(findPreset("ezviz-token-get"), tokenRequestId));
        token = rememberEzvizToken(tokenResult.body);
        if (!token) throw { code: "missing_cloud_field", message: "萤石 Token 接口没有返回 accessToken" };
      }
      setActiveRequestId(requestId);
      const result = await api.executeCloudRequest({
        ...buildRequest(requestId),
        credentials: {
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.accessKeySecret,
          securityToken: token,
        },
      });
      rememberEzvizToken(result.body);
      setResponse(result);
      setSignature(result.signature);
      setResultTab("body");
      setHistory((current) => [{
        id: requestId,
        label: `${form.product} · ${form.label}`,
        method: form.method,
        timestamp: new Date(),
        response: result,
      }, ...current].slice(0, 20));
    } catch (reason) {
      const commandError = normalizeError(reason);
      setError(commandError);
      setHistory((current) => [{
        id: requestId,
        label: `${form.product} · ${form.label}`,
        method: form.method,
        timestamp: new Date(),
        error: commandError,
      }, ...current].slice(0, 20));
    } finally {
      setRequesting(false);
      setActiveRequestId(null);
    }
  }, [buildPresetRequest, buildRequest, canSign, credentials, form.id, form.label, form.method, form.product, isEzviz, rememberEzvizToken, requesting, setCredentials]);

  const cancelRequest = useCallback(async () => {
    probeAbort.current = true;
    if (activeRequestId) await api.cancelRequest(activeRequestId);
  }, [activeRequestId]);

  const enumerateAccess = useCallback(async () => {
    if (requesting || probing || !canSign) return;
    if (expirationStatus(credentials.expiration).kind === "expired") {
      if (isEzviz) setCredentials({ securityToken: "", expiration: "" });
      else {
        setError({ code: "expired", message: "临时凭据已过期，请重新粘贴 STS JSON。" });
        return;
      }
    }
    const targets = enumerationPresets(form.provider);
    probeAbort.current = false;
    setProbing(true);
    setRequesting(true);
    setError(null);
    setResultTab("access");
    setProbes(targets.map(createProbe));

    let sessionToken = isEzviz && expirationStatus(credentials.expiration).kind === "expired" ? "" : credentials.securityToken;
    let stopReason = "";
    for (const preset of targets) {
      if (probeAbort.current) {
        stopReason = "已取消，其余未测";
        break;
      }
      if (createProbe(preset).status === "skipped") continue;
      const requestId = crypto.randomUUID();
      const adapted = applyRegionToPreset(preset, regionValue);
      setActiveRequestId(requestId);
      setProbes((current) => current.map((item) => (
        item.id === preset.id ? { ...item, status: "running", detail: "探测中" } : item
      )));
      try {
        const result = await api.executeCloudRequest({
          ...buildPresetRequest(adapted, requestId),
          credentials: {
            accessKeyId: credentials.accessKeyId,
            accessKeySecret: credentials.accessKeySecret,
            securityToken: sessionToken,
          },
        });
        sessionToken = rememberEzvizToken(result.body) || sessionToken;
        const next = probeFromResponse(preset, result);
        setProbes((current) => current.map((item) => (item.id === preset.id ? next : item)));
        const fatal = next.status === "invalid" || next.status === "expired";
        if (fatal) {
          stopReason = next.detail || "密钥不可用，停止探测";
          break;
        }
      } catch (reason) {
        const commandError = normalizeError(reason);
        const next = probeFromCommandError(preset, commandError);
        setProbes((current) => current.map((item) => (item.id === preset.id ? next : item)));
        if (commandError.code === "cancelled" || FATAL_PROBE_KINDS.has(explainCloudFailure(commandError).kind)) {
          stopReason = commandError.code === "cancelled" ? "已取消，其余未测" : next.detail || "密钥不可用，停止探测";
          break;
        }
      }
    }

    if (stopReason) setProbes((current) => markRemainingSkipped(current, stopReason));
    setActiveRequestId(null);
    setRequesting(false);
    setProbing(false);
    setNotice(stopReason && !stopReason.startsWith("已取消") ? stopReason : "只读权限探测完成");
  }, [buildPresetRequest, canSign, credentials, form.provider, isEzviz, probing, regionValue, rememberEzvizToken, requesting, setCredentials]);

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
    const next = applyRegionToPreset(preset, preset.provider === form.provider ? regionValue : "");
    setPresetId(next.id);
    setForm(next);
    setExpandedProviders((current) => new Set(current).add(next.provider));
    setResponse(null);
    setSignature(null);
    setError(null);
    patchWorkspaceMemory({
      cloudPresetId: next.id,
      cloudEndpoint: next.endpoint,
      cloudRegion: next.region,
      cloudQuery: next.query,
    });
  };

  const toggleProvider = (id: CloudProvider) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const update = <K extends keyof CloudPreset>(key: K, value: CloudPreset[K]) => {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "endpoint" || key === "region" || key === "query") {
        patchWorkspaceMemory({
          cloudEndpoint: next.endpoint,
          cloudRegion: next.region,
          cloudQuery: next.query,
        });
      }
      return next;
    });
  };

  const copy = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(message);
  };

  const useQiniuResultValue = (column: string, value: string) => {
    const nextValue = value.trim();
    if (!nextValue) return;
    if (column === "name" && (form.resultKind === "bucketNameList" || form.resultKind === "bucketInfo")) {
      const key = /(?:^|&)tbl=/.test(form.query) && !/(?:^|&)bucket=/.test(form.query) ? "tbl" : "bucket";
      let next = replaceQueryValue(form.query, key, nextValue);
      if (/(?:^|&)tbl=/.test(form.query) && key === "bucket") next = replaceQueryValue(next, "tbl", nextValue);
      update("query", next);
      void copy(nextValue, `已填入 ${key}=${nextValue}`);
      return;
    }
    if (column === "name" && form.resultKind === "objectList") {
      update("query", replaceQueryValue(form.query, "key", nextValue));
      void copy(nextValue, `已填入 key=${nextValue}`);
      return;
    }
    if (column === "region") {
      void copy(nextValue, `机房 ${nextValue}，对象存储的机房填这个`);
      return;
    }
    void copy(nextValue, `${column} 已复制`);
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
                            className={`function-button ${preset.id === presetId ? "active" : ""} ${probeById.get(preset.id) ? `access-nav-${probeById.get(preset.id)?.status}` : ""}`}
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
          <div className="header-actions">
            {showRegion && (
              <label className="header-region">
                <span>地域</span>
                <select value={regionValue} onChange={(event) => applyRegion(event.target.value)} aria-label="地域">
                  {!regionValue && <option value="">选择地域</option>}
                  {regionChoices.map((region) => <option key={region} value={region}>{region}</option>)}
                </select>
              </label>
            )}
            <span className="shortcut-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 查询</span>
            <PreferenceControls />
            <span className="cloud-algorithm">{provider.algorithm}</span>
          </div>
        </header>

        <div className="cloud-scroll">
          <CredentialBar
            title="访问凭据"
            hint={isTianditu ? "天地图只要服务端 tk，会自动加到 Query。控制台需配出口 IP 白名单。" : isQiniu ? "七牛 AccessKey / SecretKey，本机算 Qiniu MAC。先列举空间，再单击名称填入 bucket。" : isEzviz ? "萤石用开放平台 AppKey / AppSecret。查询设备前会自动换 AccessToken。" : "云 API 与对象存储共用当前会话；可粘贴 AssumeRole JSON。SK 不落盘。"}
            idLabel={isTianditu ? "tk" : isEzviz ? "AppKey" : "AccessKey ID"}
            keyLabel={isTianditu ? "Secret（天地图不用）" : isEzviz ? "AppSecret" : "AccessKey Secret"}
            tokenLabel={isEzviz ? "AccessToken" : "STS Security Token"}
            secretOptional={isTianditu}
            onNotice={setNotice}
          />

          <section className={`cloud-panel request-panel ${requestOpen ? "" : "collapsed"}`}>
            <div className="cloud-panel-heading">
              <TerminalSquare size={16} />
              <div>
                <strong>查询</strong>
                <span>左侧选接口，改 Query / Endpoint 时再展开</span>
              </div>
              <button className="button secondary" onClick={() => setRequestOpen((current) => !current)}>
                {requestOpen ? "收起参数" : "请求参数"}
              </button>
            </div>

            <div className="cloud-endpoint-line">
              <select value={form.method} onChange={(event) => update("method", event.target.value)} aria-label="请求方法"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
              <input value={form.endpoint} onChange={(event) => update("endpoint", event.target.value)} spellCheck={false} aria-label="Endpoint" />
              <div className="cloud-send-actions">
                {requesting ? (
                  <button className="button danger" onClick={cancelRequest}><Ban size={15} />取消</button>
                ) : (
                  <>
                    <button
                      className="button secondary"
                      onClick={() => void enumerateAccess()}
                      disabled={!canSign}
                      title={canSign ? "探测当前厂商只读模板，不是完整 IAM" : "先填写 AccessKey ID 和 Secret"}
                    >
                      <ListChecks size={15} />探测权限
                    </button>
                    <button
                      className="button primary"
                      onClick={() => void sendRequest()}
                      disabled={!canSign}
                      title={!canSign ? "先填写 AccessKey ID 和 Secret" : undefined}
                    >
                      <Send size={15} />查询
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="cloud-fields request-meta-fields">
              <label><span>Provider</span><select value={form.provider} onChange={(event) => update("provider", event.target.value as CloudProvider)}><option value="alibabaAcs3">阿里云 ACS3</option><option value="tencentTc3">腾讯云 TC3</option><option value="huaweiSdkHmac">华为云 SDK-HMAC</option><option value="volcengineHmac">火山引擎 HMAC</option><option value="baiduBceV1">百度智能云 BCE V1</option><option value="ezvizLapp">萤石云 LAPP</option><option value="tiandituTk">天地图 tk</option><option value="qiniuMac">七牛云 MAC</option></select></label>
              <label><span>Service</span><input value={form.service} onChange={(event) => update("service", event.target.value)} spellCheck={false} disabled={!usesService} placeholder={usesService ? "服务代码" : "当前协议不使用"} /></label>
              <label><span>Action</span><input value={form.action} onChange={(event) => update("action", event.target.value)} spellCheck={false} disabled={!usesActionVersion} placeholder={usesActionVersion ? "接口操作" : "由 Endpoint path 表示"} /></label>
              <label><span>Version</span><input value={form.version} onChange={(event) => update("version", event.target.value)} spellCheck={false} disabled={!usesActionVersion} placeholder={usesActionVersion ? "API 版本" : "当前协议不使用"} /></label>
              <label><span>Region</span><input value={regionValue} onChange={(event) => applyRegion(event.target.value)} spellCheck={false} disabled={!showRegion} placeholder={showRegion ? "地域代码" : "由 Endpoint 表示"} /></label>
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

          {error && (() => {
            const failure = explainCloudFailure(error);
            return (
              <div className={`error-banner cloud-error ${failure.kind === "cancelled" ? "neutral" : ""}`} role="alert">
                <AlertCircle size={17} />
                <div>
                  <strong>{failure.title}</strong>
                  <span>{failure.hint}</span>
                </div>
                <button className="icon-button small" onClick={() => setError(null)}><X size={14} /></button>
              </div>
            );
          })()}

          <section className="cloud-panel cloud-result-panel">
            <div className="tabs-toolbar">
              <div className="tabs" role="tablist">
                <button className={resultTab === "body" ? "active" : ""} onClick={() => setResultTab("body")}><Code2 size={15} />结果</button>
                <button className={resultTab === "access" ? "active" : ""} onClick={() => setResultTab("access")}><ListChecks size={15} />权限 {probes.length ? <small>{probes.filter((item) => item.status === "ok" || item.status === "empty").length}/{probes.length}</small> : null}</button>
                <button className={resultTab === "headers" ? "active" : ""} onClick={() => setResultTab("headers")}><SlidersHorizontal size={15} />响应头 {response && <small>{response.headers.length}</small>}</button>
                <button className={resultTab === "signature" ? "active" : ""} onClick={() => setResultTab("signature")}><LockKeyhole size={15} />签名诊断</button>
                <button className={resultTab === "history" ? "active" : ""} onClick={() => setResultTab("history")}><Activity size={15} />历史 {history.length ? <small>{history.length}</small> : null}</button>
              </div>
              {response && resultTab !== "history" && <div className="response-meta"><span className={`status-pill ${statusTone(response.status)}`}>{response.status} {response.statusText}</span><span><Clock3 size={13} />{response.elapsedMs} ms</span></div>}
            </div>
            <div className="cloud-result-content">
              {resultTab === "access" ? <AccessProbeView probes={probes} probing={probing} onOpen={(id) => applyPreset(findPreset(id))} />
                : requesting ? <div className="response-empty"><LoaderCircle className="spin" size={24} /><strong>正在等待云服务响应</strong><span>按 Esc 可取消</span></div>
                : resultTab === "history" ? history.length ? <div className="history-list">
                  {history.map((entry) => (
                    <button
                      key={entry.id}
                      className="history-row"
                      onClick={() => {
                        if (entry.response) {
                          setResponse(entry.response);
                          setSignature(entry.response.signature);
                          setError(null);
                          setResultTab("body");
                        }
                      }}
                      disabled={!entry.response}
                    >
                      <span className={`method method-${entry.method.toLowerCase()}`}>{entry.method}</span>
                      <strong>{entry.label}</strong>
                      <time>{entry.timestamp.toLocaleTimeString()}</time>
                      {entry.response ? (
                        <span className={`status-text ${statusTone(entry.response.status)}`}>{entry.response.status}</span>
                      ) : (
                        <span className="status-text error">失败</span>
                      )}
                      <span className="history-duration">{entry.response ? `${entry.response.elapsedMs} ms` : entry.error?.message}</span>
                    </button>
                  ))}
                  <button className="clear-history" onClick={() => setHistory([])}><Trash2 size={14} />清空历史</button>
                </div> : <div className="response-empty"><Activity size={24} /><strong>还没有请求记录</strong><span>发送后可在这里对照本次会话的结果</span></div>
                : resultTab === "signature" ? signature ? <div className="signature-diagnostics">
                  <div className="signature-summary"><span>{signature.algorithm}</span><span>{signature.timestamp}</span><span>{signature.signedHeaders}</span>{signature.redacted && <i>已脱敏</i>}</div>
                  {[["Canonical Request", signature.canonicalRequest], ["String to Sign", signature.stringToSign], ["Authorization", signature.authorization]].map(([label, value]) => <section key={label}><header><strong>{label}</strong><button className="icon-button small" onClick={() => void copy(value, `${label} 已复制`)}><Copy size={14} /></button></header><pre><code>{value}</code></pre></section>)}
                </div> : <div className="response-empty"><FileKey2 size={24} /><strong>还没有签名诊断</strong><span>点击“只生成签名”不会发送网络请求</span></div>
                : resultTab === "headers" ? response ? <div className="headers-table">{response.headers.map((header, index) => <div className="header-row" key={`${header.name}-${index}`}><span>{header.name}</span><code>{header.value}</code></div>)}</div> : <div className="response-empty"><Network size={24} /><strong>还没有响应头</strong></div>
                : response ? <CloudResultView body={response.body} kind={form.resultKind} requestUrl={response.url} httpStatus={response.status} onCopy={copy} onUseValue={isQiniu ? useQiniuResultValue : undefined} />
                : <div className="response-empty"><Play size={24} /><strong>{canSign ? "还没有结果" : "先填入凭据"}</strong><span>{canSign ? "点探测权限看这把钥匙能查哪些只读接口，或直接查询。" : "粘贴 AK/SK 或 STS JSON 后点查询。"}</span></div>}
            </div>
          </section>
        </div>

        <footer className="status-bar">
          <span className="connected"><i />Rust Cloud Signer 就绪</span>
          <span>{provider.name}官方域名 · {provider.domain}</span>
          <span className="status-path">
            <ShieldCheck size={12} />
            {describeCredentialMode(credentials) === "sts" ? "STS 会话凭据 · 不落盘" : "凭据仅内存 · 不落盘"}
          </span>
        </footer>
      </main>
      {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    </div>
  );
}
