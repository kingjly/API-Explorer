import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface SessionCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
}

const EMPTY: SessionCredentials = {
  accessKeyId: "",
  accessKeySecret: "",
  securityToken: "",
  expiration: "",
};

const ID_KEYS = ["AccessKeyId", "accessKeyId", "TmpSecretId", "tmpSecretId", "tmpAccessKeyId", "access", "Access"];
const SECRET_KEYS = ["AccessKeySecret", "accessKeySecret", "SecretAccessKey", "TmpSecretKey", "tmpSecretKey", "secret", "Secret"];
const TOKEN_KEYS = ["SecurityToken", "securityToken", "SessionToken", "sessionToken", "Token", "token", "securitytoken", "XSecurityToken", "accessToken", "AccessToken"];
const EXPIRY_KEYS = ["Expiration", "expiration", "ExpireAt", "expireAt", "ExpiredTime", "expiredTime", "ExpiresAt", "expireTime"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizeExpiration(value: string): string {
  if (!value) return "";
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    const millis = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function extractFromRecord(record: Record<string, unknown>): SessionCredentials | null {
  const accessKeyId = readString(record, ID_KEYS);
  const accessKeySecret = readString(record, SECRET_KEYS);
  const securityToken = readString(record, TOKEN_KEYS);
  const expiration = normalizeExpiration(readString(record, EXPIRY_KEYS));
  if (!accessKeyId && !accessKeySecret && !securityToken) return null;
  if (accessKeyId || accessKeySecret || securityToken.length > 20) {
    return { accessKeyId, accessKeySecret, securityToken, expiration };
  }
  return null;
}

function collectCandidates(root: unknown): Record<string, unknown>[] {
  const record = asRecord(root);
  if (!record) return [];
  const nested = [
    record.Credentials,
    record.credentials,
    record.credential,
    record.Credential,
    asRecord(record.Response)?.Credentials,
    asRecord(record.Response)?.credentials,
    asRecord(record.Result)?.Credentials,
    asRecord(record.data)?.Credentials,
    record.data,
    asRecord(record.AssumeRoleResponse)?.Credentials,
  ];
  return [record, ...nested.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)];
}

export function parseStsCredentialBlob(raw: string): {
  credentials: SessionCredentials;
  source: "json" | "token" | "none";
  label: string;
} {
  const text = raw.trim();
  if (!text) return { credentials: EMPTY, source: "none", label: "" };

  try {
    const parsed = JSON.parse(text) as unknown;
    for (const candidate of collectCandidates(parsed)) {
      const extracted = extractFromRecord(candidate);
      if (extracted && (extracted.accessKeyId || extracted.securityToken)) {
        const hasToken = Boolean(extracted.securityToken);
        return {
          credentials: extracted,
          source: "json",
          label: hasToken ? "已填入 STS 临时凭据" : "已从 JSON 填入访问密钥",
        };
      }
    }
  } catch {
    // not JSON
  }

  if (!text.startsWith("{") && text.length >= 40 && !text.includes("\n") && !/\s/.test(text.slice(0, 16))) {
    return {
      credentials: { ...EMPTY, securityToken: text },
      source: "token",
      label: "已填入 Security Token，请补全对应的临时 AK/SK",
    };
  }

  return { credentials: EMPTY, source: "none", label: "" };
}

export function describeCredentialMode(credentials: SessionCredentials) {
  if (credentials.securityToken.trim()) return "sts" as const;
  if (credentials.accessKeyId.trim() && credentials.accessKeySecret.trim()) return "aksk" as const;
  return "empty" as const;
}

export function expirationStatus(expiration: string, now = Date.now()) {
  if (!expiration) return { kind: "none" as const, text: "", remainingMs: Number.POSITIVE_INFINITY };
  const date = new Date(expiration);
  if (Number.isNaN(date.getTime())) return { kind: "none" as const, text: "", remainingMs: Number.POSITIVE_INFINITY };
  const remainingMs = date.getTime() - now;
  if (remainingMs <= 0) return { kind: "expired" as const, text: "已过期", remainingMs };
  const minutes = Math.floor(remainingMs / 60000);
  if (minutes < 60) return { kind: "soon" as const, text: `${Math.max(1, minutes)} 分钟后过期`, remainingMs };
  const hours = Math.floor(minutes / 60);
  return { kind: "ok" as const, text: `${hours} 小时后过期`, remainingMs };
}

interface SessionCredentialsContextValue {
  credentials: SessionCredentials;
  setCredentials: (patch: Partial<SessionCredentials>) => void;
  replaceCredentials: (next: SessionCredentials) => void;
  clearCredentials: () => void;
}

const SessionCredentialsContext = createContext<SessionCredentialsContextValue | null>(null);

export function SessionCredentialsProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentialsState] = useState<SessionCredentials>(EMPTY);

  const setCredentials = useCallback((patch: Partial<SessionCredentials>) => {
    setCredentialsState((current) => ({ ...current, ...patch }));
  }, []);

  const replaceCredentials = useCallback((next: SessionCredentials) => {
    setCredentialsState(next);
  }, []);

  const clearCredentials = useCallback(() => {
    setCredentialsState(EMPTY);
  }, []);

  const value = useMemo(
    () => ({ credentials, setCredentials, replaceCredentials, clearCredentials }),
    [clearCredentials, credentials, replaceCredentials, setCredentials],
  );

  return <SessionCredentialsContext.Provider value={value}>{children}</SessionCredentialsContext.Provider>;
}

export function useSessionCredentials() {
  const context = useContext(SessionCredentialsContext);
  if (!context) throw new Error("useSessionCredentials must be used within SessionCredentialsProvider");
  return context;
}
