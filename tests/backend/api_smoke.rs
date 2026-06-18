//! Live HTTP smoke tests — every test is `#[ignore]` so a plain `cargo test`
//! stays green without a running server.
//!
//! Run against a local backend:
//!     cargo test --manifest-path backend/Cargo.toml -- --ignored
//! Or against production:
//!     WALL_TEST_BASE_URL=https://the-wall.vai-rice.space \
//!         cargo test --manifest-path backend/Cargo.toml -- --ignored

fn base() -> String {
    std::env::var("WALL_TEST_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3080".to_string())
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("build http client")
}

#[test]
#[ignore = "needs a running backend (see module docs)"]
fn meta_reports_version_and_v2() {
    let resp = client()
        .get(format!("{}/api/meta", base()))
        .send()
        .expect("GET /api/meta");
    assert_eq!(resp.status(), 200, "/api/meta status");
    let v: serde_json::Value = resp.json().expect("meta json");
    assert!(
        v.get("version").and_then(|x| x.as_str()).is_some(),
        "meta.version missing: {v}"
    );
    let api_versions = v
        .get("api_versions")
        .and_then(|x| x.as_array())
        .expect("meta.api_versions array");
    assert!(
        api_versions.iter().any(|x| x.as_str() == Some("v2")),
        "v2 not advertised: {api_versions:?}"
    );
}

#[test]
#[ignore = "needs a running backend (see module docs)"]
fn announcements_endpoint_is_up() {
    let resp = client()
        .get(format!("{}/api/announcements", base()))
        .send()
        .expect("GET /api/announcements");
    assert_eq!(resp.status(), 200, "/api/announcements status");
}

/// Unsigned interaction POSTs must NEVER be accepted: 401 means the Ed25519
/// key is configured and verification is active; 503 means the key is absent
/// and the feature is disabled. Anything 2xx would get the endpoint banned by
/// Discord's bad-signature probes.
#[test]
#[ignore = "needs a running backend (see module docs)"]
fn discord_interactions_rejects_unsigned() {
    let resp = client()
        .post(format!("{}/api/v2/discord/interactions", base()))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .expect("POST /api/v2/discord/interactions");
    let s = resp.status().as_u16();
    assert!(
        s == 401 || s == 503,
        "unsigned interaction must be 401 (key set) or 503 (key missing), got {s}"
    );
}

#[test]
#[ignore = "needs a running backend (see module docs)"]
fn me_links_requires_auth() {
    let resp = client()
        .get(format!("{}/api/v2/me/links", base()))
        .send()
        .expect("GET /api/v2/me/links");
    let s = resp.status().as_u16();
    assert!(
        s == 401 || s == 403,
        "links status without Authorization must be 401/403, got {s}"
    );
}
