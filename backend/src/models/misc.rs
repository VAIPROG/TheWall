use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: Uuid,
    pub user_id: Uuid,
    #[serde(rename = "type")]
    pub notification_type: String,
    pub title: String,
    pub body: Option<String>,
    #[serde(rename = "isRead")]
    pub read: bool,
    pub action_url: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub dismissed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationView {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub notification_type: String,
    pub title: String,
    pub body: Option<String>,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    pub action_url: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPage {
    pub items: Vec<NotificationView>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AckRequest {
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub user_id: Uuid,
    pub push_enabled: bool,
    pub template_status_changes: bool,
    pub clan_invites: bool,
    pub restriction_updates: bool,
    pub mod_actions: bool,
    pub system_announcements: bool,
    pub news_announcements: bool,
    pub mentions: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettingsUpdate {
    pub push_enabled: Option<bool>,
    pub template_status_changes: Option<bool>,
    pub clan_invites: Option<bool>,
    pub restriction_updates: Option<bool>,
    pub mod_actions: Option<bool>,
    pub system_announcements: Option<bool>,
    pub news_announcements: Option<bool>,
    pub mentions: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvatarRequest {
    pub image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModApplyRequest {
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HigherLimitsRequest {
    pub justification: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRelayRequest {
    pub markdown: String,
}

// ===========================================================================
// Telemetry models
// ===========================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub data: serde_json::Value,
    pub session_id: Option<Uuid>,
    pub page_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryBatch {
    pub events: Vec<TelemetryEvent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: String,
    pub message: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub source: Option<String>,
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    pub stack: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogBatch {
    pub client_version: String,
    pub session_id: Option<Uuid>,
    pub logs: Vec<LogEntry>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub id: Uuid,
    pub account_id: Option<Uuid>,
    pub level: String,
    pub message: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub source: Option<String>,
    pub session_id: Option<Uuid>,
    pub context: Option<serde_json::Value>,
    pub stack: Option<String>,
    pub tags: Option<Vec<String>>,
    pub client_version: String,
    pub ip: Option<String>,
    pub received_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogIngestResult {
    pub accepted: i64,
    pub rejected: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub status: String,
    pub uptime: i64,
    pub database: String,
    pub maintenance_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance_reason: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePoolStats {
    pub active: i64,
    pub idle: i64,
    pub waiting: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub request_rate: f64,
    pub average_latency_ms: f64,
    pub active_connections: i64,
    pub database_pool: DatabasePoolStats,
    pub memory_usage_mb: f64,
    pub cpu_usage_percent: f64,
}
