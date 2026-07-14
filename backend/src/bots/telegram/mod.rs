//! Telegram adapter for the bot framework (v6.3.0).
//!
//! Self-contained long-poll transport: consumes `message` and `callback_query`
//! updates, maps them onto a framework `Invocation`, dispatches through the
//! shared `Registry`, and renders the resulting `BotResponse` to Telegram Rich
//! HTML + an inline keyboard.
//!
//! This module DELIBERATELY does not depend on the legacy `crate::bot_commands`
//! or `crate::telegram_rich` (both removed in Task 7): the transport, the
//! admin-seeding, and the send/edit helpers are all reimplemented here, with
//! `reply_markup` support the legacy sender lacked.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::bots::core::command::{ArgKind, ArgValue, Chat, Platform};
use crate::bots::core::callbacks::CallbackSpec;
use crate::bots::core::data::{find_user_by_platform, is_bot_admin};
use crate::bots::core::dispatch::{self, Invocation};
use crate::bots::core::registry::Registry;
use crate::bots::render;
use crate::AppState;

/// Spawn the Telegram long-poll adapter. No-op (with a log line) when no bot
/// token is configured. Task 7 calls this from `bots::spawn`.
pub fn spawn(state: AppState, reg: Arc<Registry>) {
    let Some(token) = state.config.oauth.telegram_bot_token.clone() else {
        tracing::info!("bots::telegram: no TELEGRAM_BOT_TOKEN — telegram adapter disabled");
        return;
    };
    tokio::spawn(async move {
        // Seed env-configured admins into the persistent registry. This lives
        // here because the legacy seeding (bot_commands::spawn) is removed in
        // Task 7 — the framework adapter must keep the registry seeded.
        for (platform, ids) in [
            ("telegram", &state.config.notify.telegram_admin_ids),
            ("discord", &state.config.notify.discord_admin_ids),
        ] {
            for id in ids {
                let _ = sqlx::query(
                    r#"INSERT INTO bot_admins (platform, external_id, label)
                       VALUES ($1, $2, 'env-seeded')
                       ON CONFLICT DO NOTHING"#,
                )
                .bind(platform)
                .bind(id)
                .execute(&state.pool)
                .await;
            }
        }

        let client = reqwest::Client::new();
        let mut offset: i64 = 0;
        tracing::info!("bots::telegram: adapter started");
        loop {
            match poll_once(&client, &token, &mut offset, &state, &reg).await {
                Ok(()) => {}
                Err(e) => {
                    tracing::warn!("bots::telegram poll: {e}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

async fn poll_once(
    client: &reqwest::Client,
    token: &str,
    offset: &mut i64,
    state: &AppState,
    reg: &Registry,
) -> Result<(), String> {
    let url = format!(
        "https://api.telegram.org/bot{token}/getUpdates?timeout=50&offset={}&allowed_updates=[\"message\",\"callback_query\"]",
        *offset
    );
    let r = client
        .get(&url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let Some(updates) = v.get("result").and_then(|r| r.as_array()) else {
        return Err(format!("bad getUpdates response: {v}"));
    };
    for u in updates {
        if let Some(id) = u.get("update_id").and_then(|i| i.as_i64()) {
            *offset = (*offset).max(id + 1);
        }
        if u.get("callback_query").is_some() {
            handle_callback(client, token, state, reg, u).await;
        } else if u.get("message").is_some() {
            handle_message(client, token, state, reg, u).await;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// message updates
// ---------------------------------------------------------------------------

async fn handle_message(
    client: &reqwest::Client,
    token: &str,
    state: &AppState,
    reg: &Registry,
    u: &Value,
) {
    let Some(msg) = u.get("message") else { return };
    let Some(text) = msg.pointer("/text").and_then(|t| t.as_str()) else { return };
    if !text.starts_with('/') {
        return;
    }
    let from_id = msg
        .pointer("/from/id")
        .and_then(|i| i.as_i64())
        .map(|i| i.to_string())
        .unwrap_or_default();
    let chat_id = msg
        .pointer("/chat/id")
        .and_then(|i| i.as_i64())
        .map(|i| i.to_string())
        .unwrap_or_default();
    if from_id.is_empty() || chat_id.is_empty() {
        return;
    }
    let is_group = msg
        .pointer("/chat/type")
        .and_then(|t| t.as_str())
        .map(|t| t != "private")
        .unwrap_or(false);

    // Silent-to-strangers gating: a principal that is neither a bot admin nor a
    // linked Wall account gets NO reply at all — transport-level concern, kept
    // separate from dispatch's Permission gate (which returns an error string).
    let is_admin = is_bot_admin(&state.pool, "telegram", &from_id).await;
    let linked = find_user_by_platform(&state.pool, "telegram", &from_id).await;
    if !is_admin && linked.is_none() {
        return; // silent to strangers
    }

    let (command, sub, args) = parse_command(reg, text);
    let inv = Invocation {
        external_id: from_id,
        chat: Chat { id: chat_id.clone(), is_group, platform: Platform::Telegram },
        command,
        sub,
        args,
    };
    let resp = dispatch::run(state, reg, Platform::Telegram, inv).await;
    let html = render::telegram::render_html(&resp);
    let kb = render::telegram::render_keyboard(&resp);
    if let Err(e) = send(client, token, &chat_id, &html, kb).await {
        tracing::warn!("bots::telegram send: {e}");
    }
}

/// Parse a slash-command line into (command, sub, args).
///
/// Command name = first whitespace token, leading `/` stripped, `@botname`
/// suffix stripped, lowercased. Argument coercion is driven off the registered
/// command's `args()` schema:
///   * if the command's first top-level arg is `Sub`-kind (⇒ this is a
///     subcommand-style command), the first token selects among the TOP-LEVEL
///     args by name, and the remaining tokens map positionally onto the selected
///     arg's `Sub(leaves)`;
///   * otherwise the remaining whitespace tokens map positionally onto the
///     command's args, coerced by `ArgKind`.
/// A trailing free-text `String` arg collects the REST of the line.
/// Unknown commands still return with empty args (dispatch replies "unknown").
///
/// ## Subcommand schema shape (CONTRACT — Task 5 authors ~18 commands against it)
///
/// A subcommand-style command lists its subcommands as its top-level `args()`,
/// each `CommandArg{ kind: Sub(leaf_args) }` with BARE-kind leaves
/// (`ArgKind::String/Int/Bool`, never a nested `Sub`). Do NOT add an outer
/// wrapping `Sub`. A subcommand with no args is `kind: Sub(vec![])`. This exact
/// shape is what the Discord adapter registers as native SUB_COMMANDs, so both
/// platforms agree.
///
/// ```ignore
/// // `clanchat read [n]`  and  `clanchat send <text>`
/// vec![
///     CommandArg { name: "read".into(), desc: "Show recent clan chat".into(), required: false,
///         kind: ArgKind::Sub(vec![
///             CommandArg { name: "n".into(), desc: "How many (1-25)".into(), required: false, kind: ArgKind::Int },
///         ]) },
///     CommandArg { name: "send".into(), desc: "Post to your clan chat".into(), required: true,
///         kind: ArgKind::Sub(vec![
///             // trailing String swallows the rest of the line
///             CommandArg { name: "text".into(), desc: "Message text".into(), required: true, kind: ArgKind::String },
///         ]) },
/// ]
/// ```
fn parse_command(reg: &Registry, text: &str) -> (String, Option<String>, HashMap<String, ArgValue>) {
    let mut tokens = text.split_whitespace();
    let raw = tokens.next().unwrap_or("");
    let command = raw
        .trim_start_matches('/')
        .split('@')
        .next()
        .unwrap_or("")
        .to_lowercase();

    let rest: Vec<&str> = tokens.collect();
    let mut args = HashMap::new();
    let mut sub = None;

    let Some(cmd) = reg.get(&command) else {
        return (command, sub, args);
    };
    let schema = cmd.args();

    // Subcommand-style: the command's top-level args ARE the subcommands, each a
    // `Sub(leaf_args)`. The first token picks one by name; its leaves map positionally.
    if matches!(schema.first().map(|a| &a.kind), Some(ArgKind::Sub(_))) {
        let mut it = rest.iter();
        if let Some(tok) = it.next() {
            sub = Some((*tok).to_string());
            if let Some(s) = schema.iter().find(|a| a.name.eq_ignore_ascii_case(tok)) {
                if let ArgKind::Sub(leaves) = &s.kind {
                    let remaining: Vec<&str> = it.copied().collect();
                    map_positional(leaves, &remaining, &mut args);
                }
            }
        }
        return (command, sub, args);
    }

    map_positional(&schema, &rest, &mut args);
    (command, sub, args)
}

/// Map whitespace tokens positionally onto a schema, coercing by ArgKind.
/// A trailing `String` arg swallows the rest of the tokens (joined with spaces).
fn map_positional(schema: &[crate::bots::core::command::CommandArg], tokens: &[&str], args: &mut HashMap<String, ArgValue>) {
    let mut i = 0usize;
    for (idx, spec) in schema.iter().enumerate() {
        if i >= tokens.len() {
            break;
        }
        let is_last = idx + 1 == schema.len();
        match &spec.kind {
            ArgKind::Int => {
                if let Ok(n) = tokens[i].parse::<i64>() {
                    args.insert(spec.name.clone(), ArgValue::Int(n));
                }
                i += 1;
            }
            ArgKind::Bool => {
                if let Ok(b) = tokens[i].parse::<bool>() {
                    args.insert(spec.name.clone(), ArgValue::Bool(b));
                }
                i += 1;
            }
            ArgKind::String => {
                if is_last {
                    // Trailing free-text: collect the rest of the line.
                    let joined = tokens[i..].join(" ");
                    args.insert(spec.name.clone(), ArgValue::Str(joined));
                    i = tokens.len();
                } else {
                    args.insert(spec.name.clone(), ArgValue::Str(tokens[i].to_string()));
                    i += 1;
                }
            }
            ArgKind::Sub(_) => {
                // Defensive no-op: under Option A, leaf args are always bare
                // kinds (String/Int/Bool), never `Sub`, so this arm is not hit
                // for well-formed schemas. Skip the token if it ever occurs.
                i += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// callback_query updates
// ---------------------------------------------------------------------------

async fn handle_callback(
    client: &reqwest::Client,
    token: &str,
    state: &AppState,
    reg: &Registry,
    u: &Value,
) {
    let Some(cq) = u.get("callback_query") else { return };
    let query_id = cq.pointer("/id").and_then(|i| i.as_str()).unwrap_or_default().to_string();
    let clicker_id = cq
        .pointer("/from/id")
        .and_then(|i| i.as_i64())
        .map(|i| i.to_string())
        .unwrap_or_default();
    let data = cq.pointer("/data").and_then(|d| d.as_str()).unwrap_or_default().to_string();
    let chat_id = cq
        .pointer("/message/chat/id")
        .and_then(|i| i.as_i64())
        .map(|i| i.to_string())
        .unwrap_or_default();
    let message_id = cq.pointer("/message/message_id").and_then(|i| i.as_i64());
    let is_group = cq
        .pointer("/message/chat/type")
        .and_then(|t| t.as_str())
        .map(|t| t != "private")
        .unwrap_or(false);

    // Always answer the query so the client stops spinning.
    let answer = |text: Option<&str>| {
        let mut body = json!({ "callback_query_id": query_id });
        if let Some(t) = text {
            body["text"] = json!(t);
        }
        body
    };

    match state.callback_store.take(&data, &clicker_id).await {
        Some(spec) => {
            let CallbackSpec { command, sub, args, .. } = spec;
            let mut arg_map = HashMap::new();
            for (k, v) in args {
                arg_map.insert(k, ArgValue::Str(v));
            }
            let inv = Invocation {
                external_id: clicker_id.clone(),
                chat: Chat { id: chat_id.clone(), is_group, platform: Platform::Telegram },
                command,
                sub,
                args: arg_map,
            };
            let resp = dispatch::run(state, reg, Platform::Telegram, inv).await;
            let html = render::telegram::render_html(&resp);
            let kb = render::telegram::render_keyboard(&resp);
            if let Some(mid) = message_id {
                if let Err(e) = edit(client, token, &chat_id, mid, &html, kb).await {
                    tracing::warn!("bots::telegram edit: {e}");
                }
            } else if let Err(e) = send(client, token, &chat_id, &html, kb).await {
                tracing::warn!("bots::telegram send (callback, no message_id): {e}");
            }
            answer_query(client, token, answer(None)).await;
        }
        None => {
            let expired = "This button expired — re-run the command.";
            if let Some(mid) = message_id {
                let html = format!("<p>{}</p>", expired);
                if let Err(e) = edit(client, token, &chat_id, mid, &html, None).await {
                    tracing::warn!("bots::telegram edit (expired): {e}");
                }
            }
            answer_query(client, token, answer(Some(expired))).await;
        }
    }
}

async fn answer_query(client: &reqwest::Client, token: &str, body: Value) {
    let url = format!("https://api.telegram.org/bot{token}/answerCallbackQuery");
    if let Err(e) = client.post(&url).json(&body).send().await {
        tracing::warn!("bots::telegram answerCallbackQuery: {e}");
    }
}

// ---------------------------------------------------------------------------
// send / edit helpers (self-contained, with reply_markup support)
// ---------------------------------------------------------------------------

/// POST a JSON body and check the response. `Ok(())` on 2xx; otherwise
/// `Err("{status}: {text}")`. Shared by `send`/`edit` so the build-body-then-
/// POST-then-check pattern lives in one place.
async fn post_json(client: &reqwest::Client, url: &str, body: Value) -> Result<(), String> {
    let r = client.post(url).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = r.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("{status}: {}", r.text().await.unwrap_or_default()))
    }
}

/// Send rich HTML to a chat, with an optional inline keyboard. Falls back to
/// classic `sendMessage` (parse_mode=HTML, downgraded block tags) if the rich
/// method is rejected. `reply_markup` is included in BOTH payloads.
async fn send(
    client: &reqwest::Client,
    token: &str,
    chat_id: &str,
    html: &str,
    keyboard: Option<Value>,
) -> Result<(), String> {
    let url = format!("https://api.telegram.org/bot{token}/sendRichMessage");
    let mut body = json!({
        "chat_id": chat_id,
        "rich_message": { "html": html },
    });
    if let Some(kb) = &keyboard {
        body["reply_markup"] = kb.clone();
    }
    let rich_err = match post_json(client, &url, body).await {
        Ok(()) => return Ok(()),
        Err(e) => format!("sendRichMessage {e}"),
    };
    tracing::debug!("{rich_err} — falling back to sendMessage");

    let plain = downgrade_html(html);
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let mut body = json!({
        "chat_id": chat_id,
        "text": plain,
        "parse_mode": "HTML",
    });
    if let Some(kb) = &keyboard {
        body["reply_markup"] = kb.clone();
    }
    match post_json(client, &url, body).await {
        Ok(()) => Ok(()),
        Err(e) => Err(format!("{rich_err}; fallback sendMessage {e}")),
    }
}

/// Edit an existing message's text (and inline keyboard). Uses the rich HTML as
/// `text` with `parse_mode=HTML`; downgrades block tags so it doesn't 400.
async fn edit(
    client: &reqwest::Client,
    token: &str,
    chat_id: &str,
    message_id: i64,
    html: &str,
    keyboard: Option<Value>,
) -> Result<(), String> {
    let url = format!("https://api.telegram.org/bot{token}/editMessageText");
    let plain = downgrade_html(html);
    let mut body = json!({
        "chat_id": chat_id,
        "message_id": message_id,
        "text": plain,
        "parse_mode": "HTML",
    });
    if let Some(kb) = &keyboard {
        body["reply_markup"] = kb.clone();
    }
    post_json(client, &url, body).await.map_err(|e| format!("editMessageText {e}"))
}

/// Replace every `<img ...>` (self-closing `/>` or bare `>`) with an
/// `<a href="URL">URL</a>` link built from its `src="..."` attribute, so the
/// classic HTML parser accepts it. Tags without a parseable `src` are dropped.
/// Manual scan (no `regex` dependency in Cargo.toml).
fn rewrite_img_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<img") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        // End of the tag: first '>' after "<img".
        let Some(gt) = after.find('>') else {
            // Malformed / truncated tag: emit the remainder verbatim and stop.
            out.push_str(after);
            return out;
        };
        let tag = &after[..=gt]; // includes trailing '>'
        if let Some(url) = extract_src(tag) {
            out.push_str(&format!("<a href=\"{url}\">{url}</a>"));
        }
        rest = &after[gt + 1..];
    }
    out.push_str(rest);
    out
}

/// Extract the value of the `src="..."` attribute from a single tag string.
fn extract_src(tag: &str) -> Option<String> {
    let idx = tag.find("src=\"")?;
    let after = &tag[idx + 5..];
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

/// Best-effort downgrade of rich HTML to the classic sendMessage tag subset
/// (b/i/u/s/code/pre/a/blockquote/tg-spoiler). Block elements become line
/// breaks; tables collapse to pipe-separated rows. Ported from the legacy
/// `telegram_rich::downgrade_html` (removed in Task 7).
///
/// `<img>` is NOT a valid classic-HTML tag for Telegram's `parse_mode=HTML`
/// parser, so any `<img src="URL" .../>` emitted by `render_html` for a
/// `Block::Image` is rewritten to `<a href="URL">URL</a>`. Without this, the
/// sendMessage fallback and every editMessageText (callbacks always downgrade)
/// would 400 whenever a response contains an image.
fn downgrade_html(html: &str) -> String {
    let mut s = rewrite_img_tags(html);
    // Newline-producing closers first.
    for tag in ["</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "</p>", "</li>", "</tr>", "</table>", "</details>", "</summary>", "</footer>", "</figure>", "</figcaption>", "<hr/>", "<hr>"] {
        s = s.replace(tag, "\n");
    }
    s = s.replace("</td>", " | ").replace("</th>", " | ");
    // Headings keep emphasis via <b>.
    for (open, close) in [("<h1>", "<b>"), ("<h2>", "<b>"), ("<h3>", "<b>"), ("<h4>", "<b>"), ("<h5>", "<b>"), ("<h6>", "<b>")] {
        s = s.replace(open, close);
    }
    for h in ["</h1", "</h2", "</h3", "</h4", "</h5", "</h6"] {
        s = s.replace(&format!("{h}>"), "</b>");
    }
    // Drop structural tags entirely.
    for tag in ["<table bordered striped>", "<table bordered>", "<table>", "<tr>", "<td>", "<th>", "<ul>", "</ul>", "<ol>", "</ol>", "<li>", "<p>", "<details>", "<details open>", "<summary>", "<footer>", "<caption>", "</caption>", "<mark>", "</mark>", "<figure>", "<figcaption>"] {
        s = s.replace(tag, "");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::{downgrade_html, map_positional};
    use crate::bots::core::command::{ArgKind, ArgValue, CommandArg};
    use crate::bots::core::response::{BotResponse, Block};
    use crate::bots::render::telegram::render_html;
    use std::collections::HashMap;

    /// Locks Option-A leaf-mapping: given a subcommand's `Sub(leaves)` schema, the
    /// tokens after the subcommand name map positionally onto the leaves.
    /// (End-to-end subcommand *selection* is exercised by Task 5's real
    /// `clanchat`/`template` commands on both platforms; `parse_command` takes a
    /// `&Registry` whose `build()` only has `wall`, so we assert the predicate +
    /// leaf-mapping directly here.)
    #[test]
    fn parse_subcommand_option_a() {
        // The selection predicate: a subcommand-style command's first top-level
        // arg is `Sub`-kind.
        let clanchat = vec![
            CommandArg { name: "send".into(), desc: String::new(), required: true,
                kind: ArgKind::Sub(vec![
                    CommandArg { name: "text".into(), desc: String::new(), required: true, kind: ArgKind::String },
                ]) },
        ];
        assert!(matches!(clanchat.first().map(|a| &a.kind), Some(ArgKind::Sub(_))));

        // Trailing String swallows the rest of the line.
        let schema = vec![CommandArg { name: "text".into(), desc: String::new(), required: true, kind: ArgKind::String }];
        let mut args = HashMap::new();
        map_positional(&schema, &["hello", "world"], &mut args);
        assert!(matches!(args.get("text"), Some(ArgValue::Str(s)) if s == "hello world"));

        // Int leaf coercion.
        let schema = vec![CommandArg { name: "n".into(), desc: String::new(), required: false, kind: ArgKind::Int }];
        let mut args = HashMap::new();
        map_positional(&schema, &["7"], &mut args);
        assert!(matches!(args.get("n"), Some(ArgValue::Int(7))));

        // A no-arg subcommand is `Sub(vec![])`: mapping its (empty) leaves over any
        // remaining tokens maps nothing and does not panic.
        let leaves: Vec<CommandArg> = vec![];
        let mut args = HashMap::new();
        map_positional(&leaves, &["ignored"], &mut args);
        assert!(args.is_empty());
    }

    #[test]
    fn downgrade_strips_img() {
        let resp = BotResponse::default().push(Block::Image {
            url: "https://x/y.png".into(),
            caption: Some("cap".into()),
            spoiler: true,
        });
        let html = render_html(&resp);
        let plain = downgrade_html(&html);
        assert!(plain.contains("https://x/y.png"), "url must survive: {plain}");
        assert!(!plain.contains("<img"), "no <img>: {plain}");
        assert!(!plain.contains("<figure"), "no <figure>: {plain}");
        assert!(!plain.contains("<figcaption"), "no <figcaption>: {plain}");
        assert!(plain.contains("cap"), "caption text kept: {plain}");
    }
}
