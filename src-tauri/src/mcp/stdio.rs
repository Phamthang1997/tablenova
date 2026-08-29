//! `--mcp-stdio`: speak MCP over stdin/stdout, forwarding to the app's own HTTP server.
//!
//! **Why the app itself is the bridge.** Antigravity's HTTP client fails before any request reaches
//! us in at least one installation (its own log, at every IDE startup: `mcp_manager.go: Failed to
//! write server states, eagerly loading all tools: failed to get server directory`), and the failure
//! is identical across five server configurations and a cleared tool cache. Speaking stdio avoids
//! that code path. `docs/mcp-server-plan.md` §7 reserved a stdio bridge for exactly this - "only if
//! a target client actually needs it" - and the condition is now met by measurement.
//!
//! A standalone Node script did the job first, and it is why this exists in Rust instead: a script
//! in `scripts/` only works on a machine that has the repo, so its absolute path cannot be put in a
//! config that travels. Being the app means the client config is the smallest it can be - the exe
//! path the Settings dialog already knows, one flag, **and no token**: this process reads the keyring
//! itself, so the bearer stops living in plaintext in the client's config file (§8).
//!
//! This runs BEFORE `tauri::Builder` and never returns to it, so it never touches the window layer -
//! which is what §0.4 was worried about when it called a stdio bridge a bootstrap-level change. On
//! Windows the release binary is built with `windows_subsystem = "windows"`; that only suppresses
//! allocating a console, and a parent that spawns us with redirected pipes still hands us its
//! handles, so stdio works either way.
//!
//! **Nothing but JSON-RPC ever goes to stdout.** Diagnostics go to stderr; a stray line on stdout
//! desynchronises the client.

use std::io::{BufRead, Write};

use super::server::DEFAULT_PORT;

/// The flag a client is configured with.
const FLAG: &str = "--mcp-stdio";

/// Overrides the port when the user moved the server off its default.
const PORT_FLAG: &str = "--port";

/// The port to forward to, if `--mcp-stdio` was asked for at all.
///
/// Pure, so the argument handling has a test rather than a launch. An unparsable or absent `--port`
/// falls back to `DEFAULT_PORT` instead of failing: the flag is a convenience for a moved port, and
/// refusing to start over a typo would leave the client with no server and no explanation.
pub fn requested_port(args: &[String]) -> Option<u16> {
    if !args.iter().any(|a| a == FLAG) {
        return None;
    }
    let port = args
        .iter()
        .position(|a| a == PORT_FLAG)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT);
    Some(port)
}

/// Run the proxy until stdin closes, then exit the process.
///
/// Builds its own single-threaded runtime: the Tauri runtime is never started on this path, and one
/// thread is ample for a request-at-a-time proxy.
pub fn serve(port: u16) -> ! {
    let token = match super::auth::load_or_create() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[tablenova --mcp-stdio] cannot read the access token: {e}");
            std::process::exit(1);
        }
    };

    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[tablenova --mcp-stdio] cannot start: {e}");
            std::process::exit(1);
        }
    };

    runtime.block_on(pump(port, token));
    std::process::exit(0);
}

/// One line in, one response out, strictly in order.
///
/// Sequential on purpose: the session id arrives on the `initialize` response, and a second request
/// leaving before it is assigned would travel without the header the server requires in session
/// mode.
async fn pump(port: u16, token: String) {
    let endpoint = format!("http://127.0.0.1:{port}{}", super::http::MOUNT_PATH);
    let client = reqwest::Client::new();
    let stdin = std::io::stdin();
    let mut session: Option<String> = None;
    let mut protocol: Option<String> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[tablenova --mcp-stdio] stdin: {e}");
                return;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let mut req = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            // Both: the server may answer as one JSON body or as an SSE stream.
            .header("Accept", "application/json, text/event-stream");
        if let Some(s) = &session {
            req = req.header("mcp-session-id", s);
        }
        if let Some(p) = &protocol {
            req = req.header("MCP-Protocol-Version", p);
        }

        let res = match req.body(line).send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[tablenova --mcp-stdio] {e}");
                continue;
            }
        };

        if let Some(s) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            session = Some(s.to_string());
        }

        let body = match res.text().await {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[tablenova --mcp-stdio] reading response: {e}");
                continue;
            }
        };

        // A notification is answered with 202 and an empty body. Writing anything for it would
        // desynchronise a client that is not waiting for a reply.
        for message in extract_messages(&body) {
            if protocol.is_none() {
                protocol = negotiated_protocol(message);
            }
            let mut out = std::io::stdout().lock();
            if writeln!(out, "{message}").is_err() || out.flush().is_err() {
                return; // client closed its end
            }
        }
    }
}

/// The JSON-RPC messages inside a response body.
///
/// SSE frames carry them on `data:` lines, interleaved with `id:`/`retry:` bookkeeping that must not
/// be forwarded; a plain JSON body has no framing at all. Pure, so both shapes have a test.
fn extract_messages(body: &str) -> Vec<&str> {
    let mut out: Vec<&str> = body
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if out.is_empty() && body.trim_start().starts_with('{') {
        out.push(body.trim());
    }
    out
}

/// The protocol version the server negotiated, read off an `initialize` result.
///
/// Some rmcp modes want it echoed as a header on every later request. Parsed by hand rather than with
/// a struct: this is the one field needed out of a response this process otherwise never inspects.
fn negotiated_protocol(message: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    value.get("result")?.get("protocolVersion")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_required_and_the_port_defaults() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        assert_eq!(requested_port(&args(&["tablenova.exe"])), None, "no flag, normal launch");
        assert_eq!(requested_port(&args(&["tablenova.exe", FLAG])), Some(DEFAULT_PORT));
        assert_eq!(requested_port(&args(&["tablenova.exe", FLAG, PORT_FLAG, "45999"])), Some(45999));
        // A typo must not leave the client with no server: fall back rather than refuse.
        assert_eq!(requested_port(&args(&["tablenova.exe", FLAG, PORT_FLAG, "nope"])), Some(DEFAULT_PORT));
        assert_eq!(requested_port(&args(&["tablenova.exe", FLAG, PORT_FLAG, "0"])), Some(DEFAULT_PORT));
        assert_eq!(requested_port(&args(&["tablenova.exe", FLAG, PORT_FLAG])), Some(DEFAULT_PORT));
    }

    #[test]
    fn messages_come_out_of_both_body_shapes() {
        // SSE: only `data:` lines, and the priming/bookkeeping lines are dropped.
        let sse = "data: \nid: 0\nretry: 3000\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1}\n";
        assert_eq!(extract_messages(sse), vec!["{\"jsonrpc\":\"2.0\",\"id\":1}"]);
        // Plain JSON, no framing.
        assert_eq!(extract_messages("{\"a\":1}"), vec!["{\"a\":1}"]);
        // A notification's empty 202 body yields nothing to forward.
        assert!(extract_messages("").is_empty());
        assert!(extract_messages("\n\n").is_empty());
    }

    #[test]
    fn the_protocol_version_is_read_only_from_an_initialize_result() {
        let init = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}"#;
        assert_eq!(negotiated_protocol(init).as_deref(), Some("2025-06-18"));
        // Anything else leaves it unset rather than guessing.
        assert!(negotiated_protocol(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#).is_none());
        assert!(negotiated_protocol("not json").is_none());
    }
}
