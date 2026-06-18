use axum::{Json, extract::Path, http::StatusCode, response::IntoResponse};
use serde_json::json;

const CONTACT_EMAIL: &str = "vadim+the_wall@vai-rice.space";

pub async fn get_lang(Path(lang): Path<String>) -> Result<impl IntoResponse, StatusCode> {
    let l = lang.to_lowercase();
    let dict = match l.as_str() {
        "en" => json!({
            "title": "the_wall_dev.exe",
            "tabOverlay": "Overlay", "tabDraw": "Draw", "tabTpl": "Templates",
            "tabProfile": "Profile", "tabClan": "Clan", "tabSettings": "Settings", "tabAdmin": "Admin",
            "contact": format!("Need help or want to contribute? Email: {CONTACT_EMAIL}"),
            "fairPlay": "This is a drawing aid, not an autopainter.",
            "loading": "Loading…", "save": "Save", "cancel": "Cancel", "delete": "Delete",
            "deleteAccount": "Delete my account",
            "deleteAccountWarn": "This permanently deletes your profile, avatars, messages and templates. Continue?",
            "dm": "Direct messages", "send": "Send", "language": "Language",
        }),
        "ru" => json!({
            "title": "the_wall_dev.exe",
            "tabOverlay": "Оверлей", "tabDraw": "Рисование", "tabTpl": "Шаблоны",
            "tabProfile": "Профиль", "tabClan": "Клан", "tabSettings": "Опции", "tabAdmin": "Админ",
            "contact": format!("Нужна помощь или хотите помочь проекту? Почта: {CONTACT_EMAIL}"),
            "fairPlay": "Это помощник рисования, а не автопейнтер.",
            "loading": "Загрузка…", "save": "Сохранить", "cancel": "Отмена", "delete": "Удалить",
            "deleteAccount": "Удалить мой аккаунт",
            "deleteAccountWarn": "Это безвозвратно удалит ваш профиль, аватары, сообщения и шаблоны. Продолжить?",
            "dm": "Личные сообщения", "send": "Отправить", "language": "Язык",
        }),
        "de" => json!({
            "title": "the_wall_dev.exe",
            "tabOverlay": "Overlay", "tabDraw": "Zeichnen", "tabTpl": "Vorlagen",
            "tabProfile": "Profil", "tabClan": "Clan", "tabSettings": "Einstellungen", "tabAdmin": "Admin",
            "contact": format!("Brauchen Sie Hilfe oder möchten Sie beitragen? E-Mail: {CONTACT_EMAIL}"),
            "fairPlay": "Das ist eine Zeichenhilfe, kein Autopainter.",
            "loading": "Laden…", "save": "Speichern", "cancel": "Abbrechen", "delete": "Löschen",
            "deleteAccount": "Mein Konto löschen",
            "deleteAccountWarn": "Dies löscht dauerhaft Ihr Profil, Avatare, Nachrichten und Vorlagen. Fortfahren?",
            "dm": "Direktnachrichten", "send": "Senden", "language": "Sprache",
        }),
        "fr" => json!({
            "title": "the_wall_dev.exe",
            "tabOverlay": "Calque", "tabDraw": "Dessin", "tabTpl": "Modèles",
            "tabProfile": "Profil", "tabClan": "Clan", "tabSettings": "Options", "tabAdmin": "Admin",
            "contact": format!("Besoin d'aide ou envie de contribuer ? Email : {CONTACT_EMAIL}"),
            "fairPlay": "C'est une aide au dessin, pas un autopainter.",
            "loading": "Chargement…", "save": "Enregistrer", "cancel": "Annuler", "delete": "Supprimer",
            "deleteAccount": "Supprimer mon compte",
            "deleteAccountWarn": "Cela supprimera définitivement votre profil, avatars, messages et modèles. Continuer ?",
            "dm": "Messages privés", "send": "Envoyer", "language": "Langue",
        }),
        _ => return Err(StatusCode::NOT_FOUND),
    };
    Ok(Json(dict))
}
