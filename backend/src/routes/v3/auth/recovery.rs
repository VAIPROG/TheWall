use axum::{
    extract::{Json, State},
    http::StatusCode,
};
use rand::Rng;

use crate::{
    AppState,
    auth::{AuthUser, hash_token, issue_session_pair},
    models::{RecoverRequest, RecoveryPhraseResponse, User, V3AuthResponse},
};

// ---------------------------------------------------------------------------
// BIP-39 English wordlist (2048 words, ~11 bits per word).
// 8 words × 11 bits ≈ 88 bits of entropy — safe against brute-force even
// with an unsalted SHA-256 hash, because the search space is 2048^8 ≈ 2^88.
// ---------------------------------------------------------------------------

static WORDS_RAW: &str = include_str!("bip39_english.txt");

fn wordlist() -> Vec<&'static str> {
    WORDS_RAW.lines().map(str::trim).filter(|w| !w.is_empty()).collect()
}

// ---------------------------------------------------------------------------
// Phrase helpers
// ---------------------------------------------------------------------------

/// Normalise a phrase: trim outer whitespace, lowercase, collapse internal runs
/// of whitespace to a single space. Apply identically on generation and on
/// recovery so the hash always matches.
fn normalise(phrase: &str) -> String {
    phrase
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn generate_8_words() -> String {
    let words = wordlist();
    let len = words.len();
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| words[rng.gen_range(0..len)])
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// POST /api/v3/users/me/recovery/phrase  (auth required)
//
// Generates a fresh 8-word BIP-39 recovery phrase, stores its SHA-256/base64
// hash, and returns the phrase ONCE. A subsequent call regenerates the phrase
// (the old one is invalidated).
// ---------------------------------------------------------------------------

pub async fn generate_phrase(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<RecoveryPhraseResponse>, (StatusCode, String)> {
    let phrase = generate_8_words();
    let phrase_hash = hash_token(&normalise(&phrase));

    let created_at = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
        "INSERT INTO account_recovery (account_id, phrase_hash, created_at)
         VALUES ($1, $2, now())
         ON CONFLICT (account_id) DO UPDATE
             SET phrase_hash = EXCLUDED.phrase_hash,
                 created_at  = now()
         RETURNING created_at",
    )
    .bind(auth.user_id)
    .bind(&phrase_hash)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RecoveryPhraseResponse {
        phrase,
        word_count: 8,
        created_at,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/v3/auth/recover  (no auth — this IS the auth)
//
// Rate-limiting is enforced at the nginx/edge layer; no in-process limiter
// here (noted for future slices: add a token-bucket or fail2ban rule).
// ---------------------------------------------------------------------------

pub async fn recover(
    State(state): State<AppState>,
    Json(body): Json<RecoverRequest>,
) -> Result<Json<V3AuthResponse>, (StatusCode, String)> {
    let phrase_hash = hash_token(&normalise(&body.phrase));

    let account_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT account_id FROM account_recovery WHERE phrase_hash = $1 LIMIT 1",
    )
    .bind(&phrase_hash)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or_else(|| (StatusCode::UNAUTHORIZED, "invalid recovery phrase".to_string()))?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(account_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "account not found".to_string()))?;

    let (access, refresh, _session_id) = issue_session_pair(&state.pool, &state.config.jwt_secret, user.id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(super::v3_response(access, refresh, &user)))
}
