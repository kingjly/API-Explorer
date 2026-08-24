mod cloud;
mod object_storage;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use regex::Regex;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE, SET_COOKIE},
    Client, Method, Proxy,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    error::Error,
    fmt::{Display, Formatter},
    path::{Path, PathBuf},
    str::FromStr,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use tokio_util::sync::CancellationToken;
use url::Url;

struct AppState {
    database_path: PathBuf,
    active_requests: Mutex<HashMap<String, CancellationToken>>,
}

const BUNDLED_DATABASE: &[u8] = include_bytes!("../../ApiInfo2.0.db");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppError {
    code: &'static str,
    message: String,
}

impl AppError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl Display for AppError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("database_error", format!("数据库操作失败：{error}"))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    applications: Vec<ApiApplication>,
    database_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiApplication {
    id: i64,
    name: String,
    id_label: String,
    key_label: String,
    base_url: String,
    groups: Vec<ApiGroup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGroup {
    id: i64,
    name: String,
    functions: Vec<FunctionSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionSummary {
    id: i64,
    name: String,
    method: String,
    is_token: bool,
    spec_status: String,
    spec_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionDetails {
    id: i64,
    group_id: i64,
    name: String,
    method: String,
    url: String,
    path: String,
    headers: String,
    query: String,
    content_type: String,
    body: String,
    is_token: bool,
    token_pattern: String,
    documentation: String,
    spec_status: String,
    spec_version: String,
    doc_url: String,
    verified_at: String,
    change_note: String,
    parameters: Vec<ParameterEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogMigration {
    version: String,
    verified_at: String,
    applications: Vec<ApplicationPatch>,
    functions: Vec<FunctionPatch>,
    #[serde(default)]
    new_groups: Vec<GroupInsert>,
    #[serde(default)]
    new_functions: Vec<FunctionInsert>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationPatch {
    id: i64,
    name: Option<String>,
    id_label: Option<String>,
    key_label: Option<String>,
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupInsert {
    id: i64,
    app_id: i64,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FunctionPatch {
    id: i64,
    name: Option<String>,
    method: Option<String>,
    url: Option<String>,
    path: Option<String>,
    headers: Option<String>,
    query: Option<String>,
    content_type: Option<String>,
    body: Option<String>,
    is_token: Option<bool>,
    token_pattern: Option<String>,
    documentation: Option<String>,
    spec_status: Option<String>,
    spec_version: Option<String>,
    doc_url: Option<String>,
    #[serde(default)]
    change_note: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FunctionInsert {
    id: i64,
    group_id: i64,
    name: String,
    method: String,
    url: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    headers: String,
    #[serde(default)]
    query: String,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    body: String,
    is_token: bool,
    #[serde(default)]
    token_pattern: String,
    documentation: String,
    spec_status: String,
    spec_version: String,
    doc_url: String,
    #[serde(default)]
    change_note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParameterEntry {
    location: String,
    name: String,
    value: String,
    locked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityInput {
    id: String,
    key: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteRequest {
    request_id: String,
    function_id: i64,
    identity: IdentityInput,
    base_url: String,
    proxy_url: Option<String>,
    allow_invalid_certificates: bool,
    acquire_token: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseHeader {
    name: String,
    value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    status: u16,
    status_text: String,
    elapsed_ms: u128,
    url: String,
    content_type: String,
    headers: Vec<ResponseHeader>,
    body: String,
    token: Option<String>,
}

fn open_database(path: &Path) -> Result<Connection, AppError> {
    Connection::open(path).map_err(AppError::from)
}

fn table_exists(connection: &Connection, table: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn catalog_version_at_least(current: &str, target: &str) -> bool {
    if current == target {
        return true;
    }
    let parse = |value: &str| {
        value
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()
    };
    matches!((parse(current), parse(target)), (Some(current), Some(target)) if current >= target)
}

fn catalog_migration_needed(
    path: &Path,
    migration: &CatalogMigration,
) -> Result<bool, Box<dyn Error>> {
    let connection = Connection::open(path)?;
    if !table_exists(&connection, "function")? {
        return Ok(true);
    }
    for column in [
        "path_params",
        "spec_status",
        "spec_version",
        "doc_url",
        "verified_at",
        "change_note",
    ] {
        if !column_exists(&connection, "function", column)? {
            return Ok(true);
        }
    }
    if !table_exists(&connection, "api_catalog_metadata")? {
        return Ok(true);
    }
    for group in &migration.new_groups {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM \"group\" WHERE id = ?1)",
            [group.id],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(true);
        }
    }
    for function in &migration.new_functions {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM function WHERE id = ?1)",
            [function.id],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(true);
        }
    }
    let current = connection
        .query_row(
            "SELECT value FROM api_catalog_metadata WHERE key = 'catalog_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(!current
        .as_deref()
        .is_some_and(|version| catalog_version_at_least(version, &migration.version)))
}

fn ensure_catalog_schema(connection: &Connection) -> rusqlite::Result<()> {
    for (column, definition) in [
        ("path_params", "TEXT NOT NULL DEFAULT ''"),
        ("spec_status", "TEXT NOT NULL DEFAULT 'active'"),
        ("spec_version", "TEXT NOT NULL DEFAULT ''"),
        ("doc_url", "TEXT NOT NULL DEFAULT ''"),
        ("verified_at", "TEXT NOT NULL DEFAULT ''"),
        ("change_note", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !column_exists(connection, "function", column)? {
            connection.execute(
                &format!("ALTER TABLE function ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS api_catalog_metadata (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );",
    )?;
    Ok(())
}

fn apply_catalog_migration(path: &Path) -> Result<(), Box<dyn Error>> {
    apply_catalog_migration_document(
        path,
        include_str!("../../data/api_catalog_updates_2026-08-06.json"),
    )
}

fn apply_catalog_migration_document(path: &Path, document: &str) -> Result<(), Box<dyn Error>> {
    let migration: CatalogMigration = serde_json::from_str(document)?;
    let allowed_statuses = [
        "active",
        "legacy",
        "deprecated",
        "removed",
        "unverified",
        "test-only",
    ];
    let mut application_ids = HashSet::new();
    for application in &migration.applications {
        if !application_ids.insert(application.id) {
            return Err(format!("迁移包含重复应用 ID {}", application.id).into());
        }
    }
    let mut group_ids = HashSet::new();
    for group in &migration.new_groups {
        if !group_ids.insert(group.id) {
            return Err(format!("迁移包含重复分组 ID {}", group.id).into());
        }
    }
    let mut function_ids = HashSet::new();
    for function in &migration.functions {
        if !function_ids.insert(function.id) {
            return Err(format!("迁移包含重复接口 ID {}", function.id).into());
        }
        if function
            .spec_status
            .as_deref()
            .is_some_and(|status| !allowed_statuses.contains(&status))
        {
            return Err(format!("接口 ID {} 的规范状态无效", function.id).into());
        }
    }
    for function in &migration.new_functions {
        if !function_ids.insert(function.id) {
            return Err(format!("迁移包含重复接口 ID {}", function.id).into());
        }
        if !allowed_statuses.contains(&function.spec_status.as_str()) {
            return Err(format!("接口 ID {} 的规范状态无效", function.id).into());
        }
    }

    let mut connection = Connection::open(path)?;
    ensure_catalog_schema(&connection)?;
    let transaction = connection.transaction()?;

    for application in migration.applications {
        let changed = transaction.execute(
            "UPDATE application SET
                application = COALESCE(?1, application),
                id_tab = COALESCE(?2, id_tab),
                key_tab = COALESCE(?3, key_tab),
                baseurl = COALESCE(?4, baseurl)
             WHERE id = ?5",
            params![
                application.name,
                application.id_label,
                application.key_label,
                application.base_url,
                application.id
            ],
        )?;
        if changed != 1 {
            return Err(format!("迁移中未找到应用 ID {}", application.id).into());
        }
    }

    for group in migration.new_groups {
        let application_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM application WHERE id = ?1)",
            [group.app_id],
            |row| row.get(0),
        )?;
        if !application_exists {
            return Err(format!(
                "新增分组 ID {} 引用了不存在的应用 ID {}",
                group.id, group.app_id
            )
            .into());
        }
        let existing = transaction
            .query_row(
                "SELECT app_id, \"group\" FROM \"group\" WHERE id = ?1",
                [group.id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if existing
            .as_ref()
            .is_some_and(|(app_id, name)| *app_id != group.app_id || name != &group.name)
        {
            return Err(format!(
                "新增分组 ID {} 与用户数据库中的现有分组冲突，已停止迁移以保护数据",
                group.id
            )
            .into());
        }
        transaction.execute(
            "INSERT INTO \"group\" (id, app_id, \"group\") VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                app_id = excluded.app_id,
                \"group\" = excluded.\"group\"",
            params![group.id, group.app_id, group.name],
        )?;
    }

    for function in migration.functions {
        let changed = transaction.execute(
            "UPDATE function SET
                function = COALESCE(?1, function),
                type = COALESCE(?2, type),
                url = COALESCE(?3, url),
                path_params = COALESCE(?4, path_params),
                headers = COALESCE(?5, headers),
                get_params = COALESCE(?6, get_params),
                content_type = COALESCE(?7, content_type),
                post_params = COALESCE(?8, post_params),
                is_token = COALESCE(?9, is_token),
                token_re = COALESCE(?10, token_re),
                api_doc = COALESCE(?11, api_doc),
                spec_status = COALESCE(?12, spec_status),
                spec_version = COALESCE(?13, spec_version),
                doc_url = COALESCE(?14, doc_url),
                verified_at = ?15,
                change_note = ?16
             WHERE id = ?17",
            params![
                function.name,
                function.method,
                function.url,
                function.path,
                function.headers,
                function.query,
                function.content_type,
                function.body,
                function.is_token.map(i64::from),
                function.token_pattern,
                function.documentation,
                function.spec_status,
                function.spec_version,
                function.doc_url,
                migration.verified_at,
                function.change_note,
                function.id
            ],
        )?;
        if changed != 1 {
            return Err(format!("迁移中未找到接口 ID {}", function.id).into());
        }
    }

    for function in migration.new_functions {
        let group_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM \"group\" WHERE id = ?1)",
            [function.group_id],
            |row| row.get(0),
        )?;
        if !group_exists {
            return Err(format!(
                "新增接口 ID {} 引用了不存在的分组 ID {}",
                function.id, function.group_id
            )
            .into());
        }
        let existing = transaction
            .query_row(
                "SELECT group_id, function, url FROM function WHERE id = ?1",
                [function.id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if existing.as_ref().is_some_and(|(group_id, name, url)| {
            *group_id != function.group_id || name != &function.name || url != &function.url
        }) {
            return Err(format!(
                "新增接口 ID {} 与用户数据库中的现有接口冲突，已停止迁移以保护数据",
                function.id
            )
            .into());
        }
        transaction.execute(
            "INSERT INTO function (
                id, group_id, function, type, url, path_params, headers, get_params, content_type,
                post_params, is_token, token_re, api_doc, spec_status, spec_version,
                doc_url, verified_at, change_note
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18
             )
             ON CONFLICT(id) DO UPDATE SET
                group_id = excluded.group_id,
                function = excluded.function,
                type = excluded.type,
                url = excluded.url,
                path_params = excluded.path_params,
                headers = excluded.headers,
                get_params = excluded.get_params,
                content_type = excluded.content_type,
                post_params = excluded.post_params,
                is_token = excluded.is_token,
                token_re = excluded.token_re,
                api_doc = excluded.api_doc,
                spec_status = excluded.spec_status,
                spec_version = excluded.spec_version,
                doc_url = excluded.doc_url,
                verified_at = excluded.verified_at,
                change_note = excluded.change_note",
            params![
                function.id,
                function.group_id,
                function.name,
                function.method,
                function.url,
                function.path,
                function.headers,
                function.query,
                function.content_type,
                function.body,
                i64::from(function.is_token),
                function.token_pattern,
                function.documentation,
                function.spec_status,
                function.spec_version,
                function.doc_url,
                migration.verified_at,
                function.change_note,
            ],
        )?;
    }

    transaction.execute(
        "INSERT INTO api_catalog_metadata(key, value) VALUES('catalog_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&migration.version],
    )?;
    transaction.execute(
        "INSERT INTO api_catalog_metadata(key, value) VALUES('verified_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&migration.verified_at],
    )?;
    transaction.commit()?;
    Ok(())
}

fn value_or_default(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<String> {
    Ok(row.get::<_, Option<String>>(index)?.unwrap_or_default())
}

fn read_function(connection: &Connection, function_id: i64) -> Result<FunctionDetails, AppError> {
    let mut function = connection
        .query_row(
            "SELECT id, group_id, function, type, url, path_params, headers, get_params, content_type, post_params, is_token, token_re, api_doc,
                    spec_status, spec_version, doc_url, verified_at, change_note
             FROM function WHERE id = ?1",
            [function_id],
            |row| {
                Ok(FunctionDetails {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    name: row.get(2)?,
                    method: row.get(3)?,
                    url: row.get(4)?,
                    path: value_or_default(row, 5)?,
                    headers: value_or_default(row, 6)?,
                    query: value_or_default(row, 7)?,
                    content_type: value_or_default(row, 8)?,
                    body: value_or_default(row, 9)?,
                    is_token: row.get::<_, i64>(10)? == 1,
                    token_pattern: value_or_default(row, 11)?,
                    documentation: value_or_default(row, 12)?,
                    spec_status: value_or_default(row, 13)?,
                    spec_version: value_or_default(row, 14)?,
                    doc_url: value_or_default(row, 15)?,
                    verified_at: value_or_default(row, 16)?,
                    change_note: value_or_default(row, 17)?,
                    parameters: Vec::new(),
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::new("not_found", "未找到所选接口"))?;

    function.parameters = collect_parameters(&function);
    Ok(function)
}

fn parse_pairs(input: &str) -> Vec<(String, String)> {
    if input.trim().is_empty() {
        return Vec::new();
    }
    url::form_urlencoded::parse(input.as_bytes())
        .into_owned()
        .collect()
}

fn contains_template(value: &str) -> bool {
    ["{id}", "{secert}", "{token}"]
        .iter()
        .any(|template| value.contains(template))
}

fn collect_parameters(function: &FunctionDetails) -> Vec<ParameterEntry> {
    [
        ("path", function.path.as_str()),
        ("query", function.query.as_str()),
        ("header", function.headers.as_str()),
        ("body", function.body.as_str()),
    ]
    .into_iter()
    .flat_map(|(location, raw)| {
        parse_pairs(raw)
            .into_iter()
            .map(move |(name, value)| ParameterEntry {
                location: location.to_string(),
                name,
                locked: contains_template(&value),
                value,
            })
    })
    .collect()
}

fn serialize_pairs(entries: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in entries {
        serializer.append_pair(name, value);
    }
    serializer.finish()
}

fn replace_templates(value: &str, identity: &IdentityInput) -> String {
    value
        .replace("{id}", &identity.id)
        .replace("{secert}", &identity.key)
        .replace("{token}", &identity.token)
}

fn encode_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

fn substitute_path_parameters(
    configured_url: &str,
    path_parameters: &str,
    identity: &IdentityInput,
) -> String {
    let mut resolved = configured_url.to_string();
    for (name, value) in parse_pairs(path_parameters) {
        if name.is_empty() {
            continue;
        }
        let placeholder = format!("{{{name}}}");
        let value = replace_templates(&value, identity);
        resolved = resolved.replace(&placeholder, &encode_path_segment(&value));
    }
    replace_templates(&resolved, identity)
}

fn parse_http_method(value: &str) -> Result<Method, AppError> {
    Method::from_str(value.trim())
        .map_err(|_| AppError::new("unsupported_method", format!("请求方法无效：{value}")))
}

fn resolve_url(base_url: &str, configured_url: &str) -> Result<Url, AppError> {
    if base_url.trim().is_empty() {
        return Url::parse(configured_url).map_err(|_| {
            AppError::new("invalid_url", "接口地址不是完整 URL，请填写有效的 Base URL")
        });
    }

    let normalized_base = format!("{}/", base_url.trim().trim_end_matches('/'));
    let mut base = Url::parse(&normalized_base)
        .map_err(|_| AppError::new("invalid_base_url", "Base URL 格式无效"))?;

    if let Ok(configured) = Url::parse(configured_url) {
        base.set_path(configured.path());
        base.set_query(configured.query());
        return Ok(base);
    }

    base.join(configured_url.trim_start_matches('/'))
        .map_err(|_| AppError::new("invalid_url", "无法拼接接口地址"))
}

fn json_value(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_string()))
}

fn extract_token(
    pattern: &str,
    body: &str,
    headers: &HeaderMap,
) -> Result<Option<String>, AppError> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Ok(None);
    }

    if pattern == "{cookie}" {
        let cookies = headers
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .filter_map(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        return Ok((!cookies.is_empty()).then_some(cookies));
    }

    if let Some(field) = pattern
        .strip_prefix("{json:")
        .and_then(|value| value.strip_suffix('}'))
    {
        let document: Value = serde_json::from_str(body).map_err(|error| {
            AppError::new(
                "invalid_token_response",
                format!("Token 响应不是有效 JSON：{error}"),
            )
        })?;
        let value = if field.starts_with('/') {
            document.pointer(field)
        } else {
            document.get(field)
        };
        return Ok(value.and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            Value::Bool(value) => Some(value.to_string()),
            _ => None,
        }));
    }

    let regex = Regex::new(pattern).map_err(|error| {
        AppError::new("invalid_token_pattern", format!("Token 正则无效：{error}"))
    })?;
    Ok(regex.captures(body).and_then(|captures| {
        captures
            .get(1)
            .or_else(|| captures.get(0))
            .map(|matched| matched.as_str().to_string())
    }))
}

#[tauri::command]
fn load_catalog(state: State<'_, AppState>) -> Result<Catalog, AppError> {
    let connection = open_database(&state.database_path)?;
    let mut application_statement = connection.prepare(
        "SELECT id, application, id_tab, key_tab, COALESCE(baseurl, '') FROM application ORDER BY id",
    )?;
    let applications = application_statement
        .query_map([], |row| {
            Ok(ApiApplication {
                id: row.get(0)?,
                name: row.get(1)?,
                id_label: value_or_default(row, 2)?,
                key_label: value_or_default(row, 3)?,
                base_url: value_or_default(row, 4)?,
                groups: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(application_statement);

    let mut catalog = applications;
    for application in &mut catalog {
        let mut group_statement = connection
            .prepare("SELECT id, \"group\" FROM \"group\" WHERE app_id = ?1 ORDER BY id")?;
        let mut groups = group_statement
            .query_map([application.id], |row| {
                Ok(ApiGroup {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    functions: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(group_statement);

        for group in &mut groups {
            let mut function_statement = connection.prepare(
                "SELECT id, function, type, is_token, spec_status, spec_version
                 FROM function WHERE group_id = ?1 ORDER BY id",
            )?;
            group.functions = function_statement
                .query_map([group.id], |row| {
                    Ok(FunctionSummary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        method: row.get(2)?,
                        is_token: row.get::<_, i64>(3)? == 1,
                        spec_status: value_or_default(row, 4)?,
                        spec_version: value_or_default(row, 5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
        }
        application.groups = groups;
    }

    Ok(Catalog {
        applications: catalog,
        database_path: state.database_path.display().to_string(),
    })
}

#[tauri::command]
fn get_function(function_id: i64, state: State<'_, AppState>) -> Result<FunctionDetails, AppError> {
    let connection = open_database(&state.database_path)?;
    read_function(&connection, function_id)
}

#[tauri::command]
fn save_parameters(
    function_id: i64,
    parameters: Vec<ParameterEntry>,
    state: State<'_, AppState>,
) -> Result<FunctionDetails, AppError> {
    let connection = open_database(&state.database_path)?;
    let original = read_function(&connection, function_id)?;
    let locked_values = original
        .parameters
        .iter()
        .filter(|parameter| parameter.locked)
        .map(|parameter| {
            (
                (parameter.location.clone(), parameter.name.clone()),
                parameter.value.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();

    let mut grouped: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for parameter in parameters {
        if !matches!(
            parameter.location.as_str(),
            "path" | "query" | "header" | "body"
        ) {
            return Err(AppError::new("invalid_parameter", "参数位置无效"));
        }
        if parameter.name.trim().is_empty() {
            return Err(AppError::new("invalid_parameter", "参数名不能为空"));
        }
        let key = (parameter.location.clone(), parameter.name.clone());
        let value = locked_values.get(&key).cloned().unwrap_or(parameter.value);
        grouped
            .entry(parameter.location)
            .or_default()
            .push((parameter.name, value));
    }

    connection.execute(
        "UPDATE function SET path_params = ?1, get_params = ?2, headers = ?3, post_params = ?4 WHERE id = ?5",
        params![
            serialize_pairs(grouped.get("path").map(Vec::as_slice).unwrap_or(&[])),
            serialize_pairs(grouped.get("query").map(Vec::as_slice).unwrap_or(&[])),
            serialize_pairs(grouped.get("header").map(Vec::as_slice).unwrap_or(&[])),
            serialize_pairs(grouped.get("body").map(Vec::as_slice).unwrap_or(&[])),
            function_id
        ],
    )?;

    read_function(&connection, function_id)
}

#[tauri::command]
fn base64_encode(value: String) -> String {
    BASE64.encode(value.as_bytes())
}

#[tauri::command]
fn cancel_request(request_id: String, state: State<'_, AppState>) -> bool {
    if let Ok(active_requests) = state.active_requests.lock() {
        if let Some(token) = active_requests.get(&request_id) {
            token.cancel();
            return true;
        }
    }
    false
}

#[tauri::command]
async fn execute_request(
    request: ExecuteRequest,
    state: State<'_, AppState>,
) -> Result<ApiResponse, AppError> {
    let request_id = if request.request_id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        request.request_id.clone()
    };
    let cancellation = CancellationToken::new();
    state
        .active_requests
        .lock()
        .map_err(|_| AppError::new("request_state_error", "请求状态暂时不可用"))?
        .insert(request_id.clone(), cancellation.clone());

    let result = execute_request_inner(&request, &state.database_path, cancellation).await;
    if let Ok(mut active_requests) = state.active_requests.lock() {
        active_requests.remove(&request_id);
    }
    result
}

#[tauri::command]
async fn execute_cloud_request(
    request: cloud::CloudRequest,
    state: State<'_, AppState>,
) -> Result<cloud::CloudResponse, AppError> {
    let request_id = if request.request_id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        request.request_id.clone()
    };
    let cancellation = CancellationToken::new();
    state
        .active_requests
        .lock()
        .map_err(|_| AppError::new("request_state_error", "请求状态暂时不可用"))?
        .insert(request_id.clone(), cancellation.clone());

    let result = cloud::execute(request, cancellation).await;
    if let Ok(mut active_requests) = state.active_requests.lock() {
        active_requests.remove(&request_id);
    }
    result
}

#[tauri::command]
fn preview_cloud_signature(
    request: cloud::CloudRequest,
) -> Result<cloud::CloudSignaturePreview, AppError> {
    cloud::preview(&request)
}

#[tauri::command]
async fn execute_object_storage_request(
    request: object_storage::StorageRequest,
    state: State<'_, AppState>,
) -> Result<object_storage::StorageResponse, AppError> {
    let request_id = if request.request_id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        request.request_id.clone()
    };
    let cancellation = CancellationToken::new();
    state
        .active_requests
        .lock()
        .map_err(|_| AppError::new("request_state_error", "请求状态暂时不可用"))?
        .insert(request_id.clone(), cancellation.clone());

    let result = object_storage::execute(request, cancellation).await;
    if let Ok(mut active_requests) = state.active_requests.lock() {
        active_requests.remove(&request_id);
    }
    result
}

#[tauri::command]
fn preview_object_storage_signature(
    request: object_storage::StorageRequest,
) -> Result<object_storage::StorageSignaturePreview, AppError> {
    object_storage::preview(&request)
}

async fn execute_request_inner(
    request: &ExecuteRequest,
    database_path: &Path,
    cancellation: CancellationToken,
) -> Result<ApiResponse, AppError> {
    let function = {
        let connection = open_database(database_path)?;
        read_function(&connection, request.function_id)?
    };
    if matches!(function.spec_status.as_str(), "removed" | "test-only") {
        return Err(AppError::new(
            "spec_unavailable",
            format!("接口“{}”已下线或不属于正式厂商 API", function.name),
        ));
    }
    let method = parse_http_method(&function.method)?;

    let configured_url =
        substitute_path_parameters(&function.url, &function.path, &request.identity);
    let url = resolve_url(&request.base_url, &configured_url)?;
    let query_parameters = parse_pairs(&function.query)
        .into_iter()
        .map(|(name, value)| (name, replace_templates(&value, &request.identity)))
        .collect::<Vec<_>>();
    let body_parameters = parse_pairs(&function.body)
        .into_iter()
        .map(|(name, value)| (name, replace_templates(&value, &request.identity)))
        .collect::<Vec<_>>();

    let mut headers = HeaderMap::new();
    for (name, value) in parse_pairs(&function.headers) {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| AppError::new("invalid_header", format!("请求头名称无效：{name}")))?;
        let value = replace_templates(&value, &request.identity);
        let value = HeaderValue::from_str(&value)
            .map_err(|_| AppError::new("invalid_header", "请求头值包含无效字符"))?;
        headers.append(name, value);
    }
    if !headers.contains_key(ACCEPT) {
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    }

    let mut client_builder = Client::builder()
        .timeout(Duration::from_secs(20))
        .danger_accept_invalid_certs(request.allow_invalid_certificates)
        .user_agent(concat!("API-Explorer/", env!("CARGO_PKG_VERSION")));
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

    let mut builder = client
        .request(method.clone(), url)
        .headers(headers)
        .query(&query_parameters);
    if !body_parameters.is_empty() {
        let content_type = function.content_type.trim().to_ascii_lowercase();
        if content_type.starts_with("application/json") {
            let mut object = Map::new();
            for (name, value) in body_parameters {
                object.insert(name, json_value(&value));
            }
            builder = builder.json(&Value::Object(object));
        } else if content_type.starts_with("application/x-www-form-urlencoded")
            || content_type.is_empty()
        {
            builder = builder.form(&body_parameters);
        } else {
            return Err(AppError::new(
                "unsupported_content_type",
                format!("暂不支持请求体类型 {}", function.content_type),
            ));
        }
    }

    let started_at = Instant::now();
    let response = tokio::select! {
        result = builder.send() => result.map_err(|error| {
            if error.is_timeout() {
                AppError::new("timeout", "请求超时，请检查网络、代理或接口地址")
            } else if error.is_connect() {
                AppError::new("connection_failed", format!("连接失败：{error}"))
            } else {
                AppError::new("request_failed", format!("请求失败：{error}"))
            }
        })?,
        _ = cancellation.cancelled() => {
            return Err(AppError::new("cancelled", "请求已取消"));
        }
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
        .map(|(name, value)| ResponseHeader {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<二进制值>").to_string(),
        })
        .collect();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::new("response_error", format!("读取响应失败：{error}")))?;
    let token = if request.acquire_token {
        extract_token(&function.token_pattern, &body, &response_headers)?
    } else {
        None
    };

    Ok(ApiResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        elapsed_ms,
        url: final_url,
        content_type,
        headers,
        body,
        token,
    })
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(feature = "portable")]
            let data_directory = std::env::current_exe()?
                .parent()
                .ok_or("无法确定便携版程序目录")?
                .to_path_buf();
            #[cfg(not(feature = "portable"))]
            let data_directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_directory)?;
            let database_path = data_directory.join("ApiInfo2.0.db");
            if !database_path.exists() {
                let seed_path = data_directory.join("ApiInfo2.0.db.seed");
                std::fs::write(&seed_path, BUNDLED_DATABASE)?;
                std::fs::rename(seed_path, &database_path)?;
            }
            let migration: CatalogMigration = serde_json::from_str(include_str!(
                "../../data/api_catalog_updates_2026-08-06.json"
            ))?;
            if catalog_migration_needed(&database_path, &migration)? {
                let backup_path =
                    data_directory.join(format!("ApiInfo2.0.pre-{}.db", migration.version));
                if !backup_path.exists() {
                    std::fs::copy(&database_path, backup_path)?;
                }
                apply_catalog_migration(&database_path)?;
            }
            app.manage(AppState {
                database_path,
                active_requests: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_catalog,
            get_function,
            save_parameters,
            execute_request,
            execute_cloud_request,
            preview_cloud_signature,
            execute_object_storage_request,
            preview_object_storage_signature,
            cancel_request,
            base64_encode
        ])
        .run(tauri::generate_context!())
        .expect("API Explorer 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> IdentityInput {
        IdentityInput {
            id: "app-1".into(),
            key: "secret-2".into(),
            token: "token-3".into(),
        }
    }

    #[test]
    fn replaces_every_template_in_a_value() {
        let actual = replace_templates("Basic {id}:{secert} bearer={token}", &identity());
        assert_eq!(actual, "Basic app-1:secret-2 bearer=token-3");
    }

    #[test]
    fn extracts_token_from_json_field() {
        let headers = HeaderMap::new();
        let actual = extract_token(
            "{json:tenant_access_token}",
            r#"{"tenant_access_token":"tkn+/=_2026"}"#,
            &headers,
        )
        .expect("JSON token extraction should succeed");
        assert_eq!(actual.as_deref(), Some("tkn+/=_2026"));
    }

    #[test]
    fn base_url_override_keeps_the_configured_path() {
        let actual = resolve_url(
            "https://private.example.test/root",
            "https://public.example.test/v1/users",
        )
        .expect("URL should resolve");
        assert_eq!(actual.as_str(), "https://private.example.test/v1/users");
    }

    #[test]
    fn parameter_serialization_round_trips_nested_json() {
        let source = vec![
            ("nested".to_string(), r#"{"enabled":true}"#.to_string()),
            ("blank".to_string(), String::new()),
        ];
        assert_eq!(parse_pairs(&serialize_pairs(&source)), source);
    }

    #[test]
    fn token_pattern_uses_the_first_capture_group() {
        let token = extract_token(
            r#""access_token":"([\w\-]+)""#,
            r#"{"access_token":"abc-123"}"#,
            &HeaderMap::new(),
        )
        .expect("regex should compile");
        assert_eq!(token.as_deref(), Some("abc-123"));
    }

    #[test]
    fn catalog_versions_are_compared_numerically() {
        assert!(catalog_version_at_least("2026.08.06.1", "2026.08.06"));
        assert!(catalog_version_at_least("2026.08.06.10", "2026.08.06.2"));
        assert!(!catalog_version_at_least("2026.08.06", "2026.08.06.1"));
        assert!(!catalog_version_at_least("custom", "2026.08.06.1"));
    }

    #[test]
    fn substitutes_and_percent_encodes_path_parameters() {
        let parameters = serialize_pairs(&[
            ("userId".to_string(), "张 三/42".to_string()),
            ("credential".to_string(), "{token}".to_string()),
        ]);
        let actual = substitute_path_parameters(
            "/v1/users/{userId}/credentials/{credential}?keep=yes",
            &parameters,
            &identity(),
        );
        assert_eq!(
            actual,
            "/v1/users/%E5%BC%A0%20%E4%B8%89%2F42/credentials/token-3?keep=yes"
        );
        assert!(!actual.contains("userId="));
    }

    #[test]
    fn accepts_standard_http_methods() {
        for expected in [
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ] {
            assert_eq!(
                parse_http_method(expected.as_str()).expect("standard method should parse"),
                expected
            );
        }
        assert!(parse_http_method("not a method").is_err());
    }

    #[test]
    fn migration_upserts_a_new_group_and_multiple_functions_idempotently() {
        let source_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ApiInfo2.0.db");
        let database_path = std::env::temp_dir().join(format!(
            "api-explorer-expanded-catalog-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(source_path, &database_path).expect("database copy should succeed");
        let document = r#"{
            "version": "9998.1",
            "verifiedAt": "2026-08-06",
            "applications": [],
            "functions": [],
            "newGroups": [
                { "id": 9000, "appId": 1, "name": "扩展接口" }
            ],
            "newFunctions": [
                {
                    "id": 9001,
                    "groupId": 9000,
                    "name": "更新资源",
                    "method": "PATCH",
                    "url": "/v1/resources/{resourceId}",
                    "path": "resourceId=alpha%2Fbeta",
                    "contentType": "application/json",
                    "body": "enabled=true",
                    "isToken": false,
                    "documentation": "测试 PATCH 扩展接口。",
                    "specStatus": "active",
                    "specVersion": "v1",
                    "docUrl": "https://example.test/patch"
                },
                {
                    "id": 9002,
                    "groupId": 9000,
                    "name": "删除资源",
                    "method": "DELETE",
                    "url": "/v1/resources/{resourceId}",
                    "path": "resourceId=42",
                    "isToken": false,
                    "documentation": "测试 DELETE 扩展接口。",
                    "specStatus": "active",
                    "specVersion": "v1",
                    "docUrl": "https://example.test/delete"
                }
            ]
        }"#;

        apply_catalog_migration_document(&database_path, document)
            .expect("expanded catalog should migrate");
        apply_catalog_migration_document(&database_path, document)
            .expect("expanded catalog migration should be idempotent");

        let connection = Connection::open(&database_path).expect("database should open");
        let group_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM \"group\" WHERE id = 9000",
                [],
                |row| row.get(0),
            )
            .expect("new group should be queryable");
        let function_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM function WHERE id IN (9001, 9002)",
                [],
                |row| row.get(0),
            )
            .expect("new functions should be queryable");
        let function = read_function(&connection, 9001).expect("new PATCH function should load");

        assert_eq!(group_count, 1);
        assert_eq!(function_count, 2);
        assert_eq!(function.method, "PATCH");
        assert_eq!(function.path, "resourceId=alpha%2Fbeta");
        assert!(function
            .parameters
            .iter()
            .any(|parameter| parameter.location == "path" && parameter.name == "resourceId"));

        connection
            .execute_batch(
                "DELETE FROM function WHERE id IN (9001, 9002);
                 DELETE FROM \"group\" WHERE id = 9000;",
            )
            .expect("new group and functions should be removable after migration");
        drop(connection);
        let migration: CatalogMigration =
            serde_json::from_str(document).expect("test catalog should deserialize");
        assert!(catalog_migration_needed(&database_path, &migration)
            .expect("a missing required group should force migration"));
        apply_catalog_migration_document(&database_path, document)
            .expect("missing group should be restored");
        let connection = Connection::open(&database_path).expect("database should reopen");
        let restored_group_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM \"group\" WHERE id = 9000",
                [],
                |row| row.get(0),
            )
            .expect("restored group should be queryable");
        assert_eq!(restored_group_count, 1);

        drop(connection);
        std::fs::remove_file(database_path).expect("temporary database should be removable");
    }

    #[test]
    fn bundled_legacy_database_migration_is_idempotent() {
        let source_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ApiInfo2.0.db");
        let database_path = std::env::temp_dir().join(format!(
            "api-explorer-catalog-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(source_path, &database_path).expect("database copy should succeed");
        let migration: CatalogMigration = serde_json::from_str(include_str!(
            "../../data/api_catalog_updates_2026-08-06.json"
        ))
        .expect("catalog should deserialize");
        {
            let connection = Connection::open(&database_path).expect("database should open");
            connection
                .execute("DELETE FROM function WHERE id = 88", [])
                .expect("new function should be removable from fixture");
            connection
                .execute_batch(
                    "DROP TABLE api_catalog_metadata;
                     ALTER TABLE function DROP COLUMN change_note;
                     ALTER TABLE function DROP COLUMN verified_at;
                     ALTER TABLE function DROP COLUMN doc_url;
                     ALTER TABLE function DROP COLUMN spec_version;
                     ALTER TABLE function DROP COLUMN spec_status;",
                )
                .expect("fixture should be convertible to the legacy schema");
        }
        assert!(catalog_migration_needed(&database_path, &migration)
            .expect("legacy database should be checked"));
        apply_catalog_migration(&database_path).expect("catalog migration should succeed");
        apply_catalog_migration(&database_path).expect("repeated migration should succeed");
        let connection = Connection::open(&database_path).expect("bundled database should open");
        let application_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM application", [], |row| row.get(0))
            .expect("application table should be readable");
        let function_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM function", [], |row| row.get(0))
            .expect("function table should be readable");
        let function = read_function(&connection, 88).expect("new function should deserialize");

        assert_eq!(application_count, 9);
        assert_eq!(
            function_count,
            (migration.functions.len() + migration.new_functions.len()) as i64
        );
        assert_eq!(function.name, "获取稳定版接口调用凭据");
        assert_eq!(function.token_pattern, "{json:access_token}");
        assert!(function.parameters.iter().any(|parameter| parameter.locked));
        connection
            .execute("DELETE FROM function WHERE id = 88", [])
            .expect("new function should be removable after migration");
        drop(connection);
        assert!(catalog_migration_needed(&database_path, &migration)
            .expect("a missing required function should force migration"));
        apply_catalog_migration(&database_path).expect("missing function should be restored");
        let connection = Connection::open(&database_path).expect("database should reopen");
        assert_eq!(
            read_function(&connection, 88)
                .expect("restored function should deserialize")
                .name,
            "获取稳定版接口调用凭据"
        );
        connection
            .execute(
                "UPDATE api_catalog_metadata SET value = '9999.0' WHERE key = 'catalog_version'",
                [],
            )
            .expect("future version should be writable");
        drop(connection);
        assert!(!catalog_migration_needed(&database_path, &migration)
            .expect("future database should be checked"));
        let connection = Connection::open(&database_path).expect("database should reopen");
        connection
            .execute("ALTER TABLE function DROP COLUMN change_note", [])
            .expect("required column should be removable from fixture");
        drop(connection);
        assert!(catalog_migration_needed(&database_path, &migration)
            .expect("schema should be checked even for future metadata"));
        std::fs::remove_file(database_path).expect("temporary database should be removable");
    }
}
