//! Native PipeWire output — the same transport mpv uses.
//!
//! Why this exists (issue #1): on PipeWire systems the CPAL/ALSA path goes
//! through the pipewire-alsa plugin, whose adapter runs every stream
//! through a continuous rate-matching resampler — measured as a
//! deterministic ~-97 dBFS transform vs the decoded source (identical
//! output for cadence and `aplay`; `pw-cat`/native streams are bit-exact).
//! A native `pw_stream` is driven by the graph directly and passes buffers
//! unmodified, which makes Cadence's delivered PCM indistinguishable from
//! mpv's.
//!
//! Structure: `PipeWireCaps` answers capability questions; each
//! `PipeWireSink` owns a thread loop + context + core + stream. The
//! process callback drains a lock-free staging ring (`spawn_feed`) so the
//! RT thread never touches `OutputCore`'s mutex. State changes and buffer
//! processing live in separate listeners with separate user data — the
//! RT `process` callback and the loop-thread `state_changed` callback
//! can run concurrently, and shared `&mut` user data would alias.
//!
//! Buffers after `stop()`-level control changes (pause/seek/clear) are
//! flushed via `OutputCore::clear_epoch`, which the process callback
//! polls — cheap, atomic, RT-safe — instead of playing out stale PCM.

use crate::decode::BitDepth;
use crate::engine::OutputCore;
use crate::sink::{spawn_feed, DeviceCaps, DeviceDesc, FeedGuard, Negotiated, PcmSample, Sink};
use anyhow::{anyhow, Context, Result};
use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::decode::PcmKind;

/// The negotiated kind that carries `depth` losslessly — same choice mpv
/// makes: s16 for <=16-bit int, s32 for deeper int, f32 for float.
fn kind_for(depth: BitDepth) -> PcmKind {
    match depth {
        BitDepth::Float => PcmKind::F32,
        BitDepth::Int(b) if b > 16 => PcmKind::S32,
        BitDepth::Int(_) => PcmKind::S16,
    }
}

fn spa_format(kind: PcmKind) -> spa::param::audio::AudioFormat {
    match kind {
        PcmKind::F32 => spa::param::audio::AudioFormat::F32LE,
        PcmKind::S32 => spa::param::audio::AudioFormat::S32LE,
        PcmKind::S16 => spa::param::audio::AudioFormat::S16LE,
    }
}

/// Channel ordinals from `spa_audio_channel` (spa/param/audio/raw.h) —
/// libspa doesn't re-export a typed constant for them.
mod pos {
    pub const MONO: u32 = 2;
    pub const FL: u32 = 3;
    pub const FR: u32 = 4;
    pub const FC: u32 = 5;
    pub const LFE: u32 = 6;
    pub const SL: u32 = 7;
    pub const SR: u32 = 8;
    pub const RL: u32 = 12;
    pub const RR: u32 = 13;
}

/// Standard speaker layouts; None -> leave UNPOSITIONED and let the
/// graph infer from the channel count.
fn layout_for(channels: u32) -> Option<[u32; 64]> {
    use pos::*;
    let layout: &[u32] = match channels {
        1 => &[MONO],
        2 => &[FL, FR],
        3 => &[FL, FR, LFE],
        4 => &[FL, FR, RL, RR],
        5 => &[FL, FR, FC, RL, RR],
        6 => &[FL, FR, FC, LFE, SL, SR],
        7 => &[FL, FR, FC, LFE, RL, RR, FC],
        8 => &[FL, FR, FC, LFE, RL, RR, SL, SR],
        _ => return None,
    };
    let mut p = [0u32; 64];
    p[..layout.len()].copy_from_slice(layout);
    Some(p)
}

pub struct PipeWireCaps {
    /// object.serial of an explicitly chosen sink node (set_device).
    target: Option<u32>,
    device_name: String,
    /// shared with each stream's state listener — device-loss reporting.
    error: Arc<Mutex<Option<String>>>,
}

impl PipeWireCaps {
    /// `name`: None = session default sink.
    pub fn new(name: Option<&str>) -> Result<Arc<Self>> {
        match name {
            Some(want) => {
                let (serial, found) = sink_serial_for(want)?;
                Ok(Arc::new(PipeWireCaps {
                    target: Some(serial),
                    device_name: found,
                    error: Arc::new(Mutex::new(None)),
                }))
            }
            None => {
                // Cheap presence check: a real connect beats probing the
                // socket file (stale sockets exist after daemon restarts).
                with_core(|_| Ok(())).context("pipewire connect failed")?;
                Ok(Arc::new(PipeWireCaps {
                    target: None,
                    device_name: "pipewire".into(),
                    error: Arc::new(Mutex::new(None)),
                }))
            }
        }
    }
}

/// Run `f` with a live core connection on a fresh thread loop.
fn with_core<R>(f: impl FnOnce(&pw::core::CoreRc) -> Result<R>) -> Result<R> {
    let tl = unsafe {
        // Safety: the loop is started/locked per pipewire-rs rules and
        // only used inside this function's scope.
        pw::thread_loop::ThreadLoopRc::new(Some("cadence-pw-ctl"), None)
    }
    .map_err(|e| anyhow!("thread loop: {e}"))?;
    tl.start();
    let r = (|| {
        let _guard = tl.lock();
        let ctx = pw::context::ContextRc::new(&tl, None)
            .map_err(|e| anyhow!("context: {e}"))?;
        let core = ctx.connect_rc(None).map_err(|e| anyhow!("connect: {e}"))?;
        f(&core)
    })();
    tl.stop();
    r
}

/// Enumerate Audio/Sink nodes -> (object.serial, node.name).
/// The listener, registry and core must stay alive while the loop
/// dispatches the initial global burst — dropping them inside the lock
/// (as the naive version did) yields an empty list every time. A
/// core.sync round-trip bounds the wait deterministically instead of a
/// fixed sleep.
fn enumerate_sinks() -> Result<Vec<(u32, String)>> {
    let tl = unsafe {
        // Safety: see with_core — same loop discipline.
        pw::thread_loop::ThreadLoopRc::new(Some("cadence-pw-ctl"), None)
    }?;
    tl.start();
    let found = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(u32, String)>::new()));
    let synced = std::rc::Rc::new(std::cell::Cell::new(false));
    {
        // Objects live for the whole block: registry events need the
        // listener alive while the loop thread dispatches.
        let _guard = tl.lock();
        let ctx = pw::context::ContextRc::new(&tl, None)?;
        let core = ctx.connect_rc(None)?;
        let sflag = std::rc::Rc::clone(&synced);
        let _core_listener = core
            .add_listener_local()
            .done(move |_id, _seq| sflag.set(true))
            .register();
        let reg = core.get_registry_rc()?;
        let f = std::rc::Rc::clone(&found);
        let _listener = reg
            .add_listener_local()
            .global(move |obj| {
                if obj.type_ != pw::types::ObjectType::Node {
                    return;
                }
                let Some(props) = &obj.props else { return };
                let props = props.as_ref();
                let class = props.get("media.class").unwrap_or("");
                if class != "Audio/Sink" {
                    return;
                }
                let name = props.get("node.name").unwrap_or("").to_string();
                let serial = props
                    .get("object.serial")
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(obj.id);
                f.borrow_mut().push((serial, name));
            })
            .register();
        let _seq = core.sync(0)?;
        drop(_guard);
        // Wait for the done event the sync round-trip triggers — the
        // registry burst is guaranteed to arrive first.
        for _ in 0..100 {
            if synced.get() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _guard2 = tl.lock();
    }
    tl.stop();
    Ok(found.take())
}

fn sink_serial_for(name: &str) -> Result<(u32, String)> {
    for (serial, node_name) in enumerate_sinks()? {
        if node_name == name {
            return Ok((serial, node_name));
        }
    }
    Err(anyhow!("no pipewire sink named {name:?}"))
}

impl DeviceCaps for PipeWireCaps {
    fn name(&self) -> String {
        self.device_name.clone()
    }
    /// Fallback defaults — only used when a native open fails and the
    /// engine re-plans at the device default. PipeWire's universal clock
    /// default is 48k; the graph converts, the stream stays transparent.
    fn default_rate(&self) -> u32 {
        48000
    }
    fn default_channels(&self) -> u32 {
        2
    }
    fn default_kind(&self) -> PcmKind {
        PcmKind::F32
    }

    /// A native stream accepts anything PipeWire can carry — which is every
    /// rate/channel count. Pick the depth-preserving format (mpv-style).
    fn accepts(&self, rate: u32, channels: u32, depth: BitDepth) -> Option<PcmKind> {
        if rate == 0 || channels == 0 || channels > 64 {
            return None;
        }
        Some(kind_for(depth))
    }

    fn list(&self) -> Vec<DeviceDesc> {
        enumerate_sinks()
            .unwrap_or_default()
            .into_iter()
            .map(|(serial, name)| DeviceDesc {
                name,
                is_default: self.target.map(|t| t == serial).unwrap_or(false),
                default_sample_rate_hz: 48000,
                channels: 2,
            })
            .collect()
    }

    fn device_error(&self) -> Option<String> {
        self.error.lock().unwrap().take()
    }

    fn is_pipewire(&self) -> bool {
        true
    }

    fn open_stream(&self, neg: &Negotiated, core: Arc<Mutex<OutputCore>>) -> Result<Box<dyn Sink>> {
        match neg.kind {
            PcmKind::F32 => self.open_typed::<f32>(neg, core, OutputCore::pull_f32),
            PcmKind::S32 => self.open_typed::<i32>(neg, core, OutputCore::pull_s32),
            PcmKind::S16 => self.open_typed::<i16>(neg, core, OutputCore::pull_s16),
        }
    }
}

/// Process-callback state: drain the staging ring into each buffer.
/// Separate listener + user data from `StreamErr` so the RT callback and
/// the loop-thread state callback never share a `&mut`.
struct Feed<T> {
    cons: crate::ringbuf::Consumer<T>,
    channels: usize,
    /// bumped by the engine on pause/seek/clear — staged PCM is stale.
    epoch: Arc<std::sync::atomic::AtomicU64>,
    last_epoch: u64,
}

/// State-callback state: error reporting + dead flag, atomics/mutex only
/// so writes from the loop thread are safe next to the RT `process`.
struct StreamErr {
    error: Arc<Mutex<Option<String>>>,
    dead: Arc<AtomicBool>,
}

impl PipeWireCaps {
    fn open_typed<T: PcmSample>(
        &self,
        neg: &Negotiated,
        core: Arc<Mutex<OutputCore>>,
        pull: fn(&mut OutputCore, &mut [T]),
    ) -> Result<Box<dyn Sink>> {
        // A fresh stream must not inherit the previous stream's error —
        // a stale cell would make the monitor tear down a healthy stream.
        if let Ok(mut e) = self.error.lock() {
            *e = None;
        }
        // ~60ms staging ring: decouples the RT callback from the core mutex
        // without adding audible latency to the graph.
        let capacity = (neg.rate as usize * neg.channels as usize / 16).max(8192);
        let epoch = Arc::clone(&core.lock().unwrap().clear_epoch);
        let dead = Arc::new(AtomicBool::new(false));
        // Spawn before the thread loop; FeedGuard::drop stops+joins on
        // every subsequent failure path.
        let (cons, feed) = spawn_feed(
            &core,
            pull,
            capacity,
            neg.channels as usize,
        )?;

        let tl = unsafe {
            // Safety: the loop lives for the sink's whole lifetime; all
            // stream ops run under tl.lock() per pipewire-rs rules.
            pw::thread_loop::ThreadLoopRc::new(Some("cadence-pw"), None)
        }?;
        tl.start();
        let built = (|| {
            let _guard = tl.lock();
            let ctx = pw::context::ContextRc::new(&tl, None)?;
            let pw_core = ctx.connect_rc(None)?;
            let mut props = properties! {
                *pw::keys::MEDIA_TYPE => "Audio",
                *pw::keys::MEDIA_ROLE => "Music",
                *pw::keys::MEDIA_CATEGORY => "Playback",
                *pw::keys::MEDIA_NAME => "Cadence",
                *pw::keys::APP_NAME => "Cadence",
                *pw::keys::NODE_NAME => "cadence-audio",
                *pw::keys::NODE_DESCRIPTION => "Cadence",
                *pw::keys::AUDIO_CHANNELS => neg.channels.to_string(),
                // What mpv sets so the node runs at the stream's own rate:
                // without node.rate the driver schedules us at the graph
                // rate while we deliver `rate` buffers — the adapter then
                // rate-matches (the same resampling we came here to kill).
                *pw::keys::NODE_RATE => format!("1/{}", neg.rate),
                *pw::keys::NODE_ALWAYS_PROCESS => "true",
                *pw::keys::NODE_WANT_DRIVER => "true",
                *pw::keys::STREAM_IS_LIVE => "true",
            };
            if let Some(serial) = self.target {
                // pw_stream_connect expects a node *id*; a serial goes in
                // target.object with PW_ID_ANY as the connect target.
                props.insert(*pw::keys::TARGET_OBJECT, serial.to_string());
            }
            let stream = pw::stream::StreamRc::new(pw_core.clone(), "Cadence", props)?;
            let state_listener = stream
                .add_local_listener_with_user_data(StreamErr {
                    error: Arc::clone(&self.error),
                    dead: Arc::clone(&dead),
                })
                .state_changed(|_s, ud, _old, new| {
                    if let pw::stream::StreamState::Error(e) = new {
                        ud.dead.store(true, Ordering::Relaxed);
                        if let Ok(mut cell) = ud.error.lock() {
                            *cell = Some(e);
                        }
                    }
                })
                .register()?;
            let process_listener = stream
                .add_local_listener_with_user_data(Feed {
                    cons,
                    channels: neg.channels as usize,
                    epoch,
                    last_epoch: 0,
                })
                .process(|stream, feed| fill::<T>(stream, feed))
                .register()?;

            let mut info = spa::param::audio::AudioInfoRaw::new();
            info.set_format(spa_format(neg.kind));
            info.set_rate(neg.rate);
            info.set_channels(neg.channels);
            // Standard layouts for common channel counts; UNPOSITIONED
            // otherwise (the graph infers from the count).
            if let Some(p) = layout_for(neg.channels) {
                info.set_position(p);
            }
            let pod_bytes = spa::pod::serialize::PodSerializer::serialize(
                std::io::Cursor::new(Vec::new()),
                &spa::pod::Value::Object(spa::pod::Object {
                    type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
                    id: spa::param::ParamType::EnumFormat.as_raw(),
                    properties: info.into(),
                }),
            )
            .map_err(|e| anyhow!("format pod serialize: {e:?}"))?
            .0
            .into_inner();
            let mut params = [spa::pod::Pod::from_bytes(&pod_bytes)
                .ok_or_else(|| anyhow!("format pod parse"))?];
            stream.connect(
                spa::utils::Direction::Output,
                // PW_ID_ANY: the target (if any) rides in target.object.
                None,
                pw::stream::StreamFlags::AUTOCONNECT
                    | pw::stream::StreamFlags::MAP_BUFFERS
                    | pw::stream::StreamFlags::RT_PROCESS,
                &mut params,
            )?;
            Ok((ctx, pw_core, stream, state_listener, process_listener))
        })();
        let (ctx, pw_core, stream, state_listener, process_listener) = match built {
            Ok(v) => v,
            Err(e) => {
                tl.stop();
                return Err(e);
            }
        };
        Ok(Box::new(PipeWireSink {
            stream,
            _state_listener: Box::new(state_listener),
            _process_listener: Box::new(process_listener),
            _core: pw_core,
            _ctx: ctx,
            tl,
            feed,
            dead,
        }))
    }
}

/// Fill one stream buffer from the staging ring. RT thread: never locks —
/// the ring is SPSC wait-free; an underrun zero-pads the remainder so the
/// stream keeps its timeline (same contract as the CPAL callback).
fn fill<T: PcmSample>(stream: &pw::stream::Stream, feed: &mut Feed<T>) {
    // A control operation (pause/seek/format rebuild) made the staged
    // PCM stale — drop it so nothing old plays past the control point.
    let e = feed.epoch.load(Ordering::Acquire);
    if e != feed.last_epoch {
        feed.last_epoch = e;
        feed.cons.clear();
    }
    let Some(mut buffer) = stream.dequeue_buffer() else {
        return;
    };
    // `requested` is the quantum the graph asks for; the mmap'd region is
    // far larger — filling past it would flush the staging ring into one
    // buffer and starve the following callbacks.
    let requested = buffer.requested() as usize;
    let datas = buffer.datas_mut();
    if datas.is_empty() {
        return;
    }
    let stride = T::BYTES * feed.channels;
    let data = &mut datas[0];
    let size = match data.data() {
        Some(slice) => {
            let max_frames = slice.len() / stride;
            let frames = if requested > 0 {
                requested.min(max_frames)
            } else {
                max_frames
            };
            // PW buffers are aligned to cpu.max-align — safe to cast.
            let out = unsafe {
                std::slice::from_raw_parts_mut(
                    slice.as_mut_ptr() as *mut T,
                    frames * feed.channels,
                )
            };
            let got = feed.cons.read(out);
            out[got..].fill(T::default());
            frames * stride
        }
        None => 0,
    };
    let chunk = data.chunk_mut();
    *chunk.offset_mut() = 0;
    *chunk.stride_mut() = stride as _;
    *chunk.size_mut() = size as _;
}

pub struct PipeWireSink {
    stream: pw::stream::StreamRc,
    /// Boxed listeners — keep the PW callbacks alive (concrete types
    /// vary with the negotiated sample format).
    _state_listener: Box<dyn std::any::Any>,
    _process_listener: Box<dyn std::any::Any>,
    _core: pw::core::CoreRc,
    _ctx: pw::context::ContextRc,
    tl: pw::thread_loop::ThreadLoopRc,
    feed: FeedGuard,
    dead: Arc<AtomicBool>,
}

// StreamRc/ThreadLoopRc are Rc-based (!Send) — the same portability
// constraint cpal documents for its Stream handle. The soundness rests
// on (a) the engine serializing sink access behind `self.sink`'s mutex,
// and (b) `stop()` running before the object drops — which `Drop` below
// guarantees on every path.
unsafe impl Send for PipeWireSink {}

impl Sink for PipeWireSink {
    fn stop(&mut self) {
        self.feed.stop();
        {
            let _guard = self.tl.lock();
            let _ = self.stream.disconnect();
        }
        self.tl.stop();
    }

    fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }
}

// A bare drop (e.g. a stale sink swapped out without an explicit stop)
// still has to tear the stream down under the loop lock — dropping
// StreamRc without disconnecting first destroys it from whichever
// thread happens to hold the handle.
impl Drop for PipeWireSink {
    fn drop(&mut self) {
        self.stop();
    }
}
