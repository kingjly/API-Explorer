use crate::AppError;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, HOST},
    Client, Method, Proxy, Url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    str::FromStr,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CloudProvider {
    AlibabaAcs3,
    TencentTc3,
    HuaweiSdkHmac,
    VolcengineHmac,
    BaiduBceV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudCredentials {
    access_key_id: String,
    access_key_secret: String,
    security_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudRequest {
    pub(crate) request_id: String,
    provider: CloudProvider,
    method: String,
    endpoint: String,
    service: String,
    action: String,
    version: String,
    region: String,
    query: String,
    body: String,
    content_type: String,
    credentials: CloudCredentials,
    proxy_url: Option<String>,
    allow_invalid_certificates: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSignaturePreview {
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
pub(crate) struct CloudResponseHeader {
    name: String,
    value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudResponse {
    status: u16,
    status_text: String,
    elapsed_ms: u128,
    url: String,
    content_type: String,
    headers: Vec<CloudResponseHeader>,
    body: String,
    signature: CloudSignaturePreview,
}

struct PreparedRequest {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: String,
    signature: CloudSignaturePreview,
}

pub(crate) async fn execute(
    request: CloudRequest,
    cancellation: CancellationToken,
) -> Result<CloudResponse, AppError> {
    let prepared = prepare(&request, Utc::now().timestamp(), None)?;
    let mut client_builder = Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(request.allow_invalid_certificates)
        .user_agent(concat!(
            "API-Explorer/",
            env!("CARGO_PKG_VERSION"),
            " CloudSigner"
        ));
    if let Some(proxy_url) = request
        .proxy_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let proxy = Proxy::all(proxy_url.trim())
            .map_err(|_| AppError::new("invalid_proxy", "代理地址格式无效"))?;
        client_builder = client_builder.proxy(proxy);
    }
    let client = client_builder
        .build()
        .map_err(|error| AppError::new("client_error", format!("无法创建请求客户端：{error}")))?;
    let PreparedRequest {
        method,
        url,
        headers,
        body,
        signature,
    } = prepared;
    let mut builder = client.request(method, url).headers(headers);
    if !body.is_empty() {
        builder = builder.body(body);
    }

    let started_at = Instant::now();
    let response = tokio::select! {
        result = builder.send() => result.map_err(map_request_error)?,
        _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "请求已取消")),
    };
    let elapsed_ms = started_at.elapsed().as_millis();
    let status = response.status();
    let final_url = response.url().to_string();
    let response_headers = response.headers().clone();
    let content_type = response_headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let headers = response_headers
        .iter()
        .map(|(name, value)| CloudResponseHeader {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<二进制值>").to_string(),
        })
        .collect();
    let body = tokio::select! {
        result = response.text() => result.map_err(|error| AppError::new("response_error", format!("读取响应失败：{error}")))?,
        _ = cancellation.cancelled() => return Err(AppError::new("cancelled", "请求已取消")),
    };

    Ok(CloudResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        elapsed_ms,
        url: final_url,
        content_type,
        headers,
        body,
        signature,
    })
}

pub(crate) fn preview(request: &CloudRequest) -> Result<CloudSignaturePreview, AppError> {
    Ok(prepare(request, Utc::now().timestamp(), None)?.signature)
}

fn prepare(
    request: &CloudRequest,
    timestamp: i64,
    fixed_nonce: Option<&str>,
) -> Result<PreparedRequest, AppError> {
    validate_request(request)?;
    let method = Method::from_str(request.method.trim())
        .map_err(|_| AppError::new("unsupported_method", "云 API 请求方法无效"))?;
    if matches!(request.provider, CloudProvider::TencentTc3)
        && method != Method::GET
        && method != Method::POST
    {
        return Err(AppError::new(
            "unsupported_cloud_method",
            "腾讯云 API 3.0 通用协议只支持 GET 或 POST",
        ));
    }
    let mut url = Url::parse(request.endpoint.trim())
        .map_err(|_| AppError::new("invalid_url", "Endpoint 不是有效的完整 URL"))?;
    validate_endpoint(request.provider, &url)?;
    let effective_query = if matches!(request.provider, CloudProvider::VolcengineHmac) {
        if query_has_key(&request.query, "Action") || query_has_key(&request.query, "Version") {
            return Err(AppError::new(
                "duplicate_cloud_parameter",
                "火山引擎的 Action 和 Version 由专用字段生成，请勿在 Query 中重复填写",
            ));
        }
        let prefix = request.query.trim().trim_start_matches('?');
        let separator = if prefix.is_empty() { "" } else { "&" };
        format!(
            "{prefix}{separator}Action={}&Version={}",
            request.action.trim(),
            request.version.trim()
        )
    } else {
        request.query.clone()
    };
    let canonical_query = canonical_query(url.query(), &effective_query);
    if matches!(request.provider, CloudProvider::TencentTc3) {
        if method == Method::POST && !canonical_query.is_empty() {
            return Err(AppError::new(
                "invalid_cloud_query",
                "腾讯云 POST 请求的业务参数应放入 JSON Body，Query 必须为空",
            ));
        }
        if method == Method::GET && !request.body.trim().is_empty() {
            return Err(AppError::new(
                "invalid_cloud_payload",
                "腾讯云 GET 请求不能包含 Body",
            ));
        }
    }
    url.set_query((!canonical_query.is_empty()).then_some(canonical_query.as_str()));
    let host = authority(&url)?;
    let canonical_uri = if url.path().is_empty() {
        "/".to_string()
    } else {
        url.path().to_string()
    };
    let content_type = if request.content_type.trim().is_empty() {
        match request.provider {
            CloudProvider::AlibabaAcs3 => "application/json; charset=utf-8",
            CloudProvider::TencentTc3 => "application/json; charset=utf-8",
            CloudProvider::HuaweiSdkHmac => "application/json",
            CloudProvider::VolcengineHmac => "application/json",
            CloudProvider::BaiduBceV1 => "application/json; charset=utf-8",
        }
    } else {
        request.content_type.trim()
    };

    match request.provider {
        CloudProvider::AlibabaAcs3 => prepare_aliyun(
            request,
            method,
            url,
            host,
            &canonical_uri,
            &canonical_query,
            content_type,
            timestamp,
            fixed_nonce.unwrap_or_else(|| ""),
        ),
        CloudProvider::TencentTc3 => prepare_tencent(
            request,
            method,
            url,
            host,
            &canonical_uri,
            &canonical_query,
            content_type,
            timestamp,
        ),
        CloudProvider::HuaweiSdkHmac => prepare_huawei(
            request,
            method,
            url,
            host,
            &canonical_uri,
            &canonical_query,
            content_type,
            timestamp,
        ),
        CloudProvider::VolcengineHmac => prepare_volcengine(
            request,
            method,
            url,
            host,
            &canonical_uri,
            &canonical_query,
            content_type,
            timestamp,
        ),
        CloudProvider::BaiduBceV1 => prepare_baidu(
            request,
            method,
            url,
            host,
            &canonical_uri,
            &canonical_query,
            content_type,
            timestamp,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_aliyun(
    request: &CloudRequest,
    method: Method,
    url: Url,
    host: String,
    canonical_uri: &str,
    canonical_query: &str,
    content_type: &str,
    timestamp: i64,
    fixed_nonce: &str,
) -> Result<PreparedRequest, AppError> {
    let datetime = utc_datetime(timestamp)?;
    let date = datetime.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let nonce = if fixed_nonce.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        fixed_nonce.to_string()
    };
    let payload_hash = sha256_hex(request.body.as_bytes());
    let mut canonical_headers = vec![
        ("host", host.clone()),
        ("x-acs-action", request.action.trim().to_string()),
        ("x-acs-content-sha256", payload_hash.clone()),
        ("x-acs-date", date.clone()),
        ("x-acs-signature-nonce", nonce.clone()),
        ("x-acs-version", request.version.trim().to_string()),
    ];
    if !request.body.is_empty() {
        canonical_headers.push(("content-type", content_type.to_string()));
    }
    if !request.credentials.security_token.trim().is_empty() {
        canonical_headers.push((
            "x-acs-security-token",
            request.credentials.security_token.trim().to_string(),
        ));
    }
    canonical_headers.sort_by_key(|(name, _)| *name);
    let signed_headers = canonical_headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_header_text = canonical_headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", normalize_header_value(value)))
        .collect::<String>();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri,
        canonical_query,
        canonical_header_text,
        signed_headers,
        payload_hash
    );
    let string_to_sign = format!(
        "ACS3-HMAC-SHA256\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = hmac_hex(
        request.credentials.access_key_secret.as_bytes(),
        string_to_sign.as_bytes(),
    )?;
    let authorization = format!(
        "ACS3-HMAC-SHA256 Credential={},SignedHeaders={},Signature={}",
        request.credentials.access_key_id.trim(),
        signed_headers,
        signature
    );

    let mut headers = HeaderMap::new();
    if !request.body.is_empty() {
        insert_header(&mut headers, CONTENT_TYPE, content_type)?;
    }
    insert_header(&mut headers, ACCEPT, "application/json")?;
    insert_header(&mut headers, HOST, &host)?;
    for (name, value) in &canonical_headers {
        if *name != "content-type" && *name != "host" {
            insert_named_header(&mut headers, name, value)?;
        }
    }
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;

    let has_token = !request.credentials.security_token.trim().is_empty();
    let preview_canonical = if has_token {
        canonical_request.replace(
            request.credentials.security_token.trim(),
            "<redacted-security-token>",
        )
    } else {
        canonical_request
    };
    Ok(PreparedRequest {
        method,
        url,
        headers,
        body: request.body.clone(),
        signature: CloudSignaturePreview {
            algorithm: "ACS3-HMAC-SHA256",
            timestamp: date,
            signed_headers,
            canonical_request: preview_canonical,
            string_to_sign,
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: has_token,
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_tencent(
    request: &CloudRequest,
    method: Method,
    url: Url,
    host: String,
    canonical_uri: &str,
    canonical_query: &str,
    content_type: &str,
    timestamp: i64,
) -> Result<PreparedRequest, AppError> {
    let datetime = utc_datetime(timestamp)?;
    let date = datetime.format("%Y-%m-%d").to_string();
    let is_get = method == Method::GET;
    let content_type = if is_get {
        "application/x-www-form-urlencoded"
    } else {
        content_type
    };
    let body = if is_get { "" } else { request.body.as_str() };
    let signed_headers = "content-type;host".to_string();
    let canonical_headers = format!("content-type:{content_type}\nhost:{host}\n");
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri,
        canonical_query,
        canonical_headers,
        signed_headers,
        sha256_hex(body.as_bytes())
    );
    let service = request.service.trim().to_ascii_lowercase();
    let scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let secret_date = hmac_bytes(
        format!("TC3{}", request.credentials.access_key_secret).as_bytes(),
        date.as_bytes(),
    )?;
    let secret_service = hmac_bytes(&secret_date, service.as_bytes())?;
    let secret_signing = hmac_bytes(&secret_service, b"tc3_request")?;
    let signature = hex_lower(&hmac_bytes(&secret_signing, string_to_sign.as_bytes())?);
    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        request.credentials.access_key_id.trim(),
        scope,
        signed_headers,
        signature
    );

    let mut headers = HeaderMap::new();
    insert_header(&mut headers, CONTENT_TYPE, content_type)?;
    insert_header(&mut headers, ACCEPT, "application/json")?;
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_named_header(&mut headers, "x-tc-action", request.action.trim())?;
    insert_named_header(&mut headers, "x-tc-version", request.version.trim())?;
    insert_named_header(&mut headers, "x-tc-timestamp", &timestamp.to_string())?;
    if !request.region.trim().is_empty() {
        insert_named_header(&mut headers, "x-tc-region", request.region.trim())?;
    }
    if !request.credentials.security_token.trim().is_empty() {
        insert_named_header(
            &mut headers,
            "x-tc-token",
            request.credentials.security_token.trim(),
        )?;
    }

    Ok(PreparedRequest {
        method,
        url,
        headers,
        body: body.to_string(),
        signature: CloudSignaturePreview {
            algorithm: "TC3-HMAC-SHA256",
            timestamp: timestamp.to_string(),
            signed_headers,
            canonical_request,
            string_to_sign,
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: !request.credentials.security_token.trim().is_empty(),
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_huawei(
    request: &CloudRequest,
    method: Method,
    url: Url,
    host: String,
    canonical_uri: &str,
    canonical_query: &str,
    content_type: &str,
    timestamp: i64,
) -> Result<PreparedRequest, AppError> {
    let date = utc_datetime(timestamp)?
        .format("%Y%m%dT%H%M%SZ")
        .to_string();
    let canonical_uri = if canonical_uri.ends_with('/') {
        canonical_uri.to_string()
    } else {
        format!("{canonical_uri}/")
    };
    let mut canonical_headers = vec![
        ("content-type", content_type.to_string()),
        ("host", host.clone()),
        ("x-sdk-date", date.clone()),
    ];
    if !request.credentials.security_token.trim().is_empty() {
        canonical_headers.push((
            "x-security-token",
            request.credentials.security_token.trim().to_string(),
        ));
    }
    canonical_headers.sort_by_key(|(name, _)| *name);
    let signed_headers = canonical_headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_header_text = canonical_headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri,
        canonical_query,
        canonical_header_text,
        signed_headers,
        sha256_hex(request.body.as_bytes())
    );
    let string_to_sign = format!(
        "SDK-HMAC-SHA256\n{}\n{}",
        date,
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = hmac_hex(
        request.credentials.access_key_secret.as_bytes(),
        string_to_sign.as_bytes(),
    )?;
    let authorization = format!(
        "SDK-HMAC-SHA256 Access={}, SignedHeaders={}, Signature={}",
        request.credentials.access_key_id.trim(),
        signed_headers,
        signature
    );

    let mut headers = HeaderMap::new();
    insert_header(&mut headers, CONTENT_TYPE, content_type)?;
    insert_header(&mut headers, ACCEPT, "application/json")?;
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_named_header(&mut headers, "x-sdk-date", &date)?;
    if !request.credentials.security_token.trim().is_empty() {
        insert_named_header(
            &mut headers,
            "x-security-token",
            request.credentials.security_token.trim(),
        )?;
    }

    let has_token = !request.credentials.security_token.trim().is_empty();
    let preview_canonical = if has_token {
        canonical_request.replace(
            request.credentials.security_token.trim(),
            "<redacted-security-token>",
        )
    } else {
        canonical_request
    };
    Ok(PreparedRequest {
        method,
        url,
        headers,
        body: request.body.clone(),
        signature: CloudSignaturePreview {
            algorithm: "SDK-HMAC-SHA256",
            timestamp: date,
            signed_headers,
            canonical_request: preview_canonical,
            string_to_sign,
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: has_token,
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_volcengine(
    request: &CloudRequest,
    method: Method,
    url: Url,
    host: String,
    canonical_uri: &str,
    canonical_query: &str,
    content_type: &str,
    timestamp: i64,
) -> Result<PreparedRequest, AppError> {
    let datetime = utc_datetime(timestamp)?;
    let date = datetime.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = datetime.format("%Y%m%d").to_string();
    let payload_hash = sha256_hex(request.body.as_bytes());
    let signed_headers = "content-type;host;x-content-sha256;x-date".to_string();
    let canonical_headers = format!(
        "content-type:{content_type}\nhost:{host}\nx-content-sha256:{payload_hash}\nx-date:{date}\n"
    );
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri,
        canonical_query,
        canonical_headers,
        signed_headers,
        payload_hash
    );
    let region = request.region.trim();
    let service = request.service.trim();
    let scope = format!("{short_date}/{region}/{service}/request");
    let string_to_sign = format!(
        "HMAC-SHA256\n{date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let secret_date = hmac_bytes(
        request.credentials.access_key_secret.as_bytes(),
        short_date.as_bytes(),
    )?;
    let secret_region = hmac_bytes(&secret_date, region.as_bytes())?;
    let secret_service = hmac_bytes(&secret_region, service.as_bytes())?;
    let secret_signing = hmac_bytes(&secret_service, b"request")?;
    let signature = hex_lower(&hmac_bytes(&secret_signing, string_to_sign.as_bytes())?);
    let authorization = format!(
        "HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        request.credentials.access_key_id.trim(),
        scope,
        signed_headers,
        signature
    );

    let mut headers = HeaderMap::new();
    insert_header(&mut headers, CONTENT_TYPE, content_type)?;
    insert_header(&mut headers, ACCEPT, "application/json")?;
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_named_header(&mut headers, "x-date", &date)?;
    insert_named_header(&mut headers, "x-content-sha256", &payload_hash)?;
    if !request.credentials.security_token.trim().is_empty() {
        insert_named_header(
            &mut headers,
            "x-security-token",
            request.credentials.security_token.trim(),
        )?;
    }

    Ok(PreparedRequest {
        method,
        url,
        headers,
        body: request.body.clone(),
        signature: CloudSignaturePreview {
            algorithm: "HMAC-SHA256",
            timestamp: date,
            signed_headers,
            canonical_request,
            string_to_sign,
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: !request.credentials.security_token.trim().is_empty(),
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_baidu(
    request: &CloudRequest,
    method: Method,
    url: Url,
    host: String,
    canonical_uri: &str,
    canonical_query: &str,
    content_type: &str,
    timestamp: i64,
) -> Result<PreparedRequest, AppError> {
    const EXPIRATION_SECONDS: u16 = 1800;
    let date = utc_datetime(timestamp)?
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let mut canonical_headers = vec![("host", host.clone()), ("x-bce-date", date.clone())];
    let payload_hash = sha256_hex(request.body.as_bytes());
    if !request.body.is_empty() {
        canonical_headers.push(("content-type", content_type.to_string()));
        canonical_headers.push(("x-bce-content-sha256", payload_hash.clone()));
    }
    if !request.credentials.security_token.trim().is_empty() {
        canonical_headers.push((
            "x-bce-security-token",
            request.credentials.security_token.trim().to_string(),
        ));
    }
    canonical_headers.sort_by_key(|(name, _)| *name);
    let signed_headers = canonical_headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_header_text = canonical_headers
        .iter()
        .map(|(name, value)| format!("{}:{}", rfc3986(name), rfc3986(value.trim())))
        .collect::<Vec<_>>()
        .join("\n");
    let canonical_request = format!(
        "{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri,
        canonical_query,
        canonical_header_text
    );
    let auth_prefix = format!(
        "bce-auth-v1/{}/{date}/{EXPIRATION_SECONDS}",
        request.credentials.access_key_id.trim()
    );
    let signing_key = hmac_hex(
        request.credentials.access_key_secret.as_bytes(),
        auth_prefix.as_bytes(),
    )?;
    let signature = hmac_hex(signing_key.as_bytes(), canonical_request.as_bytes())?;
    let authorization = format!("{auth_prefix}/{signed_headers}/{signature}");

    let mut headers = HeaderMap::new();
    insert_header(&mut headers, ACCEPT, "application/json")?;
    insert_header(&mut headers, HOST, &host)?;
    insert_header(&mut headers, AUTHORIZATION, &authorization)?;
    insert_named_header(&mut headers, "x-bce-date", &date)?;
    if !request.body.is_empty() {
        insert_header(&mut headers, CONTENT_TYPE, content_type)?;
        insert_named_header(&mut headers, "x-bce-content-sha256", &payload_hash)?;
    }
    if !request.credentials.security_token.trim().is_empty() {
        insert_named_header(
            &mut headers,
            "x-bce-security-token",
            request.credentials.security_token.trim(),
        )?;
    }

    let has_token = !request.credentials.security_token.trim().is_empty();
    let preview_canonical = if has_token {
        canonical_request.replace(
            &rfc3986(request.credentials.security_token.trim()),
            "<redacted-security-token>",
        )
    } else {
        canonical_request
    };
    Ok(PreparedRequest {
        method,
        url,
        headers,
        body: request.body.clone(),
        signature: CloudSignaturePreview {
            algorithm: "bce-auth-v1",
            timestamp: date,
            signed_headers,
            canonical_request: preview_canonical,
            string_to_sign: auth_prefix.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            authorization: authorization.replace(
                request.credentials.access_key_id.trim(),
                &mask_key_id(&request.credentials.access_key_id),
            ),
            redacted: has_token,
        },
    })
}

fn validate_request(request: &CloudRequest) -> Result<(), AppError> {
    for (value, label) in [
        (&request.credentials.access_key_id, "AccessKey ID"),
        (&request.credentials.access_key_secret, "AccessKey Secret"),
    ] {
        if value.trim().is_empty() {
            return Err(AppError::new(
                "missing_cloud_field",
                format!("{label} 不能为空"),
            ));
        }
    }
    if matches!(
        request.provider,
        CloudProvider::AlibabaAcs3 | CloudProvider::TencentTc3 | CloudProvider::VolcengineHmac
    ) {
        for (value, label) in [(&request.action, "Action"), (&request.version, "Version")] {
            if value.trim().is_empty() {
                return Err(AppError::new(
                    "missing_cloud_field",
                    format!("{label} 不能为空"),
                ));
            }
        }
    }
    if matches!(
        request.provider,
        CloudProvider::TencentTc3 | CloudProvider::VolcengineHmac
    ) && request.service.trim().is_empty()
    {
        return Err(AppError::new("missing_cloud_field", "Service 不能为空"));
    }
    if matches!(request.provider, CloudProvider::VolcengineHmac) && request.region.trim().is_empty()
    {
        return Err(AppError::new(
            "missing_cloud_field",
            "火山引擎 Region 不能为空",
        ));
    }
    if request.body.len() > 4 * 1024 * 1024 || request.query.len() > 256 * 1024 {
        return Err(AppError::new("request_too_large", "云 API 调试请求过大"));
    }
    Ok(())
}

fn validate_endpoint(provider: CloudProvider, url: &Url) -> Result<(), AppError> {
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err(AppError::new(
            "invalid_cloud_endpoint",
            "云 API Endpoint 必须是无内嵌凭据的 HTTPS 地址",
        ));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = match provider {
        CloudProvider::AlibabaAcs3 => host == "aliyuncs.com" || host.ends_with(".aliyuncs.com"),
        CloudProvider::TencentTc3 => {
            host == "tencentcloudapi.com" || host.ends_with(".tencentcloudapi.com")
        }
        CloudProvider::HuaweiSdkHmac => {
            host == "myhuaweicloud.com"
                || host.ends_with(".myhuaweicloud.com")
                || host == "huaweicloud.com"
                || host.ends_with(".huaweicloud.com")
        }
        CloudProvider::VolcengineHmac => {
            host == "volcengineapi.com"
                || host.ends_with(".volcengineapi.com")
                || host == "volces.com"
                || host.ends_with(".volces.com")
        }
        CloudProvider::BaiduBceV1 => {
            host == "baidubce.com"
                || host.ends_with(".baidubce.com")
                || host == "bcebos.com"
                || host.ends_with(".bcebos.com")
        }
    };
    if !allowed {
        return Err(AppError::new(
            "untrusted_cloud_endpoint",
            "Endpoint 与所选云厂商的官方域名不匹配",
        ));
    }
    Ok(())
}

fn canonical_query(endpoint_query: Option<&str>, input: &str) -> String {
    let mut pairs = Vec::new();
    for raw in [
        endpoint_query.unwrap_or_default(),
        input.trim().trim_start_matches('?'),
    ] {
        pairs.extend(
            url::form_urlencoded::parse(raw.as_bytes())
                .filter(|(key, _)| !key.eq_ignore_ascii_case("authorization"))
                .map(|(key, value)| (rfc3986(&key), rfc3986(&value))),
        );
    }
    pairs.sort();
    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn query_has_key(query: &str, expected: &str) -> bool {
    url::form_urlencoded::parse(query.trim().trim_start_matches('?').as_bytes())
        .any(|(key, _)| key == expected)
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

fn authority(url: &Url) -> Result<String, AppError> {
    let host = url
        .host_str()
        .ok_or_else(|| AppError::new("invalid_url", "Endpoint 缺少主机名"))?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn utc_datetime(timestamp: i64) -> Result<DateTime<Utc>, AppError> {
    DateTime::<Utc>::from_timestamp(timestamp, 0)
        .ok_or_else(|| AppError::new("invalid_timestamp", "无法生成签名时间"))
}

fn sha256_hex(value: &[u8]) -> String {
    hex_lower(&Sha256::digest(value))
}

fn hmac_bytes(key: &[u8], value: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| AppError::new("signature_error", "无法初始化 HMAC 签名"))?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hmac_hex(key: &[u8], value: &[u8]) -> Result<String, AppError> {
    Ok(hex_lower(&hmac_bytes(key, value)?))
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
        .map_err(|_| AppError::new("invalid_header", "签名请求头包含无效字符"))?;
    headers.insert(name, value);
    Ok(())
}

fn insert_named_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), AppError> {
    let name = HeaderName::from_str(name)
        .map_err(|_| AppError::new("invalid_header", "签名请求头名称无效"))?;
    insert_header(headers, name, value)
}

fn mask_key_id(value: &str) -> String {
    let value = value.trim();
    if value.chars().count() <= 8 {
        return "****".to_string();
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

fn map_request_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new("timeout", "请求超时，请检查网络、代理或接口地址")
    } else if error.is_connect() {
        AppError::new("connection_failed", format!("连接失败：{error}"))
    } else {
        AppError::new("request_failed", format!("请求失败：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tencent_request() -> CloudRequest {
        CloudRequest {
            request_id: "test".into(),
            provider: CloudProvider::TencentTc3,
            method: "POST".into(),
            endpoint: "https://cvm.tencentcloudapi.com".into(),
            service: "cvm".into(),
            action: "DescribeInstances".into(),
            version: "2017-03-12".into(),
            region: "ap-guangzhou".into(),
            query: String::new(),
            body: r#"{\"Limit\": 1, \"Filters\": [{\"Values\": [\"unnamed\"], \"Name\": \"instance-name\"}]}"#
                .replace("\\\"", "\""),
            content_type: "application/json; charset=utf-8".into(),
            credentials: CloudCredentials {
                access_key_id: "AKIDEXAMPLE".into(),
                access_key_secret: "SECRETEXAMPLE".into(),
                security_token: String::new(),
            },
            proxy_url: None,
            allow_invalid_certificates: false,
        }
    }

    #[test]
    fn canonical_query_is_sorted_and_rfc3986_encoded() {
        assert_eq!(
            canonical_query(Some("b=hello+world"), "z=%2F&a=~"),
            "a=~&b=hello%20world&z=%2F"
        );
    }

    #[test]
    fn rejects_cross_provider_endpoint() {
        let mut request = tencent_request();
        request.endpoint = "https://ecs.aliyuncs.com".into();
        let error = prepare(&request, 1_551_113_065, None)
            .err()
            .expect("must reject host");
        assert_eq!(error.code, "untrusted_cloud_endpoint");
    }

    #[test]
    fn signature_preview_never_contains_secret() {
        let request = tencent_request();
        let prepared = prepare(&request, 1_551_113_065, None).expect("signature should build");
        assert_eq!(
            prepared.signature.string_to_sign,
            "TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n2815843035062fffda5fd6f2a44ea8a34818b0dc46f024b8b3786976a3adda7a"
        );
        let preview = format!(
            "{}\n{}\n{}",
            prepared.signature.canonical_request,
            prepared.signature.string_to_sign,
            prepared.signature.authorization
        );
        assert!(!preview.contains("SECRETEXAMPLE"));
        assert!(!preview.contains("AKIDEXAMPLE"));
        assert!(preview.contains("AKID****MPLE"));
    }

    #[test]
    fn aliyun_sts_token_is_redacted_from_preview() {
        let mut request = tencent_request();
        request.provider = CloudProvider::AlibabaAcs3;
        request.endpoint = "https://ecs.aliyuncs.com".into();
        request.service.clear();
        request.credentials.security_token = "sensitive-session-token".into();
        let prepared =
            prepare(&request, 1_551_113_065, Some("nonce-1")).expect("signature should build");
        assert!(prepared.signature.redacted);
        assert!(!prepared
            .signature
            .canonical_request
            .contains("sensitive-session-token"));
    }

    #[test]
    fn aliyun_signature_matches_official_fixed_vector() {
        let request = CloudRequest {
            request_id: "test".into(),
            provider: CloudProvider::AlibabaAcs3,
            method: "POST".into(),
            endpoint: "https://ecs.cn-shanghai.aliyuncs.com".into(),
            service: "ecs".into(),
            action: "RunInstances".into(),
            version: "2014-05-26".into(),
            region: "cn-shanghai".into(),
            query:
                "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai"
                    .into(),
            body: String::new(),
            content_type: "application/json".into(),
            credentials: CloudCredentials {
                access_key_id: "YourAccessKeyId".into(),
                access_key_secret: "YourAccessKeySecret".into(),
                security_token: String::new(),
            },
            proxy_url: None,
            allow_invalid_certificates: false,
        };
        let timestamp = chrono::DateTime::parse_from_rfc3339("2023-10-26T10:22:32Z")
            .expect("fixed time should parse")
            .timestamp();
        let prepared = prepare(
            &request,
            timestamp,
            Some("3156853299f313e23d1673dc12e1703d"),
        )
        .expect("signature should build");
        assert_eq!(
            prepared.signature.string_to_sign,
            "ACS3-HMAC-SHA256\n7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259"
        );
        assert!(prepared
            .headers
            .get(AUTHORIZATION)
            .expect("authorization should exist")
            .to_str()
            .expect("authorization should be text")
            .ends_with(
                "Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0"
            ));
    }

    #[test]
    fn huawei_canonical_request_matches_official_fixed_vector() {
        let mut request = tencent_request();
        request.provider = CloudProvider::HuaweiSdkHmac;
        request.body.clear();
        request.credentials.security_token.clear();
        let timestamp = chrono::DateTime::parse_from_rfc3339("2019-11-15T03:36:55Z")
            .expect("fixed time should parse")
            .timestamp();
        let url = Url::parse(
            "https://service.region.example.com/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs",
        )
        .expect("example URL should parse");
        let prepared = prepare_huawei(
            &request,
            Method::GET,
            url,
            "service.region.example.com".into(),
            "/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs",
            "limit=2&marker=13551d6b-755d-4757-b956-536f674975c0",
            "application/json",
            timestamp,
        )
        .expect("Huawei signature should build");
        assert_eq!(
            prepared.signature.string_to_sign,
            "SDK-HMAC-SHA256\n20191115T033655Z\nb25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a"
        );
    }

    #[test]
    fn volcengine_adds_action_and_version_to_signed_query() {
        let mut request = tencent_request();
        request.provider = CloudProvider::VolcengineHmac;
        request.method = "GET".into();
        request.endpoint = "https://iam.volcengineapi.com".into();
        request.service = "iam".into();
        request.action = "ListUsers".into();
        request.version = "2018-01-01".into();
        request.region = "cn-beijing".into();
        request.query = "Limit=10&Offset=0".into();
        request.body.clear();
        request.content_type = "application/x-www-form-urlencoded; charset=utf-8".into();
        let prepared =
            prepare(&request, 1_604_394_027, None).expect("Volcengine signature should build");
        assert_eq!(
            prepared.url.query(),
            Some("Action=ListUsers&Limit=10&Offset=0&Version=2018-01-01")
        );
        assert_eq!(
            prepared.signature.signed_headers,
            "content-type;host;x-content-sha256;x-date"
        );
        assert!(!prepared.signature.authorization.contains("SECRETEXAMPLE"));
    }

    #[test]
    fn baidu_key_derivation_and_signature_match_official_vector() {
        let auth_prefix = "bce-auth-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2015-04-27T08:23:49Z/1800";
        let signing_key = hmac_hex(b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", auth_prefix.as_bytes())
            .expect("BCE signing key should build");
        assert_eq!(
            signing_key,
            "1d5ce5f464064cbee060330d973218821825ac6952368a482a592e6615aef479"
        );
        let canonical_request = concat!(
            "PUT\n",
            "/v1/test/myfolder/readme.txt\n",
            "partNumber=9&uploadId=a44cc9bab11cbd156984767aad637851\n",
            "content-length:8\n",
            "content-md5:NFzcPqhviddjRNnSOGo4rw%3D%3D\n",
            "content-type:text%2Fplain\n",
            "host:bj.bcebos.com\n",
            "x-bce-date:2015-04-27T08%3A23%3A49Z"
        );
        assert_eq!(
            hmac_hex(signing_key.as_bytes(), canonical_request.as_bytes())
                .expect("BCE signature should build"),
            "d74a04362e6a848f5b39b15421cb449427f419c95a480fd6b8cf9fc783e2999e"
        );
    }

    #[test]
    fn baidu_sts_token_is_redacted_from_preview() {
        let mut request = tencent_request();
        request.provider = CloudProvider::BaiduBceV1;
        request.method = "GET".into();
        request.endpoint = "https://bcc.bj.baidubce.com/v2/instance".into();
        request.service.clear();
        request.action.clear();
        request.version.clear();
        request.region.clear();
        request.query = "maxKeys=10".into();
        request.body.clear();
        request.credentials.security_token = "temporary/token+value".into();
        let prepared = prepare(&request, 1_745_729_029, None).expect("BCE signature should build");
        assert!(prepared.signature.redacted);
        assert!(!prepared
            .signature
            .canonical_request
            .contains("temporary%2Ftoken%2Bvalue"));
    }
}
