//! Boot-time owner seeding.
//!
//! If the `users` table is empty and `WALL_OWNER_SEED` is a valid JSON object,
//! the backend creates the first user with the requested roles. Once any user
//! exists, seeding is skipped. If `WALL_OWNER_SEED` is set but users already
//! exist, the backend logs a warning and prints the SQL command needed to
//! manually promote an existing user.

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::AppConfig;

pub async fn seed_owner_if_needed(pool: &PgPool, config: &AppConfig) {
    let seed = match &config.owner_seed {
        Some(s) => s,
        None => return,
    };

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await
        .unwrap_or(0);

    if count > 0 {
        eprintln!("[boot] WARNING: WALL_OWNER_SEED is set but the database already contains {} user(s).", count);
        eprintln!("[boot] Owner seeding is skipped. To promote an existing user manually, run:");
        eprintln!(
            "       UPDATE users SET global_role = 'owner', role = 'admin' WHERE username = '<username>';"
        );
        eprintln!("       UPDATE users SET global_role = 'owner', role = 'admin' WHERE id = '<uuid>';");
        return;
    }

    let uid = Uuid::new_v4();
    let result = sqlx::query(
        r#"INSERT INTO users
              (id, source, external_id, username, role, global_role, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())"#,
    )
    .bind(uid)
    .bind(&seed.source)
    .bind(&seed.external_id)
    .bind(&seed.username)
    .bind(&seed.role)
    .bind(&seed.global_role)
    .execute(pool)
    .await;

    match result {
        Ok(_) => eprintln!(
            "[boot] Seeded owner user '{}' (id={}, external_id={}) with global_role={}",
            seed.username, uid, seed.external_id, seed.global_role
        ),
        Err(e) => eprintln!("[boot] ERROR: failed to seed owner user: {e}"),
    }
}
