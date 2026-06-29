//! V3 chat + message models — wire shapes, FromRow impls, request DTOs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/// A chat row from the `chats` table.
#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ChatV3 {
    pub id: Uuid,
    #[serde(rename = "type")]
    #[sqlx(rename = "type")]
    pub chat_type: String,
    pub clan_id: Option<Uuid>,
    pub dm_key: Option<String>,
    pub topic: Option<String>,
    pub slowmode_seconds: i32,
    pub created_at: DateTime<Utc>,
}

/// Wire shape for `GET /api/v3/chats` — extends `ChatV3` with read-state
/// derived fields (`unreadCount`, `lastMessageAt`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummaryView {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub chat_type: String,
    pub clan_id: Option<Uuid>,
    pub dm_key: Option<String>,
    pub topic: Option<String>,
    pub slowmode_seconds: i32,
    pub created_at: DateTime<Utc>,
    pub unread_count: i64,
    pub last_message_at: Option<DateTime<Utc>>,
}


// ---------------------------------------------------------------------------
// Reaction
// ---------------------------------------------------------------------------

/// A single emoji reaction bucket on a message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub emoji: String,
    pub count: i64,
    pub reacted_by_me: bool,
}

// ---------------------------------------------------------------------------
// Message (raw DB row)
// ---------------------------------------------------------------------------

/// A raw message row — carries all columns, not yet flattened for the wire.
#[derive(Debug, Clone, FromRow)]
pub struct MessageV3 {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub author_id: Option<Uuid>,
    pub content: String,
    pub reply_to_id: Option<Uuid>,
    pub edited_at: Option<DateTime<Utc>>,
    pub edit_count: i32,
    pub deleted_at: Option<DateTime<Utc>>,
    pub deleted_by: Option<Uuid>,
    pub is_system: bool,
    pub version: i32,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// MessageView — wire shape returned to clients
// ---------------------------------------------------------------------------

/// The serialised representation of a message.  Deleted messages keep their
/// metadata (id, author, timestamps) but the content is blanked to "" and
/// `is_deleted` is set to `true` so clients can render a tombstone.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub author_id: Option<Uuid>,
    pub author_username: Option<String>,
    pub content: String,
    pub reply_to_id: Option<Uuid>,
    pub edited_at: Option<DateTime<Utc>>,
    pub edit_count: i32,
    pub deleted_at: Option<DateTime<Utc>>,
    pub deleted_by: Option<Uuid>,
    pub is_system: bool,
    pub is_deleted: bool,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub reactions: Vec<Reaction>,
}

impl MessageView {
    /// Build a `MessageView` from a raw DB row + joined author username.
    /// Blanks content for deleted messages so deleted text never leaks.
    pub fn from_row(msg: MessageV3, author_username: Option<String>) -> Self {
        let is_deleted = msg.deleted_at.is_some();
        let content = if is_deleted {
            String::new()
        } else {
            msg.content
        };
        MessageView {
            id: msg.id,
            chat_id: msg.chat_id,
            author_id: msg.author_id,
            author_username,
            content,
            reply_to_id: msg.reply_to_id,
            edited_at: msg.edited_at,
            edit_count: msg.edit_count,
            deleted_at: msg.deleted_at,
            deleted_by: msg.deleted_by,
            is_system: msg.is_system,
            is_deleted,
            version: msg.version,
            created_at: msg.created_at,
            reactions: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Raw join row used by list_messages / send_message
// ---------------------------------------------------------------------------

/// Flat row returned by the messages-with-author JOIN query.
#[derive(Debug, Clone, FromRow)]
pub struct MessageJoinRow {
    // message columns
    pub id: Uuid,
    pub chat_id: Uuid,
    pub author_id: Option<Uuid>,
    pub content: String,
    pub reply_to_id: Option<Uuid>,
    pub edited_at: Option<DateTime<Utc>>,
    pub edit_count: i32,
    pub deleted_at: Option<DateTime<Utc>>,
    pub deleted_by: Option<Uuid>,
    pub is_system: bool,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    // joined column
    pub author_username: Option<String>,
}

impl MessageJoinRow {
    pub fn into_view(self) -> MessageView {
        let is_deleted = self.deleted_at.is_some();
        let content = if is_deleted {
            String::new()
        } else {
            self.content
        };
        MessageView {
            id: self.id,
            chat_id: self.chat_id,
            author_id: self.author_id,
            author_username: self.author_username,
            content,
            reply_to_id: self.reply_to_id,
            edited_at: self.edited_at,
            edit_count: self.edit_count,
            deleted_at: self.deleted_at,
            deleted_by: self.deleted_by,
            is_system: self.is_system,
            is_deleted,
            version: self.version,
            created_at: self.created_at,
            reactions: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Request / query DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageReq {
    pub content: String,
    pub reply_to_id: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditMessageReq {
    pub content: String,
    pub expected_version: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageListQuery {
    /// Cursor: return messages created_at < this message's created_at.
    pub before: Option<Uuid>,
    /// Cursor: return messages created_at > this message's created_at.
    pub after: Option<Uuid>,
    pub limit: Option<i64>,
}

/// Request body for `POST /api/v3/chats/{cid}/read`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReadRequest {
    /// Mark up to this specific message as read.  When omitted, marks the
    /// latest message in the chat as read.
    pub message_id: Option<Uuid>,
}
