import {
  Activity,
  AlertCircle,
  Ban,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  Copy,
  Download,
  FileKey2,
  Folder,
  HardDrive,
  Link2,
  List,
  LoaderCircle,
  LockKeyhole,
  Network,
  Play,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CredentialBar } from "../../components/CredentialBar";
import { PreferenceControls } from "../../components/PreferenceControls";
import { WorkspaceSwitch, type WorkspaceMode } from "../../components/WorkspaceSwitch";
import { api, normalizeError } from "../../lib/ipc";
import { describeCredentialMode, useSessionCredentials } from "../../lib/sessionCredentials";
import { patchWorkspaceMemory, readWorkspaceMemory } from "../../lib/workspaceMemory";
import type {
  CommandError,
  StorageOperation,
  StorageProvider,
  StorageRequest,
  StorageResponse,
  StorageSignaturePreview,
} from "../../types";

type ResultTab = "body" | "headers" | "signature" | "history";

interface StorageHistoryEntry {
  id: string;
  label: string;
  method: string;
  timestamp: Date;
  response?: StorageResponse;
  error?: CommandError;
}

interface ProviderMeta {
  name: string;
  shortName: string;
  algorithm: string;
  domain: string;
  region: string;
  bucket: string;
  description: string;
}

const PROVIDERS: Record<StorageProvider, ProviderMeta> = {
  alibabaOss: {
    name: "阿里云对象存储 OSS",
    shortName: "阿里云 OSS",
    algorithm: "OSS4-HMAC-SHA256",
    domain: "aliyuncs.com",
    region: "cn-hangzhou",
    bucket: "examplebucket",
    description: "V4 签名 · XML API",
  },
  tencentCos: {
    name: "腾讯云对象存储 COS",
    shortName: "腾讯云 COS",
    algorithm: "q-sign-algorithm=sha1",
    domain: "myqcloud.com",
    region: "ap-guangzhou",
    bucket: "examplebucket-1250000000",
    description: "XML API · Bucket 含 APPID",
  },
  baiduBos: {
    name: "百度智能云对象存储 BOS",
    shortName: "百度云 BOS",
    algorithm: "bce-auth-v1",
    domain: "bcebos.com",
    region: "bj",
    bucket: "examplebucket",
    description: "BCE V1 · JSON API",
  },
};

const OPERATIONS: Array<{
  id: StorageOperation;
  label: string;
  description: string;
  icon: typeof List;
}> = [
  { id: "listBuckets", label: "桶列表", description: "列出当前账号可见的 Bucket", icon: HardDrive },
  { id: "listObjects", label: "对象列表", description: "按前缀列出 Bucket 中的对象", icon: List },
  { id: "uploadObject", label: "上传", description: "简单上传，最大 5 GiB", icon: Upload },
  { id: "downloadObject", label: "下载", description: "流式保存到新的本地文件", icon: Download },
  { id: "presignGet", label: "下载链接", description: "本机生成 GET 预签名 URL", icon: Link2 },
  { id: "presignPut", label: "上传链接", description: "本机生成 PUT 预签名 URL", icon: FileKey2 },
];

function statusTone(status?: number) {
  if (status === undefined) return "success";
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

function operationMethod(operation: StorageOperation) {
  return operation === "uploadObject" || operation === "presignPut" ? "PUT" : "GET";
}

export function StorageConsole({
  active,
  workspaceMode,
  onWorkspaceChange,
}: {
  active: boolean;
  workspaceMode: WorkspaceMode;
  onWorkspaceChange: (mode: WorkspaceMode) => void;
}) {
  const remembered = readWorkspaceMemory();
  const initialProvider = PROVIDERS[remembered.storageProvider] ? remembered.storageProvider : "alibabaOss";
  const initialOperation = OPERATIONS.some((item) => item.id === remembered.storageOperation)
    ? remembered.storageOperation
    : "listBuckets";
  const [providerId, setProviderId] = useState<StorageProvider>(initialProvider);
  const [operation, setOperation] = useState<StorageOperation>(initialOperation);
  const [region, setRegion] = useState(remembered.storageRegion || PROVIDERS[initialProvider].region);
  const [bucket, setBucket] = useState(remembered.storageBucket || PROVIDERS[initialProvider].bucket);
  const [objectKey, setObjectKey] = useState(remembered.storageObjectKey || "folder/example.txt");
  const [prefix, setPrefix] = useState(remembered.storagePrefix);
  const [history, setHistory] = useState<StorageHistoryEntry[]>([]);
  const [delimiter, setDelimiter] = useState("/");
  const [maxKeys, setMaxKeys] = useState(100);
  const [localPath, setLocalPath] = useState("");
  const [downloadPath, setDownloadPath] = useState("");
  const [contentType, setContentType] = useState("application/octet-stream");
  const [expiresSeconds, setExpiresSeconds] = useState(3600);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const { credentials } = useSessionCredentials();
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("http://127.0.0.1:8080");
  const [allowInvalidCertificates, setAllowInvalidCertificates] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [response, setResponse] = useState<StorageResponse | null>(null);
  const [signature, setSignature] = useState<StorageSignaturePreview | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("body");
  const [error, setError] = useState<CommandError | null>(null);
  const [notice, setNotice] = useState("");

  const provider = PROVIDERS[providerId];
  const operationMeta = useMemo(
    () => OPERATIONS.find((item) => item.id === operation) ?? OPERATIONS[0],
    [operation],
  );
  const needsBucket = operation !== "listBuckets";
  const needsObject = ["uploadObject", "downloadObject", "presignGet", "presignPut"].includes(operation);
  const isListObjects = operation === "listObjects";
  const isUpload = operation === "uploadObject";
  const isDownload = operation === "downloadObject";
  const isPresign = operation === "presignGet" || operation === "presignPut";

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const buildRequest = useCallback((requestId = crypto.randomUUID()): StorageRequest => ({
    requestId,
    provider: providerId,
    operation,
    region,
    bucket,
    objectKey,
    prefix,
    delimiter,
    maxKeys,
    localPath,
    downloadPath,
    contentType,
    expiresSeconds,
    overwriteConfirmed,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      securityToken: credentials.securityToken,
    },
    proxyUrl: !isPresign && proxyEnabled ? proxyUrl : undefined,
    allowInvalidCertificates: !isPresign && allowInvalidCertificates,
  }), [
    allowInvalidCertificates,
    bucket,
    contentType,
    delimiter,
    downloadPath,
    expiresSeconds,
    isPresign,
    localPath,
    maxKeys,
    objectKey,
    operation,
    overwriteConfirmed,
    prefix,
    providerId,
    proxyEnabled,
    proxyUrl,
    region,
    credentials,
  ]);

  const run = useCallback(async () => {
    if (requesting) return;
    const requestId = crypto.randomUUID();
    setRequesting(true);
    setActiveRequestId(requestId);
    setError(null);
    try {
      const result = await api.executeObjectStorageRequest(buildRequest(requestId));
      setResponse(result);
      setSignature(result.signature);
      setResultTab("body");
      setHistory((current) => [{
        id: requestId,
        label: `${provider.shortName} · ${operationMeta.label}`,
        method: operationMethod(operation),
        timestamp: new Date(),
        response: result,
      }, ...current].slice(0, 20));
      if (result.presignedUrl) setNotice("预签名 URL 已在本机生成，未发送网络请求");
      if (result.savedPath) setNotice("对象已完整写入本地文件");
    } catch (reason) {
      const commandError = normalizeError(reason);
      setError(commandError);
      setHistory((current) => [{
        id: requestId,
        label: `${provider.shortName} · ${operationMeta.label}`,
        method: operationMethod(operation),
        timestamp: new Date(),
        error: commandError,
      }, ...current].slice(0, 20));
    } finally {
      setRequesting(false);
      setActiveRequestId(null);
    }
  }, [buildRequest, operation, operationMeta.label, provider.shortName, requesting]);

  const preview = useCallback(async () => {
    setError(null);
    try {
      const result = await api.previewObjectStorageSignature(buildRequest());
      setSignature(result);
      setResultTab("signature");
      setNotice("签名诊断已在本机生成");
    } catch (reason) {
      setError(normalizeError(reason));
    }
  }, [buildRequest]);

  const cancel = useCallback(async () => {
    if (activeRequestId) await api.cancelRequest(activeRequestId);
  }, [activeRequestId]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void run();
      }
      if (event.key === "Escape" && activeRequestId) void cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, activeRequestId, cancel, run]);

  const chooseProvider = (next: StorageProvider) => {
    const meta = PROVIDERS[next];
    setProviderId(next);
    setRegion(meta.region);
    setBucket(meta.bucket);
    setResponse(null);
    setSignature(null);
    setError(null);
    patchWorkspaceMemory({
      storageProvider: next,
      storageRegion: meta.region,
      storageBucket: meta.bucket,
    });
  };

  const chooseOperation = (next: StorageOperation) => {
    setOperation(next);
    setOverwriteConfirmed(false);
    patchWorkspaceMemory({ storageOperation: next });
    setResponse(null);
    setSignature(null);
    setError(null);
  };

  const copy = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(message);
  };

  return (
    <div className={`cloud-shell storage-shell ${active ? "" : "workspace-pane-hidden"}`} aria-hidden={!active}>
      <aside className="cloud-sidebar" aria-label="对象存储导航">
        <header className="sidebar-header">
          <div className="brand-mark"><Network size={20} /></div>
          <div><h1>API Explorer</h1><span>Desktop 3.5</span></div>
        </header>
        <WorkspaceSwitch mode={workspaceMode} onChange={onWorkspaceChange} />

        <span className="field-label cloud-nav-label">服务商</span>
        <nav className="cloud-presets storage-providers">
          {(Object.entries(PROVIDERS) as Array<[StorageProvider, ProviderMeta]>).map(([id, item]) => (
            <button key={id} className={id === providerId ? "active" : ""} onClick={() => chooseProvider(id)}>
              <span className={`cloud-provider-dot ${id}`} />
              <strong>{item.shortName}</strong>
              <small>{item.description}</small>
            </button>
          ))}
        </nav>

        <div className="cloud-security-note">
          <ShieldCheck size={16} />
          <div><strong>流式与本机签名</strong><span>SK 不落盘；下载完成前只写临时文件。</span></div>
        </div>
      </aside>

      <main className="cloud-workspace">
        <header className="workspace-header cloud-workspace-header">
          <div className="breadcrumbs"><span>对象存储</span><span>/</span><strong>{provider.shortName} · {operationMeta.label}</strong></div>
          <div className="header-actions"><span className="shortcut-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 执行</span><PreferenceControls /><span className="cloud-algorithm">{provider.algorithm}</span></div>
        </header>

        <div className="cloud-scroll">
          <CredentialBar
            title="访问凭据"
            hint="与云 AK/SK 共用当前会话。可粘贴 STS JSON；SK 不落盘。"
            idLabel="AccessKey ID / SecretId"
            keyLabel="AccessKey Secret / SecretKey"
            onNotice={setNotice}
          />

          <section className="cloud-panel storage-request-panel">
            <div className="cloud-panel-heading">
              <Folder size={16} />
              <div><strong>对象操作</strong><span>{operationMeta.description}</span></div>
              <div className="storage-operation-select select-wrap">
                <select value={operation} onChange={(event) => chooseOperation(event.target.value as StorageOperation)} aria-label="对象存储操作">
                  {OPERATIONS.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.description}</option>)}
                </select><ChevronDown size={14} />
              </div>
            </div>

            <div className="storage-operation-tabs" role="tablist" aria-label="对象存储操作类型">
              {OPERATIONS.map((item) => {
                const Icon = item.icon;
                return <button key={item.id} className={operation === item.id ? "active" : ""} onClick={() => chooseOperation(item.id)}><Icon size={14} />{item.label}</button>;
              })}
            </div>

            <div className="cloud-fields storage-resource-fields">
              <label><span>Provider</span><select value={providerId} onChange={(event) => chooseProvider(event.target.value as StorageProvider)}><option value="alibabaOss">阿里云 OSS</option><option value="tencentCos">腾讯云 COS</option><option value="baiduBos">百度智能云 BOS</option></select></label>
              <label><span>Region</span><input value={region} onChange={(event) => { setRegion(event.target.value); patchWorkspaceMemory({ storageRegion: event.target.value }); }} spellCheck={false} /></label>
              <label><span>Bucket</span><input value={bucket} onChange={(event) => { setBucket(event.target.value); patchWorkspaceMemory({ storageBucket: event.target.value }); }} disabled={!needsBucket} spellCheck={false} placeholder={needsBucket ? "bucket-name" : "桶列表不需要"} /></label>
              <label className="storage-object-key"><span>Object Key</span><input value={objectKey} onChange={(event) => { setObjectKey(event.target.value); patchWorkspaceMemory({ storageObjectKey: event.target.value }); }} disabled={!needsObject} spellCheck={false} placeholder={needsObject ? "folder/example.txt" : "当前操作不需要"} /></label>
            </div>

            {isListObjects && (
              <div className="cloud-fields storage-list-fields">
                <label><span>Prefix</span><input value={prefix} onChange={(event) => { setPrefix(event.target.value); patchWorkspaceMemory({ storagePrefix: event.target.value }); }} spellCheck={false} placeholder="可选对象前缀" /></label>
                <label><span>Delimiter</span><input value={delimiter} onChange={(event) => setDelimiter(event.target.value)} maxLength={1} spellCheck={false} /></label>
                <label><span>Max Keys</span><input type="number" min={1} max={1000} value={maxKeys} onChange={(event) => setMaxKeys(Number(event.target.value))} /></label>
              </div>
            )}

            {(isUpload || isDownload) && (
              <div className="cloud-fields storage-file-fields">
                {isUpload ? <label className="storage-path-field"><span>本地上传文件绝对路径</span><input value={localPath} onChange={(event) => setLocalPath(event.target.value)} spellCheck={false} placeholder="D:\\files\\example.bin" /></label>
                  : <label className="storage-path-field"><span>本地保存绝对路径（必须是新文件）</span><input value={downloadPath} onChange={(event) => setDownloadPath(event.target.value)} spellCheck={false} placeholder="D:\\downloads\\example.bin" /></label>}
                {isUpload && <label><span>Content-Type</span><input value={contentType} onChange={(event) => setContentType(event.target.value)} spellCheck={false} /></label>}
              </div>
            )}

            <div className="cloud-options storage-options">
              <label className="wide-field"><span>签名有效期（秒）</span><input type="number" min={1} max={604800} value={expiresSeconds} onChange={(event) => setExpiresSeconds(Number(event.target.value))} /></label>
              <label className="switch-field"><input type="checkbox" checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} disabled={isPresign} /><span className="switch" /><span>代理</span></label>
              <input className="proxy-input" value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} disabled={isPresign || !proxyEnabled} aria-label="代理地址" />
              <label className="switch-field warning-option"><input type="checkbox" checked={allowInvalidCertificates} onChange={(event) => setAllowInvalidCertificates(event.target.checked)} disabled={isPresign} /><span className="switch" /><span>允许无效证书</span></label>
              {!isPresign && <button className="button secondary preview-button" onClick={() => void preview()} disabled={requesting}><FileKey2 size={15} />只生成签名</button>}
            </div>

            {isUpload && (
              <label className="storage-risk-confirmation">
                <input type="checkbox" checked={overwriteConfirmed} onChange={(event) => setOverwriteConfirmed(event.target.checked)} />
                <ShieldAlert size={15} />
                <span><strong>我确认上传可能覆盖同名远端对象</strong><small>本工具不会执行删除，但简单上传可能替换已存在的 Object。</small></span>
              </label>
            )}

            <div className="storage-runbar">
              <div><code>{operationMethod(operation)}</code><span>{provider.domain} 官方 HTTPS Endpoint 由 Rust 自动生成</span></div>
              {requesting ? <button className="button danger" onClick={() => void cancel()}><Ban size={15} />取消</button>
                : <button
                    className={`button ${isUpload ? "warning" : "primary"}`}
                    onClick={() => void run()}
                    disabled={(isUpload && !overwriteConfirmed) || !credentials.accessKeyId.trim() || !credentials.accessKeySecret.trim()}
                    title={!credentials.accessKeyId.trim() || !credentials.accessKeySecret.trim() ? "先填写 AccessKey ID 和 Secret" : undefined}
                  >{isPresign ? <Link2 size={15} /> : isUpload ? <Upload size={15} /> : isDownload ? <Download size={15} /> : <Play size={15} />}{isPresign ? "生成预签名 URL" : isUpload ? "确认并上传" : isDownload ? "下载到本地" : "签名并查询"}</button>}
            </div>
          </section>

          {allowInvalidCertificates && !isPresign && <div className="inline-warning storage-warning"><ShieldAlert size={14} />TLS 证书校验已关闭，只应在受信任的代理测试环境中使用。</div>}
          {providerId === "baiduBos" && isPresign && credentials.securityToken && <div className="inline-warning storage-warning"><ShieldAlert size={14} />BOS 官方要求 STS 预签名调用方另带 Token 请求头，本工具会拒绝生成不可直接使用的链接。</div>}

          {error && <div className={`error-banner cloud-error ${error.code === "cancelled" ? "neutral" : ""}`} role="alert"><AlertCircle size={17} /><div><strong>{error.code === "cancelled" ? "操作已停止" : "对象存储操作失败"}</strong><span>{error.message}</span></div><button className="icon-button small" onClick={() => setError(null)} aria-label="关闭错误"><X size={14} /></button></div>}

          <section className="cloud-panel cloud-result-panel storage-result-panel">
            <div className="tabs-toolbar">
              <div className="tabs" role="tablist">
                <button className={resultTab === "body" ? "active" : ""} onClick={() => setResultTab("body")}><Code2 size={15} />结果</button>
                <button className={resultTab === "headers" ? "active" : ""} onClick={() => setResultTab("headers")}><SlidersHorizontal size={15} />响应头 {response && <small>{response.headers.length}</small>}</button>
                <button className={resultTab === "signature" ? "active" : ""} onClick={() => setResultTab("signature")}><LockKeyhole size={15} />签名诊断</button>
                <button className={resultTab === "history" ? "active" : ""} onClick={() => setResultTab("history")}><Activity size={15} />历史 {history.length ? <small>{history.length}</small> : null}</button>
              </div>
              {response && resultTab !== "history" && <div className="response-meta"><span className={`status-pill ${statusTone(response.status)}`}>{response.status ?? "LOCAL"} {response.statusText}</span>{response.elapsedMs > 0 && <span><Clock3 size={13} />{response.elapsedMs} ms</span>}{response.bytesTransferred > 0 && <span>{response.bytesTransferred.toLocaleString()} bytes</span>}</div>}
            </div>
            <div className="cloud-result-content">
              {requesting ? <div className="response-empty"><LoaderCircle className="spin" size={24} /><strong>{isUpload ? "正在流式上传对象" : isDownload ? "正在流式下载对象" : "正在等待对象存储响应"}</strong><span>按 Esc 可取消当前操作</span></div>
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
                        <span className={`status-text ${statusTone(entry.response.status)}`}>{entry.response.status ?? "LOCAL"}</span>
                      ) : (
                        <span className="status-text error">失败</span>
                      )}
                      <span className="history-duration">{entry.response ? `${entry.response.elapsedMs} ms` : entry.error?.message}</span>
                    </button>
                  ))}
                  <button className="clear-history" onClick={() => setHistory([])}><Trash2 size={14} />清空历史</button>
                </div> : <div className="response-empty"><Activity size={24} /><strong>还没有请求记录</strong><span>执行后可在这里对照本次会话的结果</span></div>
                : resultTab === "signature" ? signature ? <div className="signature-diagnostics">
                  <div className="signature-summary"><span>{signature.algorithm}</span><span>{signature.timestamp}</span><span>{signature.signedHeaders}</span>{signature.redacted && <i>已脱敏</i>}</div>
                  {[["Canonical Request", signature.canonicalRequest], ["String to Sign", signature.stringToSign], ["Authorization / Signed URL", signature.authorization]].map(([label, value]) => <section key={label}><header><strong>{label}</strong><button className="icon-button small" onClick={() => void copy(value, `${label} 已复制`)} aria-label={`复制 ${label}`}><Copy size={14} /></button></header><pre><code>{value}</code></pre></section>)}
                </div> : <div className="response-empty"><FileKey2 size={24} /><strong>还没有签名诊断</strong><span>可以先生成签名而不发送网络请求</span></div>
                : resultTab === "headers" ? response ? <div className="headers-table">{response.headers.map((header, index) => <div className="header-row" key={`${header.name}-${index}`}><span>{header.name}</span><code>{header.value}</code></div>)}</div> : <div className="response-empty"><Network size={24} /><strong>还没有响应头</strong></div>
                : response ? <div className="storage-result-body">
                  {response.presignedUrl && <section className="presigned-output"><div><Link2 size={16} /><strong>预签名 URL</strong><span>请仅分享给需要临时访问该对象的可信对象</span></div><code>{response.presignedUrl}</code><button className="button secondary" onClick={() => void copy(response.presignedUrl ?? "", "预签名 URL 已复制")}><Copy size={14} />复制链接</button></section>}
                  {response.savedPath && <div className="saved-path"><Check size={15} /><span><strong>已保存到</strong><code>{response.savedPath}</code></span></div>}
                  <pre className="response-body"><code>{formatBody(response.body)}</code></pre>
                </div> : <div className="response-empty"><HardDrive size={24} /><strong>对象存储工作区已就绪</strong><span>列表操作是只读；预签名不会发送网络请求</span></div>}
            </div>
          </section>
        </div>

        <footer className="status-bar"><span className="connected"><i />Rust Storage Adapter 就绪</span><span>{provider.name}</span><span className="status-path"><ShieldCheck size={12} />{describeCredentialMode(credentials) === "sts" ? "STS 会话凭据 · 不落盘" : "SK 不落盘 · 下载不覆盖"}</span></footer>
      </main>
      {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    </div>
  );
}
