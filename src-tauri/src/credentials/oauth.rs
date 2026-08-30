use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use std::time::Duration;
use serde::{Deserialize, Serialize};

/// Fallback Google OAuth client id, baked in at **compile time** from `GOOGLE_CLIENT_ID`.
///
/// It used to be a literal here, so the repo carried a live client id. The frontend passes its own
/// (`VITE_GOOGLE_CLIENT_ID`, see `.env.example`) and that is the normal path; this only covers a
/// caller that sends none. Empty is fine — the flow refuses below rather than opening a browser to
/// Google's `invalid_client` page.
///
/// `match` rather than `unwrap_or`, which is not a const fn.
pub const DEFAULT_GOOGLE_CLIENT_ID: &str = match option_env!("GOOGLE_CLIENT_ID") {
    Some(v) => v,
    None => "",
};

#[derive(Debug, Serialize, Deserialize)]
pub struct OAuthCallbackResult {
    pub success: bool,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub error: Option<String>,
}

fn url_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len() * 2);
    for byte in input.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

fn simple_url_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if hex.len() == 2 {
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    result.push(byte as char);
                    continue;
                }
            }
            result.push('%');
            result.push_str(&hex);
        } else if ch == '+' {
            result.push(' ');
        } else {
            result.push(ch);
        }
    }
    result
}

#[tauri::command]
pub async fn start_google_oauth_flow(
    client_id: Option<String>,
    code_challenge: Option<String>,
) -> Result<OAuthCallbackResult, String> {
    Box::pin(async move {
    // The two revoked client ids that used to be excluded here are gone with the literals: an id
    // Google has deleted now fails the same way any wrong id does, and the caller no longer has a
    // baked-in one to be silently redirected onto.
    let cid = match client_id {
        Some(ref id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => DEFAULT_GOOGLE_CLIENT_ID.to_string(),
    };
    if cid.is_empty() {
        return Err("Chưa cấu hình Google OAuth client id cho bản dựng này".to_string());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Không thể mở cổng OAuth loopback: {}", e))?;
    
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", port);
    let encoded_redirect_uri = url_encode(&redirect_uri);
    let encoded_scope = url_encode("openid email profile https://www.googleapis.com/auth/generative-language");

    let mut auth_url = format!(
        "https://accounts.google.com/o/oauth2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        url_encode(&cid),
        encoded_redirect_uri,
        encoded_scope
    );

    if let Some(ref ch) = code_challenge {
        auth_url.push_str(&format!("&code_challenge={}&code_challenge_method=S256", url_encode(ch)));
    }

    eprintln!("[OAuth] Starting flow with Client ID: {}", cid);
    eprintln!("[OAuth] Redirect URI: {}", redirect_uri);
    eprintln!("[OAuth] Opening URL: {}", auth_url);

    // Safely open the Google sign-in URL in the default browser
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("Start-Process '{}'", auth_url.replace("'", "''")),
            ])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(&auth_url)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&auth_url)
            .spawn();
    }

    // Listen for the callback on a TCP socket with a 120 second timeout
    let timeout = Duration::from_secs(120);
    let accept_future = async {
        let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 4096];
        let n = socket.read(&mut buffer).await.map_err(|e| e.to_string())?;
        let request_str = String::from_utf8_lossy(&buffer[..n]);

        // The success HTML page sent back to the browser
        let html_body = r#"<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>TableNova - Xác thực thành công</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 36px 48px; border-radius: 16px; border: 1px solid #334155; text-align: center; box-shadow: 0 16px 36px rgba(0,0,0,0.5); max-width: 440px; }
    h2 { color: #38bdf8; margin: 16px 0 8px; font-size: 22px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0; }
    .icon { font-size: 48px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✨</div>
    <h2>Đăng nhập thành công!</h2>
    <p>Xác thực tài khoản Google qua Web Browser đã hoàn tất. Bạn có thể đóng tab này và quay lại ứng dụng <strong>TableNova</strong>.</p>
  </div>
</body>
</html>"#;

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html_body.len(),
            html_body
        );

        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.flush().await;

        Ok::<String, String>(request_str.to_string())
    };

    match tokio::time::timeout(timeout, accept_future).await {
        Ok(Ok(request_str)) => {
            let mut code = None;
            let mut error = None;

            if let Some(first_line) = request_str.lines().next() {
                if let Some(query_start) = first_line.find('?') {
                    if let Some(query_end) = first_line[query_start..].find(' ') {
                        let query = &first_line[query_start + 1..query_start + query_end];
                        for pair in query.split('&') {
                            let mut parts = pair.split('=');
                            if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
                                if k == "code" {
                                    code = Some(simple_url_decode(v));
                                } else if k == "error" {
                                    error = Some(simple_url_decode(v));
                                }
                            }
                        }
                    }
                }
            }

            Ok(OAuthCallbackResult {
                success: code.is_some(),
                code,
                redirect_uri: Some(redirect_uri),
                error,
            })
        }
        Ok(Err(e)) => Err(format!("Lỗi kết nối OAuth: {}", e)),
        Err(_) => Err("Quá thời gian xác thực (120s). Vui lòng thử lại.".to_string()),
    }
}).await
}
