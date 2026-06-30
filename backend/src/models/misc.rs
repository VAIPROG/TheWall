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
