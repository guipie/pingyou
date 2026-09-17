//! WebView2 麦克风权限放行（仅 Windows 生效，其它平台为空实现）。
//!
//! 背景：wry 挂的 `PermissionRequested` 处理器只放行剪贴板读取，其余权限
//! （含麦克风）走 WebView2 的默认行为——静默拒绝。这会让 Web Speech API
//! （`webkitSpeechRecognition`）在 `start()` 的瞬间收到 `not-allowed`，
//! 语音输入完全不可用。
//!
//! 做法：给每个 webview 追加一个事件处理器，仅对 `MICROPHONE` 种类的请求
//! `SetState(ALLOW)`，其余权限种类不处理（维持默认拒绝），不扩大权限面。
//! WebView2 对未处理过的请求不会把"拒绝"持久化进 profile，因此挂上处理器
//! 后无需再清历史记录，下一次 `start()` 即生效。

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
  COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
  COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};

#[cfg(windows)]
pub fn allow_microphone(window: &tauri::WebviewWindow) {
  // with_webview 会把闭包调度到主线程执行；窗口创建时即挂载，
  // 保证用户第一次点击麦克风前监听已就位。
  let _ = window.with_webview(move |webview| unsafe {
    let Ok(core) = webview.controller().CoreWebView2() else {
      log::warn!("挂载麦克风权限处理器失败：拿不到 CoreWebView2");
      return;
    };

    let mut token = 0i64;
    if let Err(err) = core.add_PermissionRequested(
      &webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };

        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        args.PermissionKind(&mut kind)?;
        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
          args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
        }

        Ok(())
      })),
      &mut token,
    ) {
      log::warn!("挂载麦克风权限处理器失败：{err}");
    }
  });
}

#[cfg(not(windows))]
pub fn allow_microphone(_window: &tauri::WebviewWindow) {}
