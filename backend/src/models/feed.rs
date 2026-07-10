//! V3 unified feed models.
//!
//! Everything that appears on the wall feed (snapshots, mirrored signals,
//! announcements, milestones, ...) is stored as a single `FeedEvent` row.
//! Consumers render the event based on `event_type` and the structured
//! `payload` / `media` fields.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedEvent {
    pub id: Uuid,
    pub event_type: String,
    pub source: String,
    pub external_id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub payload: Value,
    pub media: Vec<FeedMedia>,
    pub occurred_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedMedia {
    #[serde(rename = "type")]
    pub media_type: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPayload {
    #[serde(rename = "batchId")]
    pub batch_id: Option<Uuid>,
    pub sizes: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalPayload {
    #[serde(rename = "numId")]
    pub num_id: Option<i64>,
    pub name: Option<String>,
    pub location: Option<String>,
    #[serde(rename = "imageFile")]
    pub image_file: Option<String>,
    #[serde(rename = "submittedAt")]
    pub submitted_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedQuery {
    pub event_type: Option<String>,
    pub source: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub after: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedNoteBody {
    pub lang: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedEventNote {
    pub lang: String,
    pub note: String,
    pub author_id: Option<Uuid>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FeedEventRow {
    pub id: Uuid,
    pub event_type: String,
    pub source: String,
    pub external_id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub payload: Value,
    pub media: Value,
    pub occurred_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl FeedEventRow {
    pub fn into_model(self) -> FeedEvent {
        FeedEvent {
            id: self.id,
            event_type: self.event_type,
            source: self.source,
            external_id: self.external_id,
            title: self.title,
            description: self.description,
            payload: self.payload,
            media: serde_json::from_value(self.media).unwrap_or_default(),
            occurred_at: self.occurred_at,
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FeedNoteRow {
    pub lang: String,
    pub note: String,
    pub author_id: Option<Uuid>,
    pub updated_at: DateTime<Utc>,
}

impl From<FeedNoteRow> for FeedEventNote {
    fn from(r: FeedNoteRow) -> Self {
        FeedEventNote {
            lang: r.lang,
            note: r.note,
            author_id: r.author_id,
            updated_at: r.updated_at,
        }
    }
}
