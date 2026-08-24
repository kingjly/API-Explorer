use crate::AppError;
use base64::{engine::general_purpose::URL_SAFE, Engine as _};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use reqwest::{
    header::{
        HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE,
        HOST,
    },
    Body, Client, Method, Proxy, Url,
};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    str::FromStr,
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;
use tokio_util::{io::ReaderStream, sync::CancellationToken};

type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

const MAX_SIMPLE_UPLOAD: u64 = 5 * 1024 * 1024 * 1024;
const MAX_TEXT_RESPONSE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StorageProvider {
    AlibabaOss,
    TencentCos,
    BaiduBos,
    QiniuKodo,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StorageOperation {
    ListBuckets,
    ListObjects,
    UploadObject,
    DownloadObject,
    PresignGet,
    PresignPut,
}

impl StorageOperation {
    fn method(self) -> Method {
        match self {
            Self::UploadObject | Self::PresignPut => Method::PUT,
            _ => Method::GET,
        }
    }

    fn is_presign(self) -> bool {
        matches!(self, Self::PresignGet | Self::PresignPut)
    }

    fn needs_bucket(self) -> bool {
        !matches!(self, Self::ListBuckets)
    }

    fn needs_object(self) -> bool {
        matches!(
            self,
            Self::UploadObject | Self::DownloadObject | Self::PresignGet | Self::PresignPut
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageCredentials {
    access_key_id: String,
    access_key_secret: String,
    security_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageRequest {
    pub(crate) request_id: String,
    provider: StorageProvider,
    operation: StorageOperation,
    region: String,
    bucket: String,
    object_key: String,
    prefix: String,
    delimiter: String,
    max_keys: u16,
    local_path: String,
    download_path: String,
    content_type: String,
    expires_seconds: u32,
    overwrite_confirmed: bool,
    credentials: StorageCredentials,
    proxy_url: Option<String>,
    allow_invalid_certificates: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageSignaturePreview {
    algorithm: &'static str,
    timestamp: String,
    signed_headers: String,
    canonical_request: String,
    string_to_sign: String,
    authorization: String,
    redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageResponseHeader {
    name: String,
    value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageResponse {
    status: Option<u16>,
    status_text: String,
    elapsed_ms: u128,
    url: String,
    content_type: String,
    headers: Vec<StorageResponseHeader>,
    body: String,
    saved_path: Option<String>,
    bytes_transferred: u64,
    presigned_url: Option<String>,
    signature: StorageSignaturePreview,
}

struct PreparedStorageRequest {
    method: Method,
    url: Url,
    headers: HeaderMap,
    signature: StorageSignaturePreview,
    presigned_url: Option<String>,
}

pub(crate) fn preview(request: &StorageRequest) -> Result<StorageSignaturePreview, AppError> {
    Ok(prepare(request, Utc::now().timestamp())?.signature)
}

pub(crate) async fn execute(
    request: StorageRequest,
    cancellation: CancellationToken,
) -> Result<StorageResponse, AppError> {
    if request.operation == StorageOperation::UploadObject && !request.overwrite_confirmed {
        return Err(AppError::new(
            "upload_confirmation_required",
            "上传同名对象可能覆盖远端数据，请先勾选风险确认",
        ));
    }
    let prepared = prepare(&request, Utc::now().timestamp())?;
    if request.operation.is_presign() {
        let presigned_url = prepared
            .presigned_url
            .clone()
            .ok_or_else(|| AppError::new("presign_error", "预签名 URL 未生成"))?;
        return Ok(StorageResponse {
            status: None,
            status_text: "本机生成".into(),
            elapsed_ms: 0,
            url: prepared.url.to_string(),
            content_type: String::new(),
            headers: Vec::new(),
            body: "预签名 URL 已在本机生成，未发送网络请求。".into(),
            saved_path: None,
            bytes_transferred: 0,
            presigned_url: Some(presigned_url),
            signature: prepared.signature,
        });
    }

    let client = build_client(&request)?;
    match request.operation {
        StorageOperation::UploadObject => {
            execute_upload(&request, prepared, client, cancellation).await
        }
        StorageOperation::DownloadObject => {
            execute_download(&request, prepared, client, cancellation).await
        }
        StorageOperation::ListBuckets | StorageOperation::ListObjects => {
            execute_text(prepared, client, cancellation).await
        }
        StorageOperation::PresignGet | StorageOperation::PresignPut => unreachable!(),
    }
}

fn build_client(request: &StorageRequest) -> Result<Client, AppError> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .danger_accept_invalid_certs(request.allow_invalid_certificates)
        .user_agent(concat!(
            "API-Explorer/",
            env!("CARGO_PKG_VERSION"),
            " ObjectStorage"
        ));
    if let Some(proxy_url) = request
        .proxy_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        builder = builder.proxy(
            Proxy::all(proxy_url.trim())
                .map_err(|_| AppError::new("invalid_proxy", "代理地址格式无效"))?,
        );
    }
    builder
        .build()
        .map_err(|error| AppError::new("client_error", format!("无法创建请求客户端：{error}")))
}

async fn execute_text(
    prepared: PreparedStorageRequest,
    client: Client,
    cancellation: CancellationToken,
) -> Result<StorageResponse, AppError> {
    let PreparedStorageRequest {
        method,
        url,
        headers,
        signature,
        ..
    } = prepared;
    let started_at = Instant::now();
    let response = tokio::select! {
        result = client.request(method, url).headers(headers).send() => result.map_err(map_request_error)?,
        _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "对象存储请求已取消")),
    };
    response_to_text(response, started_at, signature, cancellation).await
}

async fn execute_upload(
    request: &StorageRequest,
    prepared: PreparedStorageRequest,
    client: Client,
    cancellation: CancellationToken,
) -> Result<StorageResponse, AppError> {
    let source = absolute_file_path(&request.local_path, "上传文件")?;
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|error| AppError::new("file_error", format!("无法读取上传文件：{error}")))?;
    if !metadata.is_file() {
        return Err(AppError::new("invalid_file", "上传路径不是普通文件"));
    }
    if metadata.len() > MAX_SIMPLE_UPLOAD {
        return Err(AppError::new(
            "file_too_large",
            "简单上传限制为 5 GiB；更大的对象需要后续分片上传工作流",
        ));
    }
    if request.provider == StorageProvider::QiniuKodo {
        return execute_qiniu_form_upload(request, prepared, client, cancellation, source, metadata.len()).await;
    }
    let file = tokio::fs::File::open(&source)
        .await
        .map_err(|error| AppError::new("file_error", format!("无法打开上传文件：{error}")))?;
    let PreparedStorageRequest {
        method,
        url,
        headers,
        signature,
        ..
    } = prepared;
    let stream = ReaderStream::new(file);
    let started_at = Instant::now();
    let response = tokio::select! {
        result = client
            .request(method, url)
            .headers(headers)
            .header(CONTENT_LENGTH, metadata.len())
            .body(Body::wrap_stream(stream))
            .send() => result.map_err(map_request_error)?,
        _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "对象上传已取消")),
    };
    let mut result = response_to_text(response, started_at, signature, cancellation).await?;
    if result
        .status
        .is_some_and(|status| (200..300).contains(&status))
    {
        result.bytes_transferred = metadata.len();
        if result.body.trim().is_empty() {
            result.body = format!("上传完成：{} 字节", metadata.len());
        }
    }
    Ok(result)
}

async fn execute_qiniu_form_upload(
    request: &StorageRequest,
    prepared: PreparedStorageRequest,
    client: Client,
    cancellation: CancellationToken,
    source: PathBuf,
    size: u64,
) -> Result<StorageResponse, AppError> {
    let token = prepared
        .headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("UpToken "))
        .ok_or_else(|| AppError::new("signature_error", "缺少七牛上传凭证"))?
        .to_string();
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let file = tokio::fs::File::open(&source)
        .await
        .map_err(|error| AppError::new("file_error", format!("无法打开上传文件：{error}")))?;
    let part = reqwest::multipart::Part::stream_with_length(Body::wrap_stream(ReaderStream::new(file)), size)
        .file_name(file_name)
        .mime_str(&effective_content_type(request))
        .map_err(|error| AppError::new("file_error", format!("无法构造上传表单：{error}")))?;
    let form = reqwest::multipart::Form::new()
        .text("token", token)
        .text(
            "key",
            request.object_key.trim_start_matches('/').to_string(),
        )
        .part("file", part);
    let started_at = Instant::now();
    let response = tokio::select! {
        result = client.post(prepared.url).multipart(form).send() => result.map_err(map_request_error)?,
        _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "对象上传已取消")),
    };
    let mut result = response_to_text(response, started_at, prepared.signature, cancellation).await?;
    if result
        .status
        .is_some_and(|status| (200..300).contains(&status))
    {
        result.bytes_transferred = size;
        if result.body.trim().is_empty() {
            result.body = format!("上传完成：{size} 字节");
        }
    }
    Ok(result)
}

async fn execute_download(
    request: &StorageRequest,
    prepared: PreparedStorageRequest,
    client: Client,
    cancellation: CancellationToken,
) -> Result<StorageResponse, AppError> {
    let target = absolute_download_path(&request.download_path)?;
    if tokio::fs::try_exists(&target)
        .await
        .map_err(|error| AppError::new("file_error", format!("无法检查下载目标：{error}")))?
    {
        return Err(AppError::new(
            "download_exists",
            "下载目标已经存在；为避免覆盖本地文件，请选择新的保存路径",
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::new("invalid_file", "下载路径缺少父目录"))?;
    if !parent.is_dir() {
        return Err(AppError::new("invalid_file", "下载目标的父目录不存在"));
    }

    let PreparedStorageRequest {
        method,
        url,
        headers,
        signature,
        ..
    } = prepared;
    let started_at = Instant::now();
    let response = tokio::select! {
        result = client.request(method, url).headers(headers).send() => result.map_err(map_request_error)?,
        _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "对象下载已取消")),
    };
    let status = response.status();
    if !status.is_success() {
        return response_to_text(response, started_at, signature, cancellation).await;
    }

    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let headers = response_headers(response.headers());
    let partial = partial_path(&target)?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .await
        .map_err(|error| AppError::new("file_error", format!("无法创建下载临时文件：{error}")))?;
    let mut stream = response.bytes_stream();
    let transfer_result: Result<u64, AppError> = async {
        let mut total = 0_u64;
        loop {
            let next = tokio::select! {
                chunk = stream.next() => chunk,
                _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "对象下载已取消")),
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(map_request_error)?;
            file.write_all(&chunk)
                .await
                .map_err(|error| AppError::new("file_error", format!("写入下载文件失败：{error}")))?;
            total = total.saturating_add(chunk.len() as u64);
        }
        file.flush()
            .await
            .map_err(|error| AppError::new("file_error", format!("刷新下载文件失败：{error}")))?;
        Ok(total)
    }
    .await;
    drop(file);

    let bytes_transferred = match transfer_result {
        Ok(total) => total,
        Err(error) => {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(error);
        }
    };
    if let Err(error) = tokio::fs::rename(&partial, &target).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(AppError::new(
            "file_error",
            format!("完成下载文件失败：{error}"),
        ));
    }

    Ok(StorageResponse {
        status: Some(status.as_u16()),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        elapsed_ms: started_at.elapsed().as_millis(),
        url: final_url,
        content_type,
        headers,
        body: format!("下载完成：{bytes_transferred} 字节"),
        saved_path: Some(target.to_string_lossy().into_owned()),
        bytes_transferred,
        presigned_url: None,
        signature,
    })
}

async fn response_to_text(
    response: reqwest::Response,
    started_at: Instant,
    signature: StorageSignaturePreview,
    cancellation: CancellationToken,
) -> Result<StorageResponse, AppError> {
    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let headers = response_headers(response.headers());
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let next = tokio::select! {
            chunk = stream.next() => chunk,
            _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "对象存储请求已取消")),
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(map_request_error)?;
        if body.len().saturating_add(chunk.len()) > MAX_TEXT_RESPONSE {
            return Err(AppError::new(
                "response_too_large",
                "对象存储文本响应超过 8 MiB 限制",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(StorageResponse {
        status: Some(status.as_u16()),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        elapsed_ms: started_at.elapsed().as_millis(),
        url: final_url,
        content_type,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
        saved_path: None,
        bytes_transferred: 0,
        presigned_url: None,
        signature,
    })
}

fn response_headers(headers: &HeaderMap) -> Vec<StorageResponseHeader> {
    headers
        .iter()
        .map(|(name, value)| StorageResponseHeader {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<二进制值>").to_string(),
        })
        .collect()
}

fn prepare(request: &StorageRequest, timestamp: i64) -> Result<PreparedStorageRequest, AppError> {
    validate_request(request)?;
    let method = request.operation.method();
    let expires = effective_expiration(request)?;
    let query_pairs = list_query(request);
    let canonical_query = canonical_query(&query_pairs);
    let (mut url, signing_path) = endpoint(request)?;
    if !canonical_query.is_empty() {
        url.set_query(Some(&canonical_query));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::new("invalid_storage_endpoint", "对象存储地址缺少主机名"))?
        .to_string();

    match request.provider {
        StorageProvider::AlibabaOss => prepare_oss(
            request,
            method,
            url,
            host,
            &signing_path,
            &query_pairs,
            timestamp,
            expires,
        ),
        StorageProvider::TencentCos => prepare_cos(
            request,
            method,
            url,
            host,
            &signing_path,
            &query_pairs,
            timestamp,
            expires,
        ),
        StorageProvider::BaiduBos => prepare_bos(
            request,
            method,
            url,
            host,
            &signing_path,
            &query_pairs,
            timestamp,
            expires,
        ),
        StorageProvider::QiniuKodo => {
            prepare_qiniu(request, url, host, &signing_path, &query_pairs, timestamp, expires)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_oss(
    request: &StorageRequest,
    method: Method,
    mut url: Url,
    host: String,
    signing_path: &str,
    query_pairs: &[(String, String)],
    timestamp: i64,
    expires: u32,
) -> Result<PreparedStorageRequest, AppError> {
    let datetime = utc_datetime(timestamp)?;
    let date = datetime.format("%Y%m%d").to_string();
    let iso_date = datetime.format("%Y%m%dT%H%M%SZ").to_string();
    let scope = format!("{}/{}/oss/aliyun_v4_request", date, request.region.trim());

    if request.operation.is_presign() {
        let mut presign_pairs = query_pairs.to_vec();
        presign_pairs.extend([
            ("x-oss-additional-headers".into(), "host".into()),
            (
                "x-oss-credential".into(),
                format!("{}/{}", request.credentials.access_key_id.trim(), scope),
            ),
            ("x-oss-date".into(), iso_date.clone()),
            ("x-oss-expires".into(), expires.to_string()),
            ("x-oss-signature-version".into(), "OSS4-HMAC-SHA256".into()),
        ]);
        if !request.credentials.security_token.trim().is_empty() {
            presign_pairs.push((
                "x-oss-security-token".into(),
                request.credentials.security_token.trim().into(),
            ));
        }
        let canonical_query = canonical_query(&presign_pairs);
        let canonical_request = format!(
            "{}\n{}\n{}\nhost:{}\n\nhost\nUNSIGNED-PAYLOAD",
            method.as_str(),
            signing_path,
            canonical_query,
            host
        );
        let string_to_sign = format!(
            "OSS4-HMAC-SHA256\n{}\n{}\n{}",
            iso_date,
            scope,
            sha256_hex(canonical_request.as_bytes())
        );
        let signature = oss_signature(
            &request.credentials.access_key_secret,
            &date,
            request.region.trim(),
            &string_to_sign,
        )?;
        let full_query = format!("{}&x-oss-signature={signature}", canonical_query);
        url.set_query(Some(&full_query));
        let actual_url = url.to_string();
        return Ok(PreparedStorageRequest {
            method,
            url,
            headers: HeaderMap::new(),
            signature: StorageSignaturePreview {
                algorithm: "OSS4-HMAC-SHA256",
                timestamp: iso_date,
                signed_headers: "host".into(),
                canonical_request: redact_token(&canonical_request, &request.credentials),
                string_to_sign,
                authorization: redact_token(
                    &actual_url.replace(
                        request.credentials.access_key_id.trim(),
                        &mask_key_id(&request.credentials.access_key_id),
                    ),
                    &request.credentials,
                ),
                redacted: !request.credentials.security_token.trim().is_empty(),
            },
            presigned_url: Some(actual_url),
        });
    }

    let mut canonical_headers = BTreeMap::from([
        ("host".to_string(), host.clone()),
        (
            "x-oss-content-sha256".to_string(),
            "UNSIGNED-PAYLOAD".to_string(),
        ),
        ("x-oss-date".to_string(), iso_date.clone()),
    ]);
    if request.operation == StorageOperation::UploadObject {
        canonical_headers.insert("content-type".into(), effective_content_type(request));
    }
    if !request.credentials.security_token.trim().is_empty() {
        canonical_headers.insert(
            "x-oss-security-token".into(),
            request.credentials.security_token.trim().into(),
        );
    }
    let canonical_header_text = canonical_headers
        .iter()
        .map(|(name, value)| format!("{name}:{}", normalize_header_value(value)))
        .collect::<Vec<_>>()
        .join("\n");
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n\nhost\nUNSIGNED-PAYLOAD",
        method.as_str(),
        signing_path,
        canonical_query(query_pairs),
        canonical_header_text
    );
    let string_to_sign = format!(
        "OSS4-HMAC-SHA256\n{}\n{}\n{}",
        iso_date,
        scope,
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = oss_signature(
        &request.credentials.access_key_secret,
        &date,
        request.region.trim(),
        &string_to_sign,
    )?;
    let authorization = format!(
        "OSS4-HMAC-SHA256 Credential={}/{},AdditionalHeaders=host,Signature={}",
        request.credentials.access_key_id.trim(),
        scope,
        signature
    );
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_named_header(&mut headers, "x-oss-content-sha256", "UNSIGNED-PAYLOAD")?;
    insert_named_header(&mut headers, "x-oss-date", &iso_date)?;
    if request.operation == StorageOperation::UploadObject {
        insert_header(&mut headers, CONTENT_TYPE, &effective_content_type(request))?;
    } else {
        insert_header(&mut headers, ACCEPT, "application/xml")?;
    }
    if !request.credentials.security_token.trim().is_empty() {
        insert_named_header(
            &mut headers,
            "x-oss-security-token",
            request.credentials.security_token.trim(),
        )?;
    }
    Ok(PreparedStorageRequest {
        method,
        url,
        headers,
        signature: StorageSignaturePreview {
            algorithm: "OSS4-HMAC-SHA256",
            timestamp: iso_date,
            signed_headers: "host".into(),
            canonical_request: redact_token(&canonical_request, &request.credentials),
            string_to_sign,
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: !request.credentials.security_token.trim().is_empty(),
        },
        presigned_url: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_cos(
    request: &StorageRequest,
    method: Method,
    mut url: Url,
    host: String,
    signing_path: &str,
    query_pairs: &[(String, String)],
    timestamp: i64,
    expires: u32,
) -> Result<PreparedStorageRequest, AppError> {
    let end = timestamp
        .checked_add(expires as i64)
        .ok_or_else(|| AppError::new("invalid_expiration", "预签名有效期溢出"))?;
    let key_time = format!("{timestamp};{end}");
    let (http_parameters, url_param_list) = cos_parameters(query_pairs);
    let http_headers = format!("host={}", rfc3986(&host));
    let http_string = format!(
        "{}\n{}\n{}\n{}\n",
        method.as_str().to_ascii_lowercase(),
        signing_path,
        http_parameters,
        http_headers
    );
    let string_to_sign = format!("sha1\n{}\n{}\n", key_time, sha1_hex(http_string.as_bytes()));
    let sign_key = hmac_sha1_hex(
        request.credentials.access_key_secret.as_bytes(),
        key_time.as_bytes(),
    )?;
    let signature = hmac_sha1_hex(sign_key.as_bytes(), string_to_sign.as_bytes())?;
    let authorization = format!(
        "q-sign-algorithm=sha1&q-ak={}&q-sign-time={}&q-key-time={}&q-header-list=host&q-url-param-list={}&q-signature={}",
        request.credentials.access_key_id.trim(),
        key_time,
        key_time,
        url_param_list,
        signature
    );

    if request.operation.is_presign() {
        let mut output_pairs = query_pairs.to_vec();
        output_pairs.extend([
            ("q-sign-algorithm".into(), "sha1".into()),
            (
                "q-ak".into(),
                request.credentials.access_key_id.trim().into(),
            ),
            ("q-sign-time".into(), key_time.clone()),
            ("q-key-time".into(), key_time.clone()),
            ("q-header-list".into(), "host".into()),
            ("q-url-param-list".into(), url_param_list.clone()),
            ("q-signature".into(), signature),
        ]);
        if !request.credentials.security_token.trim().is_empty() {
            output_pairs.push((
                "x-cos-security-token".into(),
                request.credentials.security_token.trim().into(),
            ));
        }
        url.set_query(Some(&canonical_query(&output_pairs)));
        let actual_url = url.to_string();
        return Ok(PreparedStorageRequest {
            method,
            url,
            headers: HeaderMap::new(),
            signature: StorageSignaturePreview {
                algorithm: "COS q-sign-algorithm=sha1",
                timestamp: key_time,
                signed_headers: "host".into(),
                canonical_request: http_string,
                string_to_sign,
                authorization: redact_token(
                    &actual_url.replace(
                        request.credentials.access_key_id.trim(),
                        &mask_key_id(&request.credentials.access_key_id),
                    ),
                    &request.credentials,
                ),
                redacted: !request.credentials.security_token.trim().is_empty(),
            },
            presigned_url: Some(actual_url),
        });
    }

    let mut headers = HeaderMap::new();
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    if request.operation == StorageOperation::UploadObject {
        insert_header(&mut headers, CONTENT_TYPE, &effective_content_type(request))?;
    } else {
        insert_header(&mut headers, ACCEPT, "application/xml")?;
    }
    if !request.credentials.security_token.trim().is_empty() {
        insert_named_header(
            &mut headers,
            "x-cos-security-token",
            request.credentials.security_token.trim(),
        )?;
    }
    Ok(PreparedStorageRequest {
        method,
        url,
        headers,
        signature: StorageSignaturePreview {
            algorithm: "COS q-sign-algorithm=sha1",
            timestamp: key_time,
            signed_headers: "host".into(),
            canonical_request: http_string,
            string_to_sign,
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: !request.credentials.security_token.trim().is_empty(),
        },
        presigned_url: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_bos(
    request: &StorageRequest,
    method: Method,
    mut url: Url,
    host: String,
    signing_path: &str,
    query_pairs: &[(String, String)],
    timestamp: i64,
    expires: u32,
) -> Result<PreparedStorageRequest, AppError> {
    let date = utc_datetime(timestamp)?
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    if request.operation.is_presign() && !request.credentials.security_token.trim().is_empty() {
        return Err(AppError::new(
            "unsupported_sts_presign",
            "BOS 官方预签名 URL 使用 STS 时仍要求调用方额外携带 x-bce-security-token 请求头；本工具不会生成看似可直接使用但实际缺少请求头的链接",
        ));
    }
    let signed_headers = if request.operation.is_presign() {
        "host"
    } else {
        "host;x-bce-date"
    };
    let canonical_headers = if request.operation.is_presign() {
        format!("host:{}", rfc3986(&host))
    } else {
        format!("host:{}\nx-bce-date:{}", rfc3986(&host), rfc3986(&date))
    };
    let canonical_request = format!(
        "{}\n{}\n{}\n{}",
        method.as_str(),
        signing_path,
        canonical_query(query_pairs),
        canonical_headers
    );
    let auth_prefix = format!(
        "bce-auth-v1/{}/{}/{}",
        request.credentials.access_key_id.trim(),
        date,
        expires
    );
    let signing_key = hmac_sha256_hex(
        request.credentials.access_key_secret.as_bytes(),
        auth_prefix.as_bytes(),
    )?;
    let signature = hmac_sha256_hex(signing_key.as_bytes(), canonical_request.as_bytes())?;
    let authorization = format!("{auth_prefix}/{signed_headers}/{signature}");

    if request.operation.is_presign() {
        let mut output_pairs = query_pairs.to_vec();
        output_pairs.push(("authorization".into(), authorization.clone()));
        url.set_query(Some(&serialized_query(&output_pairs)));
        let actual_url = url.to_string();
        return Ok(PreparedStorageRequest {
            method,
            url,
            headers: HeaderMap::new(),
            signature: StorageSignaturePreview {
                algorithm: "bce-auth-v1",
                timestamp: date,
                signed_headers: signed_headers.into(),
                canonical_request,
                string_to_sign: auth_prefix.replace(
                    request.credentials.access_key_id.trim(),
                    &mask_key_id(&request.credentials.access_key_id),
                ),
                authorization: actual_url.replace(
                    request.credentials.access_key_id.trim(),
                    &mask_key_id(&request.credentials.access_key_id),
                ),
                redacted: false,
            },
            presigned_url: Some(actual_url),
        });
    }

    let mut headers = HeaderMap::new();
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_named_header(&mut headers, "x-bce-date", &date)?;
    if request.operation == StorageOperation::UploadObject {
        insert_header(&mut headers, CONTENT_TYPE, &effective_content_type(request))?;
    } else {
        insert_header(&mut headers, ACCEPT, "application/json")?;
    }
    if !request.credentials.security_token.trim().is_empty() {
        insert_named_header(
            &mut headers,
            "x-bce-security-token",
            request.credentials.security_token.trim(),
        )?;
    }
    Ok(PreparedStorageRequest {
        method,
        url,
        headers,
        signature: StorageSignaturePreview {
            algorithm: "bce-auth-v1",
            timestamp: date,
            signed_headers: signed_headers.into(),
            canonical_request,
            string_to_sign: auth_prefix.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: !request.credentials.security_token.trim().is_empty(),
        },
        presigned_url: None,
    })
}

fn prepare_qiniu(
    request: &StorageRequest,
    url: Url,
    host: String,
    signing_path: &str,
    query_pairs: &[(String, String)],
    timestamp: i64,
    expires: u32,
) -> Result<PreparedStorageRequest, AppError> {
    match request.operation {
        StorageOperation::ListBuckets | StorageOperation::ListObjects => {
            prepare_qiniu_mac(request, url, host, signing_path, query_pairs, timestamp)
        }
        StorageOperation::UploadObject | StorageOperation::PresignPut => {
            prepare_qiniu_upload(request, url, host, timestamp, expires)
        }
        StorageOperation::DownloadObject | StorageOperation::PresignGet => {
            prepare_qiniu_download(request, signing_path, host, timestamp, expires)
        }
    }
}

fn prepare_qiniu_mac(
    request: &StorageRequest,
    url: Url,
    host: String,
    signing_path: &str,
    query_pairs: &[(String, String)],
    timestamp: i64,
) -> Result<PreparedStorageRequest, AppError> {
    let date = utc_datetime(timestamp)?.format("%Y%m%dT%H%M%SZ").to_string();
    let query = canonical_query(query_pairs);
    let mut signing = format!("GET {signing_path}");
    if !query.is_empty() {
        signing.push('?');
        signing.push_str(&query);
    }
    signing.push_str("\nHost: ");
    signing.push_str(&host);
    signing.push_str("\nContent-Type: application/x-www-form-urlencoded");
    signing.push_str("\nX-Qiniu-Date: ");
    signing.push_str(&date);
    signing.push_str("\n\n");
    let sign = hmac_sha1_bytes(
        request.credentials.access_key_secret.as_bytes(),
        signing.as_bytes(),
    )?;
    let authorization = format!(
        "Qiniu {}:{}",
        request.credentials.access_key_id.trim(),
        URL_SAFE.encode(sign)
    );
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, ACCEPT, "application/json")?;
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_header(&mut headers, CONTENT_TYPE, "application/x-www-form-urlencoded")?;
    insert_named_header(&mut headers, "X-Qiniu-Date", &date)?;
    Ok(PreparedStorageRequest {
        method: Method::GET,
        url,
        headers,
        signature: StorageSignaturePreview {
            algorithm: "qiniu-mac",
            timestamp: date,
            signed_headers: "content-type;host;x-qiniu-date".into(),
            canonical_request: signing,
            string_to_sign: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: false,
        },
        presigned_url: None,
    })
}

fn prepare_qiniu_upload(
    request: &StorageRequest,
    url: Url,
    host: String,
    timestamp: i64,
    expires: u32,
) -> Result<PreparedStorageRequest, AppError> {
    let token = qiniu_upload_token(request, timestamp, expires)?;
    let authorization = format!("UpToken {token}");
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_header(&mut headers, CONTENT_TYPE, &effective_content_type(request))?;
    let masked = authorization.replace(
        request.credentials.access_key_id.trim(),
        &mask_key_id(&request.credentials.access_key_id),
    );
    Ok(PreparedStorageRequest {
        method: Method::POST,
        url,
        headers,
        signature: StorageSignaturePreview {
            algorithm: "qiniu-uptoken",
            timestamp: (timestamp + expires as i64).to_string(),
            signed_headers: "authorization".into(),
            canonical_request: format!(
                "scope={}:{}",
                request.bucket.trim(),
                request.object_key.trim_start_matches('/')
            ),
            string_to_sign: masked.clone(),
            authorization: masked,
            redacted: false,
        },
        presigned_url: if request.operation.is_presign() {
            Some(token)
        } else {
            None
        },
    })
}

fn prepare_qiniu_download(
    request: &StorageRequest,
    signing_path: &str,
    host: String,
    timestamp: i64,
    expires: u32,
) -> Result<PreparedStorageRequest, AppError> {
    let deadline = timestamp
        .checked_add(expires as i64)
        .ok_or_else(|| AppError::new("invalid_expiration", "预签名有效期溢出"))?;
    let unsigned = format!("https://{host}{signing_path}");
    let with_deadline = format!("{unsigned}?e={deadline}");
    let sign = hmac_sha1_bytes(
        request.credentials.access_key_secret.as_bytes(),
        with_deadline.as_bytes(),
    )?;
    let token = format!(
        "{}:{}",
        request.credentials.access_key_id.trim(),
        URL_SAFE.encode(sign)
    );
    let signed = format!("{with_deadline}&token={token}");
    let signed_url = Url::parse(&signed)
        .map_err(|_| AppError::new("invalid_storage_endpoint", "无法生成七牛下载地址"))?;
    let masked = signed.replace(
        request.credentials.access_key_id.trim(),
        &mask_key_id(&request.credentials.access_key_id),
    );
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, ACCEPT, "*/*")?;
    Ok(PreparedStorageRequest {
        method: Method::GET,
        url: signed_url,
        headers,
        signature: StorageSignaturePreview {
            algorithm: "qiniu-download-token",
            timestamp: deadline.to_string(),
            signed_headers: "host".into(),
            canonical_request: with_deadline,
            string_to_sign: masked.clone(),
            authorization: masked,
            redacted: false,
        },
        presigned_url: Some(signed),
    })
}

fn qiniu_upload_token(
    request: &StorageRequest,
    timestamp: i64,
    expires: u32,
) -> Result<String, AppError> {
    let deadline = timestamp
        .checked_add(expires as i64)
        .ok_or_else(|| AppError::new("invalid_expiration", "预签名有效期溢出"))?;
    let policy = serde_json::json!({
        "scope": format!(
            "{}:{}",
            request.bucket.trim(),
            request.object_key.trim_start_matches('/')
        ),
        "deadline": deadline,
    });
    let encoded_policy = URL_SAFE.encode(policy.to_string().as_bytes());
    let sign = hmac_sha1_bytes(
        request.credentials.access_key_secret.as_bytes(),
        encoded_policy.as_bytes(),
    )?;
    Ok(format!(
        "{}:{}:{}",
        request.credentials.access_key_id.trim(),
        URL_SAFE.encode(sign),
        encoded_policy
    ))
}

fn qiniu_zone(region: &str) -> Result<&'static str, AppError> {
    match region.trim().to_ascii_lowercase().as_str() {
        "z0" | "cn-east-1" | "huadong" | "east" => Ok("z0"),
        "z1" | "cn-north-1" | "huabei" | "north" => Ok("z1"),
        "z2" | "cn-south-1" | "huanan" | "south" => Ok("z2"),
        "na0" => Ok("na0"),
        "as0" => Ok("as0"),
        "cn-east-2" => Ok("cn-east-2"),
        _ => Err(AppError::new(
            "invalid_storage_parameter",
            "七牛机房填 z0 / z1 / z2 / na0 / as0 / cn-east-2",
        )),
    }
}

fn qiniu_rsf_host(zone: &str) -> &'static str {
    match zone {
        "z1" => "rsf-z1.qiniuapi.com",
        "z2" => "rsf-z2.qiniuapi.com",
        "na0" => "rsf-na0.qiniuapi.com",
        "as0" => "rsf-as0.qiniuapi.com",
        "cn-east-2" => "rsf-cn-east-2.qiniuapi.com",
        _ => "rsf.qiniuapi.com",
    }
}

fn qiniu_upload_host(zone: &str) -> &'static str {
    match zone {
        "z1" => "upload-z1.qiniup.com",
        "z2" => "upload-z2.qiniup.com",
        "na0" => "upload-na0.qiniup.com",
        "as0" => "upload-as0.qiniup.com",
        "cn-east-2" => "upload-cn-east-2.qiniup.com",
        _ => "upload.qiniup.com",
    }
}

fn qiniu_io_host(zone: &str) -> &'static str {
    match zone {
        "z1" => "iovip-z1.qbox.me",
        "z2" => "iovip-z2.qbox.me",
        "na0" => "iovip-na0.qbox.me",
        "as0" => "iovip-as0.qbox.me",
        "cn-east-2" => "iovip-cn-east-2.qiniuio.com",
        _ => "iovip.qbox.me",
    }
}

fn validate_request(request: &StorageRequest) -> Result<(), AppError> {
    for (value, label) in [
        (&request.credentials.access_key_id, "AccessKey ID"),
        (&request.credentials.access_key_secret, "AccessKey Secret"),
        (&request.region, "Region"),
    ] {
        if value.trim().is_empty() {
            return Err(AppError::new(
                "missing_storage_field",
                format!("{label} 不能为空"),
            ));
        }
    }
    let region = if request.provider == StorageProvider::QiniuKodo {
        request.region.trim().to_ascii_lowercase()
    } else {
        request.region.trim().to_string()
    };
    validate_dns_component(&region, "Region")?;
    if request.operation.needs_bucket() {
        if request.bucket.trim().is_empty() {
            return Err(AppError::new("missing_storage_field", "Bucket 不能为空"));
        }
        validate_bucket(&request.bucket)?;
    }
    if request.operation.needs_object() {
        let key = request.object_key.trim_start_matches('/');
        if key.is_empty() {
            return Err(AppError::new(
                "missing_storage_field",
                "Object Key 不能为空",
            ));
        }
        if request.object_key.len() > 1024 || request.object_key.chars().any(char::is_control) {
            return Err(AppError::new(
                "invalid_object_key",
                "Object Key 格式无效或过长",
            ));
        }
    }
    if request.delimiter.chars().count() > 1 {
        return Err(AppError::new(
            "invalid_storage_parameter",
            "Delimiter 最多只能包含一个字符",
        ));
    }
    if request.prefix.len() > 1024 {
        return Err(AppError::new("invalid_storage_parameter", "Prefix 过长"));
    }
    Ok(())
}

fn effective_expiration(request: &StorageRequest) -> Result<u32, AppError> {
    let expires = if request.expires_seconds == 0 {
        3600
    } else {
        request.expires_seconds
    };
    let maximum = match request.provider {
        StorageProvider::AlibabaOss if !request.credentials.security_token.trim().is_empty() => {
            43_200
        }
        StorageProvider::AlibabaOss => 604_800,
        StorageProvider::TencentCos => 604_800,
        StorageProvider::BaiduBos => 604_800,
        StorageProvider::QiniuKodo => 604_800,
    };
    if !(1..=maximum).contains(&expires) {
        return Err(AppError::new(
            "invalid_expiration",
            format!("有效期必须在 1 到 {maximum} 秒之间"),
        ));
    }
    Ok(expires)
}

fn endpoint(request: &StorageRequest) -> Result<(Url, String), AppError> {
    if request.provider == StorageProvider::QiniuKodo {
        return qiniu_endpoint(request);
    }
    let region = request.region.trim().to_ascii_lowercase();
    let bucket = request.bucket.trim().to_ascii_lowercase();
    let encoded_key = encode_object_key(request.object_key.trim_start_matches('/'));
    let actual_path = if request.operation.needs_object() {
        format!("/{encoded_key}")
    } else {
        "/".into()
    };
    let (host, signing_path) = match request.provider {
        StorageProvider::AlibabaOss => {
            let host = if request.operation == StorageOperation::ListBuckets {
                format!("oss-{region}.aliyuncs.com")
            } else {
                format!("{bucket}.oss-{region}.aliyuncs.com")
            };
            let signing_path = if request.operation == StorageOperation::ListBuckets {
                "/".into()
            } else if request.operation.needs_object() {
                format!("/{bucket}/{encoded_key}")
            } else {
                format!("/{bucket}/")
            };
            (host, signing_path)
        }
        StorageProvider::TencentCos => {
            let host = if request.operation == StorageOperation::ListBuckets {
                "service.cos.myqcloud.com".into()
            } else {
                format!("{bucket}.cos.{region}.myqcloud.com")
            };
            let signing_path = if request.operation.needs_object() {
                format!("/{}", request.object_key.trim_start_matches('/'))
            } else {
                "/".into()
            };
            (host, signing_path)
        }
        StorageProvider::BaiduBos => {
            let host = if request.operation == StorageOperation::ListBuckets {
                format!("{region}.bcebos.com")
            } else {
                format!("{bucket}.{region}.bcebos.com")
            };
            (host, actual_path.clone())
        }
        StorageProvider::QiniuKodo => unreachable!("七牛 Endpoint 已单独生成"),
    };
    let url = Url::parse(&format!("https://{host}{actual_path}"))
        .map_err(|_| AppError::new("invalid_storage_endpoint", "无法生成对象存储官方地址"))?;
    Ok((url, signing_path))
}

fn qiniu_endpoint(request: &StorageRequest) -> Result<(Url, String), AppError> {
    let zone = qiniu_zone(request.region.trim())?;
    let encoded_key = encode_object_key(request.object_key.trim_start_matches('/'));
    let (host, path): (String, String) = match request.operation {
        StorageOperation::ListBuckets => ("uc.qiniuapi.com".into(), "/buckets".into()),
        StorageOperation::ListObjects => (qiniu_rsf_host(zone).into(), "/list".into()),
        StorageOperation::UploadObject | StorageOperation::PresignPut => {
            (qiniu_upload_host(zone).into(), "/".into())
        }
        StorageOperation::DownloadObject | StorageOperation::PresignGet => {
            (qiniu_io_host(zone).into(), format!("/{encoded_key}"))
        }
    };
    let url = Url::parse(&format!("https://{host}{path}"))
        .map_err(|_| AppError::new("invalid_storage_endpoint", "无法生成七牛官方地址"))?;
    Ok((url, path))
}

fn list_query(request: &StorageRequest) -> Vec<(String, String)> {
    if request.operation != StorageOperation::ListObjects {
        return Vec::new();
    }
    let mut pairs = Vec::new();
    if request.provider == StorageProvider::QiniuKodo {
        pairs.push(("bucket".into(), request.bucket.trim().into()));
    }
    if !request.prefix.is_empty() {
        pairs.push(("prefix".into(), request.prefix.clone()));
    }
    if !request.delimiter.is_empty() {
        pairs.push(("delimiter".into(), request.delimiter.clone()));
    }
    let max_keys = request.max_keys.clamp(1, 1000).to_string();
    pairs.push((
        match request.provider {
            StorageProvider::BaiduBos => "maxKeys",
            StorageProvider::QiniuKodo => "limit",
            _ => "max-keys",
        }
        .into(),
        max_keys,
    ));
    pairs
}

fn canonical_query(pairs: &[(String, String)]) -> String {
    encoded_query(pairs, false)
}

fn serialized_query(pairs: &[(String, String)]) -> String {
    encoded_query(pairs, true)
}

fn encoded_query(pairs: &[(String, String)], include_authorization: bool) -> String {
    let mut encoded = pairs
        .iter()
        .filter(|(key, _)| include_authorization || !key.eq_ignore_ascii_case("authorization"))
        .map(|(key, value)| (rfc3986(key), rfc3986(value)))
        .collect::<Vec<_>>();
    encoded.sort();
    encoded
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn cos_parameters(pairs: &[(String, String)]) -> (String, String) {
    let mut encoded = pairs
        .iter()
        .map(|(key, value)| (rfc3986(&key.to_ascii_lowercase()), rfc3986(value)))
        .collect::<Vec<_>>();
    encoded.sort();
    let names = encoded
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let values = encoded
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    (values, names)
}

fn oss_signature(secret: &str, date: &str, region: &str, value: &str) -> Result<String, AppError> {
    let date_key = hmac_sha256_bytes(format!("aliyun_v4{secret}").as_bytes(), date.as_bytes())?;
    let region_key = hmac_sha256_bytes(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256_bytes(&region_key, b"oss")?;
    let signing_key = hmac_sha256_bytes(&service_key, b"aliyun_v4_request")?;
    hmac_sha256_hex(&signing_key, value.as_bytes())
}

fn validate_dns_component(value: &str, label: &str) -> Result<(), AppError> {
    let value = value.trim();
    if value.len() > 63
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(AppError::new(
            "invalid_storage_parameter",
            format!("{label} 只能包含小写字母、数字和连字符"),
        ));
    }
    Ok(())
}

fn validate_bucket(value: &str) -> Result<(), AppError> {
    let value = value.trim();
    if value.len() < 3
        || value.len() > 63
        || value.starts_with(['-', '.'])
        || value.ends_with(['-', '.'])
        || value.contains("..")
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
        })
    {
        return Err(AppError::new(
            "invalid_storage_parameter",
            "Bucket 只能包含 3–63 位小写字母、数字、点和连字符",
        ));
    }
    Ok(())
}

fn encode_object_key(value: &str) -> String {
    value
        .split('/')
        .map(|segment| match segment {
            "." => "%2E".into(),
            ".." => "%2E%2E".into(),
            _ => rfc3986(segment),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn rfc3986(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut result = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            result.push(byte as char);
        } else {
            result.push('%');
            result.push(HEX[(byte >> 4) as usize] as char);
            result.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    result
}

fn effective_content_type(request: &StorageRequest) -> String {
    let value = request.content_type.trim();
    if value.is_empty() {
        "application/octet-stream".into()
    } else {
        value.into()
    }
}

fn absolute_file_path(value: &str, label: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() || !path.is_absolute() {
        return Err(AppError::new(
            "invalid_file",
            format!("{label}必须填写绝对路径"),
        ));
    }
    Ok(path)
}

fn absolute_download_path(value: &str) -> Result<PathBuf, AppError> {
    let path = absolute_file_path(value, "下载保存路径")?;
    if path.file_name().is_none() {
        return Err(AppError::new("invalid_file", "下载保存路径必须包含文件名"));
    }
    Ok(path)
}

fn partial_path(target: &Path) -> Result<PathBuf, AppError> {
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::new("invalid_file", "下载文件名无法编码"))?;
    Ok(target.with_file_name(format!(
        ".{file_name}.api-explorer-{}.part",
        uuid::Uuid::new_v4()
    )))
}

fn utc_datetime(timestamp: i64) -> Result<DateTime<Utc>, AppError> {
    DateTime::<Utc>::from_timestamp(timestamp, 0)
        .ok_or_else(|| AppError::new("invalid_timestamp", "无法生成签名时间"))
}

fn sha256_hex(value: &[u8]) -> String {
    hex_lower(&Sha256::digest(value))
}

fn sha1_hex(value: &[u8]) -> String {
    hex_lower(&Sha1::digest(value))
}

fn hmac_sha256_bytes(key: &[u8], value: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| AppError::new("signature_error", "无法初始化 HMAC-SHA256"))?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hmac_sha256_hex(key: &[u8], value: &[u8]) -> Result<String, AppError> {
    Ok(hex_lower(&hmac_sha256_bytes(key, value)?))
}

fn hmac_sha1_bytes(key: &[u8], value: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut mac = HmacSha1::new_from_slice(key)
        .map_err(|_| AppError::new("signature_error", "无法初始化 HMAC-SHA1"))?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hmac_sha1_hex(key: &[u8], value: &[u8]) -> Result<String, AppError> {
    Ok(hex_lower(&hmac_sha1_bytes(key, value)?))
}

fn hex_lower(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(value.len() * 2);
    for byte in value {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn normalize_header_value(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn insert_header(headers: &mut HeaderMap, name: HeaderName, value: &str) -> Result<(), AppError> {
    let value = HeaderValue::from_str(value)
        .map_err(|_| AppError::new("invalid_header", "对象存储请求头包含无效字符"))?;
    headers.insert(name, value);
    Ok(())
}

fn insert_named_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), AppError> {
    let name = HeaderName::from_str(name)
        .map_err(|_| AppError::new("invalid_header", "对象存储请求头名称无效"))?;
    insert_header(headers, name, value)
}

fn mask_key_id(value: &str) -> String {
    let value = value.trim();
    if value.chars().count() <= 8 {
        return "****".into();
    }
    let head = value.chars().take(4).collect::<String>();
    let tail = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}****{tail}")
}

fn redact_token(value: &str, credentials: &StorageCredentials) -> String {
    let token = credentials.security_token.trim();
    if token.is_empty() {
        value.into()
    } else {
        value
            .replace(token, "<redacted-security-token>")
            .replace(&rfc3986(token), "<redacted-security-token>")
    }
}

fn map_request_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new("timeout", "对象存储请求超时，请检查网络、代理或地域")
    } else if error.is_connect() {
        AppError::new("connection_failed", format!("连接对象存储失败：{error}"))
    } else {
        AppError::new("request_failed", format!("对象存储请求失败：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: StorageProvider, operation: StorageOperation) -> StorageRequest {
        StorageRequest {
            request_id: "test".into(),
            provider,
            operation,
            region: match provider {
                StorageProvider::TencentCos => "ap-beijing",
                StorageProvider::BaiduBos => "bj",
                StorageProvider::AlibabaOss => "cn-hangzhou",
                StorageProvider::QiniuKodo => "z0",
            }
            .into(),
            bucket: match provider {
                StorageProvider::TencentCos => "examplebucket-1250000000",
                _ => "examplebucket",
            }
            .into(),
            object_key: "folder/测试.txt".into(),
            prefix: String::new(),
            delimiter: "/".into(),
            max_keys: 100,
            local_path: r"C:\temp\upload.txt".into(),
            download_path: r"C:\temp\download.txt".into(),
            content_type: "text/plain".into(),
            expires_seconds: 3600,
            overwrite_confirmed: true,
            credentials: StorageCredentials {
                access_key_id: "AKIDEXAMPLE1234".into(),
                access_key_secret: "SECRETEXAMPLE".into(),
                security_token: String::new(),
            },
            proxy_url: None,
            allow_invalid_certificates: false,
        }
    }

    #[test]
    fn oss_v4_matches_official_canonical_hash_and_deterministic_signature() {
        let canonical_request = concat!(
            "PUT\n",
            "/examplebucket/exampleobject\n",
            "\n",
            "content-disposition:attachment\n",
            "content-length:3\n",
            "content-md5:ICy5YqxZB1uWSwcVLSNLcA==\n",
            "content-type:text/plain\n",
            "x-oss-content-sha256:UNSIGNED-PAYLOAD\n",
            "x-oss-date:20250411T064124Z\n",
            "\n",
            "content-disposition;content-length\n",
            "UNSIGNED-PAYLOAD"
        );
        assert_eq!(
            sha256_hex(canonical_request.as_bytes()),
            "c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca"
        );
        let string_to_sign = concat!(
            "OSS4-HMAC-SHA256\n",
            "20250411T064124Z\n",
            "20250411/cn-hangzhou/oss/aliyun_v4_request\n",
            "c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca"
        );
        assert_eq!(
            oss_signature(
                "yourAccessKeySecret",
                "20250411",
                "cn-hangzhou",
                string_to_sign
            )
            .expect("OSS signature should build"),
            "d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097"
        );
    }

    #[test]
    fn cos_http_string_matches_official_download_vector() {
        let http_string = concat!(
            "get\n",
            "/exampleobject(腾讯云)\n",
            "response-cache-control=max-age%3D600&response-content-type=application%2Foctet-stream\n",
            "date=Thu%2C%2016%20May%202019%2006%3A55%3A53%20GMT&host=examplebucket-1250000000.cos.ap-beijing.myqcloud.com\n"
        );
        assert_eq!(
            sha1_hex(http_string.as_bytes()),
            "54ecfe22f59d3514fdc764b87a32d8133ea611e6"
        );
        assert_eq!(
            format!(
                "sha1\n1557989753;1557996953\n{}\n",
                sha1_hex(http_string.as_bytes())
            ),
            "sha1\n1557989753;1557996953\n54ecfe22f59d3514fdc764b87a32d8133ea611e6\n"
        );
    }

    #[test]
    fn bos_key_derivation_matches_official_bce_vector() {
        let auth_prefix = "bce-auth-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2015-04-27T08:23:49Z/1800";
        let signing_key =
            hmac_sha256_hex(b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", auth_prefix.as_bytes())
                .expect("BCE key should build");
        assert_eq!(
            signing_key,
            "1d5ce5f464064cbee060330d973218821825ac6952368a482a592e6615aef479"
        );
    }

    #[test]
    fn generated_endpoints_stay_on_official_domains() {
        for provider in [
            StorageProvider::AlibabaOss,
            StorageProvider::TencentCos,
            StorageProvider::BaiduBos,
            StorageProvider::QiniuKodo,
        ] {
            let request = request(provider, StorageOperation::DownloadObject);
            let (url, _) = endpoint(&request).expect("endpoint should build");
            let host = url.host_str().expect("host should exist");
            assert!(
                host.ends_with(".aliyuncs.com")
                    || host.ends_with(".myqcloud.com")
                    || host.ends_with(".bcebos.com")
                    || host.ends_with(".qbox.me")
                    || host.ends_with(".qiniuio.com")
            );
        }
    }

    #[test]
    fn qiniu_upload_token_has_three_segments_and_hides_secret() {
        let request = request(StorageProvider::QiniuKodo, StorageOperation::PresignPut);
        let prepared = prepare(&request, 1_745_729_029).expect("qiniu upload token should build");
        let token = prepared.presigned_url.expect("upload token should be returned");
        assert_eq!(token.split(':').count(), 3);
        assert!(token.starts_with("AKIDEXAMPLE1234:"));
        assert!(!prepared.signature.authorization.contains("SECRETEXAMPLE"));
        assert_eq!(prepared.method, Method::POST);
        assert_eq!(prepared.url.host_str(), Some("upload.qiniup.com"));
    }

    #[test]
    fn qiniu_download_url_signs_deadline_query() {
        let request = request(StorageProvider::QiniuKodo, StorageOperation::PresignGet);
        let prepared = prepare(&request, 1_745_729_029).expect("qiniu download url should build");
        let signed = prepared.presigned_url.expect("download url should be returned");
        assert!(signed.starts_with("https://iovip.qbox.me/"));
        assert!(signed.contains("e=1745732629"));
        assert!(signed.contains("token=AKIDEXAMPLE1234:"));
        assert!(!prepared.signature.authorization.contains("SECRETEXAMPLE"));
    }

    #[test]
    fn qiniu_list_uses_management_host_and_limit() {
        let request = request(StorageProvider::QiniuKodo, StorageOperation::ListObjects);
        let prepared = prepare(&request, 1_745_729_029).expect("qiniu list should build");
        assert_eq!(prepared.url.host_str(), Some("rsf.qiniuapi.com"));
        assert_eq!(prepared.url.path(), "/list");
        let query = prepared.url.query().unwrap_or("");
        assert!(query.contains("bucket=examplebucket"));
        assert!(query.contains("limit=100"));
        assert!(prepared.signature.authorization.starts_with("Qiniu "));
    }

    #[test]
    fn preview_never_contains_secret_or_session_token() {
        let mut request = request(StorageProvider::AlibabaOss, StorageOperation::ListObjects);
        request.credentials.security_token = "session/token+secret".into();
        let prepared = prepare(&request, 1_745_729_029).expect("signature should build");
        let preview = format!(
            "{}\n{}\n{}",
            prepared.signature.canonical_request,
            prepared.signature.string_to_sign,
            prepared.signature.authorization
        );
        assert!(!preview.contains("SECRETEXAMPLE"));
        assert!(!preview.contains("session/token+secret"));
        assert!(!preview.contains("session%2Ftoken%2Bsecret"));
        assert!(!preview.contains("AKIDEXAMPLE1234"));
    }

    #[test]
    fn bos_presigned_url_contains_encoded_authorization() {
        let request = request(StorageProvider::BaiduBos, StorageOperation::PresignGet);
        let prepared = prepare(&request, 1_745_729_029).expect("BOS URL should build");
        let signed_url = prepared.presigned_url.expect("URL should be returned");
        assert!(signed_url.contains("authorization=bce-auth-v1%2F"));
        assert!(!prepared.signature.authorization.contains("SECRETEXAMPLE"));
    }

    #[test]
    fn object_key_keeps_a_trailing_slash_and_encodes_dot_segments() {
        assert_eq!(encode_object_key("folder/"), "folder/");
        assert_eq!(
            encode_object_key("../folder/./file"),
            "%2E%2E/folder/%2E/file"
        );
    }

    #[test]
    fn signature_preview_does_not_require_upload_confirmation() {
        let mut request = request(StorageProvider::AlibabaOss, StorageOperation::UploadObject);
        request.overwrite_confirmed = false;
        assert!(preview(&request).is_ok());
    }

    #[test]
    fn download_path_requires_absolute_non_existing_target_at_execution_boundary() {
        assert!(absolute_download_path("download.txt").is_err());
        assert!(absolute_download_path(r"C:\temp\download.txt").is_ok());
    }
}
