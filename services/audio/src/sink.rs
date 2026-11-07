//! Output sinks and device capabilities.
//!
//! `DeviceCaps` abstracts what an output accepts (real CPAL device or the
//! virtual null device used for headless verification). `Sink` is a live
//! output stream pulling frames out of `OutputCore`.

use crate::decode::{BitDepth, PcmKind};
use crate::engine::{EngineConfig, OutputCore};
#[cfg(target_os = "linux")]
use crate::pw_sink::PipeWireCaps;
use crate::ringbuf::{self, Consumer};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Sample type carried to a device — f32/s32/s16, little-endian on wire.
pub trait PcmSample:
    Copy + Default + Send + Sync + 'static + crate::ringbuf::RingWord
{
    const BYTES: usize;
}
impl PcmSample for f32 {
    const BYTES: usize = 4;
}
impl PcmSample for i32 {
    const BYTES: usize = 4;
}
impl PcmSample for i16 {
    const BYTES: usize = 2;
}

/// Drain the feed ring into a device callback buffer; zero-pad the tail
/// when the ring is momentarily short (underrun keeps its old contract).
fn drain<T: PcmSample>(cons: &Consumer<T>, out: &mut [T]) {
    let n = cons.read(out);
    out[n..].fill(T::default());
}

/// Drain with a paused check: paused means output silence WITHOUT
/// draining, so the pre-pause tail survives for a seamless resume.
/// Stale-PCM flushing is the feeder's job (producer-side epoch fence);
/// the callback just drains.
fn drain_paused<T: PcmSample>(cons: &Consumer<T>, paused: &AtomicBool, out: &mut [T]) {
    if paused.load(Ordering::Acquire) {
        out.fill(T::default());
        return;
    }
    drain(cons, out);
}

/// Owns the feeder stop flag + join handle. Dropping it (any error path
/// between spawn and a successful stream open) stops and joins the
/// thread, so a feeder can never detach and drain `core` forever.
pub struct FeedGuard {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl FeedGuard {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for FeedGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Ring capacity for the staging feed: the caller's latency cover, but
/// never less than two whole feed chunks. The feeder pulls `chunk`
/// whole frames at a time — a ring smaller than 2*chunk can never fit
/// one (mono at <=32.8kHz starved silently under the old sizing).
fn feed_capacity(min_capacity: usize, channels: usize) -> usize {
    let ch = channels.max(1);
    let chunk = (2048 / ch).max(1) * ch;
    // +1: the ring keeps one slot to disambiguate full/empty, so 2*chunk
    // of capacity holds only 2*chunk-1 usable slots.
    min_capacity.max(2 * chunk + 1)
}

/// Spawn a feeder thread that pulls `core` into a lock-free staging ring.
/// The device callback drains the ring instead of touching `core`'s mutex,
/// so a contended callback can never be forced to emit silence.
///
/// The epoch protocol lives entirely on the producer side: inside one
/// `core` lock the feeder reads the epoch, clears the ring if a control
/// change bumped it (every staged sample is provably pre-bump), pulls,
/// and publishes. A bump can't interleave anywhere in that sequence —
/// no fresh data is ever discarded, and no stale scratch can publish.
/// The callback needs no epoch logic; it may drain up to ~one feeder
/// cycle of stale samples after a bump, which every staged player has.
/// Returns (consumer, guard); the guard stops+joins on drop.
pub fn spawn_feed<T: PcmSample>(
    core: &Arc<Mutex<OutputCore>>,
    pull: fn(&mut OutputCore, &mut [T]),
    min_capacity: usize,
    channels: usize,
) -> Result<(Consumer<T>, FeedGuard)> {
    // Pull whole frames: a partial-frame tail at the scratch boundary
    // would split a frame across pulls and skew position accounting.
    let chunk = (2048 / channels.max(1)).max(1) * channels.max(1);
    let capacity = feed_capacity(min_capacity, channels);
    let (prod, cons) = ringbuf::channel::<T>(capacity);
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let core2 = Arc::clone(core);
    let epoch = Arc::clone(
        &core.lock().unwrap_or_else(|p| p.into_inner()).clear_epoch,
    );
    let join = std::thread::Builder::new()
        .name("pcm-feed".into())
        .spawn(move || {
            let mut scratch = vec![T::default(); chunk];
            let mut seen = epoch.load(Ordering::Acquire);
            while !stop2.load(Ordering::Relaxed) {
                {
                    // Poisoned `core` means the engine already crashed —
                    // pull through the poison like the old callback did
                    // rather than die silently into a zero ring.
                    let mut c = match core2.lock() {
                        Ok(c) => c,
                        Err(p) => p.into_inner(),
                    };
                    // Control ops bump the epoch while holding `core` —
                    // under the same lock, everything staged is provably
                    // pre-bump; clear it, then publish post-bump audio.
                    let tag = epoch.load(Ordering::Acquire);
                    if tag != seen {
                        seen = tag;
                        prod.clear();
                    }
                    if c.paused {
                        // Skip writes while paused so the ring keeps the
                        // pre-pause tail — resume continues seamlessly.
                        drop(c);
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    if c.ended_pending {
                        // Track ended: stop topping the ring up with
                        // pull-side silence so staged_frames() can reach
                        // zero — the monitor parks the end until the
                        // tail actually plays out.
                        drop(c);
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        continue;
                    }
                    if prod.free_space() < scratch.len() {
                        drop(c);
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        continue;
                    }
                    pull(&mut c, &mut scratch);
                    // free_space can't shrink between the check above
                    // and here — head only ever advances, and the
                    // fence never lets it regress below a clear.
                    let written = prod.write(&scratch);
                    debug_assert_eq!(written, scratch.len());
                }
            }
        })?;
    Ok((
        cons,
        FeedGuard {
            stop,
            join: Some(join),
        },
    ))
}

/// Negotiated stream parameters — reported honestly in event.output.
#[derive(Debug, Clone, PartialEq)]
pub struct Negotiated {
    pub rate: u32,
    pub channels: u32,
    pub kind: PcmKind,
    pub device_name: String,
    /// Resolved spa channel positions for the source's declared layout
    /// (or the ffmpeg count default). Stored resolved — NOT the layout
    /// name — so Negotiated equality compares what the stream actually
    /// does: "stereo" and None both resolve to FL/FR (equal, no
    /// spurious rebuild) while "5.1" and "5.1(side)" resolve to
    /// different positions (correctly unequal). None when the channel
    /// count is the device's, not the source's.
    pub positions: Option<Vec<u32>>,
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
    /// Marks the native PipeWire caps — lets open_sink fall back to CPAL
    /// when the stream itself fails (caps presence ≠ stream success).
    fn is_pipewire(&self) -> bool {
        false
    }
    /// The shared error cell a fallback caps should adopt so its stream
    /// errors still reach `device_error` on the caps the engine holds.
    fn error_cell(&self) -> Option<Arc<Mutex<Option<String>>>> {
        None
    }
    /// Adopt another caps' error cell (used by the open_sink fallback).
    fn set_error_cell(&mut self, _cell: Arc<Mutex<Option<String>>>) {}
    /// True when the caps address a specific named device — a stream-open
    /// failure must NOT fall back to a different device silently.
    fn has_explicit_target(&self) -> bool {
        false
    }
}


/// spa_audio_channel ordinals (spa/param/audio/raw.h) for stream
/// position maps.
pub(crate) mod chan {
    pub const MONO: u32 = 2;
    pub const FL: u32 = 3;
    pub const FR: u32 = 4;
    pub const FC: u32 = 5;
    pub const LFE: u32 = 6;
    pub const SL: u32 = 7;
    pub const SR: u32 = 8;
    pub const FLC: u32 = 9;
    pub const FRC: u32 = 10;
    pub const RC: u32 = 11;
    pub const RL: u32 = 12;
    pub const RR: u32 = 13;
    pub const TFL: u32 = 15;
    pub const TFC: u32 = 16;
    pub const TFR: u32 = 17;
    // ffmpeg "top back" ↔ spa "top rear" (TRL/TRC/TRR).
    pub const TRL: u32 = 18;
    pub const TRC: u32 = 19;
    pub const TRR: u32 = 20;
    // ffmpeg WL/WR ↔ spa FLW/FRW.
    pub const FLW: u32 = 23;
    pub const FRW: u32 = 24;
    pub const LFE2: u32 = 25;
    pub const TSL: u32 = 31;
    pub const TSR: u32 = 32;
}

/// Positions for an ffmpeg channel-order layout name — the decoder
/// emits samples in the file's declared order, so the positions must
/// label that order exactly. `mono` maps to spa MONO, not FC: an FC
/// source is mixed to a stereo sink at SQRT1_2 (-3 dB) while MONO is
/// copied at unity (channelmix-ops).
pub(crate) fn layout_named(name: &str) -> Option<Vec<u32>> {
    use chan::*;
    Some(match name {
        "mono" => vec![MONO],
        "stereo" => vec![FL, FR],
        "2.1" => vec![FL, FR, LFE],
        "3.0" => vec![FL, FR, FC],
        "3.0(back)" => vec![FL, FR, RC],
        "3.1" => vec![FL, FR, FC, LFE],
        "3.1.2" => vec![FL, FR, FC, LFE, TFL, TFR],
        "4.0" => vec![FL, FR, FC, RC],
        "4.1" => vec![FL, FR, FC, LFE, RC],
        "quad" => vec![FL, FR, RL, RR],
        "quad(side)" => vec![FL, FR, SL, SR],
        // ffmpeg truth: bare 5.0/5.1 use BACK pairs (BL/BR → spa RL/RR);
        // only (side) variants use SL/SR.
        "5.0" => vec![FL, FR, FC, RL, RR],
        "5.0(side)" => vec![FL, FR, FC, SL, SR],
        "5.1" => vec![FL, FR, FC, LFE, RL, RR],
        "5.1(side)" => vec![FL, FR, FC, LFE, SL, SR],
        "6.0" => vec![FL, FR, FC, RC, SL, SR],
        "6.0(front)" => vec![FL, FR, FLC, FRC, SL, SR],
        "6.1" => vec![FL, FR, FC, LFE, RC, SL, SR],
        "6.1(back)" => vec![FL, FR, FC, LFE, RL, RR, RC],
        "6.1(front)" => vec![FL, FR, LFE, FLC, FRC, SL, SR],
        "7.0" => vec![FL, FR, FC, RL, RR, SL, SR],
        "7.0(front)" => vec![FL, FR, FC, FLC, FRC, SL, SR],
        "7.1" => vec![FL, FR, FC, LFE, RL, RR, SL, SR],
        "7.1(wide)" => vec![FL, FR, FC, LFE, RL, RR, FLC, FRC],
        "7.1(wide-side)" => vec![FL, FR, FC, LFE, FLC, FRC, SL, SR],
        "5.1.2" => vec![FL, FR, FC, LFE, SL, SR, TFL, TFR],
        "5.1.2(back)" => vec![FL, FR, FC, LFE, RL, RR, TFL, TFR],
        "5.1.4" => vec![FL, FR, FC, LFE, SL, SR, TFL, TFR, TRL, TRR],
        "7.1.2" => vec![FL, FR, FC, LFE, RL, RR, SL, SR, TFL, TFR],
        "7.1.4" => vec![FL, FR, FC, LFE, RL, RR, SL, SR, TFL, TFR, TRL, TRR],
        "7.2.3" => vec![FL, FR, FC, LFE, RL, RR, SL, SR, TFL, TFR, TRC, LFE2],
        "hexagonal" => vec![FL, FR, FC, RL, RR, RC],
        "octagonal" => vec![FL, FR, FC, RL, RR, RC, SL, SR],
        "cube" => vec![FL, FR, RL, RR, TFL, TFR, TRL, TRR],
        "9.1.4" => vec![
            FL, FR, FC, LFE, RL, RR, FLC, FRC, SL, SR, TFL, TFR, TRL, TRR,
        ],
        "9.1.6" => vec![
            FL, FR, FC, LFE, RL, RR, FLC, FRC, SL, SR, TFL, TFR, TRL, TRR,
            TSL, TSR,
        ],
        "hexadecagonal" => vec![
            FL, FR, FC, RL, RR, RC, SL, SR, TFL, TFC, TFR, TRL, TRC, TRR,
            FLW, FRW,
        ],
        _ => return None,
    })
}

/// Resolve the source's declared layout (or the count fallback) to spa
/// positions. A declared name that mismatches the channel count is
/// ignored; ffmpeg's per-count defaults (av_get_default_channel_layout)
/// cover the rest.
pub fn resolve_positions(
    layout: Option<&str>,
    channels: u32,
) -> Option<Vec<u32>> {
    use chan::*;
    if let Some(name) = layout {
        if let Some(p) = layout_named(name) {
            // Declared and matches the count — trust it.
            if p.len() as u32 == channels {
                return Some(p);
            }
        } else if channels <= 2 {
            // Declared-but-unknown names ("2 channels", "unknown") at
            // 1-2ch are unambiguous — use the count default so they
            // compare equal to labeled stereo/mono.
            return match channels {
                1 => Some(vec![MONO]),
                _ => Some(vec![FL, FR]),
            };
        } else {
            // Declared but UNKNOWN at >2ch: an unpositioned stream
            // lets the graph infer — better than a same-count guess
            // that mislabels speakers.
            return None;
        }
        return None;
    }
    let p = match channels {
        1 => vec![MONO],
        2 => vec![FL, FR],
        3 => vec![FL, FR, FC],
        // ffmpeg's per-count defaults: 4=quad, 5=5.0-back, 6=5.1-back,
        // 7=6.1, 8=7.1.
        4 => vec![FL, FR, RL, RR],
        5 => vec![FL, FR, FC, RL, RR],
        6 => vec![FL, FR, FC, LFE, RL, RR],
        7 => vec![FL, FR, FC, LFE, RC, SL, SR],
        8 => vec![FL, FR, FC, LFE, RL, RR, SL, SR],
        _ => return None,
    };
    Some(p)
}

pub trait Sink: Send {
    fn stop(&mut self);
    /// Boot placeholder (no device yet) — the monitor skips the dead
    /// poll for these: reporting "device lost" at startup before any
    /// playback is the wrong event.
    fn is_placeholder(&self) -> bool {
        false
    }
    /// A dead sink never renders — loads over it must retry the open, not
    /// succeed silently into nothing.
    fn is_dead(&self) -> bool {
        false
    }
    /// Whole frames staged but not yet delivered to the device. Pull-side
    /// position leads audible output by this much — respawn paths
    /// subtract it so a rebuild doesn't skip the staged tail.
    fn staged_frames(&self) -> u64 {
        0
    }
    /// Frames already handed to the device but not yet audible — the
    /// negotiated quantum/device buffer. Position reporting subtracts
    /// this too (like mpv's audio-pts accounting for device delay).
    fn device_delay_frames(&self) -> u64 {
        0
    }
    /// How long a drain-unsupported backend should wait at
    /// end-of-track for its downstream queue to play out. Position
    /// never consults this — it's a wait estimate, not a measurement.
    fn drain_fallback_ms(&self) -> u64 {
        250
    }
    /// Ask the backend to drain its downstream queue; returns a
    /// completion baseline (see drained_since) or None if unsupported.
    /// Used at end-of-track so the tail plays out fully.
    fn request_drain(&self) -> Option<u64> {
        None
    }
    /// True once a drain event newer than `baseline` has completed.
    fn drained_since(&self, _baseline: u64) -> bool {
        true
    }
    /// Whether the request's ordering barrier has run — i.e. every
    /// pre-request drain notification has been delivered, so a
    /// re-issued drain's completion cannot be coalesced away. Used
    /// to re-issue a drain whose event may have been suppressed.
    fn drain_marker_ran(&self, _baseline: u64) -> bool {
        true
    }
    /// Re-issue a drain whose completion may have been coalesced,
    /// rechecking `drained_since(baseline)` under the loop lock so a
    /// completion arriving between the caller's check and the new
    /// marker can never be silently folded away. Returns the new
    /// baseline, None when unsupported, or `u64::MAX` when the
    /// original request is already complete.
    fn retry_drain(&self, _baseline: u64) -> Option<u64> {
        None
    }
    /// Reactivate a stream that was drained or suspended — PipeWire
    /// documents reactivation after a drain; no-op for backends that
    /// don't need it. Called whenever playback resumes on a reused sink.
    fn resume(&self) {}
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
    /// `supported_output_configs` can fail with EBUSY on a direct `hw:`
    /// device once a stream holds the PCM handle — query once per device
    /// instance and reuse. Only a successful result is cached: a transient
    /// failure re-queries next time instead of sticking.
    cfgs: std::sync::OnceLock<Vec<cpal::SupportedStreamConfigRange>>,
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
        let cfgs = std::sync::OnceLock::new();
        // Query the supported configs EAGERLY — on a direct `hw:` device
        // the query fails with EBUSY once our stream holds the PCM handle,
        // so the only window to learn the device's real capabilities is
        // before the first stream opens. A failure — or an empty list —
        // stays uncached and re-queries lazily later.
        if let Ok(it) = device.supported_output_configs() {
            let cfgs_vec: Vec<_> = it.collect();
            if !cfgs_vec.is_empty() {
                let _ = cfgs.set(cfgs_vec);
            }
        }
        Ok(Arc::new(CpalCaps {
            device,
            default_cfg,
            error: Arc::new(Mutex::new(None)),
            cfgs,
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

impl CpalCaps {
    /// Negotiate against THIS device's actual capabilities: keep the
    /// requested format when CPAL can carry it, else fall back to the
    /// device's default config (a PipeWire-chosen format can be
    /// anything — CPAL devices often can't).
    pub fn renegotiate(&self, neg: &Negotiated) -> Negotiated {
        let depth = match neg.kind {
            PcmKind::F32 => BitDepth::Float,
            PcmKind::S32 => BitDepth::Int(32),
            PcmKind::S16 => BitDepth::Int(16),
        };
        if let Some(kind) = self.accepts(neg.rate, neg.channels, depth) {
            return Negotiated {
                kind,
                // `neg` is the PipeWire-side plan — its device_name is the
                // pw node. Commit the CPAL name so equality against the
                // next plan doesn't force a rebuild.
                device_name: self.name(),
                ..neg.clone()
            };
        }
        let d = &self.default_cfg;
        Negotiated {
            rate: d.sample_rate().0,
            channels: d.channels() as u32,
            kind: Self::kind_of(d.sample_format()),
            device_name: self.name(),
            positions: resolve_positions(None, d.channels() as u32),
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
        let cfgs = match self.cfgs.get() {
            Some(c) => c.as_slice(),
            None => {
                let it = self.device.supported_output_configs().ok()?;
                // An empty result isn't a capability answer — leave the
                // cache unset so a later call can re-query.
                let cfgs_vec: Vec<_> = it.collect();
                if cfgs_vec.is_empty() {
                    return None;
                }
                self.cfgs.get_or_init(|| cfgs_vec).as_slice()
            }
        };
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

    fn error_cell(&self) -> Option<Arc<Mutex<Option<String>>>> {
        Some(Arc::clone(&self.error))
    }

    fn set_error_cell(&mut self, cell: Arc<Mutex<Option<String>>>) {
        self.error = cell;
    }

    fn open_stream(&self, neg: &Negotiated, core: Arc<Mutex<OutputCore>>) -> Result<Box<dyn Sink>> {
        use cpal::traits::DeviceTrait;
        let config = cpal::StreamConfig {
            channels: neg.channels as u16,
            sample_rate: cpal::SampleRate(neg.rate),
            buffer_size: cpal::BufferSize::Default,
        };
        let err_flag = Arc::clone(&self.error);
        let dead = Arc::new(AtomicBool::new(false));
        let make_err_cb = |dead: &Arc<AtomicBool>| {
            let err_flag = Arc::clone(&err_flag);
            let dead = Arc::clone(dead);
            move |e: cpal::StreamError| {
                // No unwrap: a poisoned mutex inside an FFI callback aborts.
                if let Ok(mut cell) = err_flag.lock() {
                    *cell = Some(e.to_string());
                }
                // Any stream-level error can kill the device path —
                // dead lets the engine rebuild (or fall back) instead of
                // silently playing nothing.
                dead.store(true, Ordering::Relaxed);
            }
        };
        // The callback runs on the device's real-time thread and must never
        // block on `core`'s mutex — it drains a lock-free staging ring that
        // a feeder thread keeps topped up. ~60ms of cover: a momentarily
        // contended pull no longer surfaces as an audible silence gap.
        let capacity = (neg.rate as usize * neg.channels as usize / 16).max(8192);
        let ch = neg.channels as usize;
        let paused = Arc::clone(
            &core.lock().unwrap_or_else(|p| p.into_inner()).paused_flag,
        );
        let staged_fn: Box<dyn Fn() -> u64 + Send + Sync>;
        let (stream, feed) = match neg.kind {
            PcmKind::F32 => {
                let (cons, feed) = spawn_feed(&core, OutputCore::pull_f32, capacity, ch)?;
                let staged_c = cons.clone();
                staged_fn = Box::new(move || (staged_c.available() / ch) as u64);
                let pa = Arc::clone(&paused);
                (
                    self.device.build_output_stream::<f32, _, _>(
                        &config,
                        move |data: &mut [f32], _| drain_paused(&cons, &pa, data),
                        make_err_cb(&dead),
                        None,
                    )?,
                    feed,
                )
            }
            PcmKind::S32 => {
                let (cons, feed) = spawn_feed(&core, OutputCore::pull_s32, capacity, ch)?;
                let staged_c = cons.clone();
                staged_fn = Box::new(move || (staged_c.available() / ch) as u64);
                let pa = Arc::clone(&paused);
                (
                    self.device.build_output_stream::<i32, _, _>(
                        &config,
                        move |data: &mut [i32], _| drain_paused(&cons, &pa, data),
                        make_err_cb(&dead),
                        None,
                    )?,
                    feed,
                )
            }
            PcmKind::S16 => {
                let (cons, feed) = spawn_feed(&core, OutputCore::pull_s16, capacity, ch)?;
                let staged_c = cons.clone();
                staged_fn = Box::new(move || (staged_c.available() / ch) as u64);
                let pa = Arc::clone(&paused);
                (
                    self.device.build_output_stream::<i16, _, _>(
                        &config,
                        move |data: &mut [i16], _| drain_paused(&cons, &pa, data),
                        make_err_cb(&dead),
                        None,
                    )?,
                    feed,
                )
            }
        };
        use cpal::traits::StreamTrait;
        if let Err(e) = stream.play().context("start output stream") {
            drop(feed);
            return Err(e);
        }
        Ok(Box::new(CpalSink {
            stream: Some(stream),
            feed,
            dead,
            staged: staged_fn,
        }))
    }
}

struct CpalSink {
    stream: Option<cpal::Stream>,
    feed: FeedGuard,
    dead: Arc<AtomicBool>,
    staged: Box<dyn Fn() -> u64 + Send + Sync>,
}

// cpal marks Stream !Send (portability across hosts), but the Cadence engine
// only drops/stops it from the control thread while its callback runs on
// cpal's own thread — moving the handle between threads is sound for the
// ALSA/JACK/CoreAudio backends we target.
unsafe impl Send for CpalSink {}

impl Sink for CpalSink {
    fn stop(&mut self) {
        self.stream.take();
        self.feed.stop();
    }

    fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }

    fn staged_frames(&self) -> u64 {
        (self.staged)()
    }

    fn drain_fallback_ms(&self) -> u64 {
        // BufferSize::Default leaves the real depth opaque — a
        // conservative fixed wait, used ONLY for end-of-track drain
        // fallback (never for position: reporting an estimate there
        // would mis-state position and repeat audio on respawn).
        // 500ms covers ALSA's largest typical buffers; bounded by the
        // entry deadline either way, and a delayed transition is
        // always better than a truncated tail.
        500
    }
}

// Same contract as NullSink: a bare drop must not detach the feeder or
// leave the device stream running.
impl Drop for CpalSink {
    fn drop(&mut self) {
        self.stop();
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
    fn is_placeholder(&self) -> bool {
        true
    }
    fn is_dead(&self) -> bool {
        true
    }
}

/// Result of open_sink: the sink, the negotiated format it ACTUALLY
/// opened (CPAL fallback may differ from the requested PipeWire
/// format — the engine must commit the returned one), and replacement
/// caps when the backend itself swapped.
pub struct OpenedSink {
    pub sink: Box<dyn Sink>,
    pub negotiated: Negotiated,
    pub caps: Option<Arc<dyn DeviceCaps>>,
}

/// Build the right caps + initial sink for the configured mode.
pub fn open_sink(
    cfg: &EngineConfig,
    caps: Arc<dyn DeviceCaps>,
    neg: &Negotiated,
    core: &Arc<Mutex<OutputCore>>,
) -> Result<OpenedSink> {
    let _ = cfg;
    match caps.open_stream(neg, Arc::clone(core)) {
        Err(e) if caps.is_pipewire() => {
            // A named device that can't open must not silently fall back
            // to the default — a PW node name can't be resolved by CPAL
            // anyway, and the wrong device would play while event.output
            // keeps reporting the requested name.
            if caps.has_explicit_target() {
                return Err(e.context(
                    "native stream to the selected device failed; refusing \
                     silent fallback to the default device",
                ));
            }
            // Default-device open failures drop to CPAL rather than
            // failing playback entirely. The fallback caps adopts the
            // PipeWire caps' error cell so stream errors still reach the
            // monitor's device_error poll.
            eprintln!("audio: pipewire stream failed ({e:#}); trying cpal/alsa");
            let mut c = CpalCaps::new(None)?;
            if let (Some(cell), Some(c)) = (caps.error_cell(), Arc::get_mut(&mut c)) {
                // The cell still holds the PW failure that triggered this
                // fallback — inheriting it would look like a fresh CPAL
                // error to the monitor and loop the rebuild forever.
                if let Ok(mut g) = cell.lock() {
                    *g = None;
                }
                c.set_error_cell(cell);
            }
            // Re-negotiate against CPAL's own capabilities — `neg` was
            // chosen for PipeWire, which accepts almost any native
            // format; a CPAL device restricted to 44.1k/S16 could
            // reject it while having a perfectly usable default. The
            // caller commits the returned format and caps.
            let cpal_neg = c.renegotiate(neg);
            c.open_stream(&cpal_neg, Arc::clone(core)).map(|sink| {
                OpenedSink {
                    sink,
                    negotiated: cpal_neg,
                    caps: Some(c as Arc<dyn DeviceCaps>),
                }
            })
        }
        other => other.map(|sink| OpenedSink {
            sink,
            negotiated: neg.clone(),
            caps: None,
        }),
    }
}

/// Choose the output backend for a named device (or the session default).
/// On PipeWire systems a native `pw_stream` is required for transparent
/// output — the pipewire-alsa plugin reprocesses every stream (see
/// `pw_sink`). Everywhere else CPAL/ALSA is the fallback.
#[cfg(target_os = "linux")]
pub fn device_caps(name: Option<&str>) -> Result<Arc<dyn DeviceCaps>> {
    match PipeWireCaps::new(name) {
        Ok(c) => Ok(c as Arc<dyn DeviceCaps>),
        Err(e) => {
            eprintln!("audio: pipewire backend unavailable ({e:#}); trying cpal/alsa");
            CpalCaps::new(name).map(|c| c as Arc<dyn DeviceCaps>)
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub fn device_caps(name: Option<&str>) -> Result<Arc<dyn DeviceCaps>> {
    CpalCaps::new(name).map(|c| c as Arc<dyn DeviceCaps>)
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
        device_caps(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drain_zero_pads_underruns() {
        let (prod, cons) = ringbuf::channel::<i16>(8);
        prod.write(&[1, 2, 3, 4]);
        let mut out = [0i16; 8];
        drain(&cons, &mut out);
        assert_eq!(out, [1, 2, 3, 4, 0, 0, 0, 0]);
    }

    #[test]
    fn drain_consumes_exactly_what_was_written() {
        let (prod, cons) = ringbuf::channel::<f32>(16);
        prod.write(&[1.0, 2.0, 3.0]);
        let mut out = [9.0f32; 3];
        drain(&cons, &mut out);
        assert_eq!(out, [1.0, 2.0, 3.0]);
        // Ring is empty afterwards — a second drain zero-fills.
        drain(&cons, &mut out);
        assert_eq!(out, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn drain_paused_silences_without_dropping_tail() {
        let paused = AtomicBool::new(false);
        let (prod, cons) = ringbuf::channel::<i16>(16);
        let mut out = [9i16; 8];

        // Normal drain.
        prod.write(&[1, 2, 3, 4]);
        drain_paused(&cons, &paused, &mut out);
        assert_eq!(&out[..4], &[1, 2, 3, 4]);

        // Paused → silence WITHOUT draining: the tail stays queued.
        paused.store(true, Ordering::Relaxed);
        prod.write(&[5, 6]);
        drain_paused(&cons, &paused, &mut out);
        assert_eq!(out, [0i16; 8]);
        paused.store(false, Ordering::Relaxed);
        drain_paused(&cons, &paused, &mut out);
        assert_eq!(&out[..2], &[5, 6]);
    }

    #[test]
    fn producer_clear_drops_stale_keeps_fresh() {
        // The feeder's epoch fence: clear() drops everything staged; a
        // write after the clear survives — the exact semantics the
        // producer-side fence needs.
        let (prod, cons) = ringbuf::channel::<i16>(16);
        prod.write(&[1, 2, 3, 4]);
        prod.clear();
        prod.write(&[5, 6]);
        let mut out = [9i16; 8];
        let n = cons.read(&mut out);
        assert_eq!(&out[..n], &[5, 6]);
    }

    #[test]
    fn feeder_capacity_never_starves_a_chunk() {
        // The real function under test: capacity must exceed 2×chunk
        // (+1 for the ring's reserved slot) or the feeder sleeps forever.
        for rate in [8000usize, 16000, 22050, 32000, 44100, 96000, 192000] {
            for ch in [1usize, 2, 6, 8] {
                let chunk = (2048 / ch).max(1) * ch;
                let min_cap = (rate * ch / 8).max(4 * 2048 * ch);
                let capacity = feed_capacity(min_cap, ch);
                // Usable slots are cap-1; two chunks must always fit.
                assert!(
                    capacity - 1 >= 2 * chunk,
                    "rate {rate} ch {ch}: capacity {capacity} too small for 2*chunk {chunk}"
                );
            }
        }
    }
}
