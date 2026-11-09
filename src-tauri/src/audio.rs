//! Microphone recording and speaker playback with cpal. Audio streams are not
//! `Send`, so each one lives on its own thread and is controlled via flags.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};

/// Whisper's input rate.
pub const WHISPER_RATE: u32 = 16_000;
/// Recording stops on its own after this long.
const MAX_RECORDING: Duration = Duration::from_secs(300);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InputDevice {
    /// Stable device id (survives restarts); stored in the settings.
    pub id: String,
    /// Display name; repeated names get " (2)", " (3)" …
    pub name: String,
    pub is_default: bool,
}

/// The microphones Windows offers.
pub fn input_devices() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());
    let mut out: Vec<InputDevice> = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            let (Ok(desc), Ok(id)) = (d.description(), d.id()) else {
                continue;
            };
            let base = desc.name().to_string();
            let same = out
                .iter()
                .filter(|o| o.name == base || o.name.starts_with(&format!("{base} (")))
                .count();
            let id = id.to_string();
            out.push(InputDevice {
                is_default: default.as_deref() == Some(id.as_str()),
                name: if same == 0 {
                    base
                } else {
                    format!("{base} ({})", same + 1)
                },
                id,
            });
        }
    }
    out
}

/// The device with this id (or, from older settings, this name), else the
/// Windows default.
fn find_input(wanted: Option<&str>) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if let Some(wanted) = wanted.filter(|w| !w.is_empty()) {
        let by_id = host.input_devices().ok().and_then(|mut devices| {
            devices.find(|d| d.id().is_ok_and(|id| id.to_string() == wanted))
        });
        let found = by_id.or_else(|| {
            host.input_devices().ok().and_then(|mut devices| {
                devices.find(|d| d.description().is_ok_and(|desc| desc.name() == wanted))
            })
        });
        if found.is_some() {
            return found;
        }
    }
    host.default_input_device()
}

/// Loudest absolute sample.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/// Linear resampler that keeps its position across chunks (no clicks at
/// chunk borders).
pub struct Resampler {
    step: f64,
    pos: f64,
    last: f32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self {
            step: f64::from(from) / f64::from(to),
            pos: 0.0,
            last: 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        // Index -1 is the last sample of the previous chunk.
        let at = |i: isize| if i < 0 { self.last } else { input[i as usize] };
        while self.pos < input.len() as f64 - 1.0
            || (self.pos < input.len() as f64 && input.len() == 1)
        {
            let i = self.pos.floor() as isize;
            let frac = (self.pos - i as f64) as f32;
            let a = at(i);
            let b = if (i + 1) < input.len() as isize {
                at(i + 1)
            } else {
                a
            };
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= input.len() as f64;
        if let Some(&l) = input.last() {
            self.last = l;
        }
    }
}

pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return input.to_vec();
    }
    let mut out = Vec::with_capacity(input.len() * to as usize / from.max(1) as usize + 1);
    Resampler::new(from, to).process(input, &mut out);
    out
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

pub struct Recording {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    thread: Option<JoinHandle<()>>,
}

impl Recording {
    /// Starts recording (mono). `on_level` gets the loudness (0–1) about ten
    /// times a second.
    pub fn start(
        device: Option<&str>,
        on_level: impl Fn(f32) + Send + 'static,
    ) -> Result<Self, String> {
        let device = find_input(device).ok_or("no_microphone")?;
        let config = device.default_input_config().map_err(|_| "no_microphone")?;
        let rate = config.sample_rate();
        let stop = Arc::new(AtomicBool::new(false));
        let samples = Arc::new(Mutex::new(Vec::new()));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        let thread = {
            let stop = stop.clone();
            let samples = samples.clone();
            std::thread::spawn(move || {
                let level = Arc::new(Mutex::new(0.0f32));
                let stream = match build_input(&device, &config, samples.clone(), level.clone()) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                if stream.play().is_err() {
                    let _ = ready_tx.send(Err("microphone_failed".into()));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                let started = std::time::Instant::now();
                while !stop.load(Ordering::Relaxed) && started.elapsed() < MAX_RECORDING {
                    std::thread::sleep(Duration::from_millis(100));
                    let l = std::mem::take(&mut *lock(&level));
                    on_level(l);
                }
                drop(stream);
            })
        };
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "microphone_failed".to_string())??;
        Ok(Self {
            stop,
            samples,
            rate,
            thread: Some(thread),
        })
    }

    /// Stops and returns the audio as 16 kHz mono for Whisper.
    pub fn finish(mut self) -> Vec<f32> {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        let samples = std::mem::take(&mut *lock(&self.samples));
        resample(&samples, self.rate, WHISPER_RATE)
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn build_input(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    samples: Arc<Mutex<Vec<f32>>>,
    level: Arc<Mutex<f32>>,
) -> Result<cpal::Stream, String> {
    fn build<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        samples: Arc<Mutex<Vec<f32>>>,
        level: Arc<Mutex<f32>>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let channels = usize::from(config.channels.max(1));
        device.build_input_stream(
            config,
            move |data: &[T], _| {
                let mut out = lock(&samples);
                let mut peak = 0.0f32;
                for frame in data.chunks(channels) {
                    let mono =
                        frame.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / channels as f32;
                    peak = peak.max(mono.abs());
                    out.push(mono);
                }
                let mut l = lock(&level);
                *l = l.max(peak);
            },
            |_| {},
            None,
        )
    }

    let cfg = config.config();
    let result = match config.sample_format() {
        SampleFormat::F32 => build::<f32>(device, &cfg, samples, level),
        SampleFormat::I16 => build::<i16>(device, &cfg, samples, level),
        SampleFormat::U16 => build::<u16>(device, &cfg, samples, level),
        SampleFormat::I32 => build::<i32>(device, &cfg, samples, level),
        _ => return Err("microphone_format".into()),
    };
    result.map_err(|_| "microphone_failed".into())
}

/// Writes 16 kHz mono samples as a 16-bit WAV file.
pub fn write_wav(path: &std::path::Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: WHISPER_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for s in samples {
        writer
            .write_sample(i16::from_sample(s.clamp(-1.0, 1.0)))
            .map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/// Audio queued for the speaker, already at the device rate (mono).
#[derive(Default)]
pub struct PlayQueue {
    samples: Mutex<VecDeque<f32>>,
    /// No more audio will be added.
    closed: AtomicBool,
    stop: AtomicBool,
}

impl PlayQueue {
    pub fn push(&self, samples: &[f32]) {
        lock(&self.samples).extend(samples);
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        lock(&self.samples).clear();
    }
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
    fn finished(&self) -> bool {
        self.stopped() || (self.closed.load(Ordering::Relaxed) && lock(&self.samples).is_empty())
    }
}

/// Opens the default speaker and returns its sample rate. Blocks the calling
/// thread until the queue is finished (closed and played, or stopped).
pub fn play(queue: Arc<PlayQueue>, rate_tx: std::sync::mpsc::Sender<u32>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no_speaker")?;
    let config = device.default_output_config().map_err(|_| "no_speaker")?;
    let _ = rate_tx.send(config.sample_rate());

    fn build<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        queue: Arc<PlayQueue>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: SizedSample + FromSample<f32>,
    {
        let channels = usize::from(config.channels.max(1));
        device.build_output_stream(
            config,
            move |data: &mut [T], _| {
                let mut q = lock(&queue.samples);
                for frame in data.chunks_mut(channels) {
                    let v = q.pop_front().unwrap_or(0.0);
                    let s = T::from_sample(v);
                    for out in frame.iter_mut() {
                        *out = s;
                    }
                }
            },
            |_| {},
            None,
        )
    }

    let cfg = config.config();
    let stream = match config.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &cfg, queue.clone()),
        SampleFormat::I16 => build::<i16>(&device, &cfg, queue.clone()),
        SampleFormat::U16 => build::<u16>(&device, &cfg, queue.clone()),
        SampleFormat::I32 => build::<i32>(&device, &cfg, queue.clone()),
        _ => return Err("speaker_format".into()),
    }
    .map_err(|_| "speaker_failed".to_string())?;
    stream.play().map_err(|_| "speaker_failed".to_string())?;
    while !queue.finished() {
        std::thread::sleep(Duration::from_millis(50));
    }
    // Let the device play out its last buffer.
    if !queue.stopped() {
        std::thread::sleep(Duration::from_millis(150));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records 2 s from every microphone and prints its level.
    /// `cargo test live_mic_levels -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_mic_levels() {
        let host = cpal::default_host();
        let default = host
            .default_input_device()
            .and_then(|d| d.id().ok())
            .map(|id| id.to_string());
        for device in host.input_devices().unwrap() {
            let name = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_default();
            let id = device.id().map(|i| i.to_string()).unwrap_or_default();
            let config = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    println!("{name} [{id}]: no config ({e})");
                    continue;
                }
            };
            let samples = Arc::new(Mutex::new(Vec::new()));
            let level = Arc::new(Mutex::new(0.0f32));
            let stream = build_input(&device, &config, samples.clone(), level).unwrap();
            stream.play().unwrap();
            std::thread::sleep(Duration::from_secs(2));
            drop(stream);
            let s = lock(&samples);
            let peak = s.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            let rms = (s.iter().map(|v| v * v).sum::<f32>() / s.len().max(1) as f32).sqrt();
            println!(
                "{name}{} [{id}] {:?} {} Hz {} ch: {} samples, peak {peak:.4}, rms {rms:.5}",
                if default.as_deref() == Some(id.as_str()) {
                    " (DEFAULT)"
                } else {
                    ""
                },
                config.sample_format(),
                config.sample_rate(),
                config.channels(),
                s.len()
            );
        }
    }

    #[test]
    fn resamples_lengths_and_values() {
        let one_sec: Vec<f32> = (0..48_000).map(|i| i as f32 / 48_000.0).collect();
        let out = resample(&one_sec, 48_000, 16_000);
        assert!((out.len() as i64 - 16_000).abs() <= 2, "{}", out.len());
        assert!((out[8_000] - 0.5).abs() < 0.01);

        // Chunked resampling gives the same result as one pass.
        let mut r = Resampler::new(22_050, 48_000);
        let mut chunked = Vec::new();
        for chunk in one_sec[..22_050].chunks(1000) {
            r.process(chunk, &mut chunked);
        }
        let whole = resample(&one_sec[..22_050], 22_050, 48_000);
        assert!((chunked.len() as i64 - whole.len() as i64).abs() <= 2);
        assert!((chunked[30_000] - whole[30_000]).abs() < 1e-3);
    }
}
