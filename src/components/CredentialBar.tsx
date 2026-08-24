import { ChevronDown, ChevronRight, ClipboardPaste, Eye, EyeOff, KeyRound, RotateCcw } from "lucide-react";
import { useEffect, useState, type ClipboardEvent } from "react";
import {
  describeCredentialMode,
  expirationStatus,
  parseStsCredentialBlob,
  useSessionCredentials,
} from "../lib/sessionCredentials";

export function CredentialBar({
  title,
  hint,
  idLabel = "AccessKey ID",
  keyLabel = "AccessKey Secret",
  tokenLabel = "STS Security Token",
  secretOptional = false,
  onNotice,
}: {
  title: string;
  hint: string;
  idLabel?: string;
  keyLabel?: string;
  tokenLabel?: string;
  secretOptional?: boolean;
  onNotice: (message: string) => void;
}) {
  const { credentials, setCredentials, replaceCredentials, clearCredentials } = useSessionCredentials();
  const [showSecret, setShowSecret] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mode = describeCredentialMode(credentials);
  const expiry = expirationStatus(credentials.expiration, now);
  const filled = Boolean(credentials.accessKeyId || credentials.accessKeySecret || credentials.securityToken);
  const ready = Boolean(credentials.accessKeyId.trim() && (secretOptional || credentials.accessKeySecret.trim()));
  const [open, setOpen] = useState(!ready);
  const akPreview = credentials.accessKeyId.length > 8
    ? `${credentials.accessKeyId.slice(0, 4)}…${credentials.accessKeyId.slice(-4)}`
    : credentials.accessKeyId;

  useEffect(() => {
    if (!ready) setOpen(true);
  }, [ready]);

  useEffect(() => {
    if (!credentials.expiration) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [credentials.expiration]);

  const applyBlob = (raw: string) => {
    const parsed = parseStsCredentialBlob(raw);
    if (parsed.source === "none") return false;
    replaceCredentials({
      accessKeyId: parsed.credentials.accessKeyId || credentials.accessKeyId,
      accessKeySecret: parsed.credentials.accessKeySecret || credentials.accessKeySecret,
      securityToken: parsed.credentials.securityToken || credentials.securityToken,
      expiration: parsed.credentials.expiration,
    });
    onNotice(parsed.label);
    if (parsed.credentials.accessKeyId && parsed.credentials.accessKeySecret) setOpen(false);
    return true;
  };

  const onPasteMaybeSts = (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text");
    if (applyBlob(text)) event.preventDefault();
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!applyBlob(text)) onNotice("剪贴板里没有可识别的 STS JSON");
    } catch {
      onNotice("无法读取剪贴板，请直接粘贴到输入框");
    }
  };

  return (
    <section className={`cloud-panel credentials-panel ${open ? "" : "collapsed"}`}>
      <div className="cloud-panel-heading">
        <KeyRound size={16} />
        <div>
          <strong>{title}</strong>
          <span>{open ? hint : ready ? `${akPreview}${mode === "sts" ? " · 已带 STS Token" : " · 长期密钥"}` : hint}</span>
        </div>
        <div className="credential-heading-actions">
          {mode === "sts" && (
            <span className={`sts-badge ${expiry.kind}`} title={credentials.expiration || "STS 临时凭证"}>
              STS{expiry.text ? ` · ${expiry.text}` : ""}
            </span>
          )}
          {mode === "aksk" && <span className="sts-badge aksk">长期 AK/SK</span>}
          {open && (
            <>
              <button className="button secondary" onClick={() => void pasteFromClipboard()}>
                <ClipboardPaste size={14} />粘贴 STS
              </button>
              <button className="button secondary" onClick={clearCredentials} disabled={!filled}>
                <RotateCcw size={14} />清空
              </button>
            </>
          )}
          {ready && (
            <button className="button secondary" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {open ? "收起" : "更改"}
            </button>
          )}
        </div>
      </div>
      <div className="cloud-fields credentials-fields">
        <label>
          <span>{idLabel}</span>
          <input
            value={credentials.accessKeyId}
            onChange={(event) => setCredentials({ accessKeyId: event.target.value })}
            onPaste={onPasteMaybeSts}
            placeholder="LTAI… / AKID… 或整段 STS JSON"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="secret-field">
          <span>{keyLabel}</span>
          <div>
            <input
              type={showSecret ? "text" : "password"}
              value={credentials.accessKeySecret}
              onChange={(event) => setCredentials({ accessKeySecret: event.target.value })}
              onPaste={onPasteMaybeSts}
              autoComplete="new-password"
              spellCheck={false}
            />
            <button
              className="icon-button small"
              onClick={() => setShowSecret((current) => !current)}
              aria-label={showSecret ? "隐藏密钥" : "显示密钥"}
            >
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>
        <label className="sts-token-field">
          <span>{tokenLabel}</span>
          <textarea
            value={credentials.securityToken}
            onChange={(event) => setCredentials({ securityToken: event.target.value })}
            onPaste={onPasteMaybeSts}
            placeholder="可选。AssumeRole / GetFederationToken 返回的 SecurityToken"
            spellCheck={false}
            rows={2}
          />
        </label>
      </div>
      {expiry.kind === "expired" && (
        <div className="inline-warning credential-expiry" role="status">
          临时凭证已过期，云厂商会拒绝签名。请重新签发 STS。
        </div>
      )}
    </section>
  );
}
