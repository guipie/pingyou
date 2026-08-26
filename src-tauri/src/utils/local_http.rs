//! 本地 HTTP 调试/回调服务。
//!
//! Tauri 开发模式下 deep-link 协议（pingyou://）不会注册到系统，浏览器无法唤起。
//! 因此在应用启动时用 `127.0.0.1:14201` 起一个最小 HTTP 服务，提供：
//!   * `GET /ping`             → 200 "pong"，供 Web 端探测应用是否已启动
//!   * `GET /import-model?id=xxx&src=xxx`  → 200，内部 emit `deep-link-url` 事件走
//!                                            现有的 download_and_extract_model 流程
//!
//! 完全使用 std::net 手写 HTTP/1.1 解析，避免引入新依赖。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

const PORT: u16 = 14201;
const BIND_ADDR: &str = "127.0.0.1";

/// 允许的 CORS Origin 白名单。任意命中一个就回对应的 Access-Control-Allow-Origin。
fn cors_origin(req_origin: &str) -> String {
    let allow_list = [
        "https://py.lm56.top",
        "https://www.py.lm56.top",
        "http://localhost:4000",
        "http://localhost:4001",
        "http://127.0.0.1:4000",
        "http://127.0.0.1:4001",
    ];
    // 如果是浏览器直接请求会带 Origin；如果直接 fetch，未匹配的就回 *（但带 credentials 时不能 *）
    for allowed in allow_list {
        if req_origin == allowed {
            return allowed.to_string();
        }
    }
    // 兜底：回请求的 origin 本身（方便本地调试）
    if req_origin.starts_with("http://") || req_origin.starts_with("https://") {
        return req_origin.to_string();
    }
    "*".to_string()
}

/// 从 querystring 里取某个 key 的值（非解码版，id 是数字够用了）
fn qs_get<'a>(qs: &'a str, key: &str) -> Option<&'a str> {
    for part in qs.split('&') {
        if let Some((k, v)) = part.split_once('=') {
            if k == key {
                return Some(v);
            }
        }
    }
    None
}

/// 读取一个 HTTP 请求的「首行 + Header」，不读 body。
struct HttpRequest {
    method: String,
    path: String, // 包含 querystring，如 /import-model?id=1
    origin: String,
}
fn read_request<R: BufRead>(reader: &mut R) -> Option<HttpRequest> {
    let mut first_line = String::new();
    if reader.read_line(&mut first_line).ok()? == 0 {
        return None;
    }
    let mut parts = first_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut origin = String::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) if n <= 2 => break, // \r\n / \n 空行 → header 结束
            Ok(_) => {
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("origin:") {
                    origin = line["origin:".len()..].trim().to_string();
                }
            }
            Err(_) => break,
        }
    }
    Some(HttpRequest {
        method,
        path,
        origin,
    })
}

fn write_response(stream: &mut TcpStream, status: u16, status_text: &str, cors: &str, body: &str) {
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         Access-Control-Allow-Origin: {cors}\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         \r\n",
        status = status,
        status_text = status_text,
        len = body.len(),
        cors = cors,
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn handle_conn(mut stream: TcpStream, app: AppHandle) {
    // 设置读取超时，防止客户端挂起连接占线程
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let peer_ip = stream.peer_addr().map(|a| a.ip()).ok();
    // 只允许本机回环访问（安全锁）
    if let Some(ip) = peer_ip {
        if !ip.is_loopback() {
            // 非本机直接 close，不写响应，避免反射探测
            return;
        }
    }

    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let req = match read_request(&mut reader) {
        Some(r) => r,
        None => return,
    };

    let cors = cors_origin(&req.origin);

    // 1) OPTIONS 预检
    if req.method.eq_ignore_ascii_case("OPTIONS") {
        write_response(&mut stream, 204, "No Content", &cors, "");
        return;
    }

    let (route, qs) = match req.path.split_once('?') {
        Some((p, q)) => (p, q.to_string()),
        None => (req.path.as_str(), String::new()),
    };

    // 2) GET /ping → 探测是否已启动
    if req.method.eq_ignore_ascii_case("GET") && route == "/ping" {
        write_response(
            &mut stream,
            200,
            "OK",
            &cors,
            r#"{"ok":true,"app":"pingyou"}"#,
        );
        return;
    }

    // 3) GET /import-model?id=xxx[&src=web]
    if req.method.eq_ignore_ascii_case("GET") && route == "/import-model" {
        let Some(id) = qs_get(&qs, "id") else {
            write_response(
                &mut stream,
                400,
                "Bad Request",
                &cors,
                r#"{"ok":false,"error":"id required"}"#,
            );
            return;
        };
        // 通过 emit 复用前端 deep-link-url handler（和 pingyou:// 触发的是同一套逻辑）
        let url = format!("pingyou://import-model?id={}&src=http", id);
        let _ = app.emit("deep-link-url", url.clone());
        // 同时把偏好设置窗口前置，给用户反馈
        let _ = app
            .get_webview_window("preference")
            .and_then(|w| w.show().ok().and_then(|_| w.set_focus().ok()));
        write_response(
            &mut stream,
            200,
            "OK",
            &cors,
            &format!(r#"{{"ok":true,"id":{}}}"#, id),
        );
        return;
    }

    // 404
    write_response(
        &mut stream,
        404,
        "Not Found",
        &cors,
        r#"{"ok":false,"error":"not found"}"#,
    );
}

/// 后台线程启动本地 HTTP 服务。端口被占用时静默失败（不影响应用）。
#[allow(dead_code)]
pub const PORT_NUM: u16 = PORT;
pub fn spawn_local_http_server(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let addr = format!("{}:{}", BIND_ADDR, PORT);
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                eprintln!(
                    "[local-http] bind {} failed ({}): {}，请检查端口是否被占用",
                    addr, PORT, e
                );
                return;
            }
        };
        eprintln!("[local-http] listening on http://{}", addr);

        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    let app = handle.clone();
                    thread::spawn(move || handle_conn(s, app));
                }
                Err(e) => eprintln!("[local-http] accept error: {}", e),
            }
        }
    });
}
