//! Output sinks and device capabilities.
//!
//! `DeviceCaps` abstracts what an output accepts (real CPAL device or the
//! virtual null device used for headless verification). `Sink` is a live
//! output stream pulling frames out of `OutputCore`.

use crate::decode::{BitDepth, PcmKind};
use crate::engine::{EngineConfig, OutputCore};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Negotiated stream parameters — reported honestly in event.output.
#[derive(Debug, Clone, PartialEq)]
pub struct Negotiated {
    pub rate: u32,
    pub channels: u32,
    pub kind: PcmKind,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceDesc {
    pub name: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(rename = "defaultSampleRateHz")]
    pub default_sample_rate_hz: u32,
    pub channels: u32,
}

/// What an output device can do.
pub trait DeviceCaps: Send + Sync {
    fn name(&self) -> String;
    fn default_rate(&self) -> u32;
    fn default_channels(&self) -> u32;
    fn max_channels(&self) -> u32 {
        self.default_channels()
    }
    fn default_kind(&self) -> PcmKind {
        PcmKind::F32
    }
    /// If the device can run this track natively (rate+channels+depth
    /// preserved), return the stream format to use; else None.
    fn accepts(&self, rate: u32, channels: u32, depth: BitDepth) -> Option<PcmKind>;
    fn list(&self) -> Vec<DeviceDesc>;
    /// Non-empty after a stream error (device unplugged, etc).
    fn device_error(&self) -> Option<String> {
        None
    }
    /// Open an output stream driven by `core`.
    fn open_stream(&self, neg: &Negotiated, core: Arc<Mutex<OutputCore>>) -> Result<Box<dyn Sink>>;
}

pub trait Sink: Send {
    fn stop(&mut self);
    /// A dead sink never renders — loads over it must retry the open, not
    /// succeed silently into nothing.
    fn is_dead(&self) -> bool {
        false
    }
}

// ------------------------------- null device -------------------------------

/// Virtual device for headless runs. Accepts any rate; always reports a
/// depth-preserving format so fidelity bypass is exercisable.
pub struct NullCaps {
    pub rate: u32,
    pub channels: u32,
    pub fast: bool,
}

impl DeviceCaps for NullCaps {
    fn name(&self) -> String {
        "null-sink".into()
    }
    fn default_rate(&self) -> u32 {
        self.rate
    }
    fn default_channels(&self) -> u32 {
        self.channels
    }
    fn accepts(&self, _rate: u32, _channels: u32, depth: BitDepth) -> Option<PcmKind> {
        // The virtual device takes anything; choose the format that keeps
        // the source bit-exact (32-bit int -> s32, everything else -> f32).
        Some(match depth {
            BitDepth::Int(32) => PcmKind::S32,
            _ => PcmKind::F32,
        })
    }
    fn list(&self) -> Vec<DeviceDesc> {
        vec![DeviceDesc {
            name: self.name(),
            is_default: true,
            default_sample_rate_hz: self.rate,
            channels: self.channels,
        }]
    }
    fn open_stream(&self, neg: &Negotiated, core: Arc<Mutex<OutputCore>>) -> Result<Box<dyn Sink>> {
        Ok(Box::new(NullSink::spawn(neg.clone(), core, self.fast)))
    }
}

/// Drives OutputCore at the negotiated rate, discarding (or dumping) frames.
pub struct NullSink {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl NullSink {
    fn spawn(neg: Negotiated, core: Arc<Mutex<OutputCore>>, fast: bool) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let join = std::thread::Builder::new()
            .name("null-sink".into())
            .spawn(move || {
                let frames_per_tick = (neg.rate as usize / 50).max(64); // 20ms
                let n = frames_per_tick * neg.channels as usize;
                let tick = std::time::Duration::from_secs_f64(frames_per_tick as f64 / neg.rate as f64);
                let mut buf_f = vec![0f32; n];
                let mut buf_i = vec![0i32; n];
                let mut buf_16 = vec![0i16; n];
                while !stop2.load(Ordering::Relaxed) {
                    let t0 = std::time::Instant::now();
                    {
                        // Test driver, not a real-time thread: a blocking
                        // lock keeps rendered output deterministic. This is
                        // deadlock-safe because control threads never hold
                        // `core` across sink stop/join (see Engine::rebuild_stream).
                        let mut c = core.lock().unwrap();
                        match neg.kind {
                            PcmKind::F32 => c.pull_f32(&mut buf_f),
                            PcmKind::S32 => c.pull_s32(&mut buf_i),
                            PcmKind::S16 => c.pull_s16(&mut buf_16),
                        }
                    }
                    if !fast {
                        let elapsed = t0.elapsed();
                        if elapsed < tick {
                            std::thread::sleep(tick - elapsed);
                        }
                    } else {
                        // still yield so producers/monitor get CPU
                        std::thread::sleep(std::time::Duration::from_micros(200));
                    }
                }
            })
            .expect("spawn null sink");
        NullSink { stop, join: Some(join) }
    }
}

impl Sink for NullSink {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

// Dropping a live NullSink must stop + join its pull thread; a bare drop
// would detach it and leave a zombie pulling samples forever.
impl Drop for NullSink {
    fn drop(&mut self) {
        self.stop();
    }
}

// ------------------------------- cpal device -------------------------------

pub struct CpalCaps {
    device: cpal::Device,
    default_cfg: cpal::SupportedStreamConfig,
    error: Arc<Mutex<Option<String>>>,
}

impl CpalCaps {
    /// `name`: None = system default output device.
    pub fn new(name: Option<&str>) -> Result<Arc<Self>> {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let device = match name {
            None => host
                .default_output_device()
                .ok_or_else(|| anyhow!("no default output device"))?,
            Some(n) => host
                .output_devices()?
                .find(|d| d.name().map(|dn| dn == n).unwrap_or(false))
                .ok_or_else(|| anyhow!("no output device named {n:?}"))?,
        };
        let default_cfg = device.default_output_config()?;
        Ok(Arc::new(CpalCaps {
            device,
            default_cfg,
            error: Arc::new(Mutex::new(None)),
        }))
    }

    fn kind_of(fmt: cpal::SampleFormat) -> PcmKind {
        match fmt {
            cpal::SampleFormat::I32 => PcmKind::S32,
            cpal::SampleFormat::I16 => PcmKind::S16,
            _ => PcmKind::F32,
        }
    }
}

impl DeviceCaps for CpalCaps {
    fn name(&self) -> String {
        use cpal::traits::DeviceTrait;
        self.device.name().unwrap_or_else(|_| "unknown".into())
    }
    fn default_rate(&self) -> u32 {
        self.default_cfg.sample_rate().0
    }
    fn default_channels(&self) -> u32 {
        self.default_cfg.channels() as u32
    }
    fn default_kind(&self) -> PcmKind {
        Self::kind_of(self.default_cfg.sample_format())
    }

    fn accepts(&self, rate: u32, channels: u32, depth: BitDepth) -> Option<PcmKind> {
        use cpal::traits::DeviceTrait;
        let cfgs = self.device.supported_output_configs().ok()?;
        let mut fallback_f32 = false;
        let mut i16_ok = false;
        for c in cfgs {
            if c.channels() as u32 != channels {
                continue;
            }
            if rate < c.min_sample_rate().0 || rate > c.max_sample_rate().0 {
                continue;
            }
            match (depth, c.sample_format()) {
                (BitDepth::Float, cpal::SampleFormat::F32) => return Some(PcmKind::F32),
                (BitDepth::Int(32), cpal::SampleFormat::I32) => return Some(PcmKind::S32),
                (BitDepth::Int(_), cpal::SampleFormat::I32) => return Some(PcmKind::S32),
                (BitDepth::Int(bits), cpal::SampleFormat::I16) if bits <= 16 => {
                    return Some(PcmKind::S16)
                }
                (BitDepth::Int(_), cpal::SampleFormat::I16) => i16_ok = true,
                (BitDepth::Int(_), cpal::SampleFormat::F32) => fallback_f32 = true,
                _ => {}
            }
        }
        if fallback_f32 {
            Some(PcmKind::F32)
        } else if i16_ok {
            // >16-bit source into an i16-only device: lossy but audible.
            Some(PcmKind::S16)
        } else {
            None
        }
    }

    fn list(&self) -> Vec<DeviceDesc> {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let default_name = host
            .default_output_device()
            .and_then(|d| d.name().ok());
        let mut out = Vec::new();
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                let name = d.name().unwrap_or_else(|_| "unknown".into());
                let (rate, ch) = d
                    .default_output_config()
                    .map(|c| (c.sample_rate().0, c.channels() as u32))
                    .unwrap_or((0, 0));
                out.push(DeviceDesc {
                    is_default: Some(&name) == default_name.as_ref(),
                    name,
                    default_sample_rate_hz: rate,
                    channels: ch,
                });
            }
        }
        out
    }

    fn device_error(&self) -> Option<String> {
        self.error.lock().unwrap().take()
    }

    fn open_stream(&self, neg: &Negotiated, core: Arc<Mutex<OutputCore>>) -> Result<Box<dyn Sink>> {
        use cpal::traits::DeviceTrait;
        let config = cpal::StreamConfig {
            channels: neg.channels as u16,
            sample_rate: cpal::SampleRate(neg.rate),
            buffer_size: cpal::BufferSize::Default,
        };
        let err_flag = Arc::clone(&self.error);
        let err_cb = move |e: cpal::StreamError| {
            *err_flag.lock().unwrap() = Some(e.to_string());
        };
        // The callback runs on the device's real-time thread: it must never
        // block on the core mutex. try_lock + silent fallback bounds the wait
        // to the lock attempt itself; a contended frame renders as silence
        // rather than risking an xrun (or worse, a priority inversion while a
        // control thread holds `core` across a device open).
        let stream = match neg.kind {
            PcmKind::F32 => {
                let c = Arc::clone(&core);
                self.device.build_output_stream::<f32, _, _>(
                    &config,
                    move |data: &mut [f32], _| match c.try_lock() {
                        Ok(mut core) => core.pull_f32(data),
                        Err(std::sync::TryLockError::Poisoned(p)) => {
                            p.into_inner().pull_f32(data)
                        }
                        Err(std::sync::TryLockError::WouldBlock) => data.fill(0.0),
                    },
                    err_cb,
                    None,
                )?
            }
            PcmKind::S32 => {
                let c = Arc::clone(&core);
                self.device.build_output_stream::<i32, _, _>(
                    &config,
                    move |data: &mut [i32], _| match c.try_lock() {
                        Ok(mut core) => core.pull_s32(data),
                        Err(std::sync::TryLockError::Poisoned(p)) => {
                            p.into_inner().pull_s32(data)
                        }
                        Err(std::sync::TryLockError::WouldBlock) => data.fill(0),
                    },
                    err_cb,
                    None,
                )?
            }
            PcmKind::S16 => {
                let c = Arc::clone(&core);
                self.device.build_output_stream::<i16, _, _>(
                    &config,
                    move |data: &mut [i16], _| match c.try_lock() {
                        Ok(mut core) => core.pull_s16(data),
                        Err(std::sync::TryLockError::Poisoned(p)) => {
                            p.into_inner().pull_s16(data)
                        }
                        Err(std::sync::TryLockError::WouldBlock) => data.fill(0),
                    },
                    err_cb,
                    None,
                )?
            }
        };
        use cpal::traits::StreamTrait;
        stream.play().context("start output stream")?;
        Ok(Box::new(CpalSink { stream: Some(stream) }))
    }
}

struct CpalSink {
    stream: Option<cpal::Stream>,
}

// cpal marks Stream !Send (portability across hosts), but the Cadence engine
// only drops/stops it from the control thread while its callback runs on
// cpal's own thread — moving the handle between threads is sound for the
// ALSA/JACK/CoreAudio backends we target.
unsafe impl Send for CpalSink {}

impl Sink for CpalSink {
    fn stop(&mut self) {
        self.stream.take();
    }
}

/// No output device: reported honestly, recovers via setDevice.
pub struct UnavailableCaps {
    pub reason: String,
}

impl DeviceCaps for UnavailableCaps {
    fn name(&self) -> String {
        "unavailable".into()
    }
    fn default_rate(&self) -> u32 {
        48000
    }
    fn default_channels(&self) -> u32 {
        2
    }
    fn accepts(&self, _r: u32, _c: u32, _d: BitDepth) -> Option<PcmKind> {
        None
    }
    fn list(&self) -> Vec<DeviceDesc> {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let default_name = host.default_output_device().and_then(|d| d.name().ok());
        let mut out = Vec::new();
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                let name = d.name().unwrap_or_else(|_| "unknown".into());
                let (rate, ch) = d
                    .default_output_config()
                    .map(|c| (c.sample_rate().0, c.channels() as u32))
                    .unwrap_or((0, 0));
                out.push(DeviceDesc {
                    is_default: Some(&name) == default_name.as_ref(),
                    name,
                    default_sample_rate_hz: rate,
                    channels: ch,
                });
            }
        }
        out
    }
    fn open_stream(&self, _n: &Negotiated, _c: Arc<Mutex<OutputCore>>) -> Result<Box<dyn Sink>> {
        anyhow::bail!("no output device: {}", self.reason)
    }
}

/// Placeholder sink for "no device yet" — pulls nothing.
pub struct DeadSink;
impl Sink for DeadSink {
    fn stop(&mut self) {}
    fn is_dead(&self) -> bool {
        true
    }
}

/// Build the right caps + initial sink for the configured mode.
pub fn open_sink(
    cfg: &EngineConfig,
    caps: Arc<dyn DeviceCaps>,
    neg: &Negotiated,
    core: &Arc<Mutex<OutputCore>>,
) -> Result<Box<dyn Sink>> {
    let _ = cfg;
    caps.open_stream(neg, Arc::clone(core))
}

/// Initial device capabilities for the configured mode.
pub fn initial_caps(cfg: &EngineConfig) -> Result<Arc<dyn DeviceCaps>> {
    if cfg.null_sink {
        Ok(Arc::new(NullCaps {
            rate: cfg.null_rate,
            channels: 2,
            fast: cfg.null_fast,
        }))
    } else {
        CpalCaps::new(None).map(|c| c as Arc<dyn DeviceCaps>)
    }
}
