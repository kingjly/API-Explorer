export type SpecStatus =
  | "active"
  | "legacy"
  | "deprecated"
  | "removed"
  | "unverified"
  | "test-only";

export interface FunctionSummary {
  id: number;
  name: string;
  method: string;
  isToken: boolean;
  specStatus: SpecStatus;
  specVersion: string;
}

export interface ApiGroup {
  id: number;
  name: string;
  functions: FunctionSummary[];
}

export interface ApiApplication {
  id: number;
  name: string;
  idLabel: string;
  keyLabel: string;
  baseUrl: string;
  groups: ApiGroup[];
}

export interface Catalog {
  applications: ApiApplication[];
  databasePath: string;
}

export interface ParameterEntry {
  location: "path" | "query" | "header" | "body";
  name: string;
  value: string;
  locked: boolean;
}

export interface FunctionDetails {
  id: number;
  groupId: number;
  name: string;
  method: string;
  url: string;
  path: string;
  headers: string;
  query: string;
  contentType: string;
  body: string;
  isToken: boolean;
  tokenPattern: string;
  documentation: string;
  specStatus: SpecStatus;
  specVersion: string;
  docUrl: string;
  verifiedAt: string;
  changeNote: string;
  parameters: ParameterEntry[];
}

export interface IdentityInput {
  id: string;
  key: string;
  token: string;
}

export interface ExecuteRequest {
  requestId: string;
  functionId: number;
  identity: IdentityInput;
  baseUrl: string;
  proxyUrl?: string;
  allowInvalidCertificates: boolean;
  acquireToken: boolean;
}

export interface ResponseHeader {
  name: string;
  value: string;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  elapsedMs: number;
  url: string;
  contentType: string;
  headers: ResponseHeader[];
  body: string;
  token?: string;
}

export type CloudProvider =
  | "alibabaAcs3"
  | "tencentTc3"
  | "huaweiSdkHmac"
  | "volcengineHmac"
  | "baiduBceV1"
  | "ezvizLapp"
  | "tiandituTk"
  | "qiniuMac";

export interface CloudCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
}

export interface CloudRequest {
  requestId: string;
  provider: CloudProvider;
  method: string;
  endpoint: string;
  service: string;
  action: string;
  version: string;
  region: string;
  query: string;
  body: string;
  contentType: string;
  credentials: CloudCredentials;
  proxyUrl?: string;
  allowInvalidCertificates: boolean;
}

export interface CloudSignaturePreview {
  algorithm: string;
  timestamp: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
  authorization: string;
  redacted: boolean;
}

export interface CloudResponse extends Omit<ApiResponse, "token"> {
  signature: CloudSignaturePreview;
}

export type StorageProvider = "alibabaOss" | "tencentCos" | "baiduBos" | "qiniuKodo";

export type StorageOperation =
  | "listBuckets"
  | "listObjects"
  | "uploadObject"
  | "downloadObject"
  | "presignGet"
  | "presignPut";

export interface StorageRequest {
  requestId: string;
  provider: StorageProvider;
  operation: StorageOperation;
  region: string;
  bucket: string;
  objectKey: string;
  prefix: string;
  delimiter: string;
  maxKeys: number;
  localPath: string;
  downloadPath: string;
  contentType: string;
  expiresSeconds: number;
  overwriteConfirmed: boolean;
  credentials: CloudCredentials;
  proxyUrl?: string;
  allowInvalidCertificates: boolean;
}

export interface StorageSignaturePreview extends CloudSignaturePreview {}

export interface StorageResponse {
  status?: number;
  statusText: string;
  elapsedMs: number;
  url: string;
  contentType: string;
  headers: ResponseHeader[];
  body: string;
  savedPath?: string;
  bytesTransferred: number;
  presignedUrl?: string;
  signature: StorageSignaturePreview;
}

export interface CommandError {
  code: string;
  message: string;
}

export interface HistoryEntry {
  id: string;
  functionId: number;
  functionName: string;
  method: string;
  timestamp: Date;
  response?: ApiResponse;
  error?: CommandError;
}
