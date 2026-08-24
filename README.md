# API Explorer

API Explorer 3.5 已从 PyQt5 重构为 **Rust + Tauri v2 + React** 桌面应用。它读取 `ApiInfo2.0.db` 接口库，用于管理和调用预配置的厂商 API，并提供独立的云 API AK/SK 与对象存储工作区。

## 功能

- 按应用、分组和接口浏览 138 个 API 配置
- 支持 GET、POST、PUT、PATCH、DELETE 等合法 HTTP 方法，以及 JSON 与表单请求体
- 支持 `{id}`、`{secert}`、`{token}` 模板替换
- 支持 Token JSON 字段、正则及响应 Cookie 提取
- 展示接口规范状态、版本、核验日期、变更说明和官方文档
- 支持 Base URL 覆盖、HTTP/SOCKS 代理和可选的自签名证书模式
- 可视化编辑 Path、Query、Header、Body 参数；认证模板保持只读
- 展示状态码、耗时、响应头、格式化响应和会话请求历史
- 长请求可通过界面、`Esc` 或取消按钮停止
- `Ctrl+Enter` 发送请求、`Ctrl+K` 搜索接口、`F6` 切换主要窗格
- 云 API 工作区支持阿里云、腾讯云、华为云、火山引擎、百度智能云的通用 AK/SK 签名、STS 临时 Token、签名预览及只读资源模板
- 对象存储工作区支持阿里云 OSS、腾讯云 COS、百度智能云 BOS 的桶列表、对象列表、简单上传、流式下载及 GET/PUT 预签名 URL
- 上传前必须显式确认同名对象覆盖风险；下载只写入新的本地文件，并在完整传输成功后原子完成

## 技术架构

```text
React / TypeScript UI
        │ Tauri IPC（仅注册的业务命令）
        ▼
Rust Core
  ├─ rusqlite：本地接口库
  ├─ HMAC / SHA-256：五家中国云服务商的本机签名适配器
  ├─ OSS4 / COS SHA-1 / BCE V1：三家对象存储专用适配器
  ├─ tokio stream：对象上传下载的有界内存流式 I/O
  ├─ reqwest：HTTP / HTTPS / Proxy
  └─ regex：Token 提取
```

前端不具备任意文件系统、Shell 或网络权限。数据库访问和外部 API 请求均由 Rust 命令执行；TLS 证书校验默认开启。

云 API 没有嵌入需要额外运行时的 Java/Python/Node SDK。标准 OpenAPI 由 Rust 直接签名，当前覆盖阿里云 ACS3、腾讯云 TC3、华为云 SDK-HMAC、火山引擎 HMAC-SHA256 与百度智能云 BCE V1。对象存储另用专用 Rust 适配器实现 OSS V4、COS XML API 签名和 BOS BCE V1，不复用通用 JSON 请求编辑器。端点由 Rust 根据服务商、Region 与 Bucket 生成，只允许厂商官方 HTTPS 域名；AccessKey Secret 只在当前进程内存中参与签名，不写入 SQLite、浏览器存储或签名诊断。详见 [云 AK/SK 架构](docs/cloud-aksk-architecture.md)与[对象存储架构](docs/object-storage-architecture.md)。

当前对象存储上传使用单次 PutObject，最大 5 GiB；更大对象、断点续传和并行分片上传不在 3.5 范围内。下载采用流式传输，目标文件已存在时会拒绝执行，传输未完成的临时文件会被清理。预签名 URL 只在本机生成，不发网络请求；BOS 使用 STS 预签名时官方还要求调用方额外携带 `x-bce-security-token` 请求头，因此工具会拒绝生成容易误用的链接。

## 开发

环境要求：

- Node.js 20+
- Rust stable
- Windows 上的 WebView2 与 Visual Studio C++ Build Tools

```bash
npm install
npm run tauri dev
```

只检查前端：

```bash
npm run check
npm run build
```

检查 Rust：

```bash
cd src-tauri
cargo test
cargo check
```

## 打包

```bash
npm run tauri build
```

安装包会包含 `ApiInfo2.0.db`。应用第一次启动时，会将数据库复制到系统应用数据目录；后续参数修改只写入该用户副本。接口目录升级时，应用会先创建带目录版本号的数据库备份，再更新受影响的厂商接口配置；这些接口上手动保存的参数可能被新版规范覆盖，可从备份恢复。实际路径显示在应用底部状态栏中。

### Windows 单 EXE 便携版

```bash
npm run build:portable
```

产物位于 `artifacts/portable/`。默认接口库已经嵌入 EXE，首次运行时会在 EXE 所在目录释放可写的 `ApiInfo2.0.db`；后续参数和目录备份也保存在该目录，因此移动时应将 EXE 与运行后生成的数据库一起移动。程序仍依赖 Windows WebView2 Runtime，Windows 10/11 通常已经预装。

## 接口规范目录

3.2 的接口目录按 2026-08-06 可访问的厂商官方文档逐条复核，覆盖微信公众号、微信小程序、企业微信、百度/腾讯/高德地图、飞书、钉钉、绿盟 RSAS 与代理连通性检查。

- 更新清单：[data/api_catalog_updates_2026-08-06.json](data/api_catalog_updates_2026-08-06.json)
- 独立迁移工具：`python scripts/update_catalog.py --database ApiInfo2.0.db`
- `active` 表示当前有效，`legacy` 表示仍有效但官方建议新实现迁移，`unverified` 表示公开官方资料不足，`test-only` 表示非正式厂商接口并禁止执行

原项目共有 87 条接口。3.2 目录共有 138 条：除复核和修订原有 87 条外，累计纳入 51 条真正新增接口，其中 50 条是本次针对 3.1 目录补入的 ID 89–138，另 1 条是此前补入的小程序稳定版 Token（ID 88）；同时新增 9 个功能分组。

本次新增覆盖：公众号草稿创建/更新及发布流程，小程序手机号、URL Link 和内容安全，企业微信成员/部门删除、应用消息、客户联系和日程，百度/腾讯/高德的当前地图能力，飞书 OAuth、通讯录和 IM，以及钉钉 TOPAPI CRUD、v1.0 机器人和待办。目录是面向本工具常用场景的已核验精选集，并非厂商全部 OpenAPI 的完整镜像。

每条正式记录的 `doc_url` 均指向相应官方规范。绿盟 RSAS 的详细二次开发规范未公开，相关固件接口仍明确标为 `unverified`；本地序列化测试项标为 `test-only` 并禁止发送。

## 数据兼容性

沿用原版三张核心表：

- `application`：应用、认证字段名称、默认 Base URL
- `group`：应用下的接口分组
- `function`：方法、URL、请求参数、Token 规则和接口说明

3.2 为 `function` 增加 `path_params`、`spec_status`、`spec_version`、`doc_url`、`verified_at`、`change_note`，并用 `api_catalog_metadata` 记录目录版本。旧用户数据库首次启动时会自动备份并原地迁移，重复执行迁移是幂等的；即使目录版本号已更新，缺失的新分组或接口也会被自动修复。

仓库中的原 PyQt5 文件暂时保留，便于核对迁移行为；新版本入口为 `package.json` 与 `src-tauri/`。

## 安全提示

仅对你有权访问和测试的 API 使用本工具。认证信息只保存在当前界面状态中，不写入浏览器存储。开启“允许无效证书”会关闭 TLS 证书校验，只应在受信任的测试环境中短时使用。
