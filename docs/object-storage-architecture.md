# 对象存储专用适配器

## 3.5 支持范围

API Explorer 将对象存储作为独立工作区处理，不把二进制文件和对象语义塞入通用 OpenAPI 编辑器。

| 服务商 | 签名协议 | 桶列表 | 对象列表 | 简单上传 | 流式下载 | GET/PUT 预签名 |
| --- | --- | --- | --- | --- | --- | --- |
| 阿里云 OSS | `OSS4-HMAC-SHA256` | 支持 | 支持 | 支持 | 支持 | 支持 |
| 腾讯云 COS | XML API `q-sign-algorithm=sha1` | 支持 | 支持 | 支持 | 支持 | 支持 |
| 百度智能云 BOS | `bce-auth-v1` | 支持 | 支持 | 支持 | 支持 | 长期 AK/SK 支持 |
| 七牛云 Kodo | Qiniu MAC / UpToken | 支持 | 支持 | 支持（表单直传） | 支持（源站 IO） | 下载链接 / 上传凭证 |

上传是单次 PutObject，最大 5 GiB。分片上传、并行上传、断点续传、批量删除和跨桶复制不在 3.5 范围内。

## 前后端边界

```text
React 对象存储工作区
  ├─ 服务商 / Region / Bucket / Object Key
  ├─ 本地文件绝对路径与显式风险确认
  ├─ AK / SK / STS Token 仅保存在组件内存
  └─ 展示响应、保存路径、预签名 URL 与脱敏诊断
              │ Tauri IPC
              ▼
Rust Object Storage Adapter
  ├─ 仅根据受控字段生成官方 HTTPS Endpoint
  ├─ OSS4 / COS / BCE 签名与固定向量回归
  ├─ tokio + reqwest 流式上传下载
  ├─ 下载写临时文件，成功后原子改名
  └─ 超时、取消、响应大小限制与错误结构化
```

前端没有 Tauri 文件系统、Shell 或 HTTP 权限。本地路径作为用户显式输入传入两个窄 IPC 命令，所有校验和文件 I/O 都在 Rust 中执行。

## 安全约束

- OSS Endpoint 固定在 `aliyuncs.com`，COS 固定在 `myqcloud.com`，BOS 固定在 `bcebos.com`，七牛固定在 `qiniuapi.com` / `qiniup.com` / `qbox.me` / `qiniuio.com`。
- Region、Bucket 经过 DNS 组件校验；Object Key 按路径段编码，`.` 与 `..` 不会成为 URL 路径归一化指令。
- SK 不返回前端、不写数据库、不写浏览器存储；AK 在签名诊断中遮盖。
- STS Token 在 Canonical Request 与签名诊断中脱敏。
- 上传必须显式确认同名远端对象可能被覆盖。
- 下载目标必须是绝对路径且不能已存在；数据先写随机 `.part` 文件，取消或失败时清理，完成后再改为最终文件名。
- 文本列表响应限制为 8 MiB，避免异常响应占满内存；文件上传下载使用流式 I/O。
- 预签名操作不发网络请求。链接本身拥有临时权限，应采用最小权限凭据和完成任务所需的最短有效期。
- OSS 使用 STS 预签名时最长 12 小时；长期 AK/SK 最长 7 天。
- BOS 官方说明 STS 预签名仍需调用方额外携带 `x-bce-security-token` 请求头，因此 3.5 拒绝生成无法单独直接使用的 STS 链接。

## 为什么不集成厂商 SDK

三家对象存储 SDK 的成熟语言主要是 Java、Go、Python、Node.js、C/C++ 等。为 Tauri Windows 便携版再嵌入这些运行时或动态库，会增加体积、部署依赖和故障面。基础 REST 操作的协议边界明确，纯 Rust 实现可以同时保留单 EXE、流式 I/O 和 Canonical Request 诊断。

当引入分片上传、断点续传、区域重定向、CRC64 校验或复杂重试后，应再评估成熟 Rust S3/对象存储库；这些能力不应继续堆入当前简单 PutObject 流程。

## 官方规范依据

- [阿里云 OSS V4 Authorization 签名](https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4)
- [阿里云 OSS V4 预签名 URL](https://help.aliyun.com/zh/oss/developer-reference/add-signatures-to-urls)
- [阿里云 OSS ListBuckets](https://help.aliyun.com/zh/oss/developer-reference/listbuckets)
- [阿里云 OSS PutObject](https://help.aliyun.com/zh/oss/developer-reference/putobject)
- [腾讯云 COS XML API 请求签名](https://intl.cloud.tencent.com/document/product/436/7778)
- [腾讯云 COS 预签名 URL](https://cloud.tencent.com/document/product/436/68284)
- [百度智能云 BCE V1 认证字符串](https://cloud.baidu.com/doc/Reference/s/njwvz1yfu)
- [百度智能云 BOS ListObjects](https://cloud.baidu.com/doc/BOS/s/Ekc4epj6m)
- [百度智能云 BOS STS 访问控制](https://cloud.baidu.com/doc/BOS/s/Tjwvysda9)
- [七牛云管理凭证 Qiniu MAC](https://developer.qiniu.com/kodo/1201/access-token)
- [七牛云上传凭证](https://developer.qiniu.com/kodo/1208/upload-token)
- [七牛云资源下载与私有链接](https://developer.qiniu.com/kodo/1658/get)
