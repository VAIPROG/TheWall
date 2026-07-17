use crate::bots::core::response::{BotResponse, Block, Component, Action, ActionRow, BtnStyle};
use serde_json::{json, Value};

pub fn interaction_response(r: &BotResponse) -> Value {
    json!({ "type": 4, "data": message_data(r) })
}

pub fn message_data(r: &BotResponse) -> Value {
    let mut title = Value::Null;
    let mut desc = String::new();
    let mut fields: Vec<Value> = vec![];
    let mut image: Option<String> = None;
    for b in &r.blocks {
        match b {
            Block::Heading(_, t) => title = json!(t),
            Block::Text(t) => { desc.push_str(t); desc.push('\n'); }
            Block::Quote(t) => { desc.push_str(&format!("> {}\n", t)); }
            Block::Code { lang, body } => { desc.push_str(&format!("```{}\n{}\n```\n", lang.clone().unwrap_or_default(), body)); }
            Block::Fields(kv) => for (k,v) in kv { fields.push(json!({"name":k,"value":v,"inline":true})); }
            Block::Table { headers, rows } => {
                let mut t = headers.join(" | "); t.push('\n');
                for row in rows { t.push_str(&row.join(" | ")); t.push('\n'); }
                desc.push_str(&format!("```\n{}```\n", t));
            }
            Block::Divider => desc.push_str("―――\n"),
            Block::Image { url, .. } => image = Some(url.clone()),
            Block::Progress { pct, label } => fields.push(json!({"name":label,"value":format!("{:.0}%",pct),"inline":true})),
        }
    }
    let mut embed = json!({});
    if !title.is_null() { embed["title"] = title; }
    if !desc.is_empty() { embed["description"] = json!(desc.trim_end()); }
    if !fields.is_empty() { embed["fields"] = json!(fields); }
    if let Some(u) = image { embed["image"] = json!({"url": u}); }
    // Discord rejects a fully-empty embed object; when a response carries only
    // components (no blocks), send an empty embeds array instead of `[{}]`.
    let embeds = if embed.as_object().map_or(true, |o| o.is_empty()) {
        json!([])
    } else {
        json!([embed])
    };
    let mut data = json!({ "embeds": embeds, "components": components(r) });
    if r.ephemeral { data["flags"] = json!(64); }
    data
}

fn components(r: &BotResponse) -> Value {
    let rows: Vec<Value> = r.components.iter().map(|ActionRow(cs)| {
        let inner: Vec<Value> = cs.iter().map(|c| match c {
            Component::Button { label, style, action } => {
                let mut b = json!({ "type": 2, "label": label });
                match action {
                    Action::Callback(id) => { b["custom_id"] = json!(id); b["style"] = json!(style_num(*style)); }
                    Action::Url(u) => { b["url"] = json!(u); b["style"] = json!(5); }
                }
                b
            }
            Component::Select { placeholder, options, action_prefix } => json!({
                "type": 3, "custom_id": action_prefix, "placeholder": placeholder,
                "options": options.iter().map(|(l,v)| json!({"label":l,"value":v})).collect::<Vec<_>>()
            }),
        }).collect();
        json!({ "type": 1, "components": inner })
    }).collect();
    json!(rows)
}
fn style_num(s: BtnStyle) -> u8 { match s { BtnStyle::Primary=>1, BtnStyle::Secondary=>2, BtnStyle::Success=>3, BtnStyle::Danger=>4 } }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bots::core::response::*;
    #[test] fn embed_and_button() {
        let r = BotResponse::heading("S").push(Block::Fields(vec![("U".into(),"9".into())]))
            .row(ActionRow(vec![Component::Button{label:"Y".into(),style:BtnStyle::Danger,action:Action::Callback("cx".into())}]))
            .ephemeral();
        let d = message_data(&r);
        assert_eq!(d["embeds"][0]["title"], "S");
        assert_eq!(d["embeds"][0]["fields"][0]["name"], "U");
        assert_eq!(d["components"][0]["components"][0]["custom_id"], "cx");
        assert_eq!(d["flags"], 64);
    }
}
