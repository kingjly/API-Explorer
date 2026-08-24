# 云 API AK/SK 架构

## 结论

API Explorer 使用混合策略：标准 OpenAPI 协议在 Rust Core 内直接实现签名，特殊服务协议才引入专用 Rust SDK 或适配器。

当前直接支持：

- 阿里云 `ACS3-HMAC-SHA256`
- 腾讯云 `TC3-HMAC-SHA256`
- 华为云 `SDK-HMAC-SHA256`
- 火山引擎 `HMAC-SHA256`
- 百度智能云 `bce-auth-v1`
- 长期 AK/SK 与 STS 临时 Token
- 本地签名预览、真实请求、取消、代理和测试证书模式

## 为什么不在便携版中嵌入官方 SDK

阿里云与腾讯云官方 SDK 能处理模型、重试、签名和版本差异，适合普通服务端项目。但官方主流 SDK 以 Java、Python、Node.js、Go 等语言为主；在当前 Tauri 应用中嵌入这些运行时，会增加 EXE 体积、启动依赖和打包故障面，也难以保留原始 Canonical Request 供调试。

标准 OpenAPI 的签名协议稳定且范围清楚，使用 Rust 的 `hmac`、`sha2`、`reqwest` 实现更符合单 EXE 目标。实现以厂商官方固定向量做回归测试。

## 前后端边界

```text
React 云 API 工作区
  ├─ 请求模板、参数与响应展示
  ├─ AK/SK/STS Token 仅保存在组件内存
  └─ 不具备直接网络、文件或 Shell 权限
              │ Tauri IPC
              ▼
Rust Cloud Signer
  ├─ 校验厂商与官方 HTTPS 域名
  ├─ 规范化 Query / Header / Payload Hash
  ├─ 生成 ACS3 或 TC3 Authorization
  ├─ SK 不持久化、不返回；STS 诊断脱敏
  └─ reqwest 发送、超时、代理、取消
```

## 安全约束

- 阿里云端点只允许 `aliyuncs.com` 及其子域名。
- 腾讯云端点只允许 `tencentcloudapi.com` 及其子域名。
- 华为云端点只允许 `myhuaweicloud.com`、`huaweicloud.com` 及其子域名。
- 火山引擎端点只允许 `volcengineapi.com`、`volces.com` 及其子域名。
- 百度智能云端点只允许 `baidubce.com`、`bcebos.com` 及其子域名。
- 云调用只允许 HTTPS，URL 不允许内嵌用户名或密码。
- AccessKey Secret 不出现在 IPC 响应、错误或签名诊断中。
- Authorization 诊断会遮盖 AccessKey ID；阿里云 STS Token 会从 Canonical Request 诊断中遮盖。
- 凭据不写入 SQLite、localStorage 或配置文件。

## SDK/适配器决策

| 接口类型 | 当前策略 | 原因 |
| --- | --- | --- |
| 阿里云标准 OpenAPI | Rust ACS3 通用签名器 | 统一、轻量、可诊断 |
| 腾讯云 API 3.0 | Rust TC3 通用签名器 | 统一、轻量、可诊断 |
| 华为云 API Gateway | Rust SDK-HMAC 通用签名器 | 官方允许缺少对应语言 SDK 时按协议签名 |
| 火山引擎 OpenAPI | Rust HMAC-SHA256 通用签名器 | Action/Version 与 Region/Service 可统一建模 |
| 百度智能云 BCE API | Rust BCE V1 通用签名器 | REST 协议稳定，官方提供完整固定向量 |
| OSS / COS / BOS 基础对象工作流 | 独立 Rust 适配器（3.5 已实现） | 签名、对象路径、流式文件 I/O 与通用 OpenAPI 分离 |
| 对象存储分片上传 / 断点续传 | 后续专用状态机 | 需要 uploadId、分片校验、恢复状态和并发治理 |
| SLS、Tablestore、自有网关 | 按服务单独评估 | 厂商明确使用自维护协议 |
| 文件上传 / multipart | 后续专用请求编辑器 | 当前通用工作区聚焦 JSON、Query 与签名验证 |

## 扩展步骤

1. 在后端增加服务适配器，并保留统一的脱敏响应结构。
2. 用厂商官方固定签名向量增加测试。
3. 在前端模板中声明请求参数位置、内容类型和风险提示。
4. 只有在协议包含流式上传、复杂重试或服务发现时才引入 Rust SDK。

## 官方规范依据

- [阿里云 OpenAPI V3 请求结构与签名](https://help.aliyun.com/en/sdk/product-overview/v3-request-structure-and-signature)
- [阿里云 SendSms](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)
- [腾讯云 TC3-HMAC-SHA256 签名](https://intl.cloud.tencent.com/document/product/242/54220)
- [腾讯云 API 3.0 公共参数](https://intl.cloud.tencent.com/document/product/1103/42454)
- [腾讯云 SendSms 2021-01-11](https://cloud.tencent.com/document/product/382/55981)
- [华为云 API 签名认证机制](https://support.huaweicloud.com/intl/en-us/devg-apisign/api-sign-algorithm-001.html)
- [华为云签名固定示例](https://support.huaweicloud.com/intl/en-us/devg-apisign/api-sign-algorithm-002.html)
- [火山引擎 OpenAPI 签名机制](https://www.volcengine.com/docs/6392/1272450)
- [百度智能云 BCE V1 认证字符串](https://cloud.baidu.com/doc/Reference/s/njwvz1yfu)
- [对象存储专用适配器设计](object-storage-architecture.md)
