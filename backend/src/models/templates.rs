use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Template {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub scope: String,
    pub status: String,
    pub share: String,
    pub author: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareTemplateRequest {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: Option<f64>,
    pub scope: String,
    pub share: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportRequest {
    pub reason: Option<String>,
}
