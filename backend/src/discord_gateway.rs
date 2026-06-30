//! Minimal Discord gateway client.
//!
//! The slash-command transport of record is the interactions webhook
//! (`discord_commands::interactions`) — that path needs no socket. But two
//! things only work with a live gateway session:
//!
//!   1. **Presence.** Discord shows a bot as Online only while something
//!      holds an Identified gateway connection. Without this module the bot
//!      reads "Offline" forever even though the webhook answers fine.
//!   2. **Fallback command transport.** When the developer portal has NO
//!      Interactions Endpoint URL configured, Discord delivers interactions
//!      over the gateway as INTERACTION_CREATE dispatches instead. We ack
//!      them via the REST callback and reuse the exact same command
//!      dispatcher, so slash commands work in both portal configurations.
//!
//! Deliberately tiny: intents=0 (no guild/message events), no session
//! resume — on any error we sleep with backoff and re-identify. Identify
//! limits (1000/day) are far above what a reconnect loop can plausibly burn.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{AppState, discord_commands};

const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";

pub fn spawn(state: AppState) {
    let Some(token) = state.config.oauth.discord_bot_token.clone() else {
        tracing::info!("discord_gateway: DISCORD_BOT_TOKEN missing — presence disabled");
        return;
    };
    tokio::spawn(async move {
        let mut backoff = 5u64;
        loop {
            let started = std::time::Instant::now();
            match session(&state, &token).await {
                Ok(()) => tracing::info!("discord_gateway: session ended, reconnecting"),
                Err(e) => tracing::warn!("discord_gateway: {e}"),
            }
            // A session that survived a while earns a fresh (short) backoff.
            if started.elapsed() > Duration::from_secs(60) {
                backoff = 5;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(300);
        }
    });
}

/// One gateway session: connect → HELLO → IDENTIFY → heartbeat + dispatch
/// loop. Returns Ok on server-initiated reconnect requests, Err on anything
/// abnormal; the caller reconnects either way.
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
                                tracing::info!("discord_gateway: READY — bot presence is now Online");
                            }
                            Some("INTERACTION_CREATE") => {
                                if let Some(d) = v.get("d") {
                                    handle_interaction(state, d.clone()).await;
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

/// Gateway-delivered slash command: ack with a deferred ephemeral response
/// via the REST callback (the 3-second budget applies here too), then let
/// the shared dispatcher PATCH in the real answer.
async fn handle_interaction(state: &AppState, d: Value) {
    if d.get("type").and_then(|t| t.as_u64()) != Some(2) {
        return; // only APPLICATION_COMMAND is served
    }
    let id = d.get("id").and_then(|i| i.as_str()).unwrap_or_default();
    let token = d.get("token").and_then(|t| t.as_str()).unwrap_or_default();
    if id.is_empty() || token.is_empty() {
        return;
    }
    let url = format!("https://discord.com/api/v10/interactions/{id}/{token}/callback");
    let ack = reqwest::Client::new()
        .post(&url)
        .json(&json!({ "type": 5, "data": { "flags": discord_commands::EPHEMERAL } }))
        .send()
        .await;
    match ack {
        Ok(r) if r.status().is_success() => {
            discord_commands::spawn_followup(state.clone(), d);
        }
        Ok(r) => tracing::warn!(
            "discord_gateway: interaction ack {}: {}",
            r.status(),
            r.text().await.unwrap_or_default()
        ),
        Err(e) => tracing::warn!("discord_gateway: interaction ack error: {e}"),
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
