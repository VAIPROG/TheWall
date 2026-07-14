use uuid::Uuid;
use crate::AppState;
use super::command::Platform;

#[derive(Debug, Clone)]
pub struct Principal {
    pub platform_id: String,          // discord/telegram external id
    pub is_admin: bool,               // bot_admins
    pub user_id: Option<Uuid>,        // linked Wall account
    pub username: Option<String>,
}
impl Principal {
    pub fn is_linked(&self) -> bool { self.user_id.is_some() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission { Public, Linked, Admin }

/// Whether a principal may run a command of this permission level.
pub fn gate(perm: Permission, p: &Principal) -> bool {
    match perm {
        Permission::Public => true,
        Permission::Linked => p.is_linked(),
        Permission::Admin => p.is_admin,
    }
}

pub async fn resolve_principal(state: &AppState, platform: Platform, external_id: &str) -> Principal {
    let is_admin = crate::bots::core::data::is_bot_admin(&state.pool, platform.as_str(), external_id).await;
    let linked = crate::bots::core::data::find_user_by_platform(&state.pool, platform.as_str(), external_id).await;
    let (user_id, username) = match linked { Some((id, name)) => (Some(id), Some(name)), None => (None, None) };
    Principal { platform_id: external_id.to_string(), is_admin, user_id, username }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(admin: bool, linked: bool) -> Principal {
        Principal { platform_id: "1".into(), is_admin: admin,
            user_id: if linked { Some(Uuid::nil()) } else { None }, username: None }
    }
    #[test] fn gating() {
        assert!(gate(Permission::Public, &p(false, false)));
        assert!(!gate(Permission::Linked, &p(false, false)));
        assert!(gate(Permission::Linked, &p(false, true)));
        assert!(!gate(Permission::Admin, &p(false, true)));
        assert!(gate(Permission::Admin, &p(true, false)));
    }
}
