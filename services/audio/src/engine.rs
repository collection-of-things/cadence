//! The playback engine: one PCM graph from decode to output.
//!
//! graph:  decode -> DSP (EQ + ReplayGain, skipped on bypass) -> resample
//!         -> bounded ring buffer -> output callback pull -> FFT tap -> device
//!
//! The output callback only pops samples, applies volume, and taps the FFT
//! ring. Decode/DSP/resample/alloc all happen on producer threads.

use crate::decode::{BitDepth, DecodeRequest, Decoder, FfmpegDecoder, PcmKind};
use crate::dsp::Dsp;
use crate::fft::FftAnalyzer;
use crate::resample::{plan as resample_plan, ResamplePlan, StreamingResampler};
use crate::ringbuf::{self, Consumer, Producer};
use crate::sink::{DeviceCaps, Negotiated, Sink};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq, Copy)]
pub enum PlayState {
    Idle,
    Loading,
    Playing,
    Paused,
    Stopped,
    Error,
}

impl PlayState {
    pub fn as_str(self) -> &'static str {
        match self {
            PlayState::Idle => "idle",
            PlayState::Loading => "loading",
            PlayState::Playing => "playing",
            PlayState::Paused => "paused",
            PlayState::Stopped => "stopped",
            PlayState::Error => "error",
        }
    }
}

#[derive(Debug, Clone)]
pub enum SourceSpec {
    File { path: PathBuf },
    /// PCM pushed by the coordinator via audio.feed after audio.load.
    PcmStream {
        sample_rate_hz: u32,
        channels: u32,
        bit_depth: BitDepth,
    },
}

#[derive(Debug, Clone)]
pub struct LoadParams {
    pub queue_id: String,
    pub generation_id: u64,
    pub source: SourceSpec,
    pub start_paused: bool,
    pub position_ms: u64,
    pub replay_gain_db: Option<f64>,
}

// ---------------------------------------------------------------------------
// Output core: shared with the sink callback. Hot path = pull_*().
// ---------------------------------------------------------------------------

/// Typed ring-buffer reader for one track's decoded+processed samples.
enum PipeReader {
    F32(Consumer<f32>),
    S32(Consumer<i32>),
}

impl PipeReader {
    fn is_drained(&self) -> bool {
        match self {
            PipeReader::F32(c) => c.is_drained(),
            PipeReader::S32(c) => c.is_drained(),
        }
    }
    fn abort(&self) {
        match self {
            PipeReader::F32(c) => c.abort(),
            PipeReader::S32(c) => c.abort(),
        }
    }
}

/// Reader + track metadata carried through the render chain.
struct TrackReader {
    queue_id: String,
    duration_ms: u64,
    /// source-time offset this pipeline decodes from (for position math)
    seek_offset_ms: u64,
    pipe: PipeReader,
    /// set by producer once it has buffered data or finished
    ready: Arc<AtomicBool>,
}

/// Events the output thread cannot emit itself; drained by the monitor.
#[derive(Debug)]
enum CoreEvent {
    /// Active track drained; prefetched track took over on the same stream.
    Boundary {
        ended_queue_id: String,
        started_queue_id: String,
        started_duration_ms: u64,
        started_seek_offset_ms: u64,
    },
    /// Active track drained with nothing behind it.
    Ended { queue_id: String },
}

/// Everything the output callback touches. One Mutex, held briefly.
pub struct OutputCore {
    pub negotiated: Negotiated,
    pub paused: bool,
    pub volume: f32,
    active: Option<TrackReader>,
    next: Option<TrackReader>,
    /// output frames emitted for `active` since it became current
    frames_played: u64,
    events: VecDeque<CoreEvent>,
    /// a buffering notification is pending for the monitor thread
    underrun: bool,
    /// currently inside a stall episode (latch, avoids event spam)
    stalled: bool,
    fft_tap: Producer<f32>,
    /// optional f32le dump of everything rendered (null-sink diagnostics)
    dump: Option<std::io::BufWriter<std::fs::File>>,
}

impl OutputCore {
    /// Fill `out` with f32 output samples. Hot path: pops ring, applies
    /// volume, taps FFT, writes dump. Zero-fills on underrun/pause.
    pub fn pull_f32(&mut self, out: &mut [f32]) {
        if self.paused {
            out.fill(0.0);
            return;
        }
        let ch = self.negotiated.channels.max(1) as u64;
        let mut filled = 0;
        while filled < out.len() {
            let Some(track) = self.active.as_ref() else {
                out[filled..].fill(0.0);
                break;
            };
            let n = match &track.pipe {
                PipeReader::F32(c) => c.read(&mut out[filled..]),
                PipeReader::S32(c) => {
                    // Defensive: s32 pipe into f32 sink shouldn't happen
                    // (pipelines are built for the negotiated format).
                    let mut tmp = [0i32; 2048];
                    let want = (out.len() - filled).min(tmp.len());
                    let got = c.read(&mut tmp[..want]);
                    for i in 0..got {
                        out[filled + i] = tmp[i] as f32 / i32::MAX as f32;
                    }
                    got
                }
            };
            filled += n;
            self.frames_played += (n / ch as usize) as u64;
            if n == 0 {
                if track.pipe.is_drained() {
                    match self.advance_track() {
                        true => continue,  // gapless: keep filling
                        false => {
                            out[filled..].fill(0.0);
                            break;
                        }
                    }
                }
                if !self.stalled {
                    self.stalled = true;
                    self.underrun = true;
                }
                out[filled..].fill(0.0);
                break;
            } else {
                self.stalled = false;
            }
        }
        // volume, fft tap, dump on what was rendered
        let vol = self.volume;
        if (vol - 1.0).abs() > f32::EPSILON {
            for s in out.iter_mut() {
                *s *= vol;
            }
        }
        let _ = self.fft_tap.write(out);
        if let Some(d) = self.dump.as_mut() {
            use std::io::Write;
            let bytes = unsafe {
                std::slice::from_raw_parts(out.as_ptr() as *const u8, out.len() * 4)
            };
            let _ = d.write_all(bytes);
        }
    }

    /// Fill `out` with s32 output samples (fidelity-bypass streams).
    pub fn pull_s32(&mut self, out: &mut [i32]) {
        if self.paused {
            out.fill(0);
            return;
        }
        let ch = self.negotiated.channels.max(1) as u64;
        let mut filled = 0;
        while filled < out.len() {
            let Some(track) = self.active.as_ref() else {
                out[filled..].fill(0);
                break;
            };
            let n = match &track.pipe {
                PipeReader::S32(c) => c.read(&mut out[filled..]),
                PipeReader::F32(c) => {
                    let mut tmp = [0f32; 2048];
                    let want = (out.len() - filled).min(tmp.len());
                    let got = c.read(&mut tmp[..want]);
                    for i in 0..got {
                        out[filled + i] = (tmp[i] * i32::MAX as f32) as i32;
                    }
                    got
                }
            };
            filled += n;
            self.frames_played += (n / ch as usize) as u64;
            if n == 0 {
                if track.pipe.is_drained() {
                    match self.advance_track() {
                        true => continue,
                        false => {
                            out[filled..].fill(0);
                            break;
                        }
                    }
                }
                if !self.stalled {
                    self.stalled = true;
                    self.underrun = true;
                }
                out[filled..].fill(0);
                break;
            } else {
                self.stalled = false;
            }
        }
        let vol = self.volume;
        if (vol - 1.0).abs() > f32::EPSILON {
            for s in out.iter_mut() {
                *s = (*s as f64 * vol as f64).clamp(i32::MIN as f64, i32::MAX as f64) as i32;
            }
        }
        // tap FFT with f32-converted samples (bounded write, drops on full)
        let mut tap = [0f32; 2048];
        let mut i = 0;
        while i < out.len() {
            let n = (out.len() - i).min(tap.len());
            for j in 0..n {
                tap[j] = out[i + j] as f32 / i32::MAX as f32;
            }
            let _ = self.fft_tap.write(&tap[..n]);
            i += n;
        }
    }

    /// Active track drained: promote `next` (gapless) or end. Returns true if
    /// a new track took over on the same stream.
    fn advance_track(&mut self) -> bool {
        let ended = self.active.take().unwrap();
        if let Some(next) = self.next.take() {
            self.events.push_back(CoreEvent::Boundary {
                ended_queue_id: ended.queue_id,
                started_queue_id: next.queue_id.clone(),
                started_duration_ms: next.duration_ms,
                started_seek_offset_ms: next.seek_offset_ms,
            });
            self.frames_played = 0;
            self.active = Some(next);
            self.underrun = false;
            true
        } else {
            self.events.push_back(CoreEvent::Ended {
                queue_id: ended.queue_id,
            });
            false
        }
    }

    /// Swap in a new render track (load / seek rebuild).
    fn set_active(&mut self, track: TrackReader) {
        if let Some(old) = self.active.take() {
            old.pipe.abort();
        }
        self.frames_played = 0;
        self.stalled = false;
        self.underrun = false;
        self.active = Some(track);
    }

    /// Install (or replace) the prefetched successor.
    fn set_next(&mut self, track: TrackReader) {
        if let Some(old) = self.next.take() {
            old.pipe.abort();
        }
        self.next = Some(track);
    }

    fn clear_all(&mut self) {
        if let Some(t) = self.active.take() {
            t.pipe.abort();
        }
        if let Some(t) = self.next.take() {
            t.pipe.abort();
        }
        self.frames_played = 0;
        self.stalled = false;
        self.underrun = false;
    }

    fn position_ms(&self) -> u64 {
        let off = self
            .active
            .as_ref()
            .map(|t| t.seek_offset_ms)
            .unwrap_or(0);
        off + self.frames_played * 1000 / self.negotiated.rate.max(1) as u64
    }
}

// ---------------------------------------------------------------------------
// Feed (audio.load kind=pcm-stream, audio.feed pushes bytes)
// ---------------------------------------------------------------------------

/// Shared byte queue for a pushed PCM stream. base64-decoded bytes land in
/// `buf`; `closed` marks end-of-stream.
pub struct Feed {
    buf: Mutex<VecDeque<u8>>,
    cv: Condvar,
    closed: AtomicBool,
}

impl Feed {
    fn push(&self, bytes: &[u8]) {
        self.buf.lock().unwrap().extend(bytes.iter().copied());
        self.cv.notify_all();
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.cv.notify_all();
    }
    /// Blocking read of up to `n` bytes; returns <n only at close.
    fn read(&self, out: &mut [u8]) -> usize {
        let mut buf = self.buf.lock().unwrap();
        loop {
            if !buf.is_empty() {
                let n = out.len().min(buf.len());
                for (i, b) in buf.drain(..n).enumerate() {
                    out[i] = b;
                }
                return n;
            }
            if self.closed.load(Ordering::Acquire) {
                return 0;
            }
            let (g, _t) = self
                .cv
                .wait_timeout(buf, std::time::Duration::from_millis(50))
                .unwrap();
            buf = g;
        }
    }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

pub struct EngineConfig {
    /// true when running against the virtual null device
    pub null_sink: bool,
    /// null device rate (ignored for cpal)
    pub null_rate: u32,
    /// null device sample format
    pub null_kind: PcmKind,
    /// null sink without real-time pacing (integration tests)
    pub null_fast: bool,
    /// dump rendered f32le to this path in null-sink mode
    pub null_dump: Option<PathBuf>,
    /// ring buffer capacity in seconds of output audio
    pub buffer_secs: f32,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            null_sink: false,
            null_rate: 48000,
            null_kind: PcmKind::F32,
            null_fast: false,
            null_dump: None,
            buffer_secs: 1.5,
        }
    }
}

struct EngineState {
    generation: u64,
    queue_id: Option<String>,
    source: Option<SourceSpec>,
    state: PlayState,
    duration_ms: u64,
    fidelity: bool,
    eq_bands: Vec<(f64, f64)>,
    replay_gain_db: Option<f64>,
    /// honesty flag for the current render track
    fidelity_bypass: bool,
    feeds: HashMap<String, Arc<Feed>>,
    prefetch: Option<PrefetchState>,
    reported_prefetch_ready: bool,
}

struct PrefetchState {
    queue_id: String,
    source: SourceSpec,
    replay_gain_db: Option<f64>,
    ready: Arc<AtomicBool>,
}

/// Producer thread bookkeeping (join handle kept so abort can detach cleanly).
type ProducerHandle = std::thread::JoinHandle<()>;

/// Negotiated stream params + source meta for a track, without spawning.
struct TrackPlan {
    #[allow(dead_code)]
    src_rate: u32,
    #[allow(dead_code)]
    src_channels: u32,
    #[allow(dead_code)]
    src_depth: BitDepth,
    duration_ms: u64,
    neg: Negotiated,
    rplan: ResamplePlan,
    bypass: bool,
}

pub struct Engine {
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    decoder: Arc<dyn Decoder>,
    cfg: EngineConfig,
    core: Arc<Mutex<OutputCore>>,
    state: Mutex<EngineState>,
    sink: Mutex<Option<Box<dyn Sink>>>,
    caps: Mutex<Arc<dyn DeviceCaps>>,
    monitor_stop: Arc<AtomicBool>,
    producer: Mutex<Option<ProducerHandle>>,
    prefetch_producer: Mutex<Option<ProducerHandle>>,
    fft_cons: Consumer<f32>,
}

impl Engine {
    pub fn new(
        cfg: EngineConfig,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
        sink: Box<dyn Sink>,
        caps: Arc<dyn DeviceCaps>,
        fft_cons: Consumer<f32>,
        core: Arc<Mutex<OutputCore>>,
    ) -> Arc<Self> {
        let e = Engine {
            emit,
            decoder: Arc::new(FfmpegDecoder),
            cfg,
            core,
            state: Mutex::new(EngineState {
                generation: 0,
                queue_id: None,
                source: None,
                state: PlayState::Idle,
                duration_ms: 0,
                fidelity: false,
                eq_bands: Vec::new(),
                replay_gain_db: None,
                fidelity_bypass: false,
                feeds: HashMap::new(),
                prefetch: None,
                reported_prefetch_ready: false,
            }),
            sink: Mutex::new(Some(sink)),
            caps: Mutex::new(caps),
            monitor_stop: Arc::new(AtomicBool::new(false)),
            producer: Mutex::new(None),
            prefetch_producer: Mutex::new(None),
            fft_cons,
        };
        Arc::new(e)
    }

    /// Construct core + fft channel; caller passes both into Engine::new and
    /// sinks. Keeps tap capacity ~0.5s of output.
    pub fn make_core(
        negotiated: Negotiated,
        dump: Option<PathBuf>,
    ) -> (Arc<Mutex<OutputCore>>, Producer<f32>, Consumer<f32>) {
        let (tap_p, tap_c) = ringbuf::channel::<f32>(
            (negotiated.rate as usize * negotiated.channels as usize).max(4096) / 2,
        );
        let dump = dump.and_then(|p| {
            std::fs::File::create(&p)
                .map(std::io::BufWriter::new)
                .map_err(|e| eprintln!("null dump {}: {e}", p.display()))
                .ok()
        });
        (
            Arc::new(Mutex::new(OutputCore {
                negotiated,
                paused: true,
                volume: 1.0,
                active: None,
                next: None,
                frames_played: 0,
                events: VecDeque::new(),
                underrun: false,
                stalled: false,
                fft_tap: tap_p.clone(),
                dump,
            })),
            tap_p,
            tap_c,
        )
    }

    /// Spawn the monitor thread: position events ~10Hz, FFT ~20Hz, core events.
    pub fn start_monitor(self: &Arc<Self>) {
        let engine = Arc::clone(self);
        std::thread::Builder::new()
            .name("cadence-monitor".into())
            .spawn(move || engine.monitor_loop())
            .ok();
    }

    fn emit(&self, method: &str, params: Value) {
        (self.emit)(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
    }

    fn emit_state(&self, detail: Option<&str>) {
        let s = self.state.lock().unwrap();
        let mut p = json!({
            "generationId": s.generation,
            "state": s.state.as_str(),
        });
        if let Some(d) = detail {
            p["detail"] = json!(d);
        }
        drop(s);
        self.emit("event.state", p);
    }

    fn emit_output(&self) {
        let (neg, bypass) = {
            let c = self.core.lock().unwrap();
            let s = self.state.lock().unwrap();
            (c.negotiated.clone(), s.fidelity_bypass)
        };
        let bit_depth = match neg.kind {
            PcmKind::F32 => json!("float"),
            PcmKind::S32 => json!(32),
        };
        self.emit(
            "event.output",
            json!({
                "deviceName": neg.device_name,
                "sampleRateHz": neg.rate,
                "channels": neg.channels,
                "bitDepth": bit_depth,
                "exclusive": false,
                "fidelityBypass": bypass,
            }),
        );
    }

    fn emit_error(&self, queue_id: Option<&str>, message: &str, retriable: bool) {
        let gen = self.state.lock().unwrap().generation;
        let mut p = json!({
            "generationId": gen,
            "message": message,
            "retriable": retriable,
        });
        if let Some(q) = queue_id {
            p["queueId"] = json!(q);
        }
        self.emit("event.error", p);
    }

    // ------------------------- pipeline construction ----------------------

    /// Negotiate stream params for a source; returns (negotiated, bypass).
    fn negotiate(&self, src_rate: u32, src_channels: u32, src_depth: BitDepth) -> (Negotiated, bool) {
        let caps = self.caps.lock().unwrap().clone();
        let fidelity = self.state.lock().unwrap().fidelity;
        if fidelity {
            if let Some(kind) = caps.accepts(src_rate, src_channels, src_depth) {
                return (
                    Negotiated {
                        rate: src_rate,
                        channels: src_channels.min(caps.max_channels()),
                        kind,
                        device_name: caps.name(),
                    },
                    true,
                );
            }
        }
        (
            Negotiated {
                rate: caps.default_rate(),
                channels: caps.default_channels(),
                kind: caps.default_kind(),
                device_name: caps.name(),
            },
            false,
        )
    }

    fn plan_track(&self, src: &SourceSpec, seek_ms: u64) -> Result<TrackPlan> {
        let (src_rate, src_channels, src_depth, duration_ms) = match src {
            SourceSpec::File { path } => {
                let info = self.decoder.probe(path)?;
                (
                    info.sample_rate_hz,
                    info.channels,
                    info.bit_depth,
                    info.duration_ms.saturating_sub(seek_ms),
                )
            }
            SourceSpec::PcmStream {
                sample_rate_hz,
                channels,
                bit_depth,
            } => (*sample_rate_hz, *channels, *bit_depth, 0),
        };

        let (neg, mut bypass) = self.negotiate(src_rate, src_channels, src_depth);
        if !src_depth.preserved_by(neg.kind) {
            // negotiated format can't carry source bit-exactly -> not bypass
            bypass = false;
        }
        let (rplan, plan_bypass) =
            resample_plan(src_rate, neg.rate, self.state.lock().unwrap().fidelity, bypass);
        let bypass = bypass && plan_bypass;
        Ok(TrackPlan {
            src_rate,
            src_channels,
            src_depth,
            duration_ms,
            neg,
            rplan,
            bypass,
        })
    }

    /// Spawn a producer thread for `src`.
    /// When `rebuild_ok` is false and the track negotiates a different stream
    /// format than the live one, this fails with an "incompatible" error
    /// instead of rebuilding (used for prefetched successors: a format
    /// change there means the boundary can't be seamless).
    /// Returns (reader, handle, duration_ms, fidelity_bypass).
    fn spawn_pipeline(
        &self,
        queue_id: &str,
        src: SourceSpec,
        seek_ms: u64,
        rg_db: Option<f64>,
        rebuild_ok: bool,
    ) -> Result<(TrackReader, ProducerHandle, u64, bool)> {
        let plan = self.plan_track(&src, seek_ms)?;
        let duration_ms = plan.duration_ms;
        let neg = plan.neg;
        let rplan = plan.rplan;
        let bypass = plan.bypass;

        {
            let mut core = self.core.lock().unwrap();
            if core.negotiated != neg {
                if !rebuild_ok {
                    bail!(
                        "incompatible format for seamless transition: \
                         track wants {}Hz/{:?}, stream is {}Hz/{:?}",
                        neg.rate,
                        neg.kind,
                        core.negotiated.rate,
                        core.negotiated.kind
                    );
                }
                self.rebuild_stream_locked(&mut core, &neg)?;
            }
        }

        let capacity = (neg.rate as f32 * self.cfg.buffer_secs) as usize * neg.channels as usize;

        let ready = Arc::new(AtomicBool::new(false));
        let eq = self.state.lock().unwrap().eq_bands.clone();
        let decoder = Arc::clone(&self.decoder);
        let src2 = src.clone();
        let neg2 = neg.clone();
        let qid = queue_id.to_string();

        let (reader, join) = match neg.kind {
            PcmKind::F32 => {
                let (prod, cons) = ringbuf::channel::<f32>(capacity);
                let feed = self.ensure_feed(&src2, queue_id);
                let r = ready.clone();
                let qid_c = qid.clone();
                let join = std::thread::Builder::new()
                    .name(format!("decode:{qid}"))
                    .spawn(move || {
                        if let Err(e) = run_producer_f32(
                            &*decoder, src2, seek_ms, &neg2, rplan, eq, rg_db, feed, prod, r,
                        ) {
                            eprintln!("producer {qid_c}: {e:#}");
                        }
                    })?;
                (
                    TrackReader {
                        queue_id: qid.clone(),
                        duration_ms,
                        seek_offset_ms: seek_ms,
                        pipe: PipeReader::F32(cons),
                        ready,
                    },
                    join,
                )
            }
            PcmKind::S32 => {
                let (prod, cons) = ringbuf::channel::<i32>(capacity);
                let feed = self.ensure_feed(&src2, queue_id);
                let r = ready.clone();
                let qid_c = qid.clone();
                let join = std::thread::Builder::new()
                    .name(format!("decode:{qid}"))
                    .spawn(move || {
                        if let Err(e) =
                            run_producer_s32(&*decoder, src2, seek_ms, &neg2, feed, prod, r)
                        {
                            eprintln!("producer {qid_c}: {e:#}");
                        }
                    })?;
                (
                    TrackReader {
                        queue_id: qid.clone(),
                        duration_ms,
                        seek_offset_ms: seek_ms,
                        pipe: PipeReader::S32(cons),
                        ready,
                    },
                    join,
                )
            }
        };
        Ok((reader, join, duration_ms, bypass))
    }

    fn ensure_feed(&self, src: &SourceSpec, queue_id: &str) -> Option<Arc<Feed>> {
        if !matches!(src, SourceSpec::PcmStream { .. }) {
            return None;
        }
        let mut st = self.state.lock().unwrap();
        let feed = st
            .feeds
            .entry(queue_id.to_string())
            .or_insert_with(|| Arc::new(Feed {
                buf: Mutex::new(VecDeque::new()),
                cv: Condvar::new(),
                closed: AtomicBool::new(false),
            }))
            .clone();
        Some(feed)
    }

    /// Swap the output stream for a new negotiated format. Must be called
    /// with `core` locked. Pipelines are NOT preserved across a rate/format
    /// change — callers respawn them (see respawn_pipelines).
    fn rebuild_stream_locked(
        &self,
        core: &mut OutputCore,
        neg: &Negotiated,
    ) -> Result<()> {
        core.clear_all();
        let new_sink = crate::sink::open_sink(
            &self.cfg,
            Arc::clone(&self.caps.lock().unwrap()),
            neg,
            &self.core,
        )?;
        core.negotiated = neg.clone();
        *self.sink.lock().unwrap() = Some(new_sink);
        Ok(())
    }

    /// Rebuild caps for a device change and re-negotiate the stream, then
    /// respawn the current track at its position and the prefetch from 0.
    pub fn set_device(&self, name: Option<&str>) -> Result<Value> {
        let new_caps: Arc<dyn DeviceCaps> = if self.cfg.null_sink {
            crate::sink::initial_caps(&self.cfg)?
        } else {
            crate::sink::CpalCaps::new(name)?
        };
        *self.caps.lock().unwrap() = new_caps;
        // Default negotiated for the new device; next spawn refines it.
        let neg = {
            let caps = self.caps.lock().unwrap().clone();
            Negotiated {
                rate: caps.default_rate(),
                channels: caps.default_channels(),
                kind: caps.default_kind(),
                device_name: caps.name(),
            }
        };
        {
            let mut core = self.core.lock().unwrap();
            self.rebuild_stream_locked(&mut core, &neg)?;
        }
        self.respawn_pipelines();
        self.emit_output();
        Ok(json!({ "ok": true }))
    }

    pub fn list_devices(&self) -> Value {
        let caps = self.caps.lock().unwrap().clone();
        json!({ "devices": caps.list() })
    }

    /// After a stream rebuild: restart current track at its position and the
    /// prefetched successor from 0 (same device stream params permitting).
    fn respawn_pipelines(&self) {
        let (cur, prefetch) = {
            let st = self.state.lock().unwrap();
            (
                st.queue_id.clone().zip(st.source.clone()),
                st.prefetch.as_ref().map(|p| {
                    (p.queue_id.clone(), p.source.clone(), p.replay_gain_db)
                }),
            )
        };
        if let Some((qid, src)) = cur {
            let (pos, rg) = {
                let core = self.core.lock().unwrap();
                let st = self.state.lock().unwrap();
                (core.position_ms(), st.replay_gain_db)
            };
            match self.spawn_pipeline(&qid, src, pos, rg, true) {
                Ok((reader, handle, dur, bypass)) => {
                    self.core.lock().unwrap().set_active(reader);
                    *self.producer.lock().unwrap() = Some(handle);
                    let mut st = self.state.lock().unwrap();
                    st.duration_ms = dur;
                    st.fidelity_bypass = bypass;
                }
                Err(e) => self.emit_error(Some(&qid), &format!("{e:#}"), true),
            }
        }
        if let Some((qid, src, rg)) = prefetch {
            match self.spawn_pipeline(&qid, src.clone(), 0, rg, true) {
                Ok((reader, handle, _dur, _bypass)) => {
                    let ready = reader.ready.clone();
                    self.core.lock().unwrap().set_next(reader);
                    *self.prefetch_producer.lock().unwrap() = Some(handle);
                    let mut st = self.state.lock().unwrap();
                    st.prefetch = Some(PrefetchState {
                        queue_id: qid,
                        source: src,
                        replay_gain_db: rg,
                        ready,
                    });
                    st.reported_prefetch_ready = false;
                }
                Err(e) => self.emit_error(Some(&qid), &format!("{e:#}"), true),
            }
        }
    }

    // ------------------------------ commands -------------------------------

    pub fn ping(&self) -> Value {
        json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })
    }

    pub fn load(&self, p: LoadParams) -> Result<Value> {
        {
            let mut st = self.state.lock().unwrap();
            st.state = PlayState::Loading;
            st.generation = p.generation_id;
            st.queue_id = Some(p.queue_id.clone());
            st.source = Some(p.source.clone());
            st.replay_gain_db = p.replay_gain_db;
            // Unblock any producer still waiting on a previous feed.
            for (_, f) in st.feeds.drain() {
                f.close();
            }
        }
        self.emit_state(None);

        // stop any prefetch tied to the old generation
        self.abort_prefetch();

        let (reader, handle, duration_ms, bypass) = match self.spawn_pipeline(
            &p.queue_id,
            p.source.clone(),
            p.position_ms,
            p.replay_gain_db,
            true,
        ) {
            Ok(v) => v,
            Err(e) => {
                self.set_state(PlayState::Error);
                self.emit_state(Some(&format!("{e:#}")));
                self.emit_error(Some(&p.queue_id), &format!("{e:#}"), false);
                return Err(e);
            }
        };

        {
            let mut core = self.core.lock().unwrap();
            core.set_active(reader);
            core.paused = p.start_paused;
        }
        *self.producer.lock().unwrap() = Some(handle);

        {
            let mut st = self.state.lock().unwrap();
            st.duration_ms = duration_ms;
            st.fidelity_bypass = bypass;
            st.state = if p.start_paused {
                PlayState::Paused
            } else {
                PlayState::Playing
            };
        }
        self.emit_state(None);
        self.emit_output();
        let gen = self.state.lock().unwrap().generation;
        self.emit(
            "event.trackStarted",
            json!({
                "generationId": gen,
                "queueId": p.queue_id,
                "durationMs": duration_ms,
                "gapless": false,
            }),
        );

        let info = match &p.source {
            SourceSpec::File { path } => Some(self.decoder.probe(path)?),
            _ => None,
        };
        let mut result = json!({ "ok": true, "durationMs": duration_ms });
        if let Some(i) = info {
            result["sampleRateHz"] = json!(i.sample_rate_hz);
            result["channels"] = json!(i.channels);
            result["codec"] = json!(i.codec);
            result["bitDepth"] = serde_json::to_value(i.bit_depth)?;
        }
        Ok(result)
    }

    pub fn prefetch(&self, queue_id: &str, path: &str, rg_db: Option<f64>) -> Result<Value> {
        let src = SourceSpec::File { path: PathBuf::from(path) };
        // If the successor negotiates a different stream format (strict
        // fidelity + a native format the stream can't take), it cannot
        // render seamlessly — keep it as a reopen-on-boundary prefetch and
        // report gapless:false honestly when the time comes.
        let compatible = {
            let plan = self.plan_track(&src, 0)?;
            self.core.lock().unwrap().negotiated == plan.neg
        };
        if compatible {
            let (reader, handle, _dur, _bypass) =
                self.spawn_pipeline(queue_id, src.clone(), 0, rg_db, false)?;
            let ready = reader.ready.clone();
            {
                let mut core = self.core.lock().unwrap();
                core.set_next(reader);
            }
            *self.prefetch_producer.lock().unwrap() = Some(handle);
            let mut st = self.state.lock().unwrap();
            st.prefetch = Some(PrefetchState {
                queue_id: queue_id.to_string(),
                source: src,
                replay_gain_db: rg_db,
                ready,
            });
            st.reported_prefetch_ready = false;
        } else {
            let mut st = self.state.lock().unwrap();
            st.prefetch = Some(PrefetchState {
                queue_id: queue_id.to_string(),
                source: src,
                replay_gain_db: rg_db,
                // "ready" in the control sense: validated and reproducible
                ready: Arc::new(AtomicBool::new(true)),
            });
            st.reported_prefetch_ready = false;
        }
        Ok(json!({ "ok": true }))
    }

    pub fn play(&self, generation: u64) -> Result<Value> {
        self.check_gen(generation)?;
        let mut core = self.core.lock().unwrap();
        core.paused = false;
        drop(core);
        self.set_state(PlayState::Playing);
        self.emit_state(None);
        Ok(json!({ "ok": true }))
    }

    pub fn pause(&self, generation: u64) -> Result<Value> {
        self.check_gen(generation)?;
        let mut core = self.core.lock().unwrap();
        core.paused = true;
        drop(core);
        self.set_state(PlayState::Paused);
        self.emit_state(None);
        self.emit_position();
        Ok(json!({ "ok": true }))
    }

    pub fn stop(&self, generation: u64) -> Result<Value> {
        self.check_gen(generation)?;
        self.abort_prefetch();
        if let Some(h) = self.producer.lock().unwrap().take() {
            drop(h); // consumer abort happens via clear_all
        }
        {
            let mut core = self.core.lock().unwrap();
            core.clear_all();
            core.paused = true;
        }
        {
            let mut st = self.state.lock().unwrap();
            st.queue_id = None;
            st.source = None;
            st.duration_ms = 0;
            for (_, f) in st.feeds.drain() {
                f.close();
            }
        }
        self.set_state(PlayState::Stopped);
        self.emit_state(None);
        Ok(json!({ "ok": true }))
    }

    pub fn seek(&self, generation: u64, position_ms: u64) -> Result<Value> {
        self.check_gen(generation)?;
        let (queue_id, src, rg) = {
            let st = self.state.lock().unwrap();
            match (&st.queue_id, &st.source) {
                (Some(q), Some(s)) => (q.clone(), s.clone(), st.replay_gain_db),
                _ => bail!("nothing loaded"),
            }
        };
        let (reader, handle, duration_ms, bypass) =
            self.spawn_pipeline(&queue_id, src, position_ms, rg, true)?;
        {
            let mut core = self.core.lock().unwrap();
            core.set_active(reader);
        }
        *self.producer.lock().unwrap() = Some(handle);
        {
            let mut st = self.state.lock().unwrap();
            st.duration_ms = duration_ms;
            st.fidelity_bypass = bypass;
        }
        self.emit_position();
        Ok(json!({ "ok": true, "positionMs": position_ms }))
    }

    pub fn set_volume(&self, volume: f64) -> Result<Value> {
        let v = volume.clamp(0.0, 1.5) as f32;
        self.core.lock().unwrap().volume = v;
        Ok(json!({ "ok": true }))
    }

    pub fn set_fidelity_mode(&self, enabled: bool) -> Result<Value> {
        {
            self.state.lock().unwrap().fidelity = enabled;
        }
        // Rebuild current + prefetch pipelines under the new rules.
        self.respawn_pipelines();
        self.emit_output();
        Ok(json!({ "ok": true }))
    }

    pub fn set_eq(&self, bands: &[(f64, f64)]) -> Result<Value> {
        self.state.lock().unwrap().eq_bands = bands.to_vec();
        // Pipelines read EQ at construction, so restart the current pipeline
        // at its position to apply changes immediately. Skipped on bypass.
        let bypass = self.state.lock().unwrap().fidelity_bypass;
        if !bypass {
            self.respawn_pipelines();
        }
        Ok(json!({ "ok": true }))
    }

    pub fn feed(&self, queue_id: &str, data: &[u8], is_final: bool) -> Result<Value> {
        let feed = {
            let st = self.state.lock().unwrap();
            st.feeds.get(queue_id).cloned()
        };
        match feed {
            Some(f) => {
                f.push(data);
                if is_final {
                    f.close();
                }
                Ok(json!({ "ok": true }))
            }
            None => Err(anyhow!("no pcm-stream loaded for queueId {queue_id}")),
        }
    }

    fn check_gen(&self, generation: u64) -> Result<()> {
        let cur = self.state.lock().unwrap().generation;
        if generation != cur {
            bail!("stale generation {generation} (current {cur})");
        }
        Ok(())
    }

    fn set_state(&self, s: PlayState) {
        self.state.lock().unwrap().state = s;
    }

    fn abort_prefetch(&self) {
        {
            let mut core = self.core.lock().unwrap();
            if let Some(old) = core.next.take() {
                old.pipe.abort();
            }
        }
        if let Some(h) = self.prefetch_producer.lock().unwrap().take() {
            drop(h);
        }
        let mut st = self.state.lock().unwrap();
        st.prefetch = None;
        st.reported_prefetch_ready = false;
    }

    fn emit_position(&self) {
        let (pos, dur, gen) = {
            let core = self.core.lock().unwrap();
            let st = self.state.lock().unwrap();
            (core.position_ms(), st.duration_ms, st.generation)
        };
        self.emit(
            "event.position",
            json!({
                "generationId": gen,
                "positionMs": pos,
                "durationMs": dur,
                "atMs": now_ms(),
            }),
        );
    }

    // ------------------------------ monitor ---------------------------------

    fn monitor_loop(&self) {
        let (mut nch, mut rate) = {
            let c = self.core.lock().unwrap();
            (
                c.negotiated.channels.max(1) as usize,
                c.negotiated.rate,
            )
        };
        let mut fft = FftAnalyzer::new(rate);
        let mut last_fft_emit = std::time::Instant::now() - std::time::Duration::from_millis(100);
        let mut last_pos_emit = std::time::Instant::now();
        let mut mono_buf = Vec::with_capacity(8192);
        let mut tap_buf = vec![0f32; 8192];

        while !self.monitor_stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(20));

            // negotiated format may change on device/fidelity rebuild
            {
                let core = self.core.lock().unwrap();
                if core.negotiated.rate != rate || core.negotiated.channels as usize != nch {
                    rate = core.negotiated.rate;
                    nch = core.negotiated.channels.max(1) as usize;
                    fft = FftAnalyzer::new(rate);
                    tap_buf = vec![0f32; 8192.max(nch * 4096)];
                }
            }

            // drain core events
            let events: Vec<CoreEvent> = {
                let mut core = self.core.lock().unwrap();
                core.events.drain(..).collect()
            };
            for ev in events {
                match ev {
                    CoreEvent::Boundary {
                        ended_queue_id,
                        started_queue_id,
                        started_duration_ms,
                        started_seek_offset_ms,
                    } => {
                        let gen = {
                            let mut st = self.state.lock().unwrap();
                            st.queue_id = Some(started_queue_id.clone());
                            st.duration_ms = started_duration_ms;
                            let _ = started_seek_offset_ms;
                            st.generation
                        };
                        self.emit(
                            "event.trackEnded",
                            json!({
                                "generationId": gen,
                                "queueId": ended_queue_id,
                                "gapless": true,
                            }),
                        );
                        self.emit(
                            "event.trackStarted",
                            json!({
                                "generationId": gen,
                                "queueId": started_queue_id,
                                "durationMs": started_duration_ms,
                                "gapless": true,
                            }),
                        );
                        // promoted prefetch slot consumed
                        let mut st = self.state.lock().unwrap();
                        st.prefetch = None;
                        st.reported_prefetch_ready = false;
                    }
                    CoreEvent::Ended { queue_id } => {
                        let gen = {
                            let mut st = self.state.lock().unwrap();
                            st.queue_id = None;
                            st.generation
                        };
                        self.emit(
                            "event.trackEnded",
                            json!({
                                "generationId": gen,
                                "queueId": queue_id,
                                "gapless": false,
                            }),
                        );
                        // A prefetched successor that couldn't share the
                        // stream (format reopen required) starts here —
                        // honestly NOT gapless.
                        let pf = self.state.lock().unwrap().prefetch.take();
                        if let Some(pf) = pf {
                            match self.spawn_pipeline(&pf.queue_id, pf.source.clone(), 0, pf.replay_gain_db, true) {
                                Ok((reader, handle, dur, bypass)) => {
                                    {
                                        let mut core = self.core.lock().unwrap();
                                        core.set_active(reader);
                                        core.paused = false;
                                    }
                                    *self.producer.lock().unwrap() = Some(handle);
                                    {
                                        let mut st = self.state.lock().unwrap();
                                        st.queue_id = Some(pf.queue_id.clone());
                                        st.source = Some(pf.source);
                                        st.duration_ms = dur;
                                        st.fidelity_bypass = bypass;
                                        st.state = PlayState::Playing;
                                    }
                                    self.emit_state(None);
                                    self.emit_output();
                                    self.emit(
                                        "event.trackStarted",
                                        json!({
                                            "generationId": gen,
                                            "queueId": pf.queue_id,
                                            "durationMs": dur,
                                            "gapless": false,
                                        }),
                                    );
                                    continue;
                                }
                                Err(e) => {
                                    self.emit_error(Some(&pf.queue_id), &format!("{e:#}"), true);
                                }
                            }
                        }
                        self.set_state(PlayState::Stopped);
                        self.emit_state(None);
                    }
                }
            }

            // underrun -> buffering (once per stall)
            {
                let (underrun, qid) = {
                    let core = self.core.lock().unwrap();
                    let st = self.state.lock().unwrap();
                    (core.underrun, st.queue_id.clone())
                };
                if underrun {
                    if let Some(q) = qid {
                        let gen = self.state.lock().unwrap().generation;
                        self.emit(
                            "event.buffering",
                            json!({ "generationId": gen, "queueId": q }),
                        );
                        self.core.lock().unwrap().underrun = false;
                    }
                }
            }

            // prefetch readiness
            {
                let st = self.state.lock().unwrap();
                if !st.reported_prefetch_ready {
                    if let Some(pf) = &st.prefetch {
                        if pf.ready.load(Ordering::Acquire) {
                            let gen = st.generation;
                            let qid = pf.queue_id.clone();
                            drop(st);
                            self.emit(
                                "event.prefetchReady",
                                json!({ "generationId": gen, "queueId": qid }),
                            );
                            self.state.lock().unwrap().reported_prefetch_ready = true;
                        }
                    }
                }
            }

            // FFT tap -> event.fft ~20Hz while playing
            let playing = self.state.lock().unwrap().state == PlayState::Playing;
            let n = self.fft_cons.read(&mut tap_buf);
            if playing && n > 0 {
                mono_buf.clear();
                for f in 0..(n / nch) {
                    let mut acc = 0f32;
                    for ch in 0..nch {
                        acc += tap_buf[f * nch + ch];
                    }
                    mono_buf.push(acc / nch as f32);
                }
                if let Some(frame) = fft.push(&mono_buf) {
                    if last_fft_emit.elapsed() >= std::time::Duration::from_millis(45) {
                        last_fft_emit = std::time::Instant::now();
                        let gen = self.state.lock().unwrap().generation;
                        self.emit(
                            "event.fft",
                            json!({
                                "generationId": gen,
                                "bands": frame.bands.to_vec(),
                                "peak": frame.peak,
                                "atMs": now_ms(),
                            }),
                        );
                    }
                }
            }

            // device loss -> honest error + stop
            if let Some(msg) = self.caps.lock().unwrap().device_error() {
                self.emit_error(None, &format!("output device lost: {msg}"), false);
                {
                    let mut core = self.core.lock().unwrap();
                    core.clear_all();
                    core.paused = true;
                }
                self.set_state(PlayState::Error);
                self.emit_state(Some("device lost"));
            }

            // position ~10Hz while playing
            if playing && last_pos_emit.elapsed() >= std::time::Duration::from_millis(100) {
                last_pos_emit = std::time::Instant::now();
                self.emit_position();
            }
        }
    }

    pub fn shutdown(&self) {
        self.monitor_stop.store(true, Ordering::Release);
        let mut core = self.core.lock().unwrap();
        core.clear_all();
        if let Some(d) = core.dump.as_mut() {
            use std::io::Write;
            let _ = d.flush();
        }
        drop(core);
        if let Some(mut s) = self.sink.lock().unwrap().take() {
            s.stop();
        }
    }
}

// ---------------------------------------------------------------------------
// producer threads
// ---------------------------------------------------------------------------

/// File -> read f32 -> DSP -> resample -> ring.
fn run_producer_f32(
    decoder: &dyn Decoder,
    src: SourceSpec,
    seek_ms: u64,
    neg: &Negotiated,
    rplan: ResamplePlan,
    eq_bands: Vec<(f64, f64)>,
    rg_db: Option<f64>,
    feed: Option<Arc<Feed>>,
    prod: Producer<f32>,
    ready: Arc<AtomicBool>,
) -> Result<()> {
    let bypass = matches!(rplan, ResamplePlan::Passthrough) && eq_bands.is_empty() && rg_db.is_none();
    let _ = bypass;

    let mut resampler = match rplan {
        ResamplePlan::Passthrough => None,
        ResamplePlan::Resample { from, to } => {
            Some(StreamingResampler::new(from, to, neg.channels as usize)?)
        }
    };

    // Processing rate: source rate (DSP runs pre-resample).
    let src_rate = match rplan {
        ResamplePlan::Resample { from, .. } => from,
        ResamplePlan::Passthrough => neg.rate,
    };
    let mut dsp = Dsp::new(&eq_bands, rg_db, src_rate, neg.channels as usize);

    let mut inbuf = vec![0f32; 8192];
    // whole frames only
    let ch = neg.channels as usize;
    let mut out: Vec<f32> = Vec::with_capacity(16384);
    let mut first = true;

    macro_rules! pump {
        ($frames:expr) => {{
            let frames = &mut $frames;
            dsp.apply(frames);
            out.clear();
            match resampler.as_mut() {
                Some(rs) => {
                    rs.push(frames, &mut out)?;
                }
                None => out.extend_from_slice(frames),
            }
            if !out.is_empty() && !prod.write_all(&out) {
                return Ok(()); // aborted
            }
            if first && !out.is_empty() {
                ready.store(true, Ordering::Release);
                first = false;
            }
        }};
    }

    match (&src, feed) {
        (SourceSpec::File { path }, _) => {
            let mut stream = decoder.open(&DecodeRequest {
                path: path.clone(),
                seek_ms,
                kind: PcmKind::F32,
                channels: Some(neg.channels),
            })?;
            loop {
                let n = stream.read_f32(&mut inbuf)?;
                if n == 0 {
                    break;
                }
                let n = n - (n % ch);
                pump!(&mut inbuf[..n]);
            }
        }
        (SourceSpec::PcmStream {
             bit_depth,
             channels: src_ch,
             ..
         }, Some(feed)) => {
            let mut raw = vec![0u8; 8192 * 4];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                let n = feed.read(&mut raw);
                if n == 0 {
                    break;
                }
                carry.extend_from_slice(&raw[..n]);
                let mut frames = bytes_to_f32(&carry, *bit_depth, *src_ch as usize);
                let whole = frames.len() - (frames.len() % (*src_ch as usize).max(1));
                frames.truncate(whole);
                let consumed = pcm_bytes_len(whole, *bit_depth);
                carry.drain(..consumed.min(carry.len()));
                let mut remapped = remap_channels(&frames, *src_ch as usize, ch);
                if !remapped.is_empty() {
                    pump!(&mut remapped);
                }
            }
            // trailing bytes that don't make a whole sample are dropped.
        }
        (SourceSpec::PcmStream { .. }, None) => {
            return Err(anyhow!("pcm-stream source without feed channel"));
        }
    }

    out.clear();
    if let Some(rs) = resampler.as_mut() {
        rs.finish(&mut out)?;
    }
    if !out.is_empty() {
        prod.write_all(&out);
    }
    ready.store(true, Ordering::Release);
    prod.finish();
    Ok(())
}

/// -> read s32 -> ring. Only used for fidelity-bypass streams; no DSP.
/// Supports files (ffmpeg s32le) and Int(32) pcm-stream feeds (bytes are
/// already s32le — passed through bit-exact).
fn run_producer_s32(
    decoder: &dyn Decoder,
    src: SourceSpec,
    seek_ms: u64,
    neg: &Negotiated,
    feed: Option<Arc<Feed>>,
    prod: Producer<i32>,
    ready: Arc<AtomicBool>,
) -> Result<()> {
    let ch = neg.channels as usize;
    let mut first = true;
    macro_rules! emit {
        ($buf:expr) => {{
            let b: &[i32] = $buf;
            if !b.is_empty() && !prod.write_all(b) {
                return Ok(());
            }
            if first && !b.is_empty() {
                ready.store(true, Ordering::Release);
                first = false;
            }
        }};
    }
    match (&src, feed) {
        (SourceSpec::File { path }, _) => {
            let mut stream = decoder.open(&DecodeRequest {
                path: path.clone(),
                seek_ms,
                kind: PcmKind::S32,
                channels: Some(ch as u32),
            })?;
            let mut inbuf = vec![0i32; 8192];
            loop {
                let n = stream.read_s32(&mut inbuf)?;
                if n == 0 {
                    break;
                }
                let n = n - (n % ch);
                emit!(&inbuf[..n]);
            }
        }
        (SourceSpec::PcmStream {
             bit_depth,
             channels: src_ch,
             ..
         }, Some(feed)) => {
            let mut raw = vec![0u8; 8192 * 4];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                let n = feed.read(&mut raw);
                if n == 0 {
                    break;
                }
                carry.extend_from_slice(&raw[..n]);
                let frames = bytes_to_i32(&carry, *bit_depth, *src_ch as usize);
                let whole = frames.len() - (frames.len() % (*src_ch as usize).max(1));
                let consumed = pcm_bytes_len(whole, *bit_depth);
                carry.drain(..consumed.min(carry.len()));
                let remapped = remap_channels(&frames[..whole], *src_ch as usize, ch);
                emit!(&remapped);
            }
        }
        (SourceSpec::PcmStream { .. }, None) => {
            return Err(anyhow!("pcm-stream source without feed channel"));
        }
    }
    prod.finish();
    Ok(())
}

/// Convert little-endian PCM bytes to f32 samples for the declared depth.
fn bytes_to_f32(bytes: &[u8], depth: BitDepth, _src_ch: usize) -> Vec<f32> {
    match depth {
        BitDepth::Float | BitDepth::Int(32) => bytes
            .chunks_exact(4)
            .map(|c| {
                if matches!(depth, BitDepth::Float) {
                    f32::from_le_bytes([c[0], c[1], c[2], c[3]])
                } else {
                    i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / i32::MAX as f32
                }
            })
            .collect(),
        BitDepth::Int(24) => bytes
            .chunks_exact(3)
            .map(|c| {
                let v = (c[0] as i32) | ((c[1] as i32) << 8) | ((c[2] as i32) << 16);
                let v = if v & 0x800000 != 0 { v | !0xFFFFFF } else { v };
                v as f32 / 8388607.0
            })
            .collect(),
        _ => bytes // 16-bit and anything narrower
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / i16::MAX as f32)
            .collect(),
    }
}

/// Convert little-endian PCM bytes to s32 samples for the fidelity path.
fn bytes_to_i32(bytes: &[u8], depth: BitDepth, _src_ch: usize) -> Vec<i32> {
    match depth {
        BitDepth::Float => bytes
            .chunks_exact(4)
            .map(|c| (f32::from_le_bytes([c[0], c[1], c[2], c[3]]) * i32::MAX as f32) as i32)
            .collect(),
        BitDepth::Int(32) => bytes
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
        BitDepth::Int(24) => bytes
            .chunks_exact(3)
            .map(|c| {
                let v = (c[0] as i32) | ((c[1] as i32) << 8) | ((c[2] as i32) << 16);
                (if v & 0x800000 != 0 { v | !0xFFFFFF } else { v }) << 8
            })
            .collect(),
        _ => bytes
            .chunks_exact(2)
            .map(|c| (i16::from_le_bytes([c[0], c[1]]) as i32) << 16)
            .collect(),
    }
}

/// Sample math for channel remixing.
trait RemixSample: Copy + Default {
    fn to_f64(self) -> f64;
    fn from_f64(v: f64) -> Self;
}
impl RemixSample for f32 {
    fn to_f64(self) -> f64 {
        self as f64
    }
    fn from_f64(v: f64) -> Self {
        v as f32
    }
}
impl RemixSample for i32 {
    fn to_f64(self) -> f64 {
        self as f64 / i32::MAX as f64
    }
    fn from_f64(v: f64) -> Self {
        (v * i32::MAX as f64).clamp(i32::MIN as f64, i32::MAX as f64) as i32
    }
}

/// Remap interleaved samples between channel counts.
/// same -> copy; 1->N duplicate; N->1 average; else truncate/zero-pad.
fn remap_channels<T: RemixSample>(input: &[T], src_ch: usize, dst_ch: usize) -> Vec<T> {
    if src_ch == dst_ch || src_ch == 0 {
        return input.to_vec();
    }
    let frames = input.len() / src_ch;
    let mut out = Vec::with_capacity(frames * dst_ch);
    for f in 0..frames {
        let frame = &input[f * src_ch..(f + 1) * src_ch];
        if dst_ch == 1 {
            let sum = frame.iter().fold(0f64, |a, s| a + s.to_f64());
            out.push(T::from_f64(sum / src_ch as f64));
        } else if src_ch == 1 {
            for _ in 0..dst_ch {
                out.push(frame[0]);
            }
        } else {
            for c in 0..dst_ch {
                out.push(*frame.get(c).unwrap_or(&T::default()));
            }
        }
    }
    out
}

/// Bytes consumed by `n` samples in the declared depth.
fn pcm_bytes_len(n_samples: usize, depth: BitDepth) -> usize {
    let bps = match depth {
        BitDepth::Float | BitDepth::Int(32) => 4,
        BitDepth::Int(24) => 3,
        _ => 2,
    };
    n_samples * bps
}
