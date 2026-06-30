//! V3 telemetry endpoints:
//!   POST  /api/v3/telemetry/events
//!   POST  /api/v3/telemetry/logs
//!   GET   /api/v3/telemetry/logs
//!   GET   /api/v3/telemetry/logs/export
//!   GET   /api/v3/telemetry/health
//!   GET   /api/v3/telemetry/metrics

use axum::{
    Json,
    extract::{ConnectInfo, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{DatabasePoolStats, HealthStatus, LogBatch, LogIngestResult, LogRecord, MetricsSnapshot, TelemetryBatch},
    routes::v3::utils::permissions::global_role_of,
};

// ---------------------------------------------------------------------------
// POST /api/v3/telemetry/events
// ---------------------------------------------------------------------------

pub async fn submit_events(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<TelemetryBatch>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let opted_in: Option<bool> = sqlx::query_scalar(
        "SELECT telemetry_opt_in FROM users WHERE id = $1",
    )
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !opted_in.unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "telemetry opt-in required".to_string()));
    }

    if body.events.is_empty() || body.events.len() > 100 {
        return Err((StatusCode::BAD_REQUEST, "events must be 1–100".to_string()));
    }

    for e in body.events {
        sqlx::query(
            r#"INSERT INTO telemetry_events
                  (user_id, event_type, client_ts, data, session_id, page_url)
               VALUES ($1, $2, $3, $4, $5, $6)"#,
        )
        .bind(auth.user_id)
        .bind(&e.event_type)
        .bind(e.timestamp)
        .bind(&e.data)
        .bind(e.session_id)
        .bind(e.page_url)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    Ok(Json(json!({"ok": true, "message": "events accepted"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/telemetry/logs
// ---------------------------------------------------------------------------

pub async fn upload_logs(
    auth: AuthUser,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LogBatch>,
) -> Result<Json<LogIngestResult>, (StatusCode, String)> {
    let opted_in: Option<bool> = sqlx::query_scalar(
        "SELECT telemetry_opt_in FROM users WHERE id = $1",
    )
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !opted_in.unwrap_or(false) {
        return Ok(Json(LogIngestResult { accepted: 0, rejected: body.logs.len() as i64 }));
    }

    if body.logs.is_empty() || body.logs.len() > 200 {
        return Err((StatusCode::BAD_REQUEST, "logs must be 1–200".to_string()));
    }

    let recent: Option<bool> = sqlx::query_scalar(
        r#"SELECT TRUE FROM telemetry_rate_limits
            WHERE user_id = $1 AND last_log_at > NOW() - INTERVAL '10 seconds'"#,
    )
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if recent.is_some() {
        return Err((StatusCode::TOO_MANY_REQUESTS, "rate limited".to_string()));
    }

    let mut accepted = 0i64;
    let ip = addr.ip().to_string();

    let total_logs = body.logs.len();
    for log in &body.logs {
        if log.message.len() > 8000 {
            continue;
        }
        sqlx::query(
            r#"INSERT INTO telemetry_logs
                  (user_id, level, message, client_ts, source, session_id, context,
                   stack, tags, client_version, ip)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::inet)"#,
        )
        .bind(auth.user_id)
        .bind(&log.level)
        .bind(&log.message)
        .bind(log.timestamp)
        .bind(log.source.as_deref())
        .bind(body.session_id)
        .bind(log.context.clone())
        .bind(log.stack.as_deref())
        .bind(log.tags.clone())
        .bind(&body.client_version)
        .bind(&ip)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        accepted += 1;
    }

    sqlx::query(
        r#"INSERT INTO telemetry_rate_limits (user_id, last_log_at)
           VALUES ($1, NOW())
           ON CONFLICT (user_id) DO UPDATE SET last_log_at = NOW()"#,
    )
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(LogIngestResult {
        accepted,
        rejected: total_logs as i64 - accepted,
    }))
}

// ---------------------------------------------------------------------------
// GET /api/v3/telemetry/logs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct LogQuery {
    pub level: Option<String>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub user_ref: Option<String>,
    pub session_id: Option<Uuid>,
    pub source: Option<String>,
    pub q: Option<String>,
    pub cursor: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}

pub async fn query_logs(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<LogQuery>,
) -> Result<Json<Vec<LogRecord>>, (StatusCode, String)> {
    let role = global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !role.is_admin() {
        return Err((StatusCode::FORBIDDEN, "admin required".to_string()));
    }

    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let mut filters = vec!["1=1".to_string()];
    if let Some(level) = q.level {
        filters.push(format!("level = '{level}'"));
    }
    if let Some(from) = q.from {
        filters.push(format!("client_ts >= '{}'::timestamptz", from.to_rfc3339()));
    }
    if let Some(to) = q.to {
        filters.push(format!("client_ts <= '{}'::timestamptz", to.to_rfc3339()));
    }
    if let Some(session_id) = q.session_id {
        filters.push(format!("session_id = '{}'", session_id));
    }
    if let Some(source) = q.source {
        filters.push(format!("source = '{source}'"));
    }
    if let Some(cursor) = q.cursor {
        filters.push(format!("client_ts < '{}'::timestamptz", cursor.to_rfc3339()));
    }
    if let Some(user_ref) = q.user_ref {
        if let Ok(uid) = Uuid::parse_str(&user_ref) {
            filters.push(format!("user_id = '{}'", uid));
        } else {
            let escaped = user_ref.replace('\'', "''");
            filters.push(format!(
                "user_id = (SELECT id FROM users WHERE lower(username) = lower('{escaped}'))"
            ));
        }
    }
    if let Some(query) = q.q {
        let escaped = query.replace('\'', "''");
        filters.push(format!("message ILIKE '%{escaped}%'"));
    }

    let where_clause = filters.join(" AND ");
    let sql = format!(
        r#"SELECT id, user_id AS account_id, level, message, client_ts AS timestamp,
                  source, session_id, context, stack, tags, client_version,
                  ip::text, received_at
             FROM telemetry_logs
            WHERE {where_clause}
            ORDER BY client_ts DESC
            LIMIT {limit}"#
    );

    let rows = sqlx::query_as::<_, LogRecord>(&sql)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}

// ---------------------------------------------------------------------------
// GET /api/v3/telemetry/logs/export
// ---------------------------------------------------------------------------

pub async fn export_logs(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<LogQuery>,
) -> Result<Response, (StatusCode, String)> {
    let rows = query_logs(auth, State(state), Query(q)).await?.0;
    let body = rows
        .into_iter()
        .map(|r| serde_json::to_string(&r).unwrap())
        .collect::<Vec<_>>()
        .join("\n");

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        body,
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// GET /api/v3/telemetry/health
// ---------------------------------------------------------------------------

pub async fn health_check(
    State(state): State<AppState>,
) -> Result<Json<HealthStatus>, (StatusCode, String)> {
    let db_ok = sqlx::query_scalar::<_, bool>("SELECT TRUE")
        .fetch_optional(&state.pool)
        .await
        .is_ok();

    let uptime = std::time::SystemTime::now()
        .duration_since(state.started_at)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let maintenance = std::env::var("WALL_MAINTENANCE_MODE")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false);

    let status = if !db_ok || maintenance {
        "maintenance"
    } else {
        "healthy"
    };

    Ok(Json(HealthStatus {
        status: status.to_string(),
        uptime,
        database: if db_ok { "connected".to_string() } else { "disconnected".to_string() },
        maintenance_mode: maintenance,
        maintenance_reason: if maintenance {
            Some(std::env::var("WALL_MAINTENANCE_REASON").unwrap_or_default())
        } else {
            None
        },
        version: env!("CARGO_PKG_VERSION").to_string(),
    }))
}

// ---------------------------------------------------------------------------
// GET /api/v3/telemetry/metrics
// ---------------------------------------------------------------------------

pub async fn get_metrics(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<MetricsSnapshot>, (StatusCode, String)> {
    let role = global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !role.is_admin() {
        return Err((StatusCode::FORBIDDEN, "admin required".to_string()));
    }

    let pool_stats = DatabasePoolStats {
        active: state.pool.size() as i64,
        idle: 0,
        waiting: 0,
    };

    Ok(Json(MetricsSnapshot {
        request_rate: 0.0,
        average_latency_ms: 0.0,
        active_connections: 0,
        database_pool: pool_stats,
        memory_usage_mb: 0.0,
        cpu_usage_percent: 0.0,
    }))
}
