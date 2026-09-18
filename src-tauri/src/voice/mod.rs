//! Rust 原生语音输入：cpal 采集 → sherpa-onnx 流式识别 → 事件回传前端。
//!
//! 事件约定：
//! - `voice-state`  `{ listening: bool }` 监听开始/结束
//! - `voice-partial` `string` 实时中间结果（边说边上屏）
//! - `voice-final`   `string` 一句话结束（endpoint 判定）或停止时的最终结果
//! - `voice-level`   `number` 0~1 的麦克风音量（约 25Hz，供前端画音量动画）
//! - `voice-error`   `string` 任何环节的失败原因
//! - `voice-model-progress` 模型下载进度（见 model.rs）

pub mod model;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use sherpa_onnx::{
    LinearResampler, OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig,
    OnlineTransducerModelConfig,
};
use tauri::{AppHandle, Emitter, State};

/// 全局语音会话状态：同一时刻至多一个监听会话。
#[derive(Default)]
pub struct VoiceState {
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct VoiceStateEvent {
    listening: bool,
}

#[tauri::command]
pub fn voice_start(app: AppHandle, state: State<VoiceState>) -> Result<(), String> {
    // swap 保证并发点击时只有第一个请求生效
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    state.stop.store(false, Ordering::SeqCst);

    let stop = state.stop.clone();
    let running = state.running.clone();
    tauri::async_runtime::spawn(async move {
        // 无论成功失败，最终都要复位 running 并广播停止状态
        if let Err(e) = run_session(&app, &stop).await {
            let _ = app.emit("voice-error", e);
        }
        running.store(false, Ordering::SeqCst);
        let _ = app.emit("voice-state", VoiceStateEvent { listening: false });
    });
    Ok(())
}

#[tauri::command]
pub fn voice_stop(state: State<VoiceState>) {
    state.stop.store(true, Ordering::SeqCst);
}

async fn run_session(app: &AppHandle, stop: &Arc<AtomicBool>) -> Result<(), String> {
    // 模型缺失时先下载（进度走 voice-model-progress 事件）
    model::ensure_model(app).await?;
    // 下载/初始化期间用户可能已经点了停止：直接放弃，连麦都不要开
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }

    let app = app.clone();
    let stop = stop.clone();
    tauri::async_runtime::spawn_blocking(move || blocking_session(app, stop))
        .await
        .map_err(|e| format!("语音会话线程异常: {e}"))?
}

/// 采集 + 解码主循环，运行在独立阻塞线程里，直到收到停止信号。
fn blocking_session(app: AppHandle, stop: Arc<AtomicBool>) -> Result<(), String> {
    let dir = model::model_dir(&app)?;
    let recognizer = OnlineRecognizer::create(&OnlineRecognizerConfig {
        model_config: OnlineModelConfig {
            transducer: OnlineTransducerModelConfig {
                encoder: Some(file_path(&dir, "encoder-epoch-99-avg-1.int8.onnx")),
                decoder: Some(file_path(&dir, "decoder-epoch-99-avg-1.int8.onnx")),
                joiner: Some(file_path(&dir, "joiner-epoch-99-avg-1.int8.onnx")),
            },
            tokens: Some(file_path(&dir, "tokens.txt")),
            num_threads: 2,
            ..Default::default()
        },
        decoding_method: Some("greedy_search".into()),
        enable_endpoint: true,
        // rule2 = 说话后静音 1 秒即认为一句话结束，触发 voice-final 并继续下一段
        rule1_min_trailing_silence: 2.4,
        rule2_min_trailing_silence: 1.0,
        rule3_min_utterance_length: 20.0,
        ..Default::default()
    })
    .ok_or("语音识别引擎初始化失败（模型文件可能不完整，请删除 voice-models 目录后重试）")?;

    let stream = recognizer.create_stream();

    // ---- 麦克风采集（设备原生格式 → 单声道 f32 缓冲） ----
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("未找到麦克风设备")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("读取麦克风配置失败: {e}"))?;
    let src_rate = config.sample_rate();
    let channels = config.channels().max(1) as usize;
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let err_fn = |e| log::warn!("麦克风数据流错误: {e}");
    let input_stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let buf = buffer.clone();
            device.build_input_stream(
                config.config(),
                move |data: &[f32], _| push_mono(&mut lock(&buf), data, channels, f32::from),
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let buf = buffer.clone();
            device.build_input_stream(
                config.config(),
                move |data: &[i16], _| push_mono(&mut lock(&buf), data, channels, |s| s as f32 / 32768.0),
                err_fn,
                None,
            )
        }
        other => return Err(format!("不支持的麦克风采样格式: {other:?}")),
    }
    .map_err(|e| format!("打开麦克风失败: {e}"))?;
    input_stream
        .play()
        .map_err(|e| format!("启动麦克风失败: {e}"))?;

    let _ = app.emit("voice-state", VoiceStateEvent { listening: true });

    // ---- 解码循环：缓冲 → 重采样 16k → 流式解码 → 事件回传 ----
    let resampler =
        LinearResampler::create(src_rate as i32, 16000).ok_or("音频重采样器初始化失败")?;
    let mut last_partial = String::new();
    // 音量平滑值：留一点衰减惯性，动画才不会一帧一跳
    let mut level = 0.0f32;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));

        let raw = {
            let mut guard = lock(&buffer);
            std::mem::take(&mut *guard)
        };

        // 先推音量（静音时也推，前端动画才会自然回落）
        let instant = audio_level(&raw);
        level = if instant > level {
            instant
        } else {
            level * 0.7 + instant * 0.3
        };
        let _ = app.emit("voice-level", level);

        if raw.is_empty() {
            continue;
        }
        let chunk = resampler.resample(&raw, false);
        if chunk.is_empty() {
            continue;
        }

        stream.accept_waveform(16000, &chunk);
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
        let Some(result) = recognizer.get_result(&stream) else {
            continue;
        };
        if result.text != last_partial {
            last_partial = result.text.clone();
            let _ = app.emit("voice-partial", last_partial.clone());
        }
        if recognizer.is_endpoint(&stream) {
            if !last_partial.is_empty() {
                let _ = app.emit("voice-final", last_partial.clone());
            }
            last_partial.clear();
            recognizer.reset(&stream);
        }
    }

    // 停止：冲刷尾部上下文，把剩余内容作为最终结果发出
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    if let Some(result) = recognizer.get_result(&stream) {
        if !result.text.is_empty() {
            let _ = app.emit("voice-final", result.text);
        }
    }
    drop(input_stream);
    Ok(())
}

/// 多声道取平均折叠为单声道，采样值经 `convert` 统一为 f32。
fn push_mono<T: Copy>(
    buffer: &mut Vec<f32>,
    data: &[T],
    channels: usize,
    convert: impl Fn(T) -> f32,
) {
    let step = channels.max(1);
    let mut i = 0;
    while i + step <= data.len() {
        let sum: f32 = data[i..i + step].iter().map(|s| convert(*s)).sum();
        buffer.push(sum / step as f32);
        i += step;
    }
}

/// 把一段 PCM 折算成 0~1 的音量，供前端画音量动画。
///
/// 用 RMS 转 dBFS 再做区间映射（而不是直接线性用 RMS）：人耳对音量是对数感知，
/// 线性 RMS 下正常说话只有 0.05 左右，动画几乎不动。
fn audio_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    // -60dB 视为静音，-15dB 及以上视为满格
    let db = 20.0 * rms.max(1e-6).log10();
    ((db + 60.0) / 45.0).clamp(0.0, 1.0)
}

/// 锁中毒时直接取内部数据继续跑（采集回调里宁可降级也不中断）。
fn lock(buffer: &Arc<Mutex<Vec<f32>>>) -> MutexGuard<'_, Vec<f32>> {
    match buffer.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn file_path(dir: &std::path::Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}
