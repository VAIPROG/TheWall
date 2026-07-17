use crate::bots::core::response::{BotResponse, Block, Component, Action, ActionRow};
use serde_json::{json, Value};

fn esc(s: &str) -> String { s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;") }
fn bar(pct: f32) -> String {
    let n = ((pct/10.0).round() as usize).min(10);
    format!("{}{}", "█".repeat(n), "░".repeat(10-n))
}

pub fn render_html(r: &BotResponse) -> String {
    let mut out = String::new();
    for b in &r.blocks {
        match b {
            Block::Heading(_, t) => out.push_str(&format!("<h2>{}</h2>", esc(t))),
            Block::Text(t) => out.push_str(&format!("<p>{}</p>", esc(t))),
            Block::Quote(t) => out.push_str(&format!("<blockquote>{}</blockquote>", esc(t))),
            Block::Code { lang, body } => {
                let cls = lang.as_deref().map(|l| format!(" class=\"language-{}\"", esc(l))).unwrap_or_default();
                out.push_str(&format!("<pre><code{}>{}</code></pre>", cls, esc(body)));
            }
            Block::Fields(kv) => {
                out.push_str("<table>");
                for (k,v) in kv { out.push_str(&format!("<tr><td><b>{}</b></td><td>{}</td></tr>", esc(k), esc(v))); }
                out.push_str("</table>");
            }
            Block::Table { headers, rows } => {
                out.push_str("<table><tr>");
                for h in headers { out.push_str(&format!("<th>{}</th>", esc(h))); }
                out.push_str("</tr>");
                for row in rows { out.push_str("<tr>"); for c in row { out.push_str(&format!("<td>{}</td>", esc(c))); } out.push_str("</tr>"); }
                out.push_str("</table>");
            }
            Block::Divider => out.push_str("<hr/>"),
            Block::Image { url, caption, spoiler } => {
                let sp = if *spoiler { " tg-spoiler" } else { "" };
                let cap = caption.as_deref().map(|c| format!("<figcaption>{}</figcaption>", esc(c))).unwrap_or_default();
                out.push_str(&format!("<figure><img src=\"{}\"{}/>{}</figure>", esc(url), sp, cap));
            }
            Block::Progress { pct, label } => out.push_str(&format!("<b>{}</b> <code>{}</code> {:.0}%", esc(label), bar(*pct), pct)),
        }
    }
    out
}

pub fn render_keyboard(r: &BotResponse) -> Option<Value> {
    if r.components.is_empty() { return None; }
    let rows: Vec<Value> = r.components.iter().map(|ActionRow(cs)| {
        cs.iter().filter_map(|c| match c {
            Component::Button { label, action, .. } => Some(match action {
                Action::Callback(id) => json!({ "text": label, "callback_data": id }),
                Action::Url(u) => json!({ "text": label, "url": u }),
            }),
            Component::Select { .. } => None,   // Telegram has no native select; skip
        }).collect::<Vec<_>>()
    }).filter(|r: &Vec<Value>| !r.is_empty()).map(Value::Array).collect();
    Some(json!({ "inline_keyboard": rows }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bots::core::response::{Block, BtnStyle};
    #[test] fn html_and_keyboard() {
        let r = BotResponse::heading("Hi")
            .push(Block::Fields(vec![("A".into(),"1".into())]))
            .row(ActionRow(vec![Component::Button{ label:"Next".into(), style:BtnStyle::Primary, action:Action::Callback("c1alice".into()) }]));
        let html = render_html(&r);
        assert!(html.contains("<h2>Hi</h2>") && html.contains("<b>A</b>"));
        let kb = render_keyboard(&r).unwrap();
        assert_eq!(kb["inline_keyboard"][0][0]["callback_data"], "c1alice");
    }
}
