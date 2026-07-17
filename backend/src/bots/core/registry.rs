use std::collections::HashMap;
use crate::bots::core::command::Command;
pub struct Registry { by_name: HashMap<&'static str, Box<dyn Command>> }
impl Registry {
    pub fn build() -> Self {
        let mut by_name = HashMap::new();
        for c in crate::bots::commands::all_commands() { by_name.insert(c.name(), c); }
        Registry { by_name }
    }
    pub fn get(&self, name: &str) -> Option<&dyn Command> { self.by_name.get(name).map(|b| b.as_ref()) }
    pub fn all(&self) -> impl Iterator<Item = &dyn Command> { self.by_name.values().map(|b| b.as_ref()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn registry_builds_and_names_unique() {
        let cmds = crate::bots::commands::all_commands();
        let mut seen = std::collections::HashSet::new();
        for c in &cmds { assert!(seen.insert(c.name()), "duplicate command name: {}", c.name()); }
        assert!(Registry::build().get("wall").is_some());
    }
}
