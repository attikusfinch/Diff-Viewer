#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, Read, Write}, net::TcpStream, path::PathBuf,
    sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Review {
    reviewed: HashMap<String, String>,
    comments: Vec<Comment>,
    plan: HashMap<String, PlanItem>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PlanItem {
    priority: String,
    reason: String,
    author: String,
    signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comment {
    id: String,
    path: String,
    line: usize,
    side: String,
    body: String,
    author: String,
    created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Client { id: String, name: String, version: String, last_seen: u64 }

#[derive(Default)]
struct Workspace {
    root: Option<PathBuf>,
    base: String,
    reviews: HashMap<String, Review>,
    clients: HashMap<String, Client>,
    port: u16,
    connection_error: Option<String>,
}

type Shared = Arc<Mutex<Workspace>>;

#[derive(Serialize, Deserialize)]
struct Bridge { port: u16, token: String }

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn config_dir() -> PathBuf {
    std::env::var_os("PATCHWORK_DATA_DIR").map(PathBuf::from)
        .unwrap_or_else(|| dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("Patchwork"))
}
fn review_key(root: &std::path::Path, base: &str) -> String { format!("{}\n{base}", root.display()) }
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing string parameter: {key}"))
}

fn persist(workspace: &Workspace) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec(&workspace.reviews).map_err(|e| e.to_string())?;
    let temp = dir.join("reviews.tmp");
    fs::write(&temp, data).map_err(|e| e.to_string())?;
    fs::rename(temp, dir.join("reviews.json")).map_err(|e| e.to_string())
}

fn dispatch(app: &tauri::AppHandle, state: &Shared, method: &str, params: &Value) -> Result<Value, String> {
    let mut ws = state.lock().map_err(|_| "Workspace lock failed")?;
    if method == "get_connection" {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let clients: Vec<_> = ws.clients.values().filter(|c| now().saturating_sub(c.last_seen) < 90).cloned().collect();
        return Ok(json!({ "command": exe, "args": ["--mcp"], "clients": clients,
            "available": ws.port != 0, "error": ws.connection_error }));
    }
    if method == "open_repository" {
        let root = git::repository(string(params, "path")?)?;
        let base = params.get("base").and_then(Value::as_str).unwrap_or("working");
        let snap = git::snapshot(&root, base)?;
        ws.root = Some(root);
        ws.base = base.into();
        return Ok(json!(snap));
    }
    let root = ws.root.clone().ok_or("Open a Git repository first.")?;
    let base = params.get("base").and_then(Value::as_str).unwrap_or(&ws.base).to_string();
    let key = review_key(&root, &base);
    match method {
        "get_preview" => Ok(json!(git::file_preview(&root, &base, string(params, "path")?)?)),
        "get_snapshot" => {
            let snap = git::snapshot(&root, &base)?;
            ws.base = base;
            Ok(json!(snap))
        },
        "get_file" | "get_diff" => {
            let path = string(params, "path")?;
            let content = git::file_content(&root, &base, path)?;
            if method == "get_diff" {
                let snap = git::snapshot(&root, &base)?;
                let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];
                if base == "staged" { args.push("--cached"); }
                args.extend([snap.base_commit.as_str(), "--", path]);
                let mut patch = String::from_utf8_lossy(&git::run(&root, &args)?).into_owned();
                if patch.is_empty() && content.before.is_empty() && !content.after.is_empty() {
                    patch = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n{}",
                        content.after.lines().count(), content.after.lines().map(|l| format!("+{l}\n")).collect::<String>());
                }
                Ok(json!({"file": content, "patch": patch}))
            } else { Ok(json!(content)) }
        },
        "get_review" => Ok(json!(ws.reviews.get(&key).cloned().unwrap_or_default())),
        "set_review_plan" => {
            let entries = params.get("files").and_then(Value::as_array).ok_or("files must be an array")?;
            if entries.len() > 1000 { return Err("A review plan can contain up to 1,000 files.".into()); }
            let snapshot = git::snapshot(&root, &base)?;
            let mut plan = HashMap::new();
            for entry in entries {
                let path = string(entry, "path")?;
                git::safe_path(&root, path)?;
                let file = snapshot.files.iter().find(|f| f.path == path)
                    .ok_or_else(|| format!("{path} is not a changed file in this comparison."))?;
                let priority = string(entry, "priority")?;
                if !["validate", "normal", "low"].contains(&priority) {
                    return Err("Priority must be validate, normal, or low.".into());
                }
                let reason = entry.get("reason").and_then(Value::as_str).unwrap_or("");
                if reason.len() > 4000 { return Err("Review reasons must be at most 4,000 bytes.".into()); }
                plan.insert(path.into(), PlanItem { priority: priority.into(), reason: reason.into(),
                    author: params.get("author").and_then(Value::as_str).unwrap_or("Agent").into(), signature: file.signature.clone() });
            }
            let review = ws.reviews.entry(key).or_default();
            review.plan = plan;
            let result = json!(review);
            persist(&ws)?;
            let _ = app.emit("review-updated", ());
            Ok(result)
        },
        "set_reviewed" => {
            let path = string(params, "path")?;
            git::safe_path(&root, path)?;
            let review = ws.reviews.entry(key).or_default();
            if params.get("reviewed").and_then(Value::as_bool).unwrap_or(false) {
                review.reviewed.insert(path.into(), string(params, "fingerprint")?.into());
            } else { review.reviewed.remove(path); }
            let result = json!(review);
            persist(&ws)?;
            Ok(result)
        },
        "add_comment" => {
            let path = string(params, "path")?;
            git::safe_path(&root, path)?;
            let body = string(params, "body")?.trim();
            if body.is_empty() || body.len() > 20_000 { return Err("Comment must contain 1–20,000 bytes.".into()); }
            let side = params.get("side").and_then(Value::as_str).unwrap_or("after");
            if side != "before" && side != "after" { return Err("Comment side must be before or after.".into()); }
            let review = ws.reviews.entry(key).or_default();
            review.comments.push(Comment { id: uuid::Uuid::new_v4().to_string(), path: path.into(),
                line: params.get("line").and_then(Value::as_u64).unwrap_or(1).max(1) as usize,
                side: side.into(), body: body.into(), author: params.get("author").and_then(Value::as_str).unwrap_or("You").into(), created_at: now() });
            let result = json!(review);
            persist(&ws)?;
            let _ = app.emit("review-updated", ());
            Ok(result)
        },
        "delete_comment" => {
            let id = string(params, "id")?;
            let review = ws.reviews.entry(key).or_default();
            review.comments.retain(|c| c.id != id);
            let result = json!(review);
            persist(&ws)?;
            Ok(result)
        },
        "stage_file" => {
            git::stage(&root, string(params, "path")?, params.get("staged").and_then(Value::as_bool).unwrap_or(true))?;
            Ok(json!(git::snapshot(&root, &base)?))
        },
        "stage_all" => {
            let staged = params.get("staged").and_then(Value::as_bool).unwrap_or(true);
            let snapshot = git::snapshot(&root, if staged { "working" } else { "staged" })?;
            for file in snapshot.files { git::stage(&root, &file.path, staged)?; }
            Ok(json!(git::snapshot(&root, &base)?))
        },
        "commit" => Ok(json!({"message": git::commit(&root, string(params, "message")?)?})),
        "show_diff" => {
            git::resolve_base(&root, &base)?;
            if let Some(path) = params.get("path").and_then(Value::as_str) { git::safe_path(&root, path)?; }
            if let Some(mode) = params.get("mode").and_then(Value::as_str) {
                if mode != "diff" && mode != "file" { return Err("View mode must be diff or file.".into()); }
            }
            ws.base = base.clone();
            let _ = app.emit("show-diff", json!({"root": root, "base": base, "path": params.get("path"), "line": params.get("line"), "mode": params.get("mode")}));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
            }
            Ok(json!({"opened": true, "repository": root, "base": base, "path": params.get("path")}))
        },
        _ => Err(format!("Unknown action: {method}")),
    }
}

#[tauri::command]
async fn api(app: tauri::AppHandle, state: tauri::State<'_, Shared>, method: String, params: Value) -> Result<Value, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &shared, &method, &params))
        .await.map_err(|e| e.to_string())?
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name": name, "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": false},
        "annotations": {"readOnlyHint": !["add_comment", "set_review_plan", "open_repository", "show_diff"].contains(&name),
        "destructiveHint": false, "openWorldHint": false}})
}

fn tools_list() -> Value {
    let path = json!({"type":"string","description":"Repository-relative file path"});
    let base = json!({"type":"string","description":"working, staged, or a branch such as main. Defaults to the current comparison."});
    json!({"tools": [
        tool("open_repository", "Open a local Git repository in Patchwork. Does not modify Git or working files.", json!({"path":{"type":"string","description":"Absolute path to a Git repository"}, "base":base}), &["path"]),
        tool("list_changes", "List changed files, additions, deletions and staging state for the open repository.", json!({"base":base}), &[]),
        tool("get_diff", "Read a file's unified Git patch and before/after contents. Branch comparisons use the merge base and include local changes.", json!({"path":path,"base":base}), &["path"]),
        tool("get_file", "Read complete before/after file contents (2 MB limit) from the current comparison.", json!({"path":path,"base":base}), &["path"]),
        tool("show_diff", "Focus Patchwork and show a particular file, line and comparison for the human to review.", json!({"path":path,"base":base,"line":{"type":"integer","minimum":1},"mode":{"type":"string","enum":["diff","file"]}}), &[]),
        tool("get_review", "Read review priorities, human comments and reviewed-file fingerprints. Use this to address feedback after a human reviews your changes.", json!({"base":base}), &[]),
        tool("set_review_plan", "Replace the review plan for changed files. Mark files requiring human validation as validate, routine changes as normal, and less important files as low. Explain why in reason. Omitted files remain normal; an empty array clears the plan. Priorities are suggestions, not approval.", json!({"base":base,"files":{"type":"array","maxItems":1000,"items":{"type":"object","properties":{"path":path,"priority":{"type":"string","enum":["validate","normal","low"]},"reason":{"type":"string","description":"Concise explanation of what the human should check"}},"required":["path","priority"],"additionalProperties":false}}}), &["files"]),
        tool("add_comment", "Add a review note on a file and line. Does not change source code.", json!({"path":path,"base":base,"line":{"type":"integer","minimum":1},"side":{"type":"string","enum":["before","after"]},"body":{"type":"string"},"author":{"type":"string"}}), &["path","body"])
    ]})
}

fn rpc(app: &tauri::AppHandle, state: &Shared, request: Value, session: &str) -> Option<Value> {
    let id = request.get("id").cloned();
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":"Invalid JSON-RPC request"}}));
    }
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or(json!({}));
    if let Ok(mut ws) = state.lock() {
        if let Some(client) = ws.clients.get_mut(session) { client.last_seen = now(); }
    }
    let result: Result<Value, (i32, String)> = match method {
        "initialize" => {
            let client = params.get("clientInfo").cloned().unwrap_or(json!({}));
            if let Ok(mut ws) = state.lock() {
                ws.clients.insert(session.into(), Client { id: session.into(), name: client["name"].as_str().unwrap_or("MCP agent").into(),
                    version: client["version"].as_str().unwrap_or("").into(), last_seen: now() });
            }
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-11-25");
            let version = if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"].contains(&requested) { requested } else { "2025-11-25" };
            Ok(json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"patchwork","version":env!("CARGO_PKG_VERSION")},
                "instructions":"Use open_repository and list_changes, then set_review_plan to suggest files requiring human validation and lower-priority changes with reasons. Use show_diff to present changes. Read get_review to receive human feedback. All tools leave source files unchanged."}))
        },
        "ping" | "notifications/initialized" | "notifications/cancelled" | "bridge/ping" => Ok(json!({})),
        "bridge/disconnect" => { if let Ok(mut ws) = state.lock() { ws.clients.remove(session); } Ok(json!({})) },
        "tools/list" => Ok(tools_list()),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let method = match name {
                "list_changes" => "get_snapshot",
                "open_repository" | "get_diff" | "get_file" | "show_diff" | "get_review" | "add_comment" | "set_review_plan" => name,
                _ => "",
            };
            if method.is_empty() { Err((-32602, "Unknown tool".into())) }
            else {
                let mut args = params.get("arguments").cloned().unwrap_or(json!({}));
                if !args.is_object() { return id.map(|id| json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Tool arguments must be an object"}})); }
                if method == "set_review_plan" {
                    let author = state.lock().ok().and_then(|ws| ws.clients.get(session).map(|client| client.name.clone())).unwrap_or_else(|| "Agent".into());
                    args["author"] = json!(author);
                }
                let result = dispatch(app, state, method, &args);
                if method == "open_repository" && result.is_ok() { let _ = app.emit("repository-opened", args.clone()); }
                Ok(match result {
                    Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}], "isError":false}),
                    Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
                })
            }
        },
        m if m.starts_with("notifications/") => Ok(json!({})),
        _ => Err((-32601, "Method not found".into())),
    };
    id.map(|id| match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err((code, message)) => json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
    })
}

fn start_bridge(app: tauri::AppHandle, state: Shared) -> Result<(), String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().ok_or("Invalid bridge address")?.port();
    let token = uuid::Uuid::new_v4().to_string();
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?; }
    let bridge_path = dir.join("bridge.json");
    fs::write(&bridge_path, serde_json::to_vec(&Bridge { port, token: token.clone() }).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&bridge_path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?; }
    state.lock().map_err(|_| "Workspace lock failed")?.port = port;
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let authorized = request.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {token}"));
            if !authorized || request.method() != &tiny_http::Method::Post || request.url() != "/rpc" {
                let _ = request.respond(tiny_http::Response::from_string("Forbidden").with_status_code(403)); continue;
            }
            if request.body_length().unwrap_or(0) > 1024 * 1024 {
                let _ = request.respond(tiny_http::Response::from_string("Request too large").with_status_code(413)); continue;
            }
            let session = request.headers().iter().find(|h| h.field.equiv("X-Patchwork-Session"))
                .map(|h| h.value.to_string()).unwrap_or_default();
            let mut body = String::new();
            let parsed = request.as_reader().take(1024 * 1024 + 1).read_to_string(&mut body)
                .map_err(|e| e.to_string()).and_then(|_| serde_json::from_str(&body).map_err(|e| e.to_string()));
            let response = match parsed {
                Ok(value) => rpc(&app, &state, value, &session),
                Err(_) => Some(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})),
            };
            let response = tiny_http::Response::from_string(response.map(|v| v.to_string()).unwrap_or_default())
                .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
                .with_header(tiny_http::Header::from_bytes("Connection", "close").unwrap());
            let _ = request.respond(response);
        }
    });
    Ok(())
}

fn forward(value: &Value, session: &str) -> Result<Option<Value>, String> {
    let bridge: Bridge = serde_json::from_slice(&fs::read(config_dir().join("bridge.json"))
        .map_err(|_| "Start the Patchwork desktop application before connecting MCP.")?).map_err(|e| e.to_string())?;
    let mut socket = TcpStream::connect_timeout(&format!("127.0.0.1:{}", bridge.port).parse().map_err(|e: std::net::AddrParseError| e.to_string())?, Duration::from_secs(3))
        .map_err(|_| "Patchwork is not running. Open the desktop application and reconnect.")?;
    socket.set_read_timeout(Some(Duration::from_secs(60))).map_err(|e| e.to_string())?;
    socket.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let body = value.to_string();
    write!(socket, "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nX-Patchwork-Session: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", bridge.port, bridge.token, session, body.len(), body).map_err(|e| e.to_string())?;
    let mut response = String::new();
    socket.take(16 * 1024 * 1024).read_to_string(&mut response).map_err(|e| e.to_string())?;
    let (headers, body) = response.split_once("\r\n\r\n").ok_or("Invalid bridge response")?;
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") { return Err("Patchwork rejected the connection. Restart the agent's MCP server.".into()); }
    if body.trim().is_empty() { return Ok(None); }
    serde_json::from_str(body).map(Some).map_err(|e| e.to_string())
}

fn stdio_bridge() {
    let session = uuid::Uuid::new_v4().to_string();
    let heartbeat_session = session.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        let _ = forward(&json!({"jsonrpc":"2.0","method":"bridge/ping"}), &heartbeat_session);
    });
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line { Ok(line) if line.trim().is_empty() => continue, Ok(line) => line, Err(_) => break };
        let parsed: Result<Value, _> = serde_json::from_str(&line);
        let response = match parsed {
            Ok(value) => match forward(&value, &session) {
                Ok(result) => result,
                Err(e) => value.get("id").map(|id| json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":e}})),
            },
            Err(_) => Some(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})),
        };
        if let Some(value) = response {
            if writeln!(stdout, "{value}").and_then(|_| stdout.flush()).is_err() { break; }
        }
    }
    let _ = forward(&json!({"jsonrpc":"2.0","method":"bridge/disconnect"}), &session);
}

fn main() {
    if std::env::args().any(|a| a == "--mcp") { stdio_bridge(); return; }
    let reviews = fs::read(config_dir().join("reviews.json")).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    let shared: Shared = Arc::new(Mutex::new(Workspace { base: "working".into(), reviews, ..Default::default() }));
    let setup_state = shared.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(shared)
        .invoke_handler(tauri::generate_handler![api])
        .setup(move |app| {
            if let Err(e) = start_bridge(app.handle().clone(), setup_state.clone()) {
                if let Ok(mut ws) = setup_state.lock() { ws.connection_error = Some(e); }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Could not start Patchwork");
}
