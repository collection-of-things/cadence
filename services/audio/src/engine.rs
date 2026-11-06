//! The playback engine: one PCM graph from decode to output.
//!
//! graph:  decode -> DSP (EQ + ReplayGain, skipped on bypass) -> resample
//!         -> bounded ring buffer -> output callback pull -> FFT tap -> device
//!
//! The output callback only pops samples, applies volume, and taps the
//! FFT/dump rings. Decode/DSP/resample/alloc all happen on producer threads.
//! The device callback takes the core lock with try_lock + a silent fallback;
//! control threads never hold `core` across device opens (rebuild_stream
//! drops/opens sinks outside the lock), so the callback's worst-case wait is
//! one brief critical section — bounded, documented, non-allocating.

use crate::decode::{AudioInfo, BitDepth, DecodeRequest, Decoder, FfmpegDecoder, PcmKind};
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

static NEXT_TRACK_INSTANCE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

/// Reader + track metadata carried through the render chain.
struct TrackReader {
    /// Unique per spawned pipeline — lets the monitor tell a stale queued
    /// event (pre-seek/pre-load) apart from one belonging to the live track.
    instance: u64,
    queue_id: String,
    duration_ms: u64,
    /// source-time offset this pipeline decodes from (for position math)
    seek_offset_ms: u64,
    pipe: PipeReader,
    /// this reader's own fidelity-bypass flag — promotion must adopt it
    /// (the successor may be non-bypass on the same stream format)
    bypass: bool,
    /// the negotiated format this reader renders — installs verify the
    /// stream still matches so a concurrent rebuild can't pin an
    /// old-format reader onto a new stream
    neg: Negotiated,
    /// set by producer once it has buffered data or finished
    ready: Arc<AtomicBool>,
}

/// Events the output thread cannot emit itself; drained by the monitor.
#[derive(Debug)]
enum CoreEvent {
    /// Active track drained; prefetched track took over on the same stream.
    Boundary {
        ended_queue_id: String,
        ended_instance: u64,
        started_queue_id: String,
        started_instance: u64,
        started_duration_ms: u64,
        started_seek_offset_ms: u64,
        /// the promoted reader's own fidelity-bypass flag
        started_bypass: bool,
    },
    /// Active track drained with nothing behind it.
    Ended { queue_id: String, instance: u64 },
}

/// Bound on queued CoreEvents. Track-boundary events are rare and the
/// monitor drains them every 20ms; 64 is unreachable in practice. The
/// VecDeque is created with this capacity, so pushes below the cap never
/// allocate on the callback thread.
const MAX_CORE_EVENTS: usize = 64;

/// Bound on retired track readers awaiting reclamation. Track ends are
/// seconds apart and the monitor drains this every 20ms; 8 is
/// unreachable in practice. The VecDeque is created with this capacity,
/// so pushes below the cap never allocate on the callback thread.
const MAX_RETIRED_READERS: usize = 8;

/// Rendered-sample dump: the callback taps f32 into a ring (drop-on-full);
/// a writer thread does the file I/O so the callback never touches the
/// filesystem. Under --null-fast the writer can fall behind and samples are
/// dropped — the dump stays lossless at real-time pacing, which is what the
/// probe and tests use.
struct Dump {
    tap: Producer<f32>,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Dump {
    /// Signal the writer thread and join it (flushes the BufWriter).
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for Dump {
    fn drop(&mut self) {
        self.stop();
    }
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
    /// Ended readers parked for the monitor to drop. A TrackReader owns
    /// its ring buffer (~buffer_secs of samples) — freeing that inside
    /// the audio callback is an RT violation, so advance_track moves
    /// ownership here instead and the monitor reclaims it off-thread.
    retired: VecDeque<TrackReader>,
    /// a buffering notification is pending for the monitor thread
    underrun: bool,
    /// currently inside a stall episode (latch, avoids event spam)
    stalled: bool,
    /// bumped on every pull-side track boundary (promotion or end) —
    /// command paths use it to detect a boundary landing mid-respawn,
    /// including ones whose event is still in flight to the monitor
    boundary_seq: u64,
    /// the last track ended with nothing behind it — set by advance_track,
    /// cleared when a new track is installed. Distinguishes "active is
    /// None because playback ended" from "active is None because a
    /// rebuild cleared it".
    ended_pending: bool,
    /// a stream rebuild is between clear_all and the negotiated commit —
    /// readers spawned or installed in this window would attach to a
    /// format that is about to change.
    rebuilding: bool,
    fft_tap: Producer<f32>,
    /// optional f32le dump tap of everything rendered (null-sink diagnostics)
    dump: Option<Dump>,
    /// reusable f32 scratch for pull_s16 (preallocated, grows once)
    scratch16: Vec<f32>,
}

impl OutputCore {
    /// Fill `out` with f32 output samples. Hot path: pops ring, applies
    /// volume, taps FFT + dump rings (drop-on-full). No allocation and no
    /// blocking I/O — safe to call on the device callback thread. Zero-fills
    /// on underrun/pause.
    pub fn pull_f32(&mut self, out: &mut [f32]) {
        if self.paused || self.rebuilding {
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
                        out[filled + i] = tmp[i] as f32 / 2147483648.0f32;
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
        // FFT taps the source level BEFORE volume — muting or turning the
        // volume down must not starve the visualizer.
        let _ = self.fft_tap.write(out);
        let vol = self.volume;
        if (vol - 1.0).abs() > f32::EPSILON {
            for s in out.iter_mut() {
                *s *= vol;
            }
        }
        if let Some(d) = &self.dump {
            let _ = d.tap.write(out);
        }
    }

    /// Fill `out` with s32 output samples (fidelity-bypass streams).
    pub fn pull_s32(&mut self, out: &mut [i32]) {
        if self.paused || self.rebuilding {
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
                        out[filled + i] = (tmp[i] as f64 * 2147483648.0)
                            .round()
                            .clamp(i32::MIN as f64, i32::MAX as f64)
                            as i32;
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
        // tap FFT (pre-volume, as in pull_f32) + dump with f32-converted
        // samples — bounded writes, drop on full.
        let mut tap = [0f32; 2048];
        let mut i = 0;
        while i < out.len() {
            let n = (out.len() - i).min(tap.len());
            for j in 0..n {
                tap[j] = out[i + j] as f32 / 2147483648.0f32;
            }
            let _ = self.fft_tap.write(&tap[..n]);
            i += n;
        }
        let vol = self.volume;
        if (vol - 1.0).abs() > f32::EPSILON {
            for s in out.iter_mut() {
                *s = (*s as f64 * vol as f64).clamp(i32::MIN as f64, i32::MAX as f64) as i32;
            }
        }
        if let Some(d) = &self.dump {
            let mut i = 0;
            while i < out.len() {
                let n = (out.len() - i).min(tap.len());
                for j in 0..n {
                    tap[j] = out[i + j] as f32 / 2147483648.0f32;
                }
                let _ = d.tap.write(&tap[..n]);
                i += n;
            }
        }
    }

    /// Fill `out` with i16 samples for devices whose only supported formats
    /// are s16. Renders through pull_f32 (volume, FFT + dump taps all apply),
    /// then converts with round + clip. The scratch buffer is preallocated
    /// so the real-time path does not allocate after warmup.
    pub fn pull_s16(&mut self, out: &mut [i16]) {
        let mut tmp = std::mem::take(&mut self.scratch16);
        // Grow-only: after warmup the capacity covers every callback size,
        // so the RT path never allocates.
        if tmp.len() < out.len() {
            tmp.resize(out.len(), 0.0);
        }
        self.pull_f32(&mut tmp[..out.len()]);
        for (i, s) in tmp[..out.len()].iter().enumerate() {
            // ffmpeg's s16<->f32 convention scales by 2^15: s16-representable
            // values round-trip exactly. (32768.0, not i16::MAX.)
            out[i] = (*s * 32768.0)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
        self.scratch16 = tmp;
    }

    /// Active track drained: promote `next` (gapless) or end. Returns true if
    /// a new track took over on the same stream.
    fn advance_track(&mut self) -> bool {
        self.boundary_seq += 1;
        let mut ended = self.active.take().unwrap();
        // Move the queue id into the event without cloning (no RT alloc)
        // and park the reader for the monitor to reclaim.
        let ended_queue_id = std::mem::take(&mut ended.queue_id);
        let ended_instance = ended.instance;
        self.retire(ended);
        if let Some(next) = self.next.take() {
            self.push_event(CoreEvent::Boundary {
                ended_queue_id,
                ended_instance,
                started_queue_id: next.queue_id.clone(),
                started_instance: next.instance,
                started_duration_ms: next.duration_ms,
                started_seek_offset_ms: next.seek_offset_ms,
                started_bypass: next.bypass,
            });
            self.frames_played = 0;
            self.active = Some(next);
            self.underrun = false;
            true
        } else {
            self.ended_pending = true;
            self.push_event(CoreEvent::Ended {
                queue_id: ended_queue_id,
                instance: ended_instance,
            });
            false
        }
    }

    /// Park an ended reader for reclamation by the monitor thread. Bounded;
    /// the drop-on-full fallback frees one ring inline — the same cost the
    /// engine always paid, now only reachable if the monitor stalls.
    fn retire(&mut self, track: TrackReader) {
        if self.retired.len() >= MAX_RETIRED_READERS {
            self.retired.pop_front();
        }
        self.retired.push_back(track);
    }

    /// Queue an event for the monitor. Bounded: drops rather than growing
    /// past MAX_CORE_EVENTS (the VecDeque was preallocated, so in-bounds
    /// pushes never allocate on the callback thread).
    fn push_event(&mut self, ev: CoreEvent) {
        if self.events.len() < MAX_CORE_EVENTS {
            self.events.push_back(ev);
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
        self.ended_pending = false;
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
///
/// Bounded: `push` blocks while the buffer is full and fails after
/// `PUSH_TIMEOUT`, so audio.feed applies real backpressure to the JSON-RPC
/// caller instead of growing memory without bound (e.g. a paused stream).
/// The wait is interruptible by `close`/`abort`.
pub struct Feed {
    buf: Mutex<VecDeque<u8>>,
    cv: Condvar,
    closed: AtomicBool,
}

impl Feed {
    /// ~4 MiB ≈ 23s of 44.1kHz/16-bit stereo PCM.
    const CAP: usize = 4 * 1024 * 1024;
    /// How long a push may wait for drain before erroring.
    const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

    /// Append bytes atomically, blocking while the buffer is at CAP. On
    /// timeout the appended prefix is rolled back — a partially-accepted
    /// chunk would misalign every later byte in the stream.
    fn push(&self, bytes: &[u8]) -> Result<()> {
        let mut buf = self.buf.lock().unwrap();
        let deadline = std::time::Instant::now() + Self::PUSH_TIMEOUT;
        let mut off = 0;
        while off < bytes.len() {
            if self.closed.load(Ordering::Acquire) {
                buf.drain(..off);
                bail!("feed closed");
            }
            let space = Self::CAP.saturating_sub(buf.len());
            if space > 0 {
                let n = space.min(bytes.len() - off);
                buf.extend(bytes[off..off + n].iter().copied());
                off += n;
                self.cv.notify_all();
                continue;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                buf.drain(..off);
                bail!("feed full: no drain within {}ms", Self::PUSH_TIMEOUT.as_millis());
            }
            let (g, t) = self.cv.wait_timeout(buf, deadline - now).unwrap();
            buf = g;
            if t.timed_out() {
                buf.drain(..off);
                bail!("feed full: no drain within {}ms", Self::PUSH_TIMEOUT.as_millis());
            }
        }
        Ok(())
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.cv.notify_all();
    }
    /// Discard buffered bytes and close immediately.
    fn abort(&self) {
        self.buf.lock().unwrap().clear();
        self.close();
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
                // space opened up: wake any push waiting on a full buffer
                self.cv.notify_all();
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
    /// Instance id of the live track — stale queued events carry the old
    /// instance and get dropped instead of clobbering fresh state.
    current_instance: u64,
    source: Option<SourceSpec>,
    state: PlayState,
    duration_ms: u64,
    fidelity: bool,
    eq_bands: Vec<(f64, f64)>,
    /// ReplayGain user toggle — tag gains are only applied when enabled.
    /// Off by default: mpv-style transparent loudness.
    replay_gain: bool,
    replay_gain_db: Option<f64>,
    /// A native-format stream that failed to open once on this device —
    /// plans skip it until the backoff expires (a transient failure
    /// shouldn't downgrade the format for the whole session). Also
    /// cleared on set_device and on a successful open at the same format.
    native_failed: Option<(Negotiated, std::time::Instant)>,
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
    /// the generation that armed it — a slot from an older generation
    /// must never reopen against a newer track's end
    generation: u64,
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
    /// True when `neg` came from the device's native acceptance of the
    /// source format (not the device default). Lets the spawn path fall
    /// back to the default negotiation if that stream won't open.
    native: bool,
    /// Probe result for file sources — threaded into DecodeRequest so the
    /// producer's ffmpeg spawn doesn't re-run ffprobe.
    info: Option<AudioInfo>,
}

pub struct Engine {
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    decoder: Arc<dyn Decoder>,
    cfg: EngineConfig,
    core: Arc<Mutex<OutputCore>>,
    state: Mutex<EngineState>,
    sink: Mutex<Option<Box<dyn Sink>>>,
    /// Serializes stream rebuilds (set_device / fidelity / format mismatch)
    /// so two of them can never interleave a sink swap.
    stream_mu: Mutex<()>,
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
                current_instance: 0,
                source: None,
                state: PlayState::Idle,
                duration_ms: 0,
                fidelity: false,
                eq_bands: Vec::new(),
                replay_gain: false,
                replay_gain_db: None,
                native_failed: None,
                fidelity_bypass: false,
                feeds: HashMap::new(),
                prefetch: None,
                reported_prefetch_ready: false,
            }),
            sink: Mutex::new(Some(sink)),
            stream_mu: Mutex::new(()),
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
        let dump = dump.and_then(|p| Self::spawn_dump_writer(&p, &negotiated));
        (
            Arc::new(Mutex::new(OutputCore {
                negotiated,
                paused: true,
                volume: 1.0,
                active: None,
                next: None,
                frames_played: 0,
                events: VecDeque::with_capacity(MAX_CORE_EVENTS),
                retired: VecDeque::with_capacity(MAX_RETIRED_READERS),
                underrun: false,
                stalled: false,
                boundary_seq: 0,
                ended_pending: false,
                rebuilding: false,
                fft_tap: tap_p.clone(),
                dump,
                scratch16: Vec::new(),
            })),
            tap_p,
            tap_c,
        )
    }

    /// Spawn the dump writer thread: drains the dump tap ring into a
    /// BufWriter. Runs until `stop` is set AND the ring is empty; flushes on
    /// exit (also via BufWriter's Drop).
    fn spawn_dump_writer(path: &PathBuf, neg: &Negotiated) -> Option<Dump> {
        let file = match std::fs::File::create(path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("null dump {}: {e}", path.display());
                return None;
            }
        };
        // ~2s of output; large enough that a real-time-paced render never
        // drops samples into the dump.
        let cap = (neg.rate as usize * neg.channels.max(1) as usize * 2).max(65536);
        let (tap, cons) = ringbuf::channel::<f32>(cap);
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);
        let join = std::thread::Builder::new()
            .name("pcm-dump".into())
            .spawn(move || {
                use std::io::Write;
                let mut w = std::io::BufWriter::new(file);
                let mut buf = vec![0f32; 8192];
                loop {
                    let n = cons.read(&mut buf);
                    if n > 0 {
                        for s in &buf[..n] {
                            let _ = w.write_all(&s.to_le_bytes());
                        }
                    } else {
                        if stop2.load(Ordering::Acquire) {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                }
                let _ = w.flush();
            })
            .expect("spawn pcm-dump");
        Some(Dump {
            tap,
            stop,
            join: Some(join),
        })
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
            PcmKind::S16 => json!(16),
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
    ///
    /// When `prefer_native` and the device can run the source's native
    /// rate/channels in a depth-preserving format, open the stream at those
    /// parameters — no in-graph resample and no bit-depth loss. This is the
    /// DEFAULT path too (mpv-style): rendering is transparent unless the
    /// device can't take the source format. `bypass` is still only reported
    /// for strict fidelity mode.
    fn negotiate(
        &self,
        src_rate: u32,
        src_channels: u32,
        src_depth: BitDepth,
        prefer_native: bool,
    ) -> (Negotiated, bool) {
        let caps = self.caps.lock().unwrap().clone();
        let fidelity = self.state.lock().unwrap().fidelity;
        if fidelity {
            if let Some(kind) = caps.accepts(src_rate, src_channels, src_depth) {
                return (
                    Negotiated {
                        rate: src_rate,
                        // accepts() validated exactly this channel count —
                        // open it, not a clamped guess at a different one.
                        channels: src_channels,
                        kind,
                        device_name: caps.name(),
                    },
                    true,
                );
            }
        } else if prefer_native {
            // Default path: run the stream at the source's native
            // rate/channels when the device can carry them — no in-graph
            // resample, no double resample at the OS mixer. DSP still
            // applies (this is not fidelity bypass). "Depth-preserving"
            // is scoped to the f32 graph: it carries <=24-bit integer and
            // float sources exactly; a 32-bit-INTEGER source can only be
            // rendered bit-exact by the fidelity bypass s32 pipe, so its
            // S32-accepting devices get the native rate but lose the low
            // byte through f32 like every other format.
            if let Some(kind) = caps.accepts(src_rate, src_channels, src_depth) {
                if src_depth.preserved_by(kind) {
                    let neg = Negotiated {
                        rate: src_rate,
                        channels: src_channels,
                        kind,
                        device_name: caps.name(),
                    };
                    // Skip a format this device recently failed to open.
                    const NATIVE_RETRY_BACKOFF: std::time::Duration =
                        std::time::Duration::from_secs(60);
                    let failed = self
                        .state
                        .lock()
                        .unwrap()
                        .native_failed
                        .as_ref()
                        .is_some_and(|(f, t)| {
                            *f == neg && t.elapsed() < NATIVE_RETRY_BACKOFF
                        });
                    if !failed {
                        return (neg, false);
                    }
                }
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
        self.plan_track_opts(src, seek_ms, true)
    }

    fn plan_track_opts(
        &self,
        src: &SourceSpec,
        seek_ms: u64,
        prefer_native: bool,
    ) -> Result<TrackPlan> {
        let (src_rate, src_channels, src_depth, duration_ms, info) = match src {
            SourceSpec::File { path } => {
                let info = self.decoder.probe(path)?;
                (
                    info.sample_rate_hz,
                    info.channels,
                    info.bit_depth,
                    info.duration_ms.saturating_sub(seek_ms),
                    Some(info),
                )
            }
            SourceSpec::PcmStream {
                sample_rate_hz,
                channels,
                bit_depth,
            } => (*sample_rate_hz, *channels, *bit_depth, 0, None),
        };

        let (neg, mut bypass) =
            self.negotiate(src_rate, src_channels, src_depth, prefer_native);
        // Track whether the negotiation landed on the device's native
        // acceptance of the source format vs. its default — the spawn path
        // falls back to the default when a native stream won't open.
        let native = {
            let caps = self.caps.lock().unwrap().clone();
            let fidelity = self.state.lock().unwrap().fidelity;
            let default_neg = Negotiated {
                rate: caps.default_rate(),
                channels: caps.default_channels(),
                kind: caps.default_kind(),
                device_name: caps.name(),
            };
            // Only the non-fidelity preference falls back to the device
            // default — strict fidelity stays honest about what it took.
            prefer_native && !fidelity && neg != default_neg
        };
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
            native,
            info,
        })
    }

    /// Spawn a producer thread for `src`.
    /// When `rebuild_ok` is false and the track negotiates a different stream
    /// format than the live one, this fails with an "incompatible" error
    /// instead of rebuilding (used for prefetched successors: a format
    /// change there means the boundary can't be seamless).
    /// Returns (reader, handle, duration_ms, fidelity_bypass, audio_info).
    fn spawn_pipeline(
        &self,
        queue_id: &str,
        src: SourceSpec,
        seek_ms: u64,
        rg_db: Option<f64>,
        rebuild_ok: bool,
        expected: Option<(u64, u64)>,
    ) -> Result<(TrackReader, ProducerHandle, u64, bool, Option<AudioInfo>)> {
        let plan = self.plan_track(&src, seek_ms)?;
        self.spawn_with_native_fallback(
            queue_id,
            src,
            seek_ms,
            rg_db,
            rebuild_ok,
            plan,
            expected,
        )
    }

    /// Try a planned spawn. On a failed NATIVE stream open (sink left
    /// absent) the negotiated format is cached in `native_failed` so later
    /// plans skip it; with `rebuild_ok` the spawn retries once at the
    /// device default. Other errors propagate unchanged.
    fn spawn_with_native_fallback(
        &self,
        queue_id: &str,
        src: SourceSpec,
        seek_ms: u64,
        rg_db: Option<f64>,
        rebuild_ok: bool,
        plan: TrackPlan,
        expected: Option<(u64, u64)>,
    ) -> Result<(TrackReader, ProducerHandle, u64, bool, Option<AudioInfo>)> {
        let native = plan.native;
        let attempted = plan.neg.clone();
        let res = self.spawn_pipeline_planned(
            queue_id,
            src.clone(),
            seek_ms,
            rg_db,
            rebuild_ok,
            plan,
            expected,
        );
        match res {
            // Only act when the stream itself failed to open (sink is
            // absent) — pipeline-construction errors propagate honestly.
            Err(e) if native && self.sink.lock().unwrap().is_none() => {
                // A device may advertise the source format yet fail to open
                // a stream at it — remember the failure so later spawns
                // (seeks, respawns, boundary reopens) go straight to the
                // device default instead of a doomed open every time. A
                // later successful open at the same format clears this.
                self.state.lock().unwrap().native_failed =
                    Some((attempted, std::time::Instant::now()));
                if !rebuild_ok {
                    return Err(e);
                }
                eprintln!(
                    "native stream negotiation failed ({e:#}); retrying at device default"
                );
                let plan = self.plan_track_opts(&src, seek_ms, false)?;
                self.spawn_pipeline_planned(
                    queue_id,
                    src,
                    seek_ms,
                    rg_db,
                    rebuild_ok,
                    plan,
                    expected,
                )
            }
            other => other,
        }
    }

    /// spawn_pipeline over a caller-computed plan — lets prefetch() reuse
    /// the plan (and its ffprobe result) from the compatibility check.
    fn spawn_pipeline_planned(
        &self,
        queue_id: &str,
        src: SourceSpec,
        seek_ms: u64,
        rg_db: Option<f64>,
        rebuild_ok: bool,
        plan: TrackPlan,
        expected: Option<(u64, u64)>,
    ) -> Result<(TrackReader, ProducerHandle, u64, bool, Option<AudioInfo>)> {
        let duration_ms = plan.duration_ms;
        let neg = plan.neg;
        let rplan = plan.rplan;
        let bypass = plan.bypass;
        let info = plan.info;
        // ReplayGain is opt-in: tagged gains only reach DSP when the user
        // enabled them. Off by default = mpv-style transparent loudness.
        let rg_db = if self.state.lock().unwrap().replay_gain {
            rg_db
        } else {
            None
        };

        {
            // A missing/dead sink (open failed earlier) must retry the open —
            // otherwise load reports success while rendering nothing.
            let sink_unhealthy = self
                .sink
                .lock()
                .unwrap()
                .as_ref()
                .map(|s| s.is_dead())
                .unwrap_or(true);
            let core = self.core.lock().unwrap();
            let format_differs = core.negotiated != neg;
            if format_differs || sink_unhealthy {
                let (cur_rate, cur_kind) = (core.negotiated.rate, core.negotiated.kind);
                drop(core);
                if !rebuild_ok && format_differs {
                    bail!(
                        "incompatible format for seamless transition: \
                         track wants {}Hz/{:?}, stream is {}Hz/{:?}",
                        neg.rate,
                        neg.kind,
                        cur_rate,
                        cur_kind
                    );
                }
                self.rebuild_stream(&neg, expected, None)?;
                // The open just proved this format works — drop any
                // remembered native-open failure for it (transient
                // contention shouldn't downgrade the format forever).
                let mut st = self.state.lock().unwrap();
                if st.native_failed.as_ref().is_some_and(|(f, _)| *f == neg) {
                    st.native_failed = None;
                }
                drop(st);
            }
        }

        // Another rebuild may have committed a different format while we
        // planned — this reader is only valid for plan.neg.
        {
            let core = self.core.lock().unwrap();
            if core.rebuilding || core.negotiated != neg {
                bail!("stream format changed during spawn — retry");
            }
        }

        let capacity = (neg.rate as f32 * self.cfg.buffer_secs) as usize * neg.channels as usize;

        let ready = Arc::new(AtomicBool::new(false));
        // Fidelity bypass means NO DSP on ANY negotiated kind — only the
        // s32 bypass runs a DSP-free producer, so the f32 bypass path must
        // be starved of EQ/RG inputs to stay bit-transparent.
        let eq = if bypass {
            Vec::new()
        } else {
            self.state.lock().unwrap().eq_bands.clone()
        };
        let rg_db = if bypass { None } else { rg_db };
        let decoder = Arc::clone(&self.decoder);
        let src2 = src.clone();
        let neg2 = neg.clone();
        let qid = queue_id.to_string();

        // The s32 producer is fidelity-only: no resampler, no EQ, no
        // ReplayGain. Selecting it by negotiated kind alone would bypass all
        // DSP on every I32-default device — wrong rate, wrong pitch, lying
        // capability reports. Non-bypass S32 output runs the f32 graph and
        // converts at pull_s32.
        let use_bypass_s32 = bypass && neg.kind == PcmKind::S32;
        let (reader, join) = match (use_bypass_s32, neg.kind) {
            (false, _) => {
                let (prod, cons) = ringbuf::channel::<f32>(capacity);
                let feed = self.ensure_feed(&src2, queue_id);
                let r = ready.clone();
                let qid_c = qid.clone();
                let emit_c = Arc::clone(&self.emit);
                let prod_ret = prod.clone();
                let info_c = info.clone();
                let join = std::thread::Builder::new()
                    .name(format!("decode:{qid}"))
                    .spawn(move || {
                        let res = run_producer_f32(
                            &*decoder, src2, seek_ms, &neg2, rplan, eq, rg_db, feed, prod, r,
                            info_c,
                        );
                        if let Err(e) = res {
                            eprintln!("producer {qid_c}: {e:#}");
                            (emit_c)(serde_json::json!({
                                "jsonrpc": "2.0",
                                "method": "event.error",
                                "params": {
                                    "queueId": qid_c,
                                    "message": format!("decode failed: {e:#}"),
                                    "retriable": true,
                                },
                            }));
                        }
                        // A dead producer must still close the ring — else
                        // the consumer buffers forever and the boundary
                        // reports a false gapless promotion.
                        prod_ret.finish();
                    })?;
                (
                    TrackReader {
                        instance: NEXT_TRACK_INSTANCE.fetch_add(1, Ordering::Relaxed),
                        queue_id: qid.clone(),
                        duration_ms,
                        seek_offset_ms: seek_ms,
                        pipe: PipeReader::F32(cons),
                        bypass,
                        neg: neg.clone(),
                        ready,
                    },
                    join,
                )
            }
            (true, _) => {
                let (prod, cons) = ringbuf::channel::<i32>(capacity);
                let feed = self.ensure_feed(&src2, queue_id);
                let r = ready.clone();
                let qid_c = qid.clone();
                let emit_c = Arc::clone(&self.emit);
                let prod_ret = prod.clone();
                let info_c = info.clone();
                let join = std::thread::Builder::new()
                    .name(format!("decode:{qid}"))
                    .spawn(move || {
                        let res =
                            run_producer_s32(&*decoder, src2, seek_ms, &neg2, feed, prod, r, info_c);
                        if let Err(e) = res {
                            eprintln!("producer {qid_c}: {e:#}");
                            (emit_c)(serde_json::json!({
                                "jsonrpc": "2.0",
                                "method": "event.error",
                                "params": {
                                    "queueId": qid_c,
                                    "message": format!("decode failed: {e:#}"),
                                    "retriable": true,
                                },
                            }));
                        }
                        prod_ret.finish();
                    })?;
                (
                    TrackReader {
                        instance: NEXT_TRACK_INSTANCE.fetch_add(1, Ordering::Relaxed),
                        queue_id: qid.clone(),
                        duration_ms,
                        seek_offset_ms: seek_ms,
                        pipe: PipeReader::S32(cons),
                        bypass,
                        neg: neg.clone(),
                        ready,
                    },
                    join,
                )
            }
        };
        Ok((reader, join, duration_ms, bypass, info))
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

    /// Swap the output stream for a new negotiated format. Serialized via
    /// `stream_mu`. The old sink is taken out and stopped/dropped WITHOUT
    /// holding `core` — dropping a CpalSink joins its audio thread, which
    /// blocks on `core`, so joining it while holding the core mutex
    /// deadlocks. The new stream is likewise opened without holding `core`
    /// so the RT callback never finds the mutex held across a device open.
    /// Pipelines are NOT preserved across a rate/format change — callers
    /// respawn them (see respawn_pipelines).
    fn rebuild_stream(
        &self,
        neg: &Negotiated,
        expected: Option<(u64, u64)>,
        caps_override: Option<Arc<dyn DeviceCaps>>,
    ) -> Result<()> {
        let _serial = self.stream_mu.lock().unwrap();
        // Another rebuild may have landed while we waited on the lock — only
        // skip when the format matches AND a healthy sink exists.
        let healthy = self
            .sink
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| !s.is_dead())
            .unwrap_or(false);
        if self.core.lock().unwrap().negotiated == *neg && healthy {
            return Ok(());
        }
        if self.monitor_stop.load(Ordering::Acquire) {
            bail!("engine is shutting down");
        }
        {
            let mut core = self.core.lock().unwrap();
            // Callers that captured (boundary_seq, generation) must not
            // destroy a reader promoted or loaded AFTER the capture. The
            // check runs BEFORE any destructive step: after clear_all no
            // pull-side boundary is possible (nothing left to advance),
            // and the sink is still live, so bailing loses nothing.
            if let Some((seq, gen)) = expected {
                let st = self.state.lock().unwrap();
                if core.boundary_seq != seq
                    || core.ended_pending
                    || st.generation != gen
                {
                    bail!("track boundary landed mid-spawn — stale pipeline");
                }
            }
            // From here until the negotiated commit, installs based on the
            // OLD format are forbidden — the flag makes them bail instead
            // of attaching a reader to a stream about to change.
            core.rebuilding = true;
            core.clear_all();
        }
        let old = self.sink.lock().unwrap().take();
        // Re-verify ownership before the irreversible stop — a load or
        // boundary landing during our spawn makes this rebuild stale.
        // The put-back keeps the old stream alive for the new owner.
        if let Some((seq, gen)) = expected {
            let stale = {
                let core = self.core.lock().unwrap();
                let st = self.state.lock().unwrap();
                core.boundary_seq != seq
                    || core.ended_pending
                    || st.generation != gen
            };
            if stale {
                *self.sink.lock().unwrap() = old;
                self.core.lock().unwrap().rebuilding = false;
                bail!("ownership changed mid-rebuild — stale pipeline");
            }
        }
        if let Some(mut old) = old {
            old.stop();
        }
        let caps = caps_override.unwrap_or_else(|| Arc::clone(&self.caps.lock().unwrap()));
        // Open BEFORE committing negotiated: on failure the core keeps the
        // old negotiation so the next load still attempts a rebuild instead
        // of rendering into a dead sink.
        let new_sink = match crate::sink::open_sink(&self.cfg, caps, neg, &self.core) {
            Ok(s) => s,
            Err(e) => {
                self.core.lock().unwrap().rebuilding = false;
                return Err(e);
            }
        };
        {
            let mut core = self.core.lock().unwrap();
            core.negotiated = neg.clone();
            core.rebuilding = false;
        }
        *self.sink.lock().unwrap() = Some(new_sink);
        Ok(())
    }

    /// Rebuild caps for a device change and re-negotiate the stream, then
    /// respawn the current track at its position and the prefetch from 0.
    pub fn set_device(&self, name: Option<&str>) -> Result<Value> {
        self.set_device_inner(name, None)
    }

    fn set_device_inner(&self, name: Option<&str>, owner_gen: Option<u64>) -> Result<Value> {
        // Don't probe or commit anything while a boundary is un-adopted —
        // the guarded rebuild would bail anyway and leave mixed state.
        let (pos, expected) = {
            let core = self.core.lock().unwrap();
            let st = self.state.lock().unwrap();
            // The caller's ownership token: a newer load supersedes the
            // request entirely.
            if owner_gen.is_some_and(|g| st.generation != g) {
                bail!("device change superseded by a newer load");
            }
            if core.ended_pending
                || core
                    .active
                    .as_ref()
                    .is_some_and(|r| Some(r.instance) != Some(st.current_instance))
            {
                bail!("track boundary in flight — retry device change");
            }
            (
                core.position_ms(),
                Some((core.boundary_seq, st.generation)),
            )
        };
        let new_caps: Arc<dyn DeviceCaps> = if self.cfg.null_sink {
            crate::sink::initial_caps(&self.cfg)?
        } else {
            crate::sink::CpalCaps::new(name)?
        };
        // Default negotiated for the new device; next spawn refines it.
        let neg = Negotiated {
            rate: new_caps.default_rate(),
            channels: new_caps.default_channels(),
            kind: new_caps.default_kind(),
            device_name: new_caps.name(),
        };
        // Rebuild under the new caps BEFORE committing them — a rejected
        // rebuild leaves the old device caps and stream intact.
        if let Err(e) = self.rebuild_stream(&neg, expected, Some(new_caps.clone())) {
            // Guard rejections leave the sink alive; only an actual open
            // failure leaves playback with no output — mark it honestly.
            if self.sink.lock().unwrap().is_none() {
                self.set_state(PlayState::Error);
                self.emit_state(Some(&format!("{e:#}")));
            }
            return Err(e);
        }
        *self.caps.lock().unwrap() = new_caps;
        // New device: the cached native-open failure belongs to the old one.
        self.state.lock().unwrap().native_failed = None;
        self.respawn_pipelines(pos);
        self.emit_output();
        Ok(json!({ "ok": true }))
    }

    pub fn list_devices(&self) -> Value {
        let caps = self.caps.lock().unwrap().clone();
        json!({ "devices": caps.list() })
    }

    /// Wait out an un-adopted pull-side boundary so callers reading
    /// `state` metadata (bypass flag, prefetch slot, current track) see
    /// the settled truth rather than the ended track's leftovers.
    fn settle_boundary(&self) {
        for _ in 0..4 {
            let torn = {
                let core = self.core.lock().unwrap();
                let st = self.state.lock().unwrap();
                core.ended_pending
                    || core
                        .active
                        .as_ref()
                        .is_some_and(|r| Some(r.instance) != Some(st.current_instance))
            };
            if !torn {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// After a stream rebuild: restart the current track at `position_ms`
    /// and the prefetched successor from 0 (same device stream params
    /// permitting).
    fn respawn_pipelines(&self, position_ms: u64) {
        self.respawn_pipelines_inner(position_ms, true);
    }

    /// `follow_prefetch` tails into respawn_prefetch for the armed slot;
    /// promoted-successor redirects pass false so the convergence can't
    /// recurse unboundedly (fatal on the monitor thread, which can't
    /// adopt a boundary while it's inside this function).
    fn respawn_pipelines_inner(&self, position_ms: u64, follow_prefetch: bool) {
        // Bounded loop: a gapless promotion can land while we spawn — a
        // stale install would overwrite the newly-active successor. A
        // snapshot is only trustworthy when core and state agree on the
        // current instance (a pending adoption shows them disagreeing);
        // the install itself runs inside the `core` lock so the callback
        // cannot promote between the check and set_active.
        for attempt in 0..8 {
            // Lock order: core first, then state (same as emit_position).
            let (live_inst, seq, ended_pending) = {
                let core = self.core.lock().unwrap();
                (
                    core.active.as_ref().map(|r| r.instance),
                    core.boundary_seq,
                    core.ended_pending,
                )
            };
            let (cur, gen, cur_inst) = {
                let st = self.state.lock().unwrap();
                (
                    st.queue_id.clone().zip(st.source.clone()),
                    st.generation,
                    st.current_instance,
                )
            };
            let Some((qid, src)) = cur else { break };
            // A pull-side boundary is waiting for the monitor to adopt it:
            // either active and state disagree (promotion mid-flight), or
            // playback already ended but state hasn't caught up. Wait for
            // the adoption tick (~20ms) rather than act on a torn snapshot.
            if (live_inst.is_some() && live_inst != Some(cur_inst)) || ended_pending {
                if attempt == 7 {
                    eprintln!("respawn: boundary adoption never settled");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
                continue;
            }
            // A live pcm-stream can't be respawned mid-flow — the byte source
            // belongs to the original load. Report and mark the dead stream
            // Error rather than leave a silent "playing".
            if matches!(src, SourceSpec::PcmStream { .. }) {
                self.emit_error(Some(&qid), "live stream cannot rebuild at position", true);
                // Paused streams are dead too — a later play() would set
                // Playing with no reader and stay silent. Only mark Error
                // when the rebuild actually destroyed the reader — a plain
                // set_eq respawn leaves the stream's reader alive.
                let was_live = {
                    let core = self.core.lock().unwrap();
                    let mut st = self.state.lock().unwrap();
                    let ours = st.generation == gen
                        && core.active.is_none()
                        && (st.state == PlayState::Playing
                            || st.state == PlayState::Paused);
                    if ours {
                        st.state = PlayState::Error;
                    }
                    ours
                };
                if was_live {
                    self.emit_state(Some("live stream ended by device change"));
                }
                break;
            }
            // Position is read FRESH per attempt: after a stale retry the
            // track may be a different one — respawning it at the entry
            // parameter's offset would skip or mis-place it.
            let (pos, rg) = {
                let pos = if attempt == 0 {
                    position_ms
                } else {
                    self.core.lock().unwrap().position_ms()
                };
                let st = self.state.lock().unwrap();
                (pos, st.replay_gain_db)
            };
            match self.spawn_pipeline(&qid, src.clone(), pos, rg, true, Some((seq, gen))) {
                Ok((reader, handle, dur, bypass, _info)) => {
                    let inst = reader.instance;
                    // Check + install inside one `core` critical section —
                    // the callback cannot advance a track while we hold it.
                    let mut core = self.core.lock().unwrap();
                    let mut st = self.state.lock().unwrap();
                    let stale = st.generation != gen
                        || st.queue_id.as_deref() != Some(qid.as_str())
                        || st.current_instance != cur_inst
                        // a boundary (promotion or end) landed mid-spawn
                        || core.boundary_seq != seq
                        || core.ended_pending
                        // a stream rebuild is mid-flight or already
                        // committed a different format — attaching now
                        // would pin this reader to the outgoing format
                        || core.rebuilding
                        || core.negotiated != reader.neg;
                    if stale {
                        drop(st);
                        drop(core);
                        reader.pipe.abort();
                        drop(handle);
                        // the boundary's adoption lands within a monitor
                        // tick — retry against the settled state
                        std::thread::sleep(std::time::Duration::from_millis(25));
                        continue;
                    }
                    core.set_active(reader);
                    st.current_instance = inst;
                    st.duration_ms = dur;
                    st.fidelity_bypass = bypass;
                    drop(st);
                    drop(core);
                    *self.producer.lock().unwrap() = Some(handle);
                }
                Err(e) => {
                    self.emit_error(Some(&qid), &format!("{e:#}"), true);
                    // When a rebuild already cleared the pipeline and this
                    // file track can't respawn, nothing is playing — mark
                    // it rather than stay silently Playing. Ownership and
                    // the Error write must be one section: a newer load
                    // must not be marked failed by a stale respawn.
                    let dead = {
                        let core = self.core.lock().unwrap();
                        let mut st = self.state.lock().unwrap();
                        let ours = st.generation == gen
                            && st.queue_id.as_deref() == Some(qid.as_str())
                            && st.current_instance == cur_inst;
                        let dead = ours
                            && core.active.is_none()
                            && matches!(src, SourceSpec::File { .. });
                        if dead {
                            st.state = PlayState::Error;
                        }
                        dead
                    };
                    if dead {
                        self.emit_state(Some(&format!("{e:#}")));
                    }
                }
            }
            break;
        }
        let prefetch = {
            let st = self.state.lock().unwrap();
            st.prefetch.as_ref().map(|p| {
                (p.queue_id.clone(), p.source.clone(), p.replay_gain_db)
            })
        };
        if follow_prefetch {
            if let Some((qid, src, rg)) = prefetch {
                self.respawn_prefetch(qid, src, rg);
            }
        }
    }

    /// Re-arm the prefetched successor after a rebuild/toggle. The old
    /// `next` reader is ALWAYS retired first — it was built under the
    /// pre-respawn DSP state and must never be promoted as-is. A
    /// format-mismatched successor stays armed for the boundary reopen;
    /// only a probe failure refuses to claim readiness.
    fn respawn_prefetch(&self, qid: String, src: SourceSpec, rg: Option<f64>) {
        // Promotion check + retire + capture in ONE section — a promotion
        // can't slip between them and leave the live track stale.
        let step = {
            let mut core = self.core.lock().unwrap();
            let st = self.state.lock().unwrap();
            if core
                .active
                .as_ref()
                .is_some_and(|r| r.queue_id == qid)
            {
                Some(None)
            } else if st.prefetch.as_ref().map(|p| p.queue_id.as_str())
                != Some(qid.as_str())
            {
                None
            } else {
                if let Some(old) = core.next.take() {
                    old.pipe.abort();
                }
                Some(Some((core.boundary_seq, st.generation)))
            }
        };
        let Some(step) = step else { return };
        let Some((seq, gen)) = step else {
            // Already promoted pull-side — respawn it as the ACTIVE track
            // rather than dropping the install below. No prefetch tail —
            // that would recurse back here unboundedly.
            let pos = self.core.lock().unwrap().position_ms();
            self.respawn_pipelines_inner(pos, false);
            return;
        };
        *self.prefetch_producer.lock().unwrap() = None;
        // Re-arm only when the prefetch slot still describes THIS
        // successor — a promotion (or a newer prefetch) may have claimed
        // it while we planned.
        let arm = |ready: bool, qid: &str, src: &SourceSpec, rg| {
            let mut st = self.state.lock().unwrap();
            if st.prefetch.as_ref().map(|p| p.queue_id.as_str()) == Some(qid) {
                st.prefetch = Some(PrefetchState {
                    queue_id: qid.to_string(),
                    source: src.clone(),
                    replay_gain_db: rg,
                    ready: Arc::new(AtomicBool::new(ready)),
                    generation: gen,
                });
                st.reported_prefetch_ready = false;
            }
        };
        match self.plan_track(&src, 0) {
            Ok(plan) if plan.neg == self.core.lock().unwrap().negotiated => {
                match self.spawn_with_native_fallback(&qid, src.clone(), 0, rg, false, plan, Some((seq, gen))) {
                    Ok((reader, handle, _dur, _bypass, _info)) => {
                        let ready = reader.ready.clone();
                        // Check + install in ONE critical section — a
                        // boundary between them would either consume the
                        // armed slot or install this track as its own
                        // successor.
                        let mut core = self.core.lock().unwrap();
                        let mut st = self.state.lock().unwrap();
                        let stale = core.boundary_seq != seq
                            || core.ended_pending
                            || core.rebuilding
                            || core.negotiated != reader.neg
                            || st.prefetch
                                .as_ref()
                                .map(|p| p.queue_id.as_str())
                                != Some(qid.as_str())
                            || core
                                .active
                                .as_ref()
                                .is_some_and(|r| r.queue_id == qid);
                        if stale {
                            let promoted = core
                                .active
                                .as_ref()
                                .is_some_and(|r| r.queue_id == qid);
                            drop(st);
                            drop(core);
                            reader.pipe.abort();
                            drop(handle);
                            if promoted {
                                // The successor is already live — respawn
                                // it as the active track so the new DSP
                                // settings actually apply. No prefetch
                                // tail — bounded, non-recursive.
                                let pos = self.core.lock().unwrap().position_ms();
                                self.respawn_pipelines_inner(pos, false);
                            }
                            return;
                        }
                        core.set_next(reader);
                        st.prefetch = Some(PrefetchState {
                            queue_id: qid,
                            source: src,
                            replay_gain_db: rg,
                            ready,
                            generation: gen,
                        });
                        st.reported_prefetch_ready = false;
                        drop(st);
                        drop(core);
                        *self.prefetch_producer.lock().unwrap() = Some(handle);
                    }
                    // The plan validated but nothing verified renderable —
                    // stay armed for the boundary reopen without claiming
                    // readiness.
                    Err(e) => {
                        self.emit_error(Some(&qid), &format!("{e:#}"), true);
                        arm(false, &qid, &src, rg);
                    }
                }
            }
            // Different stream format — armed for the boundary reopen,
            // honestly "ready" in the control sense (validated).
            Ok(_) => arm(true, &qid, &src, rg),
            // Can't even probe the file — stay armed for the boundary
            // reopen, but do NOT claim readiness it can't back.
            Err(_) => arm(false, &qid, &src, rg),
        }
    }

    // ------------------------------ commands -------------------------------

    pub fn ping(&self) -> Value {
        json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })
    }

    pub fn load(&self, p: LoadParams) -> Result<Value> {
        {
            // core first, then state — the monitor holds that order.
            let mut core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            st.state = PlayState::Loading;
            st.generation = p.generation_id;
            st.queue_id = Some(p.queue_id.clone());
            st.source = Some(p.source.clone());
            st.replay_gain_db = p.replay_gain_db;
            // A new generation obsoletes any un-adopted end — its event
            // will be dropped as stale, so the flag would otherwise wedge.
            core.ended_pending = false;
            // A slot armed under a previous generation is retired here
            // even when a promotion is pending — its adoption will drop
            // as stale and the slot must not survive into this load.
            if st
                .prefetch
                .as_ref()
                .is_some_and(|pf| pf.generation != st.generation)
            {
                st.prefetch = None;
                st.reported_prefetch_ready = false;
            }
            // Unblock any producer still waiting on a previous feed.
            for (_, f) in st.feeds.drain() {
                f.close();
            }
        }
        self.emit_state(None);

        // stop any prefetch tied to the old generation
        self.abort_prefetch();

        let (reader, handle, duration_ms, bypass, info) = match self.spawn_pipeline(
            &p.queue_id,
            p.source.clone(),
            p.position_ms,
            p.replay_gain_db,
            true,
            None,
        ) {
            Ok(v) => v,
            Err(e) => {
                self.set_state(PlayState::Error);
                self.emit_state(Some(&format!("{e:#}")));
                self.emit_error(Some(&p.queue_id), &format!("{e:#}"), false);
                return Err(e);
            }
        };

        let load_instance = reader.instance;
        // Reader and state install in ONE critical section — a fast-ending
        // track can't slip a boundary between them and be discarded, and a
        // rebuild mid-spawn can't pin an old-format reader to the stream.
        {
            let mut core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            if core.rebuilding || core.negotiated != reader.neg {
                reader.pipe.abort();
                st.state = PlayState::Error;
                drop(st);
                drop(core);
                drop(handle);
                self.emit_state(Some("stream rebuild in flight"));
                bail!("stream rebuild in flight — retry load");
            }
            core.set_active(reader);
            core.paused = p.start_paused;
            st.current_instance = load_instance;
            st.duration_ms = duration_ms;
            st.fidelity_bypass = bypass;
            st.state = if p.start_paused {
                PlayState::Paused
            } else {
                PlayState::Playing
            };
        }
        *self.producer.lock().unwrap() = Some(handle);
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

        // The plan already probed the file — report it back without a
        // second ffprobe run.
        let mut result = json!({ "ok": true, "durationMs": duration_ms });
        if let Some(i) = info {
            result["sampleRateHz"] = json!(i.sample_rate_hz);
            result["channels"] = json!(i.channels);
            result["codec"] = json!(i.codec);
            result["bitDepth"] = serde_json::to_value(i.bit_depth)?;
        }
        Ok(result)
    }

    /// Prefetch a successor under the current lease generation — a stale
    /// generation is rejected like every other generation-gated command, so
    /// a skip can never install the wrong track.
    /// Drop an installed prefetch — queue edits must cancel the successor
    /// the engine would otherwise promote at the boundary.
    pub fn clear_prefetch(&self, generation: u64) -> Result<Value> {
        self.check_gen(generation)?;
        self.abort_prefetch();
        Ok(json!({ "ok": true }))
    }

    pub fn prefetch(
        &self,
        queue_id: &str,
        path: &str,
        generation: u64,
        rg_db: Option<f64>,
    ) -> Result<Value> {
        self.check_gen(generation)?;
        // A promotion the monitor hasn't adopted yet still needs the armed
        // slot's metadata — refuse rather than overwrite it. The caller
        // re-prefetches after the boundary settles.
        let seq = {
            let core = self.core.lock().unwrap();
            let st = self.state.lock().unwrap();
            if core.ended_pending
                || core
                    .active
                    .as_ref()
                    .is_some_and(|r| Some(r.instance) != Some(st.current_instance))
            {
                bail!("track boundary in flight — retry prefetch");
            }
            core.boundary_seq
        };
        // Replace any armed prefetch BEFORE planning: an incompatible new
        // successor must never inherit a stale `next` reader — the
        // boundary would promote the old track while the state names the
        // new one.
        self.abort_prefetch();
        let src = SourceSpec::File { path: PathBuf::from(path) };
        // If the successor negotiates a different stream format (strict
        // fidelity + a native format the stream can't take), it cannot
        // render seamlessly — keep it as a reopen-on-boundary prefetch and
        // report gapless:false honestly when the time comes.
        // One plan (one ffprobe) serves both the compatibility check and
        // the spawn below.
        let plan = self.plan_track(&src, 0)?;
        let compatible = self.core.lock().unwrap().negotiated == plan.neg;
        if compatible {
            // Via the fallback so a failed native open is cached here too
            // (no retry — the boundary reopen handles an open failure).
            let spawned = self.spawn_with_native_fallback(
                queue_id,
                src.clone(),
                0,
                rg_db,
                false,
                plan,
                Some((seq, generation)),
            );
            let (reader, handle, _dur, _bypass, _info) = match spawned {
                Ok(v) => v,
                Err(e) => {
                    // Nothing verified renderable — arm for the boundary
                    // reopen without claiming readiness, same as
                    // respawn_prefetch, then report the failure.
                    let core = self.core.lock().unwrap();
                    let mut st = self.state.lock().unwrap();
                    if core.boundary_seq == seq
                        && !core.ended_pending
                        && st.generation == generation
                    {
                        st.prefetch = Some(PrefetchState {
                            queue_id: queue_id.to_string(),
                            source: src.clone(),
                            replay_gain_db: rg_db,
                            ready: Arc::new(AtomicBool::new(false)),
                            generation,
                        });
                        st.reported_prefetch_ready = false;
                    }
                    return Err(e);
                }
            };
            let ready = reader.ready.clone();
            // Check + install in one critical section — a boundary landing
            // mid-spawn must not leave this track installed as its own
            // successor or resurrect consumed prefetch state.
            let mut core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            let stale = core.boundary_seq != seq
                || core.ended_pending
                || core.rebuilding
                || core.negotiated != reader.neg
                || st.generation != generation
                || core
                    .active
                    .as_ref()
                    .is_some_and(|r| r.queue_id == queue_id);
            if stale {
                // The boundary's adoption/reopen path owns the successor
                // now — a fresh prefetch can re-arm the next one.
                reader.pipe.abort();
                drop(st);
                drop(core);
                drop(handle);
                return Err(anyhow::anyhow!(
                    "track boundary landed during prefetch — retry"
                ));
            }
            core.set_next(reader);
            st.prefetch = Some(PrefetchState {
                queue_id: queue_id.to_string(),
                source: src,
                replay_gain_db: rg_db,
                ready,
                generation,
            });
            st.reported_prefetch_ready = false;
            drop(st);
            drop(core);
            *self.prefetch_producer.lock().unwrap() = Some(handle);
        } else {
            // A boundary landing while we planned would consume the armed
            // slot and never reopen this successor — the caller retries.
            let core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            if core.boundary_seq != seq
                || core.ended_pending
                || st.generation != generation
            {
                bail!("track boundary landed during prefetch — retry");
            }
            st.prefetch = Some(PrefetchState {
                queue_id: queue_id.to_string(),
                source: src,
                replay_gain_db: rg_db,
                // "ready" in the control sense: validated and reproducible
                ready: Arc::new(AtomicBool::new(true)),
                generation,
            });
            st.reported_prefetch_ready = false;
        }
        Ok(json!({ "ok": true }))
    }

    pub fn play(&self, generation: u64) -> Result<Value> {
        self.check_gen(generation)?;
        // Flag and state together — a boundary reopen installing in the
        // gap would otherwise see stale state and override the flag.
        {
            let mut core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            core.paused = false;
            st.state = PlayState::Playing;
        }
        self.emit_state(None);
        Ok(json!({ "ok": true }))
    }

    pub fn pause(&self, generation: u64) -> Result<Value> {
        self.check_gen(generation)?;
        {
            let mut core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            core.paused = true;
            st.state = PlayState::Paused;
        }
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
            let mut st = self.state.lock().unwrap();
            core.clear_all();
            core.paused = true;
            // The stopped event supersedes the un-adopted end.
            core.ended_pending = false;
            st.queue_id = None;
            st.source = None;
            st.duration_ms = 0;
            st.state = PlayState::Stopped;
            for (_, f) in st.feeds.drain() {
                f.close();
            }
        }
        self.emit_state(None);
        Ok(json!({ "ok": true }))
    }

    pub fn seek(&self, generation: u64, position_ms: u64) -> Result<Value> {
        self.check_gen(generation)?;
        // core first, then state — same order as emit_position.
        let (queue_id, src, rg, cur_inst, seq) = {
            let core = self.core.lock().unwrap();
            let st = self.state.lock().unwrap();
            // Torn snapshot: a boundary the monitor hasn't adopted yet —
            // the track this seek targets is already gone.
            let torn = core.ended_pending
                || core.active.as_ref().map(|r| r.instance)
                    != Some(st.current_instance);
            if torn {
                bail!("track boundary in flight — retry seek");
            }
            match (&st.queue_id, &st.source) {
                (Some(q), Some(s)) => (
                    q.clone(),
                    s.clone(),
                    st.replay_gain_db,
                    st.current_instance,
                    core.boundary_seq,
                ),
                _ => bail!("nothing loaded"),
            }
        };
        let (reader, handle, duration_ms, bypass, _info) =
            self.spawn_pipeline(&queue_id, src, position_ms, rg, true, Some((seq, generation)))?;
        let seek_instance = reader.instance;
        // Install atomically: a boundary landing mid-spawn made this seek
        // moot — the successor owns the stream now.
        {
            let mut core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            let stale = core.boundary_seq != seq
                || core.ended_pending
                || core.rebuilding
                || core.negotiated != reader.neg
                || st.generation != generation
                || st.current_instance != cur_inst;
            if stale {
                reader.pipe.abort();
                drop(handle);
                bail!("track boundary landed during seek — retry");
            }
            core.set_active(reader);
            st.current_instance = seek_instance;
            st.duration_ms = duration_ms;
            st.fidelity_bypass = bypass;
        }
        *self.producer.lock().unwrap() = Some(handle);
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
        // Same settle as set_eq — a mid-flight boundary leaves stale
        // current/prefetch metadata in state.
        self.settle_boundary();
        // Rebuild current + prefetch pipelines under the new rules.
        let pos = self.core.lock().unwrap().position_ms();
        self.respawn_pipelines(pos);
        self.emit_output();
        Ok(json!({ "ok": true }))
    }

    pub fn set_eq(&self, bands: &[(f64, f64)]) -> Result<Value> {
        self.state.lock().unwrap().eq_bands = bands.to_vec();
        // A boundary mid-flight would let the bypass/prefetch decisions
        // read the ended track's metadata — wait for adoption first.
        self.settle_boundary();
        // Pipelines read EQ at construction, so restart the current pipeline
        // at its position to apply changes immediately. Skipped on bypass.
        let (bypass, seq, torn) = {
            let core = self.core.lock().unwrap();
            let st = self.state.lock().unwrap();
            (
                st.fidelity_bypass,
                core.boundary_seq,
                core.ended_pending
                    || core
                        .active
                        .as_ref()
                        .is_some_and(|r| Some(r.instance) != Some(st.current_instance)),
            )
        };
        // A promotion landing between settle and snapshot leaves state
        // describing the ended track — converge through the respawn path
        // which waits for adoption and re-reads settled state.
        if torn || !bypass {
            let pos = self.core.lock().unwrap().position_ms();
            self.respawn_pipelines(pos);
        } else {
            // Bypass starves the current track's DSP anyway — but an armed
            // prefetch may be non-bypass on the same stream and would keep
            // the old EQ through promotion.
            let pf = {
                let st = self.state.lock().unwrap();
                st.prefetch
                    .as_ref()
                    .map(|p| (p.queue_id.clone(), p.source.clone(), p.replay_gain_db))
            };
            if let Some((qid, src, rg)) = pf {
                self.respawn_prefetch(qid, src, rg);
            }
            // A boundary landing between the snapshot and the respawn may
            // have promoted a non-bypass successor — converge it here.
            if self.core.lock().unwrap().boundary_seq != seq {
                let pos = self.core.lock().unwrap().position_ms();
                self.respawn_pipelines(pos);
            }
        }
        Ok(json!({ "ok": true }))
    }

    /// ReplayGain toggle: per-track tag gains are applied only when enabled
    /// (off by default). A change mid-track respawns the affected
    /// pipelines at position, like set_eq. The current track is skipped on
    /// fidelity bypass (no DSP runs) and live pcm-streams (can't respawn);
    /// an armed prefetch is still refreshed — a compatible non-bypass
    /// successor would otherwise keep the old gain through promotion.
    pub fn set_replay_gain(&self, enabled: bool) -> Result<Value> {
        self.settle_boundary();
        let (changed, live_stream, bypass, cur_tagged, pf_tagged, torn) = {
            let core = self.core.lock().unwrap();
            let mut st = self.state.lock().unwrap();
            let was = st.replay_gain;
            st.replay_gain = enabled;
            (
                was != enabled,
                matches!(st.source, Some(SourceSpec::PcmStream { .. })),
                st.fidelity_bypass,
                st.replay_gain_db.is_some(),
                st.prefetch
                    .as_ref()
                    .filter(|p| p.replay_gain_db.is_some())
                    .map(|p| (p.queue_id.clone(), p.source.clone(), p.replay_gain_db)),
                core.ended_pending
                    || core
                        .active
                        .as_ref()
                        .is_some_and(|r| Some(r.instance) != Some(st.current_instance)),
            )
        };
        if !changed {
            return Ok(json!({ "ok": true }));
        }
        if torn || (cur_tagged && !bypass && !live_stream) {
            // respawn_pipelines handles the prefetched successor too.
            let pos = self.core.lock().unwrap().position_ms();
            self.respawn_pipelines(pos);
        } else if let Some((qid, src, rg)) = pf_tagged {
            self.respawn_prefetch(qid, src, rg);
            // A boundary may have promoted the tagged successor while we
            // respawned it — converge any track that crossed the boundary.
            if self.core.lock().unwrap().ended_pending
                || {
                    let core = self.core.lock().unwrap();
                    let st = self.state.lock().unwrap();
                    core.active.as_ref().is_some_and(|r| {
                        Some(r.instance) != Some(st.current_instance)
                    })
                }
            {
                let pos = self.core.lock().unwrap().position_ms();
                self.respawn_pipelines(pos);
            }
        }
        Ok(json!({ "ok": true }))
    }

    pub fn feed(&self, queue_id: &str, data: &[u8], is_final: bool, abort: bool) -> Result<Value> {
        let feed = {
            let st = self.state.lock().unwrap();
            st.feeds.get(queue_id).cloned()
        };
        let Some(f) = feed else {
            // Say which feeds ARE open — a wrong queueId is otherwise
            // indistinguishable from "no pcm-stream loaded at all".
            let known = {
                let st = self.state.lock().unwrap();
                st.feeds.keys().cloned().collect::<Vec<_>>().join(", ")
            };
            if known.is_empty() {
                bail!("audio.feed: no pcm-stream feed is open (queueId {queue_id})");
            }
            bail!("audio.feed: unknown queueId {queue_id} (open feeds: {known})");
        };
        if abort {
            f.abort();
            return Ok(json!({ "ok": true }));
        }
        if f.closed.load(Ordering::Acquire) {
            bail!("audio.feed: feed for queueId {queue_id} is already closed");
        }
        // May block up to Feed::PUSH_TIMEOUT when the stream is full — that
        // delay + a possible error IS the backpressure signal to the RPC
        // caller.
        f.push(data)?;
        if is_final {
            f.close();
        }
        Ok(json!({ "ok": true }))
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
        // Clear the control slot except while a promotion is un-adopted —
        // the monitor still needs its source/ReplayGain to adopt. For a
        // pending END clearing is correct: the monitor takes the slot for
        // the boundary reopen, and cancel means "no reopen". A slot from
        // another generation is retired either way — its adoption drops
        // as stale and it must not reopen later.
        let core = self.core.lock().unwrap();
        let mut st = self.state.lock().unwrap();
        let keep = core
            .active
            .as_ref()
            .is_some_and(|r| Some(r.instance) != Some(st.current_instance))
            && st
                .prefetch
                .as_ref()
                .is_some_and(|pf| pf.generation == st.generation);
        if !keep {
            st.prefetch = None;
            st.reported_prefetch_ready = false;
        }
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
        let mut monitor_stalled = false;
        let mut deferred_device_error: Option<(String, u64)> = None;

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

            // drain core events + reclaim retired readers: their ring
            // buffers (~buffer_secs of samples) are freed here, never on
            // the audio callback thread.
            let (events, retired) = {
                let mut core = self.core.lock().unwrap();
                (
                    core.events.drain(..).collect::<Vec<CoreEvent>>(),
                    core.retired.drain(..).collect::<Vec<TrackReader>>(),
                )
            };
            drop(retired);
            for ev in events {
                match ev {
                    CoreEvent::Boundary {
                        ended_queue_id,
                        ended_instance,
                        started_queue_id,
                        started_instance,
                        started_duration_ms,
                        started_seek_offset_ms,
                        started_bypass,
                    } => {
                        // A concurrent load may have landed while this event
                        // sat in the drain window — only adopt the promotion
                        // if the ended track is still our current one.
                        // Validate + commit bookkeeping + consume the prefetch
                        // slot in ONE critical section — a concurrent load in
                        // the emit gap must not see half-adopted state.
                        let gen = {
                            let mut st = self.state.lock().unwrap();
                            if st.queue_id.as_deref() != Some(ended_queue_id.as_str())
                                || st.current_instance != ended_instance
                            {
                                eprintln!("monitor: dropped stale boundary {ended_queue_id}->{started_queue_id}");
                                continue;
                            }
                            st.current_instance = started_instance;
                            st.queue_id = Some(started_queue_id.clone());
                            st.duration_ms = started_duration_ms;
                            // The successor's own bypass flag — it may
                            // differ from the ended track's on the same
                            // stream format (e.g. Int(32) on F32).
                            st.fidelity_bypass = started_bypass;
                            let _ = started_seek_offset_ms;
                            // promoted prefetch slot consumed — its source and
                            // ReplayGain become the CURRENT track's. A slot
                            // from another generation is dropped, not adopted.
                            if let Some(pf) = st.prefetch.take() {
                                if pf.queue_id == started_queue_id
                                    && pf.generation == st.generation
                                {
                                    st.source = Some(pf.source);
                                    st.replay_gain_db = pf.replay_gain_db;
                                }
                            }
                            st.reported_prefetch_ready = false;
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
                        // The promoted track's bypass flag may differ from
                        // the ended track's on the same stream — report it.
                        self.emit_output();
                    }
                    CoreEvent::Ended { queue_id, instance } => {
                        // Take the armed successor in the SAME critical
                        // section as the adoption — a write in between
                        // would be stolen by the boundary.
                        let (gen, pf) = {
                            // core first, then state.
                            let mut core = self.core.lock().unwrap();
                            let mut st = self.state.lock().unwrap();
                            // Ignore an end for a track no longer current
                            // (a concurrent load already replaced it).
                            if st.queue_id.as_deref() != Some(queue_id.as_str())
                                || st.current_instance != instance
                            {
                                continue;
                            }
                            // The monitor owns this end now — pending-end
                            // is resolved, not "in flight" for respawns.
                            core.ended_pending = false;
                            st.current_instance = 0;
                            st.queue_id = None;
                            // A slot armed under another generation must
                            // not reopen against THIS track's end.
                            let pf = match st.prefetch.take() {
                                Some(pf) if pf.generation == st.generation => Some(pf),
                                _ => None,
                            };
                            (st.generation, pf)
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
                        if let Some(pf) = pf {
                            // A rebuild in flight makes the spawn/install
                            // transiently stale — retry on the settled
                            // format rather than lose the only successor.
                            for attempt in 0..3u8 {
                                // A load landing during this spawn must not
                                // be destroyed by the reopen's rebuild —
                                // guard it.
                                let seq = self.core.lock().unwrap().boundary_seq;
                                match self.spawn_pipeline(&pf.queue_id, pf.source.clone(), 0, pf.replay_gain_db, true, Some((seq, gen))) {
                                    Ok((reader, handle, dur, bypass, _info)) => {
                                        // A concurrent audio.load may have landed
                                        // while we decoded — check + install in
                                        // ONE critical section so it can't be
                                        // clobbered mid-gap.
                                        let reopen_instance = reader.instance;
                                        let mut core = self.core.lock().unwrap();
                                        let mut st = self.state.lock().unwrap();
                                        let transient =
                                            core.rebuilding || core.negotiated != reader.neg;
                                        let stale = st.generation != gen
                                            || st.queue_id.is_some()
                                            // a stop() mid-reopen must not be
                                            // overridden back to Playing —
                                            // but a pause keeps the reader,
                                            // installed paused below
                                            || (st.state != PlayState::Playing
                                                && st.state != PlayState::Paused)
                                            || transient;
                                        if stale {
                                            drop(st);
                                            drop(core);
                                            reader.pipe.abort();
                                            let _ = handle;
                                            if transient && attempt < 2 {
                                                std::thread::sleep(
                                                    std::time::Duration::from_millis(25),
                                                );
                                                continue;
                                            }
                                            eprintln!(
                                                "monitor: dropped stale reopen for {}",
                                                pf.queue_id
                                            );
                                            break;
                                        }
                                        let paused = st.state == PlayState::Paused;
                                        core.set_active(reader);
                                        core.paused = paused;
                                        st.current_instance = reopen_instance;
                                        st.queue_id = Some(pf.queue_id.clone());
                                        st.source = Some(pf.source.clone());
                                        st.replay_gain_db = pf.replay_gain_db;
                                        st.duration_ms = dur;
                                        st.fidelity_bypass = bypass;
                                        st.state = if paused {
                                            PlayState::Paused
                                        } else {
                                            PlayState::Playing
                                        };
                                        drop(st);
                                        drop(core);
                                        *self.producer.lock().unwrap() = Some(handle);
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
                                        break;
                                    }
                                    Err(e) => {
                                        // A concurrent rebuild or boundary
                                        // can fail the spawn transiently —
                                        // retry like the install path does.
                                        let transient = {
                                            let core = self.core.lock().unwrap();
                                            core.rebuilding || core.boundary_seq != seq
                                        };
                                        if transient && attempt < 2 {
                                            std::thread::sleep(
                                                std::time::Duration::from_millis(25),
                                            );
                                            continue;
                                        }
                                        // A concurrent load may own the slot
                                        // now — only report against ours.
                                        let ours = {
                                            let st = self.state.lock().unwrap();
                                            st.generation == gen && st.queue_id.is_none()
                                        };
                                        if ours {
                                            self.emit_error(
                                                Some(&pf.queue_id),
                                                &format!("{e:#}"),
                                                true,
                                            );
                                        }
                                        break;
                                    }
                                }
                            }
                            // The successful install above already
                            // advanced the state — skip the stopped check
                            // when a successor is now active.
                            let advanced = {
                                let st = self.state.lock().unwrap();
                                st.queue_id.is_some()
                            };
                            if advanced {
                                continue;
                            }
                        }
                        // Check + stop atomically — a newer load must not
                        // be overwritten with Stopped in the gap.
                        let stopped = {
                            let mut st = self.state.lock().unwrap();
                            let ours = st.generation == gen && st.queue_id.is_none();
                            if ours {
                                st.state = PlayState::Stopped;
                            }
                            ours
                        };
                        if stopped {
                            self.emit_state(None);
                        }
                    }
                }
            }

            // underrun -> buffering (once per stall), then a state=playing
            // event when the stall clears so the UI never sticks on buffering.
            {
                let (underrun, stall_cleared, qid, playing) = {
                    let core = self.core.lock().unwrap();
                    let st = self.state.lock().unwrap();
                    let cleared = monitor_stalled && !core.stalled;
                    monitor_stalled = core.stalled;
                    (
                        core.underrun,
                        cleared,
                        st.queue_id.clone(),
                        st.state == PlayState::Playing,
                    )
                };
                if underrun {
                    if let Some(q) = qid.clone() {
                        let gen = self.state.lock().unwrap().generation;
                        self.emit(
                            "event.buffering",
                            json!({ "generationId": gen, "queueId": q }),
                        );
                        self.core.lock().unwrap().underrun = false;
                    }
                }
                if stall_cleared && playing {
                    let gen = self.state.lock().unwrap().generation;
                    self.emit("event.state", json!({ "generationId": gen, "state": "playing" }));
                }
            }

            // prefetch readiness — mark reported inside the same section
            // so a replacement slot armed during the emit isn't
            // suppressed; its own arm resets reported_prefetch_ready.
            {
                let mut st = self.state.lock().unwrap();
                if !st.reported_prefetch_ready {
                    if let Some(pf) = &st.prefetch {
                        if pf.ready.load(Ordering::Acquire) {
                            let gen = st.generation;
                            let qid = pf.queue_id.clone();
                            st.reported_prefetch_ready = true;
                            drop(st);
                            self.emit(
                                "event.prefetchReady",
                                json!({ "generationId": gen, "queueId": qid }),
                            );
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

            // device loss -> honest error + stop. The error is bound to
            // the generation that owned the device when it died — a newer
            // load supersedes it entirely, and an un-adopted boundary
            // defers handling to the next tick.
            let device_error = deferred_device_error.take().or_else(|| {
                let gen = self.state.lock().unwrap().generation;
                self.caps
                    .lock()
                    .unwrap()
                    .device_error()
                    .map(|msg| (msg, gen))
            });
            if let Some((msg, err_gen)) = device_error {
                let verdict = {
                    let core = self.core.lock().unwrap();
                    let st = self.state.lock().unwrap();
                    if st.generation != err_gen {
                        // Superseded by a newer load — its own error
                        // paths handle whatever the device does next.
                        2
                    } else if core.ended_pending
                        || core
                            .active
                            .as_ref()
                            .is_some_and(|r| Some(r.instance) != Some(st.current_instance))
                    {
                        1
                    } else {
                        0
                    }
                };
                if verdict == 1 {
                    // A guarded rebuild would bail during adoption — defer
                    // to the next tick after the drain settles it.
                    deferred_device_error = Some((msg, err_gen));
                } else if verdict == 0 {
                    // Try the default output once — an unplugged headphone
                    // shouldn't end the session when speakers are available.
                    let was_default = {
                        let caps = self.caps.lock().unwrap();
                        caps.list().iter().any(|d| d.is_default && d.name == caps.name())
                    };
                    if !self.cfg.null_sink && !was_default {
                        match self.set_device_inner(None, Some(err_gen)) {
                            Ok(_) => {
                                self.emit_error(
                                    None,
                                    &format!("output device lost ({msg}); fell back to default"),
                                    true,
                                );
                                continue;
                            }
                            Err(e) => {
                                // A boundary landing mid-switch bails the
                                // guarded rebuild — defer instead of
                                // destroying the promoted reader below.
                                let pending = {
                                    let core = self.core.lock().unwrap();
                                    let st = self.state.lock().unwrap();
                                    st.generation == err_gen
                                        && (core.ended_pending
                                            || core
                                                .active
                                                .as_ref()
                                                .is_some_and(|r| {
                                                    Some(r.instance)
                                                        != Some(st.current_instance)
                                                }))
                                };
                                if pending {
                                    deferred_device_error = Some((msg, err_gen));
                                    continue;
                                }
                                // Superseded while switching — drop it.
                                if self.state.lock().unwrap().generation != err_gen {
                                    continue;
                                }
                                eprintln!("device fallback failed: {e:#}");
                            }
                        }
                    }
                    // Check + destroy atomically — a boundary or load
                    // landing between them must not be torn down.
                    let handled = {
                        let mut core = self.core.lock().unwrap();
                        let mut st = self.state.lock().unwrap();
                        if st.generation != err_gen {
                            false // superseded — drop silently
                        } else if core.ended_pending
                            || core
                                .active
                                .as_ref()
                                .is_some_and(|r| {
                                    Some(r.instance) != Some(st.current_instance)
                                })
                        {
                            deferred_device_error = Some((msg.clone(), err_gen));
                            false
                        } else {
                            core.clear_all();
                            core.paused = true;
                            st.state = PlayState::Error;
                            true
                        }
                    };
                    if !handled {
                        continue;
                    }
                    self.emit_error(None, &format!("output device lost: {msg}"), false);
                    self.emit_state(Some("device lost"));
                }
                // verdict == 2: superseded — drop the error entirely
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
        // Serialize with any in-flight rebuild so a new sink can't be
        // installed after this point.
        let _serial = self.stream_mu.lock().unwrap();
        // Stop the sink first so no more samples land on the dump tap.
        if let Some(mut s) = self.sink.lock().unwrap().take() {
            s.stop();
        }
        let mut core = self.core.lock().unwrap();
        core.clear_all();
        if let Some(d) = core.dump.as_mut() {
            d.stop(); // joins the writer thread; its BufWriter flushes on exit
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
    info: Option<AudioInfo>,
) -> Result<()> {
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

    // whole frames only — the buffer must be a multiple of the channel
    // count or every full read truncates a partial frame and the leftover
    // samples desync the channel order
    let ch = neg.channels.max(1) as usize;
    let mut inbuf = vec![0f32; (8192 / ch) * ch];
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
                info,
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
    info: Option<AudioInfo>,
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
                info,
            })?;
            // same reason as the f32 path — buffer sized to whole frames
            let mut inbuf = vec![0i32; (8192 / neg.channels.max(1) as usize)
                * neg.channels.max(1) as usize];
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
                    i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2147483648.0f32
                }
            })
            .collect(),
        BitDepth::Int(24) => bytes
            .chunks_exact(3)
            .map(|c| {
                let v = (c[0] as i32) | ((c[1] as i32) << 8) | ((c[2] as i32) << 16);
                let v = if v & 0x800000 != 0 { v | !0xFFFFFF } else { v };
                v as f32 / 8388608.0
            })
            .collect(),
        _ => bytes // 16-bit and anything narrower
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect(),
    }
}

/// Convert little-endian PCM bytes to s32 samples for the fidelity path.
fn bytes_to_i32(bytes: &[u8], depth: BitDepth, _src_ch: usize) -> Vec<i32> {
    match depth {
        BitDepth::Float => bytes
            .chunks_exact(4)
            .map(|c| {
                let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64 * 2147483648.0;
                v.round().clamp(i32::MIN as f64, i32::MAX as f64) as i32
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_feed() -> Arc<Feed> {
        Arc::new(Feed {
            buf: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            closed: AtomicBool::new(false),
        })
    }

    /// A push into a full feed must block (real backpressure) and then error
    /// after the deadline instead of growing memory without bound.
    #[test]
    fn feed_push_blocks_then_errors_when_full() {
        let feed = make_feed();
        feed.push(&vec![0u8; Feed::CAP]).unwrap(); // fills to CAP exactly
        let t0 = std::time::Instant::now();
        let err = feed.push(&[1u8; 16]).unwrap_err();
        assert!(format!("{err:#}").contains("feed full"), "{err:#}");
        let el = t0.elapsed();
        assert!(
            el >= std::time::Duration::from_millis(400),
            "push returned too early ({el:?}): no backpressure"
        );
        assert!(el < std::time::Duration::from_secs(5));
    }

    /// A blocked push must be interruptible by abort (and close).
    #[test]
    fn feed_push_unblocks_on_abort() {
        let feed = make_feed();
        feed.push(&vec![0u8; Feed::CAP]).unwrap();
        let f2 = Arc::clone(&feed);
        let t0 = std::time::Instant::now();
        let t = std::thread::spawn(move || f2.push(&[1u8; 16]));
        std::thread::sleep(std::time::Duration::from_millis(100));
        feed.abort();
        let err = t.join().unwrap().unwrap_err();
        assert!(format!("{err:#}").contains("closed"), "{err:#}");
        assert!(
            t0.elapsed() < std::time::Duration::from_millis(450),
            "abort did not interrupt the push wait"
        );
    }

    /// advance_track must not free the ended reader's ring on the callback
    /// path — it parks it in `retired` for the monitor to reclaim.
    #[test]
    fn advance_track_parks_ended_reader_for_monitor() {
        let neg = Negotiated {
            rate: 48_000,
            channels: 2,
            kind: PcmKind::F32,
            device_name: "test".into(),
        };
        let (core, _tap, _cons) = Engine::make_core(neg, None);
        let mut c = core.lock().unwrap();
        let (prod, cons) = ringbuf::channel::<f32>(64);
        prod.finish();
        c.active = Some(TrackReader {
            instance: 1,
            queue_id: "qa".into(),
            duration_ms: 1_000,
            seek_offset_ms: 0,
            pipe: PipeReader::F32(cons),
            bypass: false,
            neg: Negotiated {
                rate: 48_000,
                channels: 2,
                kind: PcmKind::F32,
                device_name: "test".into(),
            },
            ready: Arc::new(AtomicBool::new(true)),
        });
        assert!(!c.advance_track()); // nothing behind it -> Ended
        assert_eq!(c.retired.len(), 1, "ended reader must be parked");
        assert_eq!(c.retired[0].queue_id, "", "queue_id moved into the event");
        assert!(
            matches!(c.events.back(), Some(CoreEvent::Ended { .. })),
            "expected a pending Ended event"
        );
        // Monitor-side drain frees the ring off the callback thread.
        let retired: Vec<TrackReader> = c.retired.drain(..).collect();
        drop(retired);
        assert!(c.retired.is_empty());
    }

    /// pull_s16 must round-trip s16-representable values exactly — the
    /// f32→i16 conversion uses the 2^15 scale, not i16::MAX (issue #1).
    #[test]
    fn pull_s16_round_trips_exact() {
        let neg = Negotiated {
            rate: 48_000,
            channels: 2,
            kind: PcmKind::S16,
            device_name: "test".into(),
        };
        let (core, _tap, _cons) = Engine::make_core(neg, None);
        let vals = [
            -1.0f32,
            -0.5,
            -1.0 / 32768.0,
            0.0,
            0.25,
            1.0 - 1.0 / 32768.0,
            1.0,
        ];
        let (prod, cons) = ringbuf::channel::<f32>(64);
        assert!(prod.write_all(&vals));
        prod.finish();
        {
            let mut c = core.lock().unwrap();
            c.active = Some(TrackReader {
                instance: 1,
                queue_id: "q".into(),
                duration_ms: 1_000,
                seek_offset_ms: 0,
                pipe: PipeReader::F32(cons),
                bypass: false,
                neg: Negotiated {
                    rate: 48_000,
                    channels: 2,
                    kind: PcmKind::F32,
                    device_name: "test".into(),
                },
                ready: Arc::new(AtomicBool::new(true)),
            });
            c.paused = false;
            let mut out = [0i16; 7];
            c.pull_s16(&mut out);
            assert_eq!(out, [-32768, -16384, -1, 0, 8192, 32767, 32767]);
        }
    }

    /// pull_s32 passes an s32 pipe through untouched and scales an f32 pipe
    /// at 2^31 — both bit-exact for representable values.
    #[test]
    fn pull_s32_paths_are_exact() {
        let neg = Negotiated {
            rate: 48_000,
            channels: 2,
            kind: PcmKind::S32,
            device_name: "test".into(),
        };
        let (core, _tap, _cons) = Engine::make_core(neg, None);
        // s32 pipe: bit-exact passthrough (bypass path)
        let vals = [i32::MIN, -1_000_000_000, 0, 1_000_000_000, i32::MAX];
        let (prod, cons) = ringbuf::channel::<i32>(64);
        assert!(prod.write_all(&vals));
        prod.finish();
        {
            let mut c = core.lock().unwrap();
            c.active = Some(TrackReader {
                instance: 1,
                queue_id: "q".into(),
                duration_ms: 1_000,
                seek_offset_ms: 0,
                pipe: PipeReader::S32(cons),
                bypass: false,
                neg: Negotiated {
                    rate: 48_000,
                    channels: 2,
                    kind: PcmKind::S32,
                    device_name: "test".into(),
                },
                ready: Arc::new(AtomicBool::new(true)),
            });
            c.paused = false;
            let mut out = [0i32; 5];
            c.pull_s32(&mut out);
            assert_eq!(out, vals);
        }
        // f32 pipe -> s32 sink: 2^31 scale, representable values exact
        let fvals = [-1.0f32, -0.5, 0.0, 0.25, 1.0];
        let (prodf, consf) = ringbuf::channel::<f32>(64);
        assert!(prodf.write_all(&fvals));
        prodf.finish();
        {
            let mut c = core.lock().unwrap();
            c.active = Some(TrackReader {
                instance: 1,
                queue_id: "q2".into(),
                duration_ms: 1_000,
                seek_offset_ms: 0,
                pipe: PipeReader::F32(consf),
                bypass: false,
                neg: Negotiated {
                    rate: 48_000,
                    channels: 2,
                    kind: PcmKind::F32,
                    device_name: "test".into(),
                },
                ready: Arc::new(AtomicBool::new(true)),
            });
            let mut out = [0i32; 5];
            c.pull_s32(&mut out);
            assert_eq!(out, [i32::MIN, -1073741824, 0, 536870912, i32::MAX]);
        }
    }

    /// Once the reader drains, a waiting push completes.
    #[test]
    fn feed_push_succeeds_after_drain() {
        let feed = make_feed();
        feed.push(&vec![7u8; Feed::CAP]).unwrap();
        let f2 = Arc::clone(&feed);
        let t = std::thread::spawn(move || f2.push(&vec![9u8; Feed::CAP / 4]));
        std::thread::sleep(std::time::Duration::from_millis(100));
        let mut out = vec![0u8; Feed::CAP];
        let n = feed.read(&mut out);
        assert_eq!(n, Feed::CAP, "expected a full drain");
        t.join().unwrap().unwrap();
        assert_eq!(feed.read(&mut out), Feed::CAP / 4);
        assert!(out[..8].iter().all(|b| *b == 9));
    }
}
