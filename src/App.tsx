import {
  Activity,
  AlertCircle,
  AppWindow,
  Ban,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Database,
  FileText,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  Play,
  RotateCcw,
  Save,
  Search,
  Send,
  Server,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, normalizeError } from "./lib/ipc";
import { patchWorkspaceMemory, readWorkspaceMemory } from "./lib/workspaceMemory";
import { PreferenceControls } from "./components/PreferenceControls";
import { WorkspaceSwitch, type WorkspaceMode } from "./components/WorkspaceSwitch";
import { CloudConsole } from "./features/cloud/CloudConsole";
import { StorageConsole } from "./features/storage/StorageConsole";
import type {
  ApiApplication,
  ApiGroup,
  ApiResponse,
  Catalog,
  CommandError,
  FunctionDetails,
  FunctionSummary,
  HistoryEntry,
  IdentityInput,
  ParameterEntry,
  SpecStatus,
} from "./types";

type InspectorTab = "parameters" | "docs";
type ResponseTab = "body" | "headers" | "history";

const EMPTY_IDENTITY: IdentityInput = { id: "", key: "", token: "" };

function statusTone(status: number) {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect";
  return "error";
}

function formatBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function methodTone(method: string) {
  return `method method-${method.toLowerCase()}`;
}

function specLabel(status: SpecStatus) {
  return {
    active: "有效",
    legacy: "旧版有效",
    deprecated: "已弃用",
    removed: "已下线",
    unverified: "待厂商确认",
    "test-only": "测试项",
  }[status] ?? status;
}

function isUnavailable(status?: SpecStatus) {
  return status === "removed" || status === "test-only";
}

function compactUrl(baseUrl: string, configuredUrl: string) {
  if (!configuredUrl) return "尚未选择接口";
  if (!baseUrl) return configuredUrl;
  try {
    const source = new URL(configuredUrl, `${baseUrl.replace(/\/$/, "")}/`);
    return source.toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}/${configuredUrl.replace(/^\//, "")}`;
  }
}

export default function App() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => readWorkspaceMemory().mode);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [selectedFunctionId, setSelectedFunctionId] = useState<number | null>(null);
  const [details, setDetails] = useState<FunctionDetails | null>(null);
  const [parameters, setParameters] = useState<ParameterEntry[]>([]);
  const [identity, setIdentity] = useState<IdentityInput>(EMPTY_IDENTITY);
  const [baseUrl, setBaseUrl] = useState("");
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("http://127.0.0.1:8080");
  const [allowInvalidCertificates, setAllowInvalidCertificates] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("parameters");
  const [responseTab, setResponseTab] = useState<ResponseTab>("body");
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const changeWorkspace = useCallback((mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    patchWorkspaceMemory({ mode });
  }, []);

  const selectedApp = useMemo(
    () => catalog?.applications.find((application) => application.id === selectedAppId) ?? null,
    [catalog, selectedAppId],
  );
  const selectedGroup = useMemo(
    () => selectedApp?.groups.find((group) => group.id === selectedGroupId) ?? null,
    [selectedApp, selectedGroupId],
  );
  const selectedFunction = useMemo(
    () => selectedGroup?.functions.find((item) => item.id === selectedFunctionId) ?? null,
    [selectedGroup, selectedFunctionId],
  );
  const hasParameterChanges = useMemo(
    () => JSON.stringify(parameters) !== JSON.stringify(details?.parameters ?? []),
    [parameters, details],
  );

  const chooseApplication = useCallback((application: ApiApplication) => {
    const group = application.groups[0] ?? null;
    const apiFunction = group?.functions[0] ?? null;
    setSelectedAppId(application.id);
    setSelectedGroupId(group?.id ?? null);
    setSelectedFunctionId(apiFunction?.id ?? null);
    setExpandedGroups(new Set(group ? [group.id] : []));
    setBaseUrl(application.baseUrl);
    setResponse(null);
    setError(null);
    patchWorkspaceMemory({
      catalogAppId: application.id,
      catalogGroupId: group?.id ?? null,
      catalogFunctionId: apiFunction?.id ?? null,
    });
  }, []);

  const chooseGroup = useCallback((group: ApiGroup) => {
    setSelectedGroupId(group.id);
    setSelectedFunctionId(group.functions[0]?.id ?? null);
    setExpandedGroups((current) => new Set(current).add(group.id));
    setResponse(null);
    setError(null);
    patchWorkspaceMemory({
      catalogGroupId: group.id,
      catalogFunctionId: group.functions[0]?.id ?? null,
    });
  }, []);

  const chooseFunction = useCallback((group: ApiGroup, apiFunction: FunctionSummary) => {
    setSelectedGroupId(group.id);
    setSelectedFunctionId(apiFunction.id);
    setExpandedGroups((current) => new Set(current).add(group.id));
    setResponse(null);
    setError(null);
    patchWorkspaceMemory({ catalogGroupId: group.id, catalogFunctionId: apiFunction.id });
  }, []);

  useEffect(() => {
    let active = true;
    api
      .loadCatalog()
      .then((loaded) => {
        if (!active) return;
        setCatalog(loaded);
        const remembered = readWorkspaceMemory();
        const application = loaded.applications.find((item) => item.id === remembered.catalogAppId) ?? loaded.applications[0];
        if (!application) return;
        const group = application.groups.find((item) => item.id === remembered.catalogGroupId) ?? application.groups[0] ?? null;
        const apiFunction = group?.functions.find((item) => item.id === remembered.catalogFunctionId) ?? group?.functions[0] ?? null;
        setSelectedAppId(application.id);
        setSelectedGroupId(group?.id ?? null);
        setSelectedFunctionId(apiFunction?.id ?? null);
        setExpandedGroups(new Set(group ? [group.id] : []));
        setBaseUrl(application.baseUrl);
      })
      .catch((reason) => active && setError(normalizeError(reason)))
      .finally(() => active && setCatalogLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (selectedFunctionId === null) {
      setDetails(null);
      setParameters([]);
      return;
    }
    let active = true;
    setDetailsLoading(true);
    api
      .getFunction(selectedFunctionId)
      .then((loaded) => {
        if (!active) return;
        setDetails(loaded);
        setParameters(loaded.parameters);
      })
      .catch((reason) => active && setError(normalizeError(reason)))
      .finally(() => active && setDetailsLoading(false));
    return () => {
      active = false;
    };
  }, [selectedFunctionId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const visibleGroups = useMemo(() => {
    if (!selectedApp) return [];
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return selectedApp.groups;
    return selectedApp.groups
      .map((group) => ({
        ...group,
        functions: group.functions.filter((apiFunction) =>
          `${apiFunction.name} ${apiFunction.method} ${group.name}`
            .toLocaleLowerCase()
            .includes(normalized),
        ),
      }))
      .filter((group) => group.functions.length > 0);
  }, [selectedApp, query]);

  const runRequest = useCallback(
    async (functionId = selectedFunctionId, acquireToken = false) => {
      if (functionId === null || requesting) return;
      const targetFunction = selectedApp?.groups
        .flatMap((group) => group.functions)
        .find((item) => item.id === functionId);
      const targetStatus = targetFunction?.specStatus
        ?? (details?.id === functionId ? details.specStatus : undefined);
      if (isUnavailable(targetStatus)) {
        setError({
          code: "spec_unavailable",
          message: "该接口已下线或仅用于本地测试，不能发送网络请求",
        });
        return;
      }
      const functionName = targetFunction?.name
        ?? (acquireToken ? "获取 Token" : selectedFunction?.name ?? details?.name ?? "接口请求");
      const method = targetFunction?.method ?? details?.method ?? "GET";
      const requestId = crypto.randomUUID();
      setRequesting(true);
      setActiveRequestId(requestId);
      setError(null);
      try {
        const result = await api.executeRequest({
          requestId,
          functionId,
          identity,
          baseUrl,
          proxyUrl: proxyEnabled ? proxyUrl : undefined,
          allowInvalidCertificates,
          acquireToken,
        });
        setResponse(result);
        setResponseTab("body");
        setHistory((current) => [
          {
            id: requestId,
            functionId,
            functionName,
            method,
            timestamp: new Date(),
            response: result,
          },
          ...current,
        ].slice(0, 30));
        if (acquireToken) {
          if (result.token) {
            setIdentity((current) => ({ ...current, token: result.token ?? "" }));
            setNotice("Token 已提取并填入认证栏");
          } else {
            setError({ code: "token_not_found", message: "请求成功，但响应中没有匹配到 Token" });
          }
        }
      } catch (reason) {
        const normalized = normalizeError(reason);
        setError(normalized);
        setHistory((current) => [
          {
            id: requestId,
            functionId,
            functionName,
            method,
            timestamp: new Date(),
            error: normalized,
          },
          ...current,
        ].slice(0, 30));
      } finally {
        setRequesting(false);
        setActiveRequestId(null);
      }
    }, [
      allowInvalidCertificates,
      baseUrl,
      details,
      identity,
      proxyEnabled,
      proxyUrl,
      requesting,
      selectedApp,
      selectedFunction,
      selectedFunctionId,
    ],
  );

  const acquireToken = useCallback(() => {
    if (!selectedApp) return;
    const currentGroupToken = selectedGroup?.functions.find((item) => item.isToken);
    const tokenFunction = currentGroupToken
      ?? selectedApp.groups.flatMap((group) => group.functions).find((item) => item.isToken);
    if (!tokenFunction) {
      setError({ code: "token_endpoint_missing", message: "当前应用没有配置 Token 接口" });
      return;
    }
    void runRequest(tokenFunction.id, true);
  }, [runRequest, selectedApp, selectedGroup]);

  const cancelActiveRequest = useCallback(async () => {
    if (activeRequestId) await api.cancelRequest(activeRequestId);
  }, [activeRequestId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (workspaceMode !== "catalog") return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void runRequest();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && activeRequestId) {
        void cancelActiveRequest();
      }
      if (event.key === "F6") {
        event.preventDefault();
        const panes = Array.from(document.querySelectorAll<HTMLElement>("[data-pane]"));
        const index = panes.indexOf(document.activeElement as HTMLElement);
        panes[(index + 1) % panes.length]?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeRequestId, cancelActiveRequest, runRequest, workspaceMode]);

  const saveParameters = async () => {
    if (!details || !hasParameterChanges) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveParameters(details.id, parameters);
      setDetails(saved);
      setParameters(saved.parameters);
      setNotice("接口参数已保存");
    } catch (reason) {
      setError(normalizeError(reason));
    } finally {
      setSaving(false);
    }
  };

  const encodeToken = async () => {
    if (!identity.token) return;
    try {
      const token = await api.base64Encode(identity.token);
      setIdentity((current) => ({ ...current, token }));
      setNotice("Access Token 已进行 Base64 编码");
    } catch (reason) {
      setError(normalizeError(reason));
    }
  };

  const copyResponse = async () => {
    if (!response) return;
    await navigator.clipboard.writeText(formatBody(response.body));
    setNotice("响应内容已复制");
  };

  const updateParameter = (index: number, value: string) => {
    setParameters((current) =>
      current.map((parameter, parameterIndex) =>
        parameterIndex === index ? { ...parameter, value } : parameter,
      ),
    );
  };

  if (catalogLoading) {
    return (
      <main className="boot-screen">
        <div className="brand-mark"><Network size={24} /></div>
        <LoaderCircle className="spin" size={20} />
        <p>正在载入 API 数据库…</p>
      </main>
    );
  }

  if (!catalog || catalog.applications.length === 0) {
    return (
      <main className="boot-screen error-screen">
        <AlertCircle size={28} />
        <h1>无法打开 API 数据库</h1>
        <p>{error?.message ?? "数据库中没有可用的应用配置。"}</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          <RotateCcw size={16} />重新载入
        </button>
      </main>
    );
  }

  return (
    <>
    <div className={`app-shell ${workspaceMode === "catalog" ? "" : "workspace-pane-hidden"}`} aria-hidden={workspaceMode !== "catalog"}>
      <aside className="sidebar" data-pane tabIndex={-1} aria-label="API 导航">
        <header className="sidebar-header">
          <div className="brand-mark"><Network size={20} /></div>
          <div>
            <h1>API Explorer</h1>
            <span>Desktop 3.5</span>
          </div>
        </header>

        <WorkspaceSwitch mode={workspaceMode} onChange={changeWorkspace} />

        <div className="search-field">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索接口  Ctrl K"
            aria-label="搜索接口"
          />
          {query && (
            <button className="icon-button small" onClick={() => setQuery("")} aria-label="清除搜索">
              <X size={14} />
            </button>
          )}
        </div>

        <label className="field-label sidebar-label" htmlFor="application-select">应用</label>
        <div className="select-wrap sidebar-select">
          <AppWindow size={15} />
          <select
            id="application-select"
            value={selectedAppId ?? ""}
            onChange={(event) => {
              const application = catalog.applications.find((item) => item.id === Number(event.target.value));
              if (application) chooseApplication(application);
            }}
          >
            {catalog.applications.map((application) => (
              <option key={application.id} value={application.id}>{application.name}</option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>

        <nav className="api-tree" aria-label="接口列表">
          {visibleGroups.map((group) => {
            const expanded = query.length > 0 || expandedGroups.has(group.id);
            return (
              <section className="tree-group" key={group.id}>
                <button
                  className={`group-button ${selectedGroupId === group.id ? "active" : ""}`}
                  onClick={() => {
                    setExpandedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                      return next;
                    });
                    if (selectedGroupId !== group.id) chooseGroup(group);
                  }}
                  aria-expanded={expanded}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{group.name}</span>
                  <small>{group.functions.length}</small>
                </button>
                {expanded && (
                  <div className="function-list">
                    {group.functions.map((apiFunction) => (
                      <button
                        key={apiFunction.id}
                        className={`function-button ${selectedFunctionId === apiFunction.id ? "active" : ""}`}
                        onClick={() => chooseFunction(group, apiFunction)}
                        title={apiFunction.name}
                      >
                        <span className={methodTone(apiFunction.method)}>{apiFunction.method}</span>
                        <span>{apiFunction.name}</span>
                        {apiFunction.isToken && <KeyRound size={12} aria-label="Token 接口" />}
                        {apiFunction.specStatus !== "active" && (
                          <i
                            className={`spec-marker spec-${apiFunction.specStatus}`}
                            title={specLabel(apiFunction.specStatus)}
                            aria-label={specLabel(apiFunction.specStatus)}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {visibleGroups.length === 0 && (
            <div className="empty-tree"><Search size={18} /><span>没有匹配的接口</span></div>
          )}
        </nav>

        <footer className="sidebar-footer" title={catalog.databasePath}>
          <Database size={14} />
          <span>{catalog.applications.length} 个应用</span>
          <i />
          <span>本地 SQLite</span>
        </footer>
      </aside>

      <header className="workspace-header">
        <div className="breadcrumbs">
          <span>{selectedApp?.name}</span><ChevronRight size={13} />
          <span>{selectedGroup?.name}</span><ChevronRight size={13} />
          <strong>{selectedFunction?.name ?? "未选择接口"}</strong>
        </div>
        <div className="header-actions">
          <span className="shortcut-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 发送</span>
          <PreferenceControls />
          <button className="icon-button" title="参数设置" onClick={() => setInspectorTab("parameters")}>
            <Settings2 size={17} />
          </button>
        </div>
      </header>

      <main className="workspace" data-pane tabIndex={-1}>
        <section className="auth-bar" aria-label="认证信息">
          <div className="section-heading compact">
            <KeyRound size={16} />
            <div><strong>认证</strong><span>仅在当前会话中保留</span></div>
          </div>
          <label className="compact-field">
            <span>{selectedApp?.idLabel || "ID"}</span>
            <input
              value={identity.id}
              onChange={(event) => setIdentity((current) => ({ ...current, id: event.target.value }))}
              placeholder="输入标识"
              spellCheck={false}
            />
          </label>
          <label className="compact-field">
            <span>{selectedApp?.keyLabel || "Secret"}</span>
            <input
              type="password"
              value={identity.key}
              onChange={(event) => setIdentity((current) => ({ ...current, key: event.target.value }))}
              placeholder="输入密钥"
              spellCheck={false}
            />
          </label>
          <label className="compact-field token-field">
            <span>Access Token</span>
            <input
              value={identity.token}
              onChange={(event) => setIdentity((current) => ({ ...current, token: event.target.value }))}
              placeholder="可手动填写或自动获取"
              spellCheck={false}
            />
          </label>
          <button className="button secondary" onClick={acquireToken} disabled={requesting}>
            <KeyRound size={15} />获取 Token
          </button>
          <button className="icon-button" onClick={encodeToken} disabled={!identity.token} title="Base64 编码 Token">
            <Braces size={16} />
          </button>
        </section>

        <section className="request-composer">
          <div className="request-line">
            <span className={`${methodTone(details?.method ?? selectedFunction?.method ?? "GET")} large`}>
              {details?.method ?? selectedFunction?.method ?? "GET"}
            </span>
            <div className="endpoint" title={compactUrl(baseUrl, details?.url ?? "")}>
              <Server size={16} />
              <span>{compactUrl(baseUrl, details?.url ?? "")}</span>
            </div>
            {requesting ? (
              <button className="button danger send-button" onClick={cancelActiveRequest}>
                <Ban size={16} />取消
              </button>
            ) : (
              <button
                className="button primary send-button"
                onClick={() => void runRequest()}
                disabled={!details || detailsLoading || isUnavailable(details.specStatus)}
                title={isUnavailable(details?.specStatus) ? "该接口已下线或仅为旧版测试项" : undefined}
              >
                <Send size={16} />发送
              </button>
            )}
          </div>

          {details && isUnavailable(details.specStatus) && (
            <div className="request-spec-warning" role="alert">
              <ShieldAlert size={14} />
              <span>{details.specStatus === "test-only" ? "这是非官方测试项，已禁止发送网络请求。" : "该接口已下线，不能再发送请求。"}</span>
            </div>
          )}

          <div className="request-options">
            <label className="wide-field">
              <span>Base URL</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" />
            </label>
            <label className="switch-field">
              <input type="checkbox" checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} />
              <span className="switch" aria-hidden="true" />
              <span>代理</span>
            </label>
            <input
              className="proxy-input"
              value={proxyUrl}
              onChange={(event) => setProxyUrl(event.target.value)}
              disabled={!proxyEnabled}
              placeholder="http://127.0.0.1:8080"
              aria-label="代理地址"
            />
            <label className="switch-field warning-option" title="仅用于受信任的自签名测试环境">
              <input
                type="checkbox"
                checked={allowInvalidCertificates}
                onChange={(event) => setAllowInvalidCertificates(event.target.checked)}
              />
              <span className="switch" aria-hidden="true" />
              <span>允许无效证书</span>
            </label>
          </div>
          {allowInvalidCertificates && (
            <div className="inline-warning"><ShieldAlert size={14} />TLS 证书校验已关闭，只应在受信任的测试环境中使用。</div>
          )}
        </section>

        {error && (
          <div className={`error-banner ${error.code === "cancelled" ? "neutral" : ""}`} role="alert">
            {error.code === "cancelled" ? <Ban size={17} /> : <AlertCircle size={17} />}
            <div><strong>{error.code === "cancelled" ? "请求已停止" : "操作失败"}</strong><span>{error.message}</span></div>
            <button className="icon-button small" onClick={() => setError(null)} aria-label="关闭错误提示"><X size={15} /></button>
          </div>
        )}

        <section className="response-panel">
          <div className="tabs-toolbar">
            <div className="tabs" role="tablist" aria-label="响应视图">
              <button className={responseTab === "body" ? "active" : ""} onClick={() => setResponseTab("body")}>
                <Code2 size={15} />响应
              </button>
              <button className={responseTab === "headers" ? "active" : ""} onClick={() => setResponseTab("headers")}>
                <SlidersHorizontal size={15} />响应头 {response ? <small>{response.headers.length}</small> : null}
              </button>
              <button className={responseTab === "history" ? "active" : ""} onClick={() => setResponseTab("history")}>
                <Activity size={15} />历史 {history.length ? <small>{history.length}</small> : null}
              </button>
            </div>
            {response && responseTab !== "history" && (
              <div className="response-meta">
                <span className={`status-pill ${statusTone(response.status)}`}>{response.status} {response.statusText}</span>
                <span><Clock3 size={13} />{response.elapsedMs} ms</span>
                <button className="icon-button small" onClick={copyResponse} title="复制响应"><Copy size={14} /></button>
              </div>
            )}
          </div>

          <div className="response-content">
            {requesting ? (
              <div className="response-empty"><LoaderCircle className="spin" size={24} /><strong>正在等待服务器响应</strong><span>按 Esc 可取消当前请求</span></div>
            ) : responseTab === "history" ? (
              history.length ? (
                <div className="history-list">
                  {history.map((entry) => (
                    <button
                      key={entry.id}
                      className="history-row"
                      onClick={() => {
                        if (entry.response) setResponse(entry.response);
                        setResponseTab("body");
                      }}
                      disabled={!entry.response}
                    >
                      <span className={methodTone(entry.method)}>{entry.method}</span>
                      <strong>{entry.functionName}</strong>
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
                </div>
              ) : (
                <div className="response-empty"><Activity size={24} /><strong>还没有请求记录</strong><span>发送接口后可在这里回看本次会话的结果</span></div>
              )
            ) : !response ? (
              <div className="response-empty"><Play size={24} /><strong>准备就绪</strong><span>选择接口并点击发送，响应会显示在这里</span></div>
            ) : responseTab === "headers" ? (
              <div className="headers-table">
                {response.headers.map((header, index) => (
                  <div className="header-row" key={`${header.name}-${index}`}>
                    <span>{header.name}</span><code>{header.value}</code>
                  </div>
                ))}
              </div>
            ) : (
              <pre className="response-body"><code>{formatBody(response.body)}</code></pre>
            )}
          </div>
        </section>

        <footer className="status-bar">
          <span className="connected"><i />Rust Core 就绪</span>
          <span>{details?.contentType?.trim() || "无请求体"}</span>
          <span className="status-path" title={catalog.databasePath}><Database size={12} />{catalog.databasePath}</span>
        </footer>
      </main>

      <aside className="inspector" data-pane tabIndex={-1} aria-label="接口检查器">
        <div className="tabs-toolbar inspector-toolbar">
          <div className="tabs" role="tablist" aria-label="接口检查器视图">
            <button
              role="tab"
              aria-selected={inspectorTab === "parameters"}
              className={inspectorTab === "parameters" ? "active" : ""}
              onClick={() => setInspectorTab("parameters")}
            >
              <SlidersHorizontal size={15} />参数
            </button>
            <button
              role="tab"
              aria-selected={inspectorTab === "docs"}
              className={inspectorTab === "docs" ? "active" : ""}
              onClick={() => setInspectorTab("docs")}
            >
              <FileText size={15} />说明
            </button>
          </div>
          {details?.isToken && <span className="token-badge"><KeyRound size={12} />Token</span>}
        </div>

        <div className="inspector-content">
          {detailsLoading ? (
            <div className="inspector-empty"><LoaderCircle className="spin" size={20} />载入接口配置…</div>
          ) : inspectorTab === "docs" ? (
            details ? (
              <article className="documentation">
                <div className="spec-summary">
                  <span className={`spec-badge spec-${details.specStatus}`}>{specLabel(details.specStatus)}</span>
                  {details.specVersion && <span>规范 {details.specVersion}</span>}
                  {details.verifiedAt && <span>核验于 {details.verifiedAt}</span>}
                </div>
                <div className="doc-meta">
                  <span className={methodTone(details.method)}>{details.method}</span>
                  <code>{details.url}</code>
                </div>
                {details.changeNote && <div className="change-note"><Activity size={13} />{details.changeNote}</div>}
                {details.documentation ? (
                  <p>{details.documentation}</p>
                ) : (
                  <p className="documentation-empty">此接口尚未配置 api_doc 正文。</p>
                )}
                {details.docUrl && (
                  <div className="source-row">
                    <div><span>官方文档</span><code title={details.docUrl}>{details.docUrl}</code></div>
                    <button
                      className="icon-button small"
                      onClick={async () => {
                        await navigator.clipboard.writeText(details.docUrl);
                        setNotice("官方文档地址已复制");
                      }}
                      title="复制官方文档地址"
                    ><Copy size={14} /></button>
                  </div>
                )}
              </article>
            ) : (
              <div className="inspector-empty"><CircleHelp size={22} /><strong>暂无接口说明</strong><span>此接口没有配置 api_doc 内容</span></div>
            )
          ) : parameters.length ? (
            <div className="parameter-list">
              {parameters.map((parameter, index) => (
                <label className="parameter-field" key={`${parameter.location}-${parameter.name}-${index}`}>
                  <span className="parameter-label">
                    <i className={`location location-${parameter.location}`}>{parameter.location}</i>
                    <strong>{parameter.name}</strong>
                    {parameter.locked && <LockKeyhole size={12} aria-label="模板参数" />}
                  </span>
                  <input
                    value={parameter.value}
                    readOnly={parameter.locked}
                    onChange={(event) => updateParameter(index, event.target.value)}
                    title={parameter.locked ? "模板参数由认证栏自动替换" : undefined}
                    spellCheck={false}
                  />
                </label>
              ))}
              {details?.contentType.toLocaleLowerCase().startsWith("application/json") && (
                <div className="json-type-hint">
                  <CircleHelp size={13} />
                  数字、布尔、数组和对象按 JSON 字面量解析；纯数字字符串请保留双引号。
                </div>
              )}
            </div>
          ) : (
            <div className="inspector-empty"><SlidersHorizontal size={22} /><strong>此接口没有参数</strong><span>可以直接发送请求</span></div>
          )}
        </div>

        {inspectorTab === "parameters" && (
          <footer className="inspector-footer">
            <button className="button secondary" onClick={() => setParameters(details?.parameters ?? [])} disabled={!hasParameterChanges || saving}>
              <RotateCcw size={14} />还原
            </button>
            <button className="button primary" onClick={saveParameters} disabled={!hasParameterChanges || saving}>
              {saving ? <LoaderCircle className="spin" size={14} /> : hasParameterChanges ? <Save size={14} /> : <Check size={14} />}
              {saving ? "保存中" : hasParameterChanges ? "保存更改" : "已保存"}
            </button>
          </footer>
        )}
      </aside>

      {notice && workspaceMode === "catalog" && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    </div>
    <CloudConsole
      active={workspaceMode === "cloud"}
      workspaceMode={workspaceMode}
      onWorkspaceChange={changeWorkspace}
    />
    <StorageConsole
      active={workspaceMode === "storage"}
      workspaceMode={workspaceMode}
      onWorkspaceChange={changeWorkspace}
    />
    </>
  );
}
