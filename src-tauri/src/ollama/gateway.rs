//! 本地模型鉴权网关。
//!
//! ## 为什么需要这一层
//!
//! Ollama 的本地服务**没有任何鉴权**（官方文档明确说明：本地 API 不需要认证；
//! `OLLAMA_API_KEY` 只对 ollama.com 云端生效，`ollama serve` 根本不读它）。
//! 官方给出的加固建议就是两条：**保持端口不可达**，以及**在前面放一个做校验的反向代理**。
//!
//! 本模块就是第二条：
//!
//! ```text
//!   任何客户端 ──► 127.0.0.1:11435（本网关，校验 apiKey）
//!                        │  校验通过后原样透传
//!                        ▼
//!                127.0.0.1:11436（Ollama 引擎，仅回环，不对外）
//! ```
//!
//! ## 两道防线
//!
//! 1. **绑定回环地址**：网关只 listen `127.0.0.1`，局域网内任何机器都无法建立连接。
//!    这是最硬的一层 —— 端口不可达，连探测都探测不到。
//! 2. **apiKey 校验**：回环地址对本机所有用户/进程都是开放的（Windows 上 loopback
//!    不做用户隔离），所以同机的其它用户或程序仍能连上。apiKey 用来挡住这一类调用。
//!
//! 如果将来要把本地模型开放给局域网（例如手机端使用），只需把 `BIND_IP` 改成
//! `0.0.0.0`，此时 apiKey 就成了唯一防线 —— 这也是它能被随时启用的原因。
//!
//! ## 实现说明
//!
//! 沿用项目既有范式（见 `utils/local_http.rs`）：用 `std::net` 手写 HTTP/1.1，
//! 不引入新依赖。请求侧只要请求头 + `Content-Length` 声明的 body；响应侧是**原始字节
//! 管道**，因此 SSE（`text/event-stream`）流式输出可以逐块抵达客户端，不会被缓冲或改写。
//! 全程使用 `Connection: close`，从而无需实现 chunked 分帧。

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use rand::distr::Alphanumeric;
use rand::RngExt;
use tauri::{AppHandle, Manager};

use super::ollama_manager::{kill_port_owner, ENGINE_PORT, GATEWAY_PORT};

/// 对外只暴露回环地址：局域网不可达。改成 "0.0.0.0" 即可开放给局域网（apiKey 会成为唯一防线）
const BIND_IP: &str = "127.0.0.1";
/// 上游 Ollama 永远只在回环上，不接受外部直连
const UPSTREAM_IP: &str = "127.0.0.1";

/// apiKey 落盘文件名（位于 app_data_dir）
const KEY_FILE_NAME: &str = "local-gateway.json";
/// apiKey 前缀：一眼能看出是本地引擎的凭据
const KEY_PREFIX: &str = "sk-pingyou-local-";
/// apiKey 随机部分长度
const KEY_RANDOM_LEN: usize = 40;

/// 读取请求头的超时（客户端迟迟不发完头就断开，避免线程挂死）
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 上游读超时：模型首次加载 + 长文本生成可能很久，给足余量
const UPSTREAM_READ_TIMEOUT: Duration = Duration::from_secs(900);
/// 转发缓冲区大小
const PIPE_BUF_SIZE: usize = 16 * 1024;
/// 单个请求体的上限（视觉请求会带 base64 图片，放宽到 64MB）
const MAX_BODY_SIZE: usize = 64 * 1024 * 1024;

// ─── 运行期 apiKey ────────────────────────────────────────────────
//
// 网关线程与 Tauri 命令分属不同线程，用全局 Mutex 共享当前有效 key；
// 重置 apiKey 后无需重启网关即刻生效。

fn api_key_store() -> &'static Mutex<String> {
    static KEY: OnceLock<Mutex<String>> = OnceLock::new();
    KEY.get_or_init(|| Mutex::new(String::new()))
}

/// 当前有效的 apiKey（空字符串表示尚未初始化，此时一律拒绝请求）
pub fn current_api_key() -> String {
    api_key_store()
        .lock()
        .map(|k| k.clone())
        .unwrap_or_default()
}

fn set_api_key(key: &str) {
    if let Ok(mut guard) = api_key_store().lock() {
        *guard = key.to_string();
    }
}

/// 网关是否已成功监听。
///
/// 暴露给前端是为了避免"静默失败"：万一 11435 被别的进程占着（且回收失败），
/// 引擎本身仍然是健康的，界面会显示"运行中"，用户却要到真正发起对话时才撞上连接错误。
/// 有了这个标记，启动检测阶段就能直接把问题报出来。
fn gateway_ready_flag() -> &'static std::sync::atomic::AtomicBool {
    static READY: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();
    READY.get_or_init(|| std::sync::atomic::AtomicBool::new(false))
}

pub fn is_gateway_ready() -> bool {
    gateway_ready_flag().load(std::sync::atomic::Ordering::SeqCst)
}

/// 生成一个高强度随机 apiKey（`rand::rng` 是以 OS 熵为种子的 CSPRNG）
fn generate_api_key() -> String {
    let random: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(KEY_RANDOM_LEN)
        .map(char::from)
        .collect();
    format!("{}{}", KEY_PREFIX, random)
}

fn key_file_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(KEY_FILE_NAME))
}

fn persist_api_key(path: &Path, key: &str) -> Result<(), String> {
    let payload = serde_json::json!({ "apiKey": key });
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("写入 apiKey 失败: {}", e))
}

/// 读取已落盘的 apiKey；不存在或损坏则生成一个新的并落盘。
/// 同时把它设进运行期状态，网关线程据此校验。
pub fn load_or_create_api_key(app: &AppHandle) -> String {
    if let Some(path) = key_file_path(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(key) = value.get("apiKey").and_then(|v| v.as_str()) {
                    let key = key.trim();
                    if !key.is_empty() {
                        set_api_key(key);
                        return key.to_string();
                    }
                }
            }
        }

        let key = generate_api_key();
        if let Err(e) = persist_api_key(&path, &key) {
            log::warn!("[GATEWAY] {}（本次仍会生效，但重启后会重新生成）", e);
        }
        set_api_key(&key);
        return key;
    }

    // 拿不到 app_data_dir 这种极端情况：仍然给一个可用 key，只是不持久化
    let key = generate_api_key();
    set_api_key(&key);
    key
}

/// 重新生成 apiKey（旧 key 立即失效）
pub fn regenerate_api_key(app: &AppHandle) -> Result<String, String> {
    let key = generate_api_key();
    if let Some(path) = key_file_path(app) {
        persist_api_key(&path, &key)?;
    }
    set_api_key(&key);
    log::info!("[GATEWAY] apiKey 已重置，旧 key 立即失效");
    Ok(key)
}

// ─── 鉴权 ─────────────────────────────────────────────────────────

/// 定长比较，避免通过响应时间差异逐字节猜测 key
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 从请求头里取出候选凭据。
/// 同时接受 `Authorization: Bearer <key>`（OpenAI 风格，本应用走这条）与
/// `x-api-key: <key>`（Anthropic 风格，方便用户拿其它客户端接本地模型）。
fn extract_credential(headers: &[(String, String)]) -> Option<String> {
    let mut api_key_header: Option<String> = None;

    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower == "authorization" {
            let value = value.trim();
            let token = value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .unwrap_or("")
                .trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        } else if lower == "x-api-key" {
            api_key_header = Some(value.trim().to_string());
        }
    }

    api_key_header.filter(|v| !v.is_empty())
}

fn unauthorized_body() -> &'static str {
    r#"{"error":{"message":"Invalid API key. 请使用屏友「本地模型」页展示的 API Key。","type":"invalid_request_error","code":"invalid_api_key"}}"#
}

// ─── HTTP 工具 ────────────────────────────────────────────────────

struct RequestHead {
    method: String,
    /// 原始 request-target（含 querystring）
    target: String,
    headers: Vec<(String, String)>,
    content_length: usize,
    /// 请求体使用了 chunked 编码 —— 本网关不解析分帧，直接拒绝
    chunked: bool,
}

/// 读取「请求行 + 请求头」（不含 body）。body 由调用方沿用同一个 BufReader 继续读，
/// 以免丢失 BufReader 已经预读进来的字节。
fn read_request_head<R: BufRead>(reader: &mut R) -> Option<RequestHead> {
    let mut first_line = String::new();
    if reader.read_line(&mut first_line).ok()? == 0 {
        return None;
    }

    let mut parts = first_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_length = 0usize;
    let mut chunked = false;

    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) if n <= 2 => break, // 空行 → 头结束
            Ok(_) => {
                let Some((name, value)) = line.split_once(':') else {
                    continue;
                };
                let name = name.trim().to_string();
                let value = value.trim().to_string();
                let lower = name.to_ascii_lowercase();

                if lower == "content-length" {
                    content_length = value.parse::<usize>().unwrap_or(0);
                } else if lower == "transfer-encoding"
                    && value.to_ascii_lowercase().contains("chunked")
                {
                    chunked = true;
                }

                headers.push((name, value));
            }
            Err(_) => break,
        }
    }

    Some(RequestHead {
        method,
        target,
        headers,
        content_length,
        chunked,
    })
}

/// 写一个自包含的 JSON 响应（用于 401 / 502 这类网关自己产生的错误）
fn write_json_response(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n",
        status = status,
        reason = reason,
        len = body.len(),
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// 需要从转发请求里剔除的头：逐跳头 + 凭据（凭据绝不能流到上游）
fn should_strip_header(lower: &str) -> bool {
    matches!(
        lower,
        "host"
            | "authorization"
            | "x-api-key"
            | "connection"
            | "proxy-connection"
            | "keep-alive"
            | "upgrade"
            | "te"
            | "trailer"
            | "transfer-encoding"
    )
}

// ─── 连接处理 ─────────────────────────────────────────────────────

/// 处理一条客户端连接。`upstream_port` 由调用方传入（生产固定为 `ENGINE_PORT`，
/// 便于测试注入假上游）。
fn handle_conn(mut client: TcpStream, upstream_port: u16) {
    let _ = client.set_nodelay(true);
    let _ = client.set_read_timeout(Some(HEAD_READ_TIMEOUT));

    let Ok(read_half) = client.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half);

    let Some(head) = read_request_head(&mut reader) else {
        return;
    };

    // ① 鉴权：没有 key / key 不匹配 → 401，不接触上游
    let expected = current_api_key();
    let provided = extract_credential(&head.headers);
    let authorized = !expected.is_empty()
        && provided
            .as_deref()
            .map(|token| constant_time_eq(token, &expected))
            .unwrap_or(false);

    if !authorized {
        log::warn!(
            "[GATEWAY] 拒绝未授权请求: {} {}",
            head.method,
            head.target
        );
        write_json_response(
            &mut client,
            401,
            "Unauthorized",
            unauthorized_body(),
        );
        let _ = client.shutdown(Shutdown::Both);
        return;
    }

    // ② 请求体只支持 Content-Length；chunked 需要分帧解析，直接明确拒绝
    if head.chunked {
        write_json_response(
            &mut client,
            411,
            "Length Required",
            r#"{"error":{"message":"Chunked request body is not supported by the local gateway.","type":"invalid_request_error"}}"#,
        );
        let _ = client.shutdown(Shutdown::Both);
        return;
    }

    if head.content_length > MAX_BODY_SIZE {
        write_json_response(
            &mut client,
            413,
            "Payload Too Large",
            r#"{"error":{"message":"Request body too large for the local gateway.","type":"invalid_request_error"}}"#,
        );
        let _ = client.shutdown(Shutdown::Both);
        return;
    }

    // ③ 连接上游引擎
    let upstream_addr = format!("{}:{}", UPSTREAM_IP, upstream_port);
    let mut upstream = match TcpStream::connect(&upstream_addr) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[GATEWAY] 连接本地引擎失败: {}", e);
            write_json_response(
                &mut client,
                502,
                "Bad Gateway",
                r#"{"error":{"message":"Local model engine is not running.","type":"api_error"}}"#,
            );
            let _ = client.shutdown(Shutdown::Both);
            return;
        }
    };
    let _ = upstream.set_nodelay(true);
    let _ = upstream.set_read_timeout(Some(UPSTREAM_READ_TIMEOUT));

    // ④ 转发请求头（逐跳头与凭据剔除；Host 指向上游；统一 Connection: close）
    let mut forwarded = format!("{} {} HTTP/1.1\r\n", head.method, head.target);
    for (name, value) in &head.headers {
        if should_strip_header(&name.to_ascii_lowercase()) {
            continue;
        }
        forwarded.push_str(name);
        forwarded.push_str(": ");
        forwarded.push_str(value);
        forwarded.push_str("\r\n");
    }
    forwarded.push_str(&format!("Host: {}\r\n", upstream_addr));
    forwarded.push_str("Connection: close\r\n\r\n");

    if upstream.write_all(forwarded.as_bytes()).is_err() {
        let _ = client.shutdown(Shutdown::Both);
        return;
    }

    // ⑤ 转发请求体（严格按 Content-Length 读，避免多读/少读）
    if head.content_length > 0 {
        let mut remaining = head.content_length;
        let mut buf = vec![0u8; PIPE_BUF_SIZE];
        while remaining > 0 {
            let want = remaining.min(buf.len());
            match reader.read(&mut buf[..want]) {
                Ok(0) => break,
                Ok(n) => {
                    if upstream.write_all(&buf[..n]).is_err() {
                        let _ = client.shutdown(Shutdown::Both);
                        return;
                    }
                    remaining -= n;
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }

    if upstream.flush().is_err() {
        let _ = client.shutdown(Shutdown::Both);
        return;
    }

    // ⑥ 反向透传响应（原始字节，逐块 flush → SSE 不丢实时性）
    let mut buf = vec![0u8; PIPE_BUF_SIZE];
    loop {
        match upstream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if client.write_all(&buf[..n]).is_err() {
                    break;
                }
                if client.flush().is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => {
                if e.kind() != ErrorKind::WouldBlock && e.kind() != ErrorKind::TimedOut {
                    log::warn!("[GATEWAY] 读取上游响应失败: {}", e);
                }
                break;
            }
        }
    }

    let _ = upstream.shutdown(Shutdown::Both);
    let _ = client.shutdown(Shutdown::Both);
}

/// 在后台线程启动鉴权网关。
///
/// 幂等性：端口已被本网关占用时不会再起第二个监听；若被**旧版本遗留的引擎**占用
/// （历史版本 Ollama 直接跑在 11435），会先接管端口再监听，否则网关永远起不来。
pub fn spawn_gateway(app: &AppHandle) {
    let key = load_or_create_api_key(app);
    log::info!(
        "[GATEWAY] 启动本地模型网关 {}:{}（上游 {}:{}），apiKey 前缀 {}",
        BIND_IP,
        GATEWAY_PORT,
        UPSTREAM_IP,
        ENGINE_PORT,
        &key[..key.len().min(18)]
    );

    thread::spawn(move || {
        let addr = format!("{}:{}", BIND_IP, GATEWAY_PORT);

        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(first_err) => {
                // 端口被占：可能是上一次运行遗留的孤儿 Ollama（旧版本跑在 11435）。
                // 11435 是本应用网关的专属端口，回收它是安全的。
                log::warn!(
                    "[GATEWAY] 绑定 {} 失败（{}），尝试回收占用该端口的进程",
                    addr,
                    first_err
                );
                kill_port_owner(GATEWAY_PORT);
                thread::sleep(Duration::from_millis(400));

                match TcpListener::bind(&addr) {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("[GATEWAY] 绑定 {} 仍然失败: {}，本地模型将无法通过网关访问", addr, e);
                        return;
                    }
                }
            }
        };

        log::info!("[GATEWAY] 已监听 http://{}", addr);
        gateway_ready_flag().store(true, std::sync::atomic::Ordering::SeqCst);

        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    thread::spawn(move || handle_conn(s, ENGINE_PORT));
                }
                Err(e) => log::warn!("[GATEWAY] accept 失败: {}", e),
            }
        }
    });
}

// ─── 对外命令 ─────────────────────────────────────────────────────

/// 读取当前本地模型的 apiKey（首次调用会顺带生成并落盘）。
#[tauri::command]
pub fn get_local_api_key(app_handle: AppHandle) -> String {
    let key = current_api_key();
    if !key.is_empty() {
        return key;
    }
    // 网关线程尚未初始化（或初始化失败）时兜底：直接从磁盘读 / 生成
    load_or_create_api_key(&app_handle)
}

/// 重新生成 apiKey；旧 key **立即失效**（已经配置好的外部客户端需要同步更新）。
#[tauri::command]
pub fn regenerate_local_api_key(app_handle: AppHandle) -> Result<String, String> {
    regenerate_api_key(&app_handle)
}

// ─── 测试 ─────────────────────────────────────────────────────────
//
// 鉴权网关是安全边界，光"看起来对"不够，这里用真实 TCP 连接跑一遍：
// 无 key / 错 key 必须 401 且**完全不接触上游**；正确 key 必须原样透传，
// 且凭据头绝不能流到上游。

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::sync::mpsc::{channel, Receiver};
    use std::time::Duration as StdDuration;

    const GOOD_KEY: &str = "sk-pingyou-local-testkey000000000000000000000000";
    const BAD_KEY: &str = "sk-pingyou-local-wrongkey0000000000000000000000";

    /// 起一个假上游：读掉请求头与请求体，把收到的头回传，然后回一段 SSE 风格响应。
    /// 返回 (端口, 收到请求头的通道)。
    fn spawn_mock_upstream() -> (u16, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = channel();

        thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());

            let mut head = String::new();
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if line == "\r\n" || line == "\n" {
                            break;
                        }
                        head.push_str(&line);
                    }
                    Err(_) => break,
                }
            }

            // 按 Content-Length 把请求体读干净，确认网关确实转发了 body
            let len = head
                .lines()
                .find_map(|l| {
                    let lower = l.to_ascii_lowercase();
                    lower
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut body = vec![0u8; len];
            let body_ok = reader.read_exact(&mut body).is_ok();

            let _ = tx.send(format!("{head}\n[BODY_OK={body_ok}]"));

            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Connection: close\r\n\
                  \r\n\
                  data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n\r\n",
            );
            let _ = stream.flush();
        });

        (port, rx)
    }

    /// 起一条被测连接：本端连到监听 socket，服务端线程里跑 `handle_conn`。
    fn open_gateway_conn(upstream_port: u16) -> TcpStream {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                handle_conn(stream, upstream_port);
            }
        });

        let client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = client.set_read_timeout(Some(StdDuration::from_secs(5)));
        let _ = client.set_write_timeout(Some(StdDuration::from_secs(5)));
        client
    }

    /// 读到 EOF 或超时为止（网关收尾会关闭连接）
    fn read_all(stream: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buf).to_string()
    }

    fn chat_request(authorization: Option<&str>) -> String {
        let body = r#"{"stream": true}"#;
        let mut req = String::from("POST /v1/chat/completions HTTP/1.1\r\n");
        req.push_str("Host: 127.0.0.1:11435\r\n");
        req.push_str("Content-Type: application/json\r\n");
        if let Some(token) = authorization {
            req.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        req.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        req.push_str(body);
        req
    }

    #[test]
    fn gateway_enforces_api_key_and_proxies_authorized_traffic() {
        // 单测内串行执行：全局 key 是进程级共享状态，分多个 #[test] 会互相干扰
        set_api_key(GOOD_KEY);

        // ① 完全不带凭据 → 401，并且绝不能碰到上游
        let (up_port, up_rx) = spawn_mock_upstream();
        let mut client = open_gateway_conn(up_port);
        client
            .write_all(chat_request(None).as_bytes())
            .expect("write request");
        let resp = read_all(&mut client);
        assert!(resp.starts_with("HTTP/1.1 401"), "未授权请求应返回 401，实际: {resp}");
        assert!(
            resp.contains("invalid_api_key"),
            "401 应给出可读的错误码，实际: {resp}"
        );
        assert!(
            up_rx.recv_timeout(StdDuration::from_millis(400)).is_err(),
            "未授权请求不应被转发到上游引擎"
        );

        // ② 凭据错误 → 依然 401
        let (up_port, up_rx) = spawn_mock_upstream();
        let mut client = open_gateway_conn(up_port);
        client
            .write_all(chat_request(Some(BAD_KEY)).as_bytes())
            .expect("write request");
        let resp = read_all(&mut client);
        assert!(resp.starts_with("HTTP/1.1 401"), "错误 key 应返回 401，实际: {resp}");
        assert!(
            up_rx.recv_timeout(StdDuration::from_millis(400)).is_err(),
            "凭据错误的请求不应被转发到上游引擎"
        );

        // ③ 凭据正确 → 原样透传响应，且请求体完整送达、凭据头不外泄
        let (up_port, up_rx) = spawn_mock_upstream();
        let mut client = open_gateway_conn(up_port);
        client
            .write_all(chat_request(Some(GOOD_KEY)).as_bytes())
            .expect("write request");
        let resp = read_all(&mut client);

        assert!(
            resp.starts_with("HTTP/1.1 200 OK"),
            "正确 key 应透传上游响应，实际: {resp}"
        );
        assert!(
            resp.contains("data: {\"choices\""),
            "SSE 响应体应逐字节透传，实际: {resp}"
        );

        let upstream_head = up_rx
            .recv_timeout(StdDuration::from_secs(3))
            .expect("上游应收到请求");
        assert!(
            upstream_head.contains("POST /v1/chat/completions HTTP/1.1"),
            "请求行应原样转发，实际: {upstream_head}"
        );
        assert!(
            upstream_head.contains("[BODY_OK=true]"),
            "请求体应完整转发，实际: {upstream_head}"
        );
        assert!(
            !upstream_head.to_ascii_lowercase().contains("authorization"),
            "apiKey 绝不能透传到上游，实际: {upstream_head}"
        );
        assert!(
            upstream_head.contains("Host: 127.0.0.1:"),
            "Host 应改写为上游地址，实际: {upstream_head}"
        );
    }

    #[test]
    fn credential_can_be_sent_via_x_api_key_header() {
        set_api_key(GOOD_KEY);
        let (up_port, up_rx) = spawn_mock_upstream();
        let mut client = open_gateway_conn(up_port);

        let req = format!(
            "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:11435\r\nx-api-key: {}\r\nContent-Length: 2\r\n\r\n{{}}",
            GOOD_KEY
        );
        client.write_all(req.as_bytes()).expect("write request");
        let resp = read_all(&mut client);

        assert!(
            resp.starts_with("HTTP/1.1 200 OK"),
            "x-api-key 也应被接受，实际: {resp}"
        );
        let upstream_head = up_rx
            .recv_timeout(StdDuration::from_secs(3))
            .expect("上游应收到请求");
        assert!(
            !upstream_head.to_ascii_lowercase().contains("x-api-key"),
            "凭据头绝不能透传到上游，实际: {upstream_head}"
        );
    }
}
