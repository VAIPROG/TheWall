//! V3 unified feed API.
//!
//! Endpoints:
//!   GET  /api/v3/feed                       — public list of feed events
//!   GET  /api/v3/feed/{id}                  — single event
//!   GET  /api/v3/feed/{id}/notes            — per-language notes
//!   POST /api/v3/admin/feed                 — create announcement/milestone
//!   POST /api/v3/admin/feed/{id}/notes      — upsert a note (admin)
//!   DELETE /api/v3/admin/feed/{id}/notes/{lang} — delete a note (admin)

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use crate::http_error::ResultExt;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::feed::{
        FeedEvent, FeedEventNote, FeedEventRow, FeedNoteBody, FeedNoteRow, FeedQuery,
    },
    routes::v3::utils::permissions,
};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<FeedQuery>,
) -> Result<Json<Vec<FeedEvent>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let rows: Vec<FeedEventRow> = sqlx::query_as::<_, FeedEventRow>(
        r#"SELECT id, event_type, source, external_id, title, description,
                  payload, media, occurred_at, created_at
             FROM feed_events
            WHERE ($1::text IS NULL OR event_type = $1)
              AND ($2::text IS NULL OR source = $2)
              AND ($3::timestamptz IS NULL OR occurred_at > $3)
              AND ($4::timestamptz IS NULL OR occurred_at < $4)
              AND ($5::uuid IS NULL OR created_at < (
                  SELECT created_at FROM feed_events WHERE id = $5
              ))
            ORDER BY occurred_at DESC, created_at DESC
            LIMIT $6"#,
    )
    .bind(q.event_type.as_deref())
    .bind(q.source.as_deref())
    .bind(q.since)
    .bind(q.until)
    .bind(q.after)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(rows.into_iter().map(FeedEventRow::into_model).collect()))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<FeedEvent>, (StatusCode, String)> {
    let row: FeedEventRow = sqlx::query_as::<_, FeedEventRow>(
        r#"SELECT id, event_type, source, external_id, title, description,
                  payload, media, occurred_at, created_at
             FROM feed_events
            WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?
    .ok_or((StatusCode::NOT_FOUND, "event not found".into()))?;

    Ok(Json(row.into_model()))
}

pub async fn list_notes(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<FeedEventNote>>, (StatusCode, String)> {
    let rows: Vec<FeedNoteRow> = sqlx::query_as::<_, FeedNoteRow>(
        "SELECT lang, note, author_id, updated_at FROM feed_event_notes WHERE event_id = $1 ORDER BY lang"
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFeedBody {
    pub event_type: String,
    pub source: Option<String>,
    pub external_id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub payload: Option<Value>,
    pub media: Option<Vec<crate::models::feed::FeedMedia>>,
    pub occurred_at: Option<DateTime<Utc>>,
}

pub async fn create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<CreateFeedBody>,
) -> Result<Json<FeedEvent>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    let event_type = b.event_type.trim().to_ascii_lowercase();
    if event_type.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "event_type required".into()));
    }
    if b.external_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "external_id required".into()));
    }

    let source = b.source.as_deref().unwrap_or("system").to_string();
    let payload = b.payload.unwrap_or_else(|| json!({}));
    let media = b
        .media
        .map(|m| serde_json::to_value(m).unwrap_or(json!([])))
        .unwrap_or_else(|| json!([]));

    let row: FeedEventRow = sqlx::query_as::<_, FeedEventRow>(
        r#"INSERT INTO feed_events
             (event_type, source, external_id, title, description, payload, media, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
           RETURNING id, event_type, source, external_id, title, description,
                     payload, media, occurred_at, created_at"#,
    )
    .bind(&event_type)
    .bind(&source)
    .bind(&b.external_id)
    .bind(b.title.as_deref())
    .bind(b.description.as_deref())
    .bind(payload)
    .bind(media)
    .bind(b.occurred_at)
    .fetch_one(&state.pool)
    .await
    .or_500()?;

    Ok(Json(row.into_model()))
}

pub async fn upsert_note(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<FeedNoteBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    let lang = b.lang.trim().to_ascii_lowercase();
    if !matches!(lang.as_str(), "en" | "ru" | "de" | "fr") {
        return Err((StatusCode::BAD_REQUEST, "unsupported lang".into()));
    }

    if b.note.trim().is_empty() {
        sqlx::query("DELETE FROM feed_event_notes WHERE event_id = $1 AND lang = $2")
            .bind(id)
            .bind(&lang)
            .execute(&state.pool)
            .await
            .or_500()?;
        return Ok(StatusCode::NO_CONTENT);
    }

    if b.note.chars().count() > 2000 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "max 2000 chars".into()));
    }

    sqlx::query(
        r#"INSERT INTO feed_event_notes (event_id, lang, note, author_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (event_id, lang) DO UPDATE
             SET note = EXCLUDED.note, author_id = EXCLUDED.author_id, updated_at = NOW()"#,
    )
    .bind(id)
    .bind(&lang)
    .bind(&b.note)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(StatusCode::OK)
}

pub async fn delete_note(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((id, lang)): Path<(Uuid, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    sqlx::query("DELETE FROM feed_event_notes WHERE event_id = $1 AND lang = $2")
        .bind(id)
        .bind(lang.trim().to_ascii_lowercase())
        .execute(&state.pool)
        .await
        .or_500()?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn feed_event_row_converts_media_array() {
        let row = FeedEventRow {
            id: Uuid::nil(),
            event_type: "snapshot".into(),
            source: "filianislost".into(),
            external_id: "batch-1".into(),
            title: None,
            description: None,
            payload: json!({"batchId": Uuid::nil()}),
            media: json!([{"type": "image", "url": "https://example.com/x.png", "label": "large"}]),
            occurred_at: Utc::now(),
            created_at: Utc::now(),
        };
        let ev = row.into_model();
        assert_eq!(ev.media.len(), 1);
        assert_eq!(ev.media[0].media_type, "image");
    }

    #[test]
    fn feed_event_row_handles_bad_media() {
        let row = FeedEventRow {
            id: Uuid::nil(),
            event_type: "signal".into(),
            source: "filianislost".into(),
            external_id: "sig-1".into(),
            title: Some("Name".into()),
            description: None,
            payload: json!({}),
            media: json!("not an array"),
            occurred_at: Utc::now(),
            created_at: Utc::now(),
        };
        let ev = row.into_model();
        assert!(ev.media.is_empty());
    }
}
