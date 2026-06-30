//! POST /api/v3/templates/{id}/report — report a template to global moderators.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::ReportCreate,
    routes::v3::utils::{audit, sanctions},
};

pub async fn report_template(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReportCreate>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, String)> {
    // Enforcement: bans block all writes; SendReports blocks report submissions.
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[(sanctions::Sanction::SendReports, None)],
    )
    .await?;

    let reason = body.reason.trim();
    if reason.len() < 10 || reason.len() > 2000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "reason must be 10–2000 characters".to_string(),
        ));
    }

    let template_exists: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if template_exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "template not found".to_string()));
    }

    sqlx::query(
        r#"INSERT INTO reports (type, target_id, reporter_id, reason, evidence)
           VALUES ('template', $1, $2, $3, $4)"#,
    )
    .bind(id.to_string())
    .bind(auth.user_id)
    .bind(reason)
    .bind(body.evidence.as_deref())
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "report_submitted",
        "template",
        &id.to_string(),
        json!({ "reason": reason }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(json!({"ok": true, "message": "report submitted"}))))
}
