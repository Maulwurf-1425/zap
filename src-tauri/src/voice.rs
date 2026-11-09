//! Voice: dictation with Whisper (whisper.cpp) and reading aloud with Piper,
//! both local. Programs, models and voices are downloaded on first use from
//! pinned URLs and checked against pinned SHA-256 hashes before use.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::{self, PlayQueue, Recording, Resampler};
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

struct Asset {
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// Path below the voice folder (a folder for zips).
    dest: &'static str,
    zip: bool,
}

const WHISPER_BIN: Asset = Asset {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip",
    sha256: "b1158bd10edf92c9799149a6fc5d3e58da3f495241d6fb3423088130e88ffbf3",
    size: 21_715_607,
    dest: "whisper",
    zip: true,
};
const WHISPER_EXE: &str = "whisper/Release/whisper-cli.exe";

const PIPER_BIN: Asset = Asset {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    size: 22_477_236,
    dest: "piper",
    zip: true,
};
const PIPER_EXE: &str = "piper/piper/piper.exe";

struct Model {
    id: &'static str,
    asset: Asset,
}

const MODELS: [Model; 2] = [
    Model {
        id: "base",
        asset: Asset {
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
            sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
            size: 147_951_465,
            dest: "models/ggml-base.bin",
            zip: false,
        },
    },
    Model {
        id: "small",
        asset: Asset {
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
            size: 487_601_967,
            dest: "models/ggml-small.bin",
            zip: false,
        },
    },
];

pub struct Voice {
    pub id: &'static str,
    pub name: &'static str,
    /// "de" | "en"
    pub lang: &'static str,
    /// "female" | "male"
    pub gender: &'static str,
    path: &'static str,
    onnx_sha: &'static str,
    json_sha: &'static str,
    onnx_size: u64,
}

const VOICE_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/";

pub const VOICES: [Voice; 7] = [
    Voice {
        id: "de_DE-thorsten-medium",
        name: "Thorsten",
        lang: "de",
        gender: "male",
        path: "de/de_DE/thorsten/medium/",
        onnx_sha: "7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819",
        json_sha: "974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85",
        onnx_size: 63_201_294,
    },
    Voice {
        id: "de_DE-kerstin-low",
        name: "Kerstin",
        lang: "de",
        gender: "female",
        path: "de/de_DE/kerstin/low/",
        onnx_sha: "d352a7641892cebf2903859af94e9ba81a141110215fe3943bcda7f7da401b7a",
        json_sha: "56e708556b7b9b7a53c4f8957e021421e69f11a600962bba554cffbe72cf2d47",
        onnx_size: 63_104_526,
    },
    Voice {
        id: "de_DE-ramona-low",
        name: "Ramona",
        lang: "de",
        gender: "female",
        path: "de/de_DE/ramona/low/",
        onnx_sha: "a1068592532aad8c49bf3d1a01b8749c11d7dba726689ee28ad64e7b627ae4c5",
        json_sha: "64906ab7a050ac685fa3dcea044baa798f67ed77be164f9c668a69298c6487d2",
        onnx_size: 63_104_526,
    },
    Voice {
        id: "en_US-amy-medium",
        name: "Amy",
        lang: "en",
        gender: "female",
        path: "en/en_US/amy/medium/",
        onnx_sha: "b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18",
        json_sha: "95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77",
        onnx_size: 63_201_294,
    },
    Voice {
        id: "en_US-lessac-medium",
        name: "Lessac",
        lang: "en",
        gender: "female",
        path: "en/en_US/lessac/medium/",
        onnx_sha: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
        json_sha: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
        onnx_size: 63_201_294,
    },
    Voice {
        id: "en_US-ryan-medium",
        name: "Ryan",
        lang: "en",
        gender: "male",
        path: "en/en_US/ryan/medium/",
        onnx_sha: "abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a",
        json_sha: "44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d",
        onnx_size: 63_201_294,
    },
    Voice {
        id: "en_GB-alba-medium",
        name: "Alba",
        lang: "en",
        gender: "female",
        path: "en/en_GB/alba/medium/",
        onnx_sha: "401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b",
        json_sha: "aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4",
        onnx_size: 63_201_294,
    },
];

fn voice(id: &str) -> AppResult<&'static Voice> {
    VOICES
        .iter()
        .find(|v| v.id == id)
        .ok_or_else(|| AppError::Other("unknown voice".into()))
}

fn model(id: &str) -> AppResult<&'static Model> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::Other("unknown model".into()))
}

// ---------------------------------------------------------------------------
// State and paths
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct VoiceState {
    recording: Mutex<Option<Recording>>,
    speaker: Mutex<Option<Speaker>>,
    installing: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn root(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().data_dir.join("voice")
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    }
    cmd
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct DownloadEvent<'a> {
    /// What is being installed, e.g. "dictation:base" or "voice:<id>".
    item: &'a str,
    /// The file being downloaded: "whisper", "model", "piper", "voice".
    part: &'a str,
    downloaded: u64,
    total: u64,
}

/// Downloads `url` to `dest`, checking size and SHA-256 before the file is
/// moved into place. Reports progress about every 250 ms.
async fn download(
    app: &AppHandle,
    url: &str,
    sha256: &str,
    total: u64,
    dest: &Path,
    item: &str,
    part: &str,
) -> AppResult<()> {
    let client = &app.state::<AppState>().web;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|_| AppError::Other("download_failed".into()))?
        .error_for_status()
        .map_err(|_| AppError::Other("download_failed".into()))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part_path = dest.with_extension("part");
    let mut file = std::fs::File::create(&part_path)?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut last = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    let emit = |done: u64| {
        let _ = app.emit(
            "voice://download",
            DownloadEvent {
                item,
                part,
                downloaded: done,
                total,
            },
        );
    };
    emit(0);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| AppError::Other("download_failed".into()))?;
        hasher.update(&chunk);
        file.write_all(&chunk)?;
        done += chunk.len() as u64;
        if last.elapsed().as_millis() >= 250 {
            emit(done);
            last = std::time::Instant::now();
        }
    }
    file.flush()?;
    drop(file);
    emit(done);
    let hash = format!("{:x}", hasher.finalize());
    if hash != sha256 {
        let _ = std::fs::remove_file(&part_path);
        return Err(AppError::Other("checksum_mismatch".into()));
    }
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&part_path, dest)?;
    Ok(())
}

fn unzip(archive: &Path, dir: &Path) -> AppResult<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|_| AppError::Other("download_failed".into()))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|_| AppError::Other("download_failed".into()))?;
        // enclosed_name rejects absolute paths and "..".
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = dir.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        std::fs::write(&out, buf)?;
    }
    Ok(())
}

async fn install_asset(app: &AppHandle, asset: &Asset, item: &str, part: &str) -> AppResult<()> {
    let root = root(app);
    let dest = root.join(asset.dest);
    if !asset.zip {
        return download(app, asset.url, asset.sha256, asset.size, &dest, item, part).await;
    }
    let archive = root.join(format!("{}.zip", asset.dest));
    download(
        app,
        asset.url,
        asset.sha256,
        asset.size,
        &archive,
        item,
        part,
    )
    .await?;
    let _ = std::fs::remove_dir_all(&dest);
    let result = unzip(&archive, &dest);
    let _ = std::fs::remove_file(&archive);
    result
}

fn whisper_ready(root: &Path) -> bool {
    root.join(WHISPER_EXE).is_file()
}

fn piper_ready(root: &Path) -> bool {
    root.join(PIPER_EXE).is_file()
}

fn model_path(root: &Path, m: &Model) -> PathBuf {
    root.join(m.asset.dest)
}

fn voice_paths(root: &Path, v: &Voice) -> (PathBuf, PathBuf) {
    let dir = root.join("voices");
    (
        dir.join(format!("{}.onnx", v.id)),
        dir.join(format!("{}.onnx.json", v.id)),
    )
}

fn voice_ready(root: &Path, v: &Voice) -> bool {
    let (onnx, json) = voice_paths(root, v);
    onnx.is_file() && json.is_file()
}

// ---------------------------------------------------------------------------
// Status, install, remove
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ModelStatus {
    id: &'static str,
    size: u64,
    installed: bool,
}

#[derive(Serialize)]
pub struct VoiceStatus {
    id: &'static str,
    name: &'static str,
    lang: &'static str,
    gender: &'static str,
    size: u64,
    installed: bool,
}

#[derive(Serialize)]
pub struct Status {
    whisper: bool,
    whisper_size: u64,
    piper: bool,
    piper_size: u64,
    models: Vec<ModelStatus>,
    voices: Vec<VoiceStatus>,
    microphones: Vec<audio::InputDevice>,
}

#[tauri::command]
pub async fn voice_status(app: AppHandle) -> Status {
    let root = root(&app);
    let microphones = tauri::async_runtime::spawn_blocking(audio::input_devices)
        .await
        .unwrap_or_default();
    Status {
        whisper: whisper_ready(&root),
        whisper_size: WHISPER_BIN.size,
        piper: piper_ready(&root),
        piper_size: PIPER_BIN.size,
        models: MODELS
            .iter()
            .map(|m| ModelStatus {
                id: m.id,
                size: m.asset.size,
                installed: model_path(&root, m).is_file(),
            })
            .collect(),
        voices: VOICES
            .iter()
            .map(|v| VoiceStatus {
                id: v.id,
                name: v.name,
                lang: v.lang,
                gender: v.gender,
                size: v.onnx_size,
                installed: voice_ready(&root, v),
            })
            .collect(),
        microphones,
    }
}

/// Installs what an item needs: "dictation:<model>" (Whisper + model) or
/// "voice:<id>" (Piper + voice). Already present files are skipped.
#[tauri::command]
pub async fn voice_install(
    app: AppHandle,
    voice_state: State<'_, VoiceState>,
    item: String,
) -> AppResult<()> {
    if voice_state.installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::Other("busy".into()));
    }
    let result = install_item(&app, &item).await;
    voice_state.installing.store(false, Ordering::SeqCst);
    result
}

async fn install_item(app: &AppHandle, item: &str) -> AppResult<()> {
    let root = root(app);
    if let Some(id) = item.strip_prefix("dictation:") {
        let m = model(id)?;
        if !whisper_ready(&root) {
            install_asset(app, &WHISPER_BIN, item, "whisper").await?;
        }
        if !model_path(&root, m).is_file() {
            install_asset(app, &m.asset, item, "model").await?;
        }
        return Ok(());
    }
    if let Some(id) = item.strip_prefix("voice:") {
        let v = voice(id)?;
        if !piper_ready(&root) {
            install_asset(app, &PIPER_BIN, item, "piper").await?;
        }
        let (onnx, json) = voice_paths(&root, v);
        if !json.is_file() {
            let url = format!("{VOICE_BASE}{}{}.onnx.json", v.path, v.id);
            download(app, &url, v.json_sha, 0, &json, item, "voice").await?;
        }
        if !onnx.is_file() {
            let url = format!("{VOICE_BASE}{}{}.onnx", v.path, v.id);
            download(app, &url, v.onnx_sha, v.onnx_size, &onnx, item, "voice").await?;
        }
        return Ok(());
    }
    Err(AppError::Other("unknown item".into()))
}

/// Deletes a model ("dictation:<model>") or voice ("voice:<id>").
#[tauri::command]
pub fn voice_remove(app: AppHandle, item: String) -> AppResult<()> {
    let root = root(&app);
    if let Some(id) = item.strip_prefix("dictation:") {
        let _ = std::fs::remove_file(model_path(&root, model(id)?));
    } else if let Some(id) = item.strip_prefix("voice:") {
        let (onnx, json) = voice_paths(&root, voice(id)?);
        let _ = std::fs::remove_file(onnx);
        let _ = std::fs::remove_file(json);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct LevelEvent {
    level: f32,
}

/// Recordings whose loudest sample stays below this contain no speech
/// (room noise peaks around 0.003, speech well above 0.05).
const SPEECH_PEAK: f32 = 0.015;

#[tauri::command]
pub async fn record_start(app: AppHandle, voice_state: State<'_, VoiceState>) -> AppResult<()> {
    let device = db::get_settings(&app.state::<AppState>().db())
        .ok()
        .and_then(|s| s.mic_device);
    let emitter = app.clone();
    let recording = tauri::async_runtime::spawn_blocking(move || {
        Recording::start(device.as_deref(), move |level| {
            let _ = emitter.emit("voice://level", LevelEvent { level });
        })
    })
    .await
    .map_err(|_| AppError::Other("microphone_failed".into()))?
    .map_err(AppError::Other)?;
    *lock(&voice_state.recording) = Some(recording);
    Ok(())
}

#[tauri::command]
pub fn record_cancel(voice_state: State<'_, VoiceState>) {
    if let Some(r) = lock(&voice_state.recording).take() {
        drop(r.finish());
    }
}

/// Stops recording and transcribes it with Whisper. Returns the text.
#[tauri::command]
pub async fn record_stop(app: AppHandle, voice_state: State<'_, VoiceState>) -> AppResult<String> {
    let recording = lock(&voice_state.recording)
        .take()
        .ok_or_else(|| AppError::Other("not_recording".into()))?;
    let samples = tauri::async_runtime::spawn_blocking(move || recording.finish())
        .await
        .unwrap_or_default();
    // Under half a second is a mis-click, not speech.
    if samples.len() < audio::WHISPER_RATE as usize / 2 {
        return Ok(String::new());
    }
    let loudest = audio::peak(&samples);
    // Exactly zero: the device sends no signal at all (muted, unplugged or
    // blocked), so another microphone is probably the right one.
    if loudest == 0.0 {
        return Err(AppError::Other("mic_silent".into()));
    }
    // Too quiet for speech: Whisper would invent words like "you".
    if loudest < SPEECH_PEAK {
        return Ok(String::new());
    }
    let settings = db::get_settings(&app.state::<AppState>().db()).unwrap_or_default();
    let root = root(&app);
    let m = model(&settings.voice_model).unwrap_or(&MODELS[0]);
    let model_file = model_path(&root, m);
    if !whisper_ready(&root) || !model_file.is_file() {
        return Err(AppError::Other("not_installed".into()));
    }
    let wav = root.join("recording.wav");
    audio::write_wav(&wav, &samples).map_err(AppError::Other)?;
    let exe = root.join(WHISPER_EXE);
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get().min(8))
        .to_string();
    let language = settings.voice_language.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        hidden(
            Command::new(&exe)
                .args(["-m"])
                .arg(&model_file)
                .arg("-f")
                .arg(&wav)
                .args(["-l", &language, "-t", &threads, "-nt", "-np"])
                .stdin(Stdio::null())
                .stderr(Stdio::null()),
        )
        .output()
    })
    .await
    .map_err(|_| AppError::Other("transcribe_failed".into()))?
    .map_err(|_| AppError::Other("transcribe_failed".into()))?;
    let _ = std::fs::remove_file(root.join("recording.wav"));
    if !output.status.success() {
        return Err(AppError::Other("transcribe_failed".into()));
    }
    Ok(clean_transcript(&String::from_utf8_lossy(&output.stdout)))
}

/// Joins Whisper's lines and drops its markers like "[BLANK_AUDIO]" or "(music)".
pub fn clean_transcript(raw: &str) -> String {
    let mut text = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    for (open, close) in [('[', ']'), ('(', ')'), ('*', '*')] {
        while let Some(start) = text.find(open) {
            let Some(len) = text[start + 1..].find(close) else {
                break;
            };
            let inner = &text[start + 1..start + 1 + len];
            // Only remove all-caps/short sound markers, keep normal brackets.
            if inner.len() <= 24 && !inner.contains(' ')
                || inner
                    .chars()
                    .all(|c| c.is_uppercase() || c == '_' || c == ' ')
            {
                text.replace_range(start..start + len + 2, "");
            } else {
                break;
            }
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Reading aloud
// ---------------------------------------------------------------------------

struct Speaker {
    id: String,
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    queue: Arc<PlayQueue>,
}

#[derive(Clone, Serialize)]
struct SpeakingEvent {
    id: String,
    active: bool,
    error: Option<String>,
}

fn voice_rate(json: &Path) -> u32 {
    std::fs::read_to_string(json)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["audio"]["sample_rate"].as_u64())
        .map_or(22_050, |r| r as u32)
}

fn stop_speaker(voice_state: &VoiceState) {
    if let Some(mut s) = lock(&voice_state.speaker).take() {
        s.queue.stop();
        drop(s.stdin.take());
        let _ = s.child.kill();
    }
}

/// Starts a reading session `id` with a voice. Text follows with
/// `speak_push`; `speak_end` says no more text comes. Emits
/// `voice://speaking` when it starts and ends.
#[tauri::command]
pub fn speak_start(
    app: AppHandle,
    voice_state: State<'_, VoiceState>,
    id: String,
    voice_id: String,
) -> AppResult<()> {
    stop_speaker(&voice_state);
    let root = root(&app);
    let v = voice(&voice_id)?;
    if !piper_ready(&root) || !voice_ready(&root, v) {
        return Err(AppError::Other("not_installed".into()));
    }
    let (onnx, json) = voice_paths(&root, v);
    let rate = db::get_settings(&app.state::<AppState>().db())
        .map(|s| s.speech_rate)
        .unwrap_or(1.0)
        .clamp(0.5, 2.0);
    let mut child = hidden(
        Command::new(root.join(PIPER_EXE))
            .arg("--model")
            .arg(&onnx)
            .args([
                "--output_raw",
                "--quiet",
                "--sentence_silence",
                "0.25",
                "--length_scale",
                &format!("{:.3}", 1.0 / rate),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .spawn()
    .map_err(|_| AppError::Other("speak_failed".into()))?;
    let stdout = child.stdout.take();
    let stdin = child.stdin.take();
    let queue = Arc::new(PlayQueue::default());
    let voice_rate = voice_rate(&json);

    // Reader + player thread: piper's raw 16-bit mono PCM → speaker.
    {
        let queue = queue.clone();
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let (rate_tx, rate_rx) = std::sync::mpsc::channel();
            let player = {
                let queue = queue.clone();
                std::thread::spawn(move || audio::play(queue, rate_tx))
            };
            let _ = app.emit(
                "voice://speaking",
                SpeakingEvent {
                    id: id.clone(),
                    active: true,
                    error: None,
                },
            );
            if let (Some(mut out), Ok(device_rate)) = (stdout, rate_rx.recv()) {
                let mut resampler = Resampler::new(voice_rate, device_rate);
                let mut buf = [0u8; 8192];
                let mut carry: Option<u8> = None;
                let mut chunk = Vec::new();
                let mut converted = Vec::new();
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 || queue.stopped() {
                        break;
                    }
                    let mut bytes: Vec<u8> = carry.take().into_iter().collect();
                    bytes.extend_from_slice(&buf[..n]);
                    if bytes.len() % 2 == 1 {
                        carry = bytes.pop();
                    }
                    chunk.clear();
                    chunk.extend(
                        bytes
                            .chunks_exact(2)
                            .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0),
                    );
                    converted.clear();
                    resampler.process(&chunk, &mut converted);
                    queue.push(&converted);
                }
            }
            queue.close();
            let error = match player.join() {
                Ok(Err(e)) => Some(e),
                _ => None,
            };
            let _ = app.emit(
                "voice://speaking",
                SpeakingEvent {
                    id,
                    active: false,
                    error,
                },
            );
        });
    }

    *lock(&voice_state.speaker) = Some(Speaker {
        id,
        child,
        stdin,
        queue,
    });
    Ok(())
}

/// Adds text to the current reading session (one sentence per line).
#[tauri::command]
pub fn speak_push(voice_state: State<'_, VoiceState>, id: String, text: String) -> AppResult<()> {
    let mut guard = lock(&voice_state.speaker);
    let Some(s) = guard.as_mut().filter(|s| s.id == id) else {
        return Ok(());
    };
    if let Some(stdin) = s.stdin.as_mut() {
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if writeln!(stdin, "{line}")
                .and_then(|()| stdin.flush())
                .is_err()
            {
                return Err(AppError::Other("speak_failed".into()));
            }
        }
    }
    Ok(())
}

/// No more text for this session; it ends once everything is spoken.
#[tauri::command]
pub fn speak_end(voice_state: State<'_, VoiceState>, id: String) {
    if let Some(s) = lock(&voice_state.speaker).as_mut().filter(|s| s.id == id) {
        drop(s.stdin.take());
    }
}

#[tauri::command]
pub fn speak_stop(voice_state: State<'_, VoiceState>) {
    stop_speaker(&voice_state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcripts_lose_whisper_markers() {
        assert_eq!(
            clean_transcript(" Hallo Welt.\n [BLANK_AUDIO]\n"),
            "Hallo Welt."
        );
        assert_eq!(
            clean_transcript("(Musik) Wie spät ist es?"),
            "Wie spät ist es?"
        );
        assert_eq!(
            clean_transcript("Ruf mich an (nach dem Essen) bitte."),
            "Ruf mich an (nach dem Essen) bitte."
        );
    }

    /// Real binaries: Piper streams raw audio line by line, ZAP resamples it
    /// to 16 kHz and writes a WAV, Whisper transcribes it back. Also opens the
    /// default microphone and plays silence on the default speaker.
    /// ZAP_VOICE_DIR must contain piperbin/piper/piper.exe, thorsten.onnx(.json),
    /// whisper/Release/whisper-cli.exe and ggml-base.bin.
    /// `ZAP_VOICE_DIR=… cargo test live_voice_roundtrip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_voice_roundtrip() {
        use std::time::Instant;
        let dir = PathBuf::from(std::env::var("ZAP_VOICE_DIR").expect("set ZAP_VOICE_DIR"));
        let rate = voice_rate(&dir.join("thorsten.onnx.json"));

        // 1. Piper: two lines in, audio for both out, first audio quickly.
        let started = Instant::now();
        let mut child = hidden(
            Command::new(dir.join("piperbin/piper/piper.exe"))
                .arg("--model")
                .arg(dir.join("thorsten.onnx"))
                .args(["--output_raw", "--quiet"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null()),
        )
        .spawn()
        .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, "Heute scheint in Berlin die Sonne.").unwrap();
        writeln!(stdin, "Morgen regnet es in Hamburg.").unwrap();
        drop(stdin);
        let mut out = child.stdout.take().unwrap();
        let mut first_audio = None;
        let mut raw = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = out.read(&mut buf) {
            if n == 0 {
                break;
            }
            first_audio.get_or_insert(started.elapsed());
            raw.extend_from_slice(&buf[..n]);
        }
        let _ = child.wait();
        let pcm: Vec<f32> = raw
            .chunks_exact(2)
            .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
            .collect();
        println!(
            "piper: first audio after {:?}, {:.1} s of speech at {rate} Hz",
            first_audio.unwrap(),
            pcm.len() as f32 / rate as f32
        );
        assert!(pcm.len() as f32 / rate as f32 > 2.0);

        // 2. ZAP's resampler + WAV writer → Whisper.
        let wav = dir.join("zap-roundtrip.wav");
        audio::write_wav(&wav, &audio::resample(&pcm, rate, audio::WHISPER_RATE)).unwrap();
        let t = Instant::now();
        let output = Command::new(dir.join("whisper/Release/whisper-cli.exe"))
            .arg("-m")
            .arg(dir.join("ggml-base.bin"))
            .arg("-f")
            .arg(&wav)
            .args(["-l", "auto", "-nt", "-np"])
            .stderr(Stdio::null())
            .output()
            .unwrap();
        let text = clean_transcript(&String::from_utf8_lossy(&output.stdout));
        println!("whisper ({:?}): {text}", t.elapsed());
        assert!(
            text.contains("Berlin") && text.contains("Hamburg"),
            "{text}"
        );

        // 3. Devices: record 1 s, play 0.5 s of silence.
        println!("microphones: {:?}", audio::input_devices());
        match Recording::start(None, |_| {}) {
            Ok(rec) => {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let samples = rec.finish();
                println!("recorded {} samples at 16 kHz", samples.len());
                assert!(samples.len() > 12_000);
            }
            Err(e) => println!("no microphone: {e}"),
        }
        let queue = Arc::new(PlayQueue::default());
        let (tx, rx) = std::sync::mpsc::channel();
        let q = queue.clone();
        let player = std::thread::spawn(move || audio::play(q, tx));
        let device_rate = rx.recv().unwrap();
        queue.push(&vec![0.0; device_rate as usize / 2]);
        queue.close();
        player.join().unwrap().unwrap();
        println!("speaker ok at {device_rate} Hz");
    }

    #[test]
    fn catalog_is_consistent() {
        for v in &VOICES {
            assert!(
                v.id.starts_with(if v.lang == "de" { "de_" } else { "en_" }),
                "{}",
                v.id
            );
            assert!(v.path.ends_with('/'));
            assert_eq!(v.onnx_sha.len(), 64);
            assert_eq!(v.json_sha.len(), 64);
        }
        for m in &MODELS {
            assert_eq!(m.asset.sha256.len(), 64);
        }
    }
}
