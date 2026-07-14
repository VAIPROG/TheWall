//! Platform-agnostic rich response. Adapters render this to native payloads.
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
pub struct BotResponse {
    pub blocks: Vec<Block>,
    pub components: Vec<ActionRow>,
    pub ephemeral: bool,
}

#[derive(Debug, Clone, Serialize)]
pub enum Block {
    Heading(u8, String),
    Text(String),                       // may contain inline spans as plain text
    Fields(Vec<(String, String)>),
    Table { headers: Vec<String>, rows: Vec<Vec<String>> },
    Quote(String),
    Code { lang: Option<String>, body: String },
    Divider,
    Image { url: String, caption: Option<String>, spoiler: bool },
    Progress { pct: f32, label: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionRow(pub Vec<Component>);

#[derive(Debug, Clone, Serialize)]
pub enum Component {
    Button { label: String, style: BtnStyle, action: Action },
    Select { placeholder: String, options: Vec<(String, String)>, action_prefix: String },
}

#[derive(Debug, Clone, Copy, Serialize)]
pub enum BtnStyle { Primary, Secondary, Danger, Success }

#[derive(Debug, Clone, Serialize)]
pub enum Action { Callback(String), Url(String) }  // Callback holds a stored callback id

impl BotResponse {
    pub fn text(s: impl Into<String>) -> Self {
        BotResponse { blocks: vec![Block::Text(s.into())], ..Default::default() }
    }
    pub fn heading(title: impl Into<String>) -> Self {
        BotResponse { blocks: vec![Block::Heading(2, title.into())], ..Default::default() }
    }
    pub fn push(mut self, b: Block) -> Self { self.blocks.push(b); self }
    pub fn row(mut self, r: ActionRow) -> Self { self.components.push(r); self }
    pub fn ephemeral(mut self) -> Self { self.ephemeral = true; self }
}
