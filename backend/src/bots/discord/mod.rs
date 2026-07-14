//! Discord adapter for the bot framework.
//!
//! Self-contained transport glue: everything Discord-specific lives here so the
//! framework core stays platform-agnostic. Two delivery paths share ONE dispatch
//! flow:
//!
//!   1. **Interactions webhook** (`interactions`) — Discord POSTs Ed25519-signed
//!      interactions to our endpoint. We verify the signature (mandatory —
//!      Discord probes with bad signatures and disables endpoints that accept
//!      them), answer PINGs, and for commands/components defer immediately then
//!      finish the real answer in a spawned task that PATCHes `@original`.
//!   2. **Gateway session** (`gateway_spawn`) — holds an Identified socket so the
//!      bot shows Online, and (when no Interactions Endpoint URL is configured in
//!      the portal) receives interactions as INTERACTION_CREATE dispatches. Those
//!      are acked via the REST callback endpoint, then routed through the exact
//!      same followup logic as the webhook.
//!
//! The registry is obtained via `crate::bots::registry()` — the webhook handler
//! only receives `State<AppState>` and can't take extra args, so the schema and
//! the dispatcher both read from the same process-global instance.

use std::collections::HashMap;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::bots::core::command::{ArgKind, ArgValue, Chat, Command, CommandArg, Platform};
use crate::bots::core::dispatch::{self, Invocation};
use crate::bots::render;
use crate::{AppState, OAuthConfig};

/// Ephemeral message flag (only the invoker sees the reply).
pub(crate) const EPHEMERAL: u64 = 1 << 6;

const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";

/* ----------------------------- registration ------------------------------ */

/// Register the global slash-command set at boot, built FROM THE REGISTRY so the
/// schema Discord validates against always matches what the dispatcher serves.
/// Fire-and-forget: a failure only logs — the webhook still answers whatever
/// commands already exist.
pub fn register_commands(oauth: OAuthConfig) {
    let (Some(app_id), Some(bot_token)) = (
        oauth.discord_application_id.clone(),
        oauth.discord_bot_token.clone(),
    ) else {
        tracing::info!("bots::discord: app id / bot token missing — slash registration skipped");
        return;
    };
    // Build the command array off the shared registry. Command + option names
    // are authored (Task 5) to satisfy Discord's ^[-_\p{L}\p{N}]{1,32}$ /
    // description 1-100 rules, so we pass them through without validation.
    let reg = crate::bots::registry();
    let commands: Vec<Value> = reg
        .all()
        .map(|cmd: &dyn Command| {
            json!({
                "name": cmd.name(),
                "description": cmd.description(),
                "type": 1,
                "options": args_to_options(&cmd.args()),
            })
        })
        .collect();

    tokio::spawn(async move {
        let url = format!("https://discord.com/api/v10/applications/{app_id}/commands");
        match reqwest::Client::new()
            .put(&url)
            .header("Authorization", format!("Bot {bot_token}"))
            .json(&json!(commands))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                tracing::info!("bots::discord: slash commands registered");
            }
            Ok(r) => tracing::warn!(
                "bots::discord: registration {}: {}",
                r.status(),
                r.text().await.unwrap_or_default()
            ),
            Err(e) => tracing::warn!("bots::discord: registration failed: {e}"),
        }
    });
}

/// Map framework command args to Discord application-command options.
/// String→3, Int→4, Bool→5, Sub(subs)→1 (SUB_COMMAND) with nested options built
/// recursively (a sub-arg that is itself `Sub` becomes a nested SUB_COMMAND).
fn args_to_options(args: &[CommandArg]) -> Vec<Value> {
    args.iter().map(arg_to_option).collect()
}

fn arg_to_option(arg: &CommandArg) -> Value {
    match &arg.kind {
        ArgKind::String => json!({ "name": arg.name, "description": arg.desc, "type": 3, "required": arg.required }),
        ArgKind::Int => json!({ "name": arg.name, "description": arg.desc, "type": 4, "required": arg.required }),
        ArgKind::Bool => json!({ "name": arg.name, "description": arg.desc, "type": 5, "required": arg.required }),
        ArgKind::Sub(subs) => json!({
            "name": arg.name,
            "description": arg.desc,
            "type": 1,
            "options": args_to_options(subs),
        }),
    }
}

/* ------------------------------ verification ----------------------------- */

fn verify_signature(public_key_hex: &str, headers: &HeaderMap, body: &[u8]) -> bool {
    let Some(sig_hex) = headers.get("x-signature-ed25519").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(timestamp) = headers.get("x-signature-timestamp").and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let (Ok(key_bytes), Ok(sig_bytes)) = (hex::decode(public_key_hex), hex::decode(sig_hex))
    else {
        return false;
    };
    let Ok(key_arr): Result<[u8; 32], _> = key_bytes.try_into() else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_arr) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);
    key.verify(&message, &sig).is_ok()
}

/* -------------------------------- handler -------------------------------- */

/// POST /api/v2/discord/interactions
///
/// verify signature → PONG for pings → for commands defer (type 5) and finish in
/// a spawned followup that PATCHes `@original`; for components defer-update
/// (type 6) and resolve the stored callback the same way. Discord cuts the cord
/// at 3 seconds — deferring makes DB latency irrelevant.
pub async fn interactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(pubkey) = state.config.oauth.discord_public_key.as_deref() else {
        tracing::warn!("bots::discord interactions hit but DISCORD_PUBLIC_KEY not set");
        return (StatusCode::SERVICE_UNAVAILABLE, "interactions not configured").into_response();
    };
    if !verify_signature(pubkey, &headers, &body) {
        tracing::warn!("bots::discord interactions: signature verification FAILED");
        return (StatusCode::UNAUTHORIZED, "invalid request signature").into_response();
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else {
        tracing::warn!("bots::discord interactions: unparseable body");
        return (StatusCode::BAD_REQUEST, "bad json").into_response();
    };

    match v.get("type").and_then(|t| t.as_u64()) {
        // PING → PONG (Discord's endpoint validation).
        Some(1) => {
            tracing::info!("bots::discord interactions: PING ok");
            axum::Json(json!({ "type": 1 })).into_response()
        }
        // APPLICATION_COMMAND → deferred ephemeral ack, then command followup.
        Some(2) => {
            spawn_command_followup(state, v);
            axum::Json(json!({ "type": 5, "data": { "flags": EPHEMERAL } })).into_response()
        }
        // MESSAGE_COMPONENT → deferred *update* ack, then component followup.
        Some(3) => {
            spawn_component_followup(state, v);
            axum::Json(json!({ "type": 6 })).into_response()
        }
        other => {
            tracing::warn!("bots::discord interactions: unsupported type {other:?}");
            (StatusCode::BAD_REQUEST, "unsupported interaction").into_response()
        }
    }
}

/* ------------------------------ followups -------------------------------- */

/// Extract (token, app_id) from an interaction Value, falling back to the
/// interaction's own `application_id` when config doesn't carry the app id.
fn token_and_app(state: &AppState, v: &Value) -> (String, String) {
    let token = v
        .pointer("/token")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let app_id = state
        .config
        .oauth
        .discord_application_id
        .clone()
        .or_else(|| {
            v.pointer("/application_id")
                .and_then(|a| a.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    (token, app_id)
}

/// Build a framework `Chat` from an interaction Value. `id` is best-effort the
/// channel id; `is_group` reflects whether the interaction came from a guild.
fn chat_from(v: &Value) -> Chat {
    let id = v
        .pointer("/channel_id")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();
    Chat {
        id,
        is_group: v.get("guild_id").is_some(),
        platform: Platform::Discord,
    }
}

/// Guild interactions carry member.user.id, DMs carry user.id.
fn invoker_id(v: &Value) -> String {
    v.pointer("/member/user/id")
        .or_else(|| v.pointer("/user/id"))
        .and_then(|i| i.as_str())
        .unwrap_or_default()
        .to_string()
}

/// PATCH the deferred original response with a rendered framework payload
/// (embeds + components), not a `{content}` blob. Shared by both followups.
async fn patch_original(app_id: String, token: String, data: Value) {
    let url = format!("https://discord.com/api/v10/webhooks/{app_id}/{token}/messages/@original");
    match reqwest::Client::new()
        .patch(&url)
        .json(&data)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            tracing::info!("bots::discord: followup delivered");
        }
        Ok(r) => tracing::warn!(
            "bots::discord: followup {}: {}",
            r.status(),
            r.text().await.unwrap_or_default()
        ),
        Err(e) => tracing::warn!("bots::discord: followup error: {e}"),
    }
}

/// Coerce a Discord option `value` by its option `type` (3→Str, 4→Int, 5→Bool).
fn coerce_option(opt: &Value) -> ArgValue {
    let val = opt.get("value");
    match opt.get("type").and_then(|t| t.as_u64()) {
        Some(3) => val.and_then(|x| x.as_str()).map(|s| ArgValue::Str(s.to_string())).unwrap_or(ArgValue::None),
        Some(4) => val.and_then(|x| x.as_i64()).map(ArgValue::Int).unwrap_or(ArgValue::None),
        Some(5) => val.and_then(|x| x.as_bool()).map(ArgValue::Bool).unwrap_or(ArgValue::None),
        // Unknown/other option type: best-effort as a string.
        _ => val.and_then(|x| x.as_str()).map(|s| ArgValue::Str(s.to_string())).unwrap_or(ArgValue::None),
    }
}

/// Parse Discord's option tree into (sub, args). If the first option is a
/// SUB_COMMAND (type 1), it names the subcommand and its nested options become
/// the args; otherwise the top-level options map directly to args.
fn parse_options(v: &Value) -> (Option<String>, HashMap<String, ArgValue>) {
    let mut args = HashMap::new();
    let Some(opts) = v.pointer("/data/options").and_then(|o| o.as_array()) else {
        return (None, args);
    };
    if let Some(first) = opts.first() {
        if first.get("type").and_then(|t| t.as_u64()) == Some(1) {
            let sub = first.get("name").and_then(|n| n.as_str()).map(String::from);
            if let Some(sub_opts) = first.get("options").and_then(|o| o.as_array()) {
                for o in sub_opts {
                    if let Some(name) = o.get("name").and_then(|n| n.as_str()) {
                        args.insert(name.to_string(), coerce_option(o));
                    }
                }
            }
            return (sub, args);
        }
    }
    for o in opts {
        if let Some(name) = o.get("name").and_then(|n| n.as_str()) {
            args.insert(name.to_string(), coerce_option(o));
        }
    }
    (None, args)
}

/// Run a slash command through the framework and PATCH the deferred response.
/// Silent-to-strangers does NOT apply on Discord — the webhook must respond;
/// `dispatch::run` returns an ephemeral "no permission" for non-admins, which is
/// the correct Discord behavior, so we just render whatever it returns.
fn spawn_command_followup(state: AppState, v: Value) {
    let command = v
        .pointer("/data/name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let external_id = invoker_id(&v);
    let (token, app_id) = token_and_app(&state, &v);
    let chat = chat_from(&v);
    let (sub, args) = parse_options(&v);
    tracing::info!("bots::discord: command /{command}");
    tokio::spawn(async move {
        let inv = Invocation { external_id, chat, command, sub, args };
        let resp = dispatch::run(&state, &crate::bots::registry(), Platform::Discord, inv).await;
        patch_original(app_id, token, render::discord::message_data(&resp)).await;
    });
}

/// Resolve a button click via the owner-scoped callback store, re-dispatch the
/// stored command, and PATCH the deferred update. Expired/foreign clicks get an
/// ephemeral "button expired" notice.
fn spawn_component_followup(state: AppState, v: Value) {
    let custom_id = v
        .pointer("/data/custom_id")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let clicker_id = invoker_id(&v);
    let (token, app_id) = token_and_app(&state, &v);
    let chat = chat_from(&v);
    tokio::spawn(async move {
        let data = match state.callback_store.take(&custom_id, &clicker_id).await {
            Some(spec) => {
                let args = spec
                    .args
                    .into_iter()
                    .map(|(k, val)| (k, ArgValue::Str(val)))
                    .collect::<HashMap<_, _>>();
                let inv = Invocation {
                    external_id: clicker_id,
                    chat,
                    command: spec.command,
                    sub: spec.sub,
                    args,
                };
                let resp = dispatch::run(&state, &crate::bots::registry(), Platform::Discord, inv).await;
                render::discord::message_data(&resp)
            }
            None => {
                let resp = crate::bots::core::response::BotResponse::text(
                    "This button expired — re-run the command.",
                )
                .ephemeral();
                render::discord::message_data(&resp)
            }
        };
        patch_original(app_id, token, data).await;
    });
}

/* ------------------------------- gateway --------------------------------- */

/// Hold an Identified gateway session so the bot shows Online, and serve
/// interactions delivered over the gateway (portal without an Interactions
/// Endpoint URL). Reconnects with backoff on any error.
pub fn gateway_spawn(state: AppState) {
    let Some(token) = state.config.oauth.discord_bot_token.clone() else {
        tracing::info!("bots::discord gateway: DISCORD_BOT_TOKEN missing — presence disabled");
        return;
    };
    tokio::spawn(async move {
        let mut backoff = 5u64;
        loop {
            let started = std::time::Instant::now();
            match session(&state, &token).await {
                Ok(()) => tracing::info!("bots::discord gateway: session ended, reconnecting"),
                Err(e) => tracing::warn!("bots::discord gateway: {e}"),
            }
            if started.elapsed() > Duration::from_secs(60) {
                backoff = 5;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(300);
        }
    });
}

/// One gateway session: connect → HELLO → IDENTIFY → heartbeat + dispatch loop.
async fn session(state: &AppState, token: &str) -> Result<(), String> {
    let (ws, _) = connect_async(GATEWAY_URL)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    let (mut tx, mut rx) = ws.split();

    let hello = next_json(&mut rx).await.ok_or("closed before HELLO")?;
    let interval_ms = hello
        .pointer("/d/heartbeat_interval")
        .and_then(|v| v.as_u64())
        .ok_or("HELLO without heartbeat_interval")?;

    let identify = json!({
        "op": 2,
        "d": {
            "token": token,
            "intents": 0,
            "properties": { "os": "linux", "browser": "the-wall-backend", "device": "the-wall-backend" },
            "presence": {
                "status": "online",
                "since": null,
                "afk": false,
                "activities": [{ "name": "The Wall", "type": 3 }]
            }
        }
    });
    tx.send(Message::Text(identify.to_string().into()))
        .await
        .map_err(|e| format!("identify send: {e}"))?;

    let mut hb = tokio::time::interval(Duration::from_millis(interval_ms.max(1000)));
    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    hb.tick().await; // interval fires immediately — consume the zeroth tick
    let mut seq: Option<u64> = None;
    let mut ready_logged = false;

    loop {
        tokio::select! {
            _ = hb.tick() => {
                tx.send(Message::Text(json!({ "op": 1, "d": seq }).to_string().into()))
                    .await
                    .map_err(|e| format!("heartbeat send: {e}"))?;
            }
            msg = rx.next() => {
                let msg = msg.ok_or("socket closed")?.map_err(|e| format!("recv: {e}"))?;
                if msg.is_close() {
                    return Err("server closed the connection".into());
                }
                let Ok(text) = msg.into_text() else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                match v.get("op").and_then(|o| o.as_u64()) {
                    // DISPATCH
                    Some(0) => {
                        if let Some(s) = v.get("s").and_then(|s| s.as_u64()) {
                            seq = Some(s);
                        }
                        match v.get("t").and_then(|t| t.as_str()) {
                            Some("READY") if !ready_logged => {
                                ready_logged = true;
                                tracing::info!("bots::discord gateway: READY — bot presence is now Online");
                            }
                            Some("INTERACTION_CREATE") => {
                                if let Some(d) = v.get("d") {
                                    handle_gateway_interaction(state, d.clone()).await;
                                }
                            }
                            _ => {}
                        }
                    }
                    // Server asks for an immediate heartbeat.
                    Some(1) => {
                        tx.send(Message::Text(json!({ "op": 1, "d": seq }).to_string().into()))
                            .await
                            .map_err(|e| format!("heartbeat send: {e}"))?;
                    }
                    // RECONNECT / INVALID_SESSION → drop and re-identify.
                    Some(7) => return Ok(()),
                    Some(9) => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        return Ok(());
                    }
                    // 11 = heartbeat ACK — nothing to do.
                    _ => {}
                }
            }
        }
    }
}

/// Gateway-delivered interaction: ack via the REST callback endpoint (deferred
/// ephemeral for commands, deferred-update for components), then route through
/// the SAME followup logic as the webhook (both PATCH `@original` by token).
async fn handle_gateway_interaction(state: &AppState, d: Value) {
    let itype = d.get("type").and_then(|t| t.as_u64());
    // Only command (2) and component (3) interactions are served here.
    let ack_body = match itype {
        Some(2) => json!({ "type": 5, "data": { "flags": EPHEMERAL } }),
        Some(3) => json!({ "type": 6 }),
        _ => return,
    };
    let id = d.get("id").and_then(|i| i.as_str()).unwrap_or_default();
    let token = d.get("token").and_then(|t| t.as_str()).unwrap_or_default();
    if id.is_empty() || token.is_empty() {
        return;
    }
    let url = format!("https://discord.com/api/v10/interactions/{id}/{token}/callback");
    let ack = reqwest::Client::new()
        .post(&url)
        .json(&ack_body)
        .send()
        .await;
    match ack {
        Ok(r) if r.status().is_success() => match itype {
            Some(2) => spawn_command_followup(state.clone(), d),
            Some(3) => spawn_component_followup(state.clone(), d),
            _ => {}
        },
        Ok(r) => tracing::warn!(
            "bots::discord gateway: interaction ack {}: {}",
            r.status(),
            r.text().await.unwrap_or_default()
        ),
        Err(e) => tracing::warn!("bots::discord gateway: interaction ack error: {e}"),
    }
}

async fn next_json<S>(rx: &mut S) -> Option<Value>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(Ok(msg)) = rx.next().await {
        if let Ok(text) = msg.into_text() {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                return Some(v);
            }
        }
    }
    None
}
