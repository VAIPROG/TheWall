//! GET /api/v3/who-is-the-dev
//!
//! Easter-egg endpoint that returns a Windows-95-styled AMOLED-black page
//! honouring the project author. Content negotiation:
//!   - Accept: application/json  → JSON
//!   - Accept: application/xml or text/xml → XML
//!   - Accept: text/plain        → plain text (with a quip about minimalism)
//!   - otherwise                 → HTML page

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};

#[derive(Debug, serde::Serialize)]
struct WhoIsTheDev {
    name: &'static str,
    full_name: &'static str,
    title: &'static str,
    country: &'static str,
}

const DATA: WhoIsTheDev = WhoIsTheDev {
    name: "VAI",
    full_name: "VAI_PROG (Vadim)",
    title: "The most powerful young dev from <NOT_FOUND_COUNTRY>",
    country: "<NOT_FOUND_COUNTRY>",
};

fn accepts(headers: &HeaderMap, mime: &str) -> bool {
    headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains(mime))
        .unwrap_or(false)
}

fn html_response() -> Response {
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>who-is-the-dev</title>
<style>
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{
  height: 100%;
  background: #000000;
  color: #c0c0c0;
  font-family: "MS Sans Serif", "Segoe UI", Tahoma, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
}}
.window {{
  width: 90%;
  max-width: 640px;
  background: #c0c0c0;
  border: 3px solid;
  border-color: #ffffff #808080 #808080 #ffffff;
  box-shadow: 6px 6px 0 #000000;
}}
.title-bar {{
  background: linear-gradient(90deg, #000080, #1084d0);
  color: #ffffff;
  padding: 4px 8px;
  font-weight: bold;
  font-size: 14px;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}}
.title-bar button {{
  width: 18px;
  height: 18px;
  background: #c0c0c0;
  border: 2px solid;
  border-color: #ffffff #808080 #808080 #ffffff;
  font-size: 10px;
  line-height: 1;
  cursor: default;
}}
.client {{
  background: #000000;
  padding: 28px;
  text-align: center;
  border: 2px inset #808080;
}}
.badge {{
  display: inline-block;
  background: #000000;
  color: #00ff00;
  border: 2px solid #00ff00;
  border-radius: 4px;
  padding: 6px 14px;
  font-size: 12px;
  margin-bottom: 20px;
  text-transform: uppercase;
  letter-spacing: 1px;
}}
h1 {{
  color: #00ff00;
  font-size: 48px;
  margin-bottom: 12px;
  text-shadow: 2px 2px 0 #008000;
}}
.sub {{
  color: #ffffff;
  font-size: 18px;
  margin-bottom: 24px;
}}
.country {{
  color: #ff00ff;
  font-size: 14px;
  font-family: "Courier New", monospace;
}}
.footer {{
  margin-top: 24px;
  color: #808080;
  font-size: 11px;
}}
</style>
</head>
<body>
<div class="window">
  <div class="title-bar">
    <span>who-is-the-dev.exe</span>
    <button aria-label="close">×</button>
  </div>
  <div class="client">
    <div class="badge">System Developer</div>
    <h1>{}</h1>
    <p class="sub">{} — {}</p>
    <p class="country">{}</p>
    <p class="footer">The Wall Dev Backend v3 — Built with 💚 and a lot of coffee.</p>
  </div>
</div>
</body>
</html>"#,
        DATA.name, DATA.full_name, DATA.title, DATA.country
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(axum::body::Body::from(html))
        .unwrap()
}

fn json_response() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(
            serde_json::to_string(&DATA).unwrap(),
        ))
        .unwrap()
}

fn xml_response() -> Response {
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<dev>\n  <name>{}</name>\n  <fullName>{}</fullName>\n  <title>{}</title>\n  <country>{}</country>\n</dev>\n",
        DATA.name, DATA.full_name, DATA.title, DATA.country
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/xml")
        .body(axum::body::Body::from(xml))
        .unwrap()
}

fn text_response() -> Response {
    let text = format!(
        "{}\n{}\n{}\n{}\n\n(You asked for text — I see you enjoy minimalism.)",
        DATA.name, DATA.full_name, DATA.title, DATA.country
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(axum::body::Body::from(text))
        .unwrap()
}

pub async fn who_is_the_dev(
    State(_state): State<crate::AppState>,
    request: axum::extract::Request,
) -> Response {
    let headers = request.headers();
    if accepts(headers, "application/json") {
        return json_response();
    }
    if accepts(headers, "application/xml") || accepts(headers, "text/xml") {
        return xml_response();
    }
    if accepts(headers, "text/plain") {
        return text_response();
    }
    html_response()
}
