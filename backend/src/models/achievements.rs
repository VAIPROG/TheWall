//! V3 achievement models.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementCatalog {
    pub id: String,
    pub category: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub rarity: Rarity,
    pub unlock_criteria: UnlockCriteria,
    pub points: u32,
    pub secret: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Rarity {
    Common,
    Uncommon,
    Rare,
    Legendary,
    Unique,
}

impl Rarity {
    pub fn from_str(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "uncommon" => Rarity::Uncommon,
            "rare" => Rarity::Rare,
            "legendary" => Rarity::Legendary,
            "unique" => Rarity::Unique,
            _ => Rarity::Common,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UnlockCriteria {
    Manual,
    Event { event: String },
    Condition { condition: String },
    AchievementCount { count: u32 },
}

impl UnlockCriteria {
    /// Build an `UnlockCriteria` from the raw DB row kind/config.
    pub fn from_db(kind: &str, config: Option<Value>) -> Self {
        match kind {
            "event" => UnlockCriteria::Event {
                event: config
                    .as_ref()
                    .and_then(|c| c.get("event"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            },
            "condition" => UnlockCriteria::Condition {
                condition: config
                    .as_ref()
                    .map(|c| c.to_string())
                    .unwrap_or_default(),
            },
            "achievement_count" => UnlockCriteria::AchievementCount {
                count: config
                    .as_ref()
                    .and_then(|c| c.get("count"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
            },
            _ => UnlockCriteria::Manual,
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            UnlockCriteria::Manual => "manual",
            UnlockCriteria::Event { .. } => "event",
            UnlockCriteria::Condition { .. } => "condition",
            UnlockCriteria::AchievementCount { .. } => "achievement_count",
        }
    }
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementGrant {
    pub achievement: AchievementCatalog,
    pub granted_at: DateTime<Utc>,
    pub granted_by: GrantSource,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GrantSource {
    System,
    Admin { by: String, reason: Option<String> },
    Event { name: String },
    SelfUnlocked,
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementEvent {
    pub id: Uuid,
    pub event: String,
    pub metadata: Option<Value>,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Request/response bodies
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantAchievementRequest {
    pub user_id: Uuid,
    pub reason: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeAchievementRequest {
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementEventRequest {
    pub event: String,
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementRecheckResponse {
    pub newly_unlocked: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementEventResponse {
    pub new: bool,
    pub achievement: Option<AchievementCatalog>,
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AchievementRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub icon_url: Option<String>,
    pub category: String,
    pub points: i32,
    pub secret: bool,
    pub rarity: String,
    pub unlock_kind: String,
    pub unlock_config: Option<Value>,
}

impl AchievementRow {
    pub fn to_catalog(self) -> AchievementCatalog {
        AchievementCatalog {
            id: self.id.clone(),
            category: self.category,
            title: self.name,
            description: self.description,
            icon_url: self.icon_url,
            rarity: Rarity::from_str(&self.rarity),
            unlock_criteria: UnlockCriteria::from_db(&self.unlock_kind, self.unlock_config),
            points: self.points as u32,
            secret: self.secret,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AchievementGrantRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub achievement_id: String,
    pub source: String,
    pub source_id: Option<Uuid>,
    pub reason: Option<String>,
    pub metadata: Option<Value>,
    pub granted_at: DateTime<Utc>,
}

impl AchievementGrantRow {
    pub fn source_label(&self) -> GrantSource {
        match self.source.as_str() {
            "admin" => GrantSource::Admin {
                by: self.source_id.map(|u| u.to_string()).unwrap_or_default(),
                reason: self.reason.clone(),
            },
            "event" => GrantSource::Event {
                name: self.reason.clone().unwrap_or_else(|| "unknown".to_string()),
            },
            "self" => GrantSource::SelfUnlocked,
            _ => GrantSource::System,
        }
    }
}
