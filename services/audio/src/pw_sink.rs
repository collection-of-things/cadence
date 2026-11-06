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
    pub const RC: u32 = 11;
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
        // 3ch content is more often 3.0 (FL/FR/FC) than 2.1 — channel
        // count alone can't distinguish, so prefer the layout the vast
        // majority of 3ch sources carry.
        3 => &[FL, FR, FC],
        4 => &[FL, FR, RL, RR],
        5 => &[FL, FR, FC, RL, RR],
        6 => &[FL, FR, FC, LFE, SL, SR],
        7 => &[FL, FR, FC, LFE, RL, RR, RC],
        8 => &[FL, FR, FC, LFE, RL, RR, SL, SR],
        _ => return None,
    };
    let mut p = [0u32; 64];
    p[..layout.len()].copy_from_slice(layout);
    Some(p)
}

pub struct PipeWireCaps {
    /// Node id of an explicitly chosen sink (set_device) — passed to
    /// connect() so the graph links us to that node directly.
    target: Option<u32>,
    device_name: String,
    /// shared with each stream's state listener — device-loss reporting.
    error: Arc<Mutex<Option<String>>>,
    /// enumerate_sinks spins two thread loops + two core syncs (~ms to
    /// seconds); the monitor's device-error path calls list() each
    /// recovery cycle — cache briefly so that path can't stall the
    /// monitor on repeated error handling.
    list_cache: Mutex<Option<(std::time::Instant, Vec<DeviceDesc>)>>,
}

impl PipeWireCaps {
    /// `name`: None = session default sink.
    pub fn new(name: Option<&str>) -> Result<Arc<Self>> {
        match name {
            Some(want) => {
                let (node_id, found) = sink_node_for(want)?;
                Ok(Arc::new(PipeWireCaps {
                    target: Some(node_id),
                    device_name: found,
                    error: Arc::new(Mutex::new(None)),
                    list_cache: Mutex::new(None),
                }))
            }
            None => {
                // Cheap presence check: a real connect beats probing the
                // socket file (stale sockets exist after daemon restarts).
                with_core(|_| Ok(())).context("pipewire connect failed")?;
                // Resolve the session default's real node name so
                // `name()` — and event.output and the monitor's
                // was_default check — report the actual sink.
                let resolved = enumerate_sinks()
                    .ok()
                    .and_then(|(_, dn)| dn)
                    .unwrap_or_else(|| "pipewire".into());
                Ok(Arc::new(PipeWireCaps {
                    target: None,
                    device_name: resolved,
                    error: Arc::new(Mutex::new(None)),
                    list_cache: Mutex::new(None),
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

/// Enumerate Audio/Sink nodes -> (global node id, node.name) plus the
/// session's default sink name (from the `default` metadata object's
/// `default.audio.sink` property). Objects stay alive through the whole
/// dispatch window; a core.sync round-trip bounds the wait, and the
/// flag/list share state through atomics/mutex because the callbacks
/// fire on the loop thread while this thread waits.
fn enumerate_sinks() -> Result<(Vec<(u32, String)>, Option<String>)> {
    let tl = unsafe {
        // Safety: see with_core — same loop discipline.
        pw::thread_loop::ThreadLoopRc::new(Some("cadence-pw-ctl"), None)
    }?;
    tl.start();
    let found = Arc::new(Mutex::new(Vec::<(u32, String)>::new()));
    let default_name = Arc::new(Mutex::new(None::<String>));
    let synced = Arc::new(std::sync::atomic::AtomicI64::new(-1));
    // Objects stay in `hold` until they've been dropped under the loop
    // lock — dispatch can race an unlocked drop otherwise. LISTENERS
    // FIRST: they unlink from their proxy's hook list on drop — dropping
    // reg/core first would unlink into freed memory (same hazard class
    // as MetaBind's field order and PipeWireSink's field order).
    let mut hold: Option<(
        Box<dyn std::any::Any>,
        Box<dyn std::any::Any>,
        pw::registry::RegistryRc,
        pw::core::CoreRc,
        pw::context::ContextRc,
    )> = None;
    let r: Result<i64> = {
        let _guard = tl.lock();
        (|| {
            let ctx = pw::context::ContextRc::new(&tl, None)?;
            let core = ctx.connect_rc(None)?;
            let sflag = Arc::clone(&synced);
            let core_listener = core
                .add_listener_local()
                .done(move |_id, seq| sflag.store(seq.seq() as i64, Ordering::Release))
                .register();
            let reg = core.get_registry_rc()?;
            let f = Arc::clone(&found);
            let dn = Arc::clone(&default_name);
            let reg2 = reg.clone();
            // The bound Metadata + its listener live inside the registry
            // listener's captures. `MetaBind`'s field order drops the
            // listener FIRST — it must unlink from the proxy's hook list
            // before the proxy dies, or teardown writes into freed memory.
            struct MetaBind {
                _listener: pw::metadata::MetadataListener,
                _proxy: pw::metadata::Metadata,
            }
            let meta_slot: std::rc::Rc<
                std::cell::RefCell<Option<MetaBind>>,
            > = std::rc::Rc::new(std::cell::RefCell::new(None));
            let ms = std::rc::Rc::clone(&meta_slot);
            let reg_listener = reg
                .add_listener_local()
                .global(move |obj| {
                    if obj.type_ == pw::types::ObjectType::Metadata {
                        // The `default` metadata object holds the session's
                        // default.audio.sink — bind it and read the
                        // property (dispatched before our sync's done).
                        let is_default_meta = obj
                            .props
                            .as_deref()
                            .and_then(|p| p.get("metadata.name"))
                            == Some("default");
                        if !is_default_meta {
                            return;
                        }
                        let Ok(md) = reg2
                            .bind::<pw::metadata::Metadata, _>(obj)
                        else {
                            return;
                        };
                        let dnc = Arc::clone(&dn);
                        let lis = md
                            .add_listener_local()
                            .property(move |_subj, key, _ty, value| {
                                if key == Some("default.audio.sink") {
                                    if let Some(name) = value
                                        .and_then(|v| {
                                            serde_json::from_str::<serde_json::Value>(v).ok()
                                        })
                                        .and_then(|v| {
                                            v.get("name")
                                                .and_then(|n| n.as_str())
                                                .map(|s| s.to_string())
                                        })
                                    {
                                        if let Ok(mut cell) = dnc.lock() {
                                            *cell = Some(name);
                                        }
                                    }
                                }
                                0
                            })
                            .register();
                        *ms.borrow_mut() = Some(MetaBind {
                            _listener: lis,
                            _proxy: md,
                        });
                        return;
                    }
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
                    // obj.id is the connect target within this session.
                    if let Ok(mut v) = f.lock() {
                        v.push((obj.id, name));
                    }
                })
                .register();
            let want = core.sync(0)?.seq() as i64;
            hold = Some((
                Box::new(reg_listener) as _,
                Box::new(core_listener) as _,
                reg,
                core,
                ctx,
            ));
            Ok(want)
        })()
    };
    let want = match r {
        Ok(w) => w,
        Err(e) => {
            tl.stop();
            return Err(e);
        }
    };
    // Wait without the lock for the done event carrying *this* sync's
    // seq — the registry burst is guaranteed to be dispatched before it.
    let mut ok = false;
    for _ in 0..100 {
        if synced.load(Ordering::Acquire) == want {
            ok = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Second round-trip: metadata was bound *during* the first burst —
    // its property events can land after the first done. A second sync
    // after it makes the default-sink read deterministic.
    if ok {
        let want2 = {
            let _guard = tl.lock();
            hold.as_ref()
                .and_then(|(_, _, _, core, _)| core.sync(0).ok().map(|s| s.seq() as i64))
                .unwrap_or(-1)
        };
        if want2 >= 0 {
            let mut got = false;
            for _ in 0..100 {
                if synced.load(Ordering::Acquire) == want2 {
                    got = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if !got {
                ok = false;
            }
        }
    }
    {
        let _guard = tl.lock();
        drop(hold.take());
    }
    tl.stop();
    if !ok {
        return Err(anyhow!("pipewire registry sync timed out"));
    }
    let out = std::mem::take(&mut *found.lock().unwrap());
    let dn = default_name.lock().unwrap().clone();
    Ok((out, dn))
}

fn sink_node_for(name: &str) -> Result<(u32, String)> {
    for (node_id, node_name) in enumerate_sinks()?.0 {
        if node_name == name {
            return Ok((node_id, node_name));
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
        const TTL: std::time::Duration = std::time::Duration::from_secs(2);
        {
            let c = self.list_cache.lock().unwrap();
            if let Some((t, v)) = c.as_ref() {
                if t.elapsed() < TTL {
                    return v.clone();
                }
            }
        }
        let (sinks, default_name) = enumerate_sinks().unwrap_or_default();
        let v: Vec<DeviceDesc> = sinks
            .into_iter()
            .map(|(_serial, name)| DeviceDesc {
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
                default_sample_rate_hz: 48000,
                channels: 2,
            })
            .collect();
        *self.list_cache.lock().unwrap() =
            Some((std::time::Instant::now(), v.clone()));
        v
    }

    fn device_error(&self) -> Option<String> {
        self.error.lock().unwrap().take()
    }

    fn error_cell(&self) -> Option<Arc<Mutex<Option<String>>>> {
        Some(Arc::clone(&self.error))
    }

    fn is_pipewire(&self) -> bool {
        true
    }

    fn has_explicit_target(&self) -> bool {
        self.target.is_some()
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
    /// atomic mirror of OutputCore::paused — silence without draining,
    /// so the pre-pause tail survives for a seamless resume. Stale-PCM
    /// flushing is the feeder's job (producer-side epoch fence).
    paused: Arc<AtomicBool>,
    /// last process() time in coarse ms since `t0` — the sink's
    /// is_dead() watchdog uses it to detect a stream that reaches
    /// Paused but never runs.
    last_process_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Negotiated latency quantum in frames — the fill ceiling when the
    /// graph doesn't state a request (mpv caps the same way).
    latency_frames: usize,
    /// Distinct from last_process_ms (which is reseeded at negotiation
    /// end): set only by an actual process callback — the watchdog's
    /// "never scheduled" arm keys on this.
    processed_once: Arc<AtomicBool>,
    t0: std::time::Instant,
}

/// State-callback state: error reporting + dead flag + last state,
/// atomics/mutex only so writes from the loop thread are safe next to
/// the RT `process`. `state`: 0 Unconnected, 1 Connecting, 2 Paused,
/// 3 Streaming, 4 Error. `suppress` is set on intentional teardown —
/// disconnect() fires Unconnected which must NOT poison the error cell.
struct StreamErr {
    error: Arc<Mutex<Option<String>>>,
    dead: Arc<AtomicBool>,
    state: Arc<std::sync::atomic::AtomicU8>,
    suppress: Arc<AtomicBool>,
    /// incremented by the `drained` stream event — entries wait on a
    /// baseline captured at request time, so one completion can never
    /// be mistaken for a LATER request's (and completions are stream-
    /// state events, valid for every pending drain).
    drained_seq: Arc<std::sync::atomic::AtomicU64>,
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
        // Staging ring: rate/8 samples (~125ms) or 4× the advertised
        // quantum, whichever is larger — it decouples the RT callback
        // from the core mutex but makes pull-side position lead the
        // audible output by up to that depth.
        // Advertise the quantum we'd like; the ring covers 4× that plus
        // a feeder-chunk floor (handled inside spawn_feed) so an
        // unlucky graph quantum still can't starve a full cycle.
        let latency = 2048u32;
        let capacity = (neg.rate as usize * neg.channels as usize / 8)
            .max(4 * latency as usize * neg.channels.max(1) as usize);
        let (paused, last_process_ms, processed_once) = {
            let c = core.lock().unwrap_or_else(|p| p.into_inner());
            (
                Arc::clone(&c.paused_flag),
                Arc::new(std::sync::atomic::AtomicU64::new(0)),
                Arc::new(AtomicBool::new(false)),
            )
        };
        let t0 = std::time::Instant::now();
        let dead = Arc::new(AtomicBool::new(false));
        let state = Arc::new(std::sync::atomic::AtomicU8::new(0));
        let suppress = Arc::new(AtomicBool::new(false));
        let drained_seq = Arc::new(std::sync::atomic::AtomicU64::new(0));
        // Spawn before the thread loop; FeedGuard::drop stops+joins on
        // every subsequent failure path.
        let (cons, feed) = spawn_feed(
            &core,
            pull,
            capacity,
            neg.channels as usize,
        )?;
        let staged_c = cons.clone();
        let staged_ch = neg.channels as usize;
        let staged: Box<dyn Fn() -> u64 + Send + Sync> =
            Box::new(move || (staged_c.available() / staged_ch) as u64);

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
            let props = properties! {
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
                // No NODE_ALWAYS_PROCESS — the node suspends when idle,
                // like mpv's: a held-active driver would pin the graph
                // rate and block device suspend for nothing.
                *pw::keys::NODE_WANT_DRIVER => "true",
                *pw::keys::STREAM_IS_LIVE => "true",
                // Advertise the quantum we sized the staging ring for;
                // mpv does the same — without it a high-latency graph
                // quantum could starve a ring sized to the default.
                *pw::keys::NODE_LATENCY => format!("{}/{}", latency, neg.rate),
            };
            let stream = pw::stream::StreamRc::new(pw_core.clone(), "Cadence", props)?;
            let state_listener = stream
                .add_local_listener_with_user_data(StreamErr {
                    error: Arc::clone(&self.error),
                    dead: Arc::clone(&dead),
                    state: Arc::clone(&state),
                    suppress: Arc::clone(&suppress),
                    drained_seq: Arc::clone(&drained_seq),
                })
                .state_changed(|_s, ud, old, new| {
                    if ud.suppress.load(Ordering::Relaxed) {
                        return;
                    }
                    ud.state.store(
                        match new {
                            pw::stream::StreamState::Unconnected => 0,
                            pw::stream::StreamState::Connecting => 1,
                            pw::stream::StreamState::Paused => 2,
                            pw::stream::StreamState::Streaming => 3,
                            pw::stream::StreamState::Error(_) => 4,
                        },
                        Ordering::Release,
                    );
                    // A stream that falls out of a live state back to
                    // Unconnected lost its remote (daemon restart, node
                    // removed) — as unrecoverable as an explicit error.
                    let lost = matches!(new, pw::stream::StreamState::Unconnected)
                        && matches!(
                            old,
                            pw::stream::StreamState::Paused | pw::stream::StreamState::Streaming
                        );
                    if let pw::stream::StreamState::Error(e) = new {
                        if let Ok(mut cell) = ud.error.lock() {
                            *cell = Some(e);
                        }
                        ud.dead.store(true, Ordering::Relaxed);
                    } else if lost {
                        if let Ok(mut cell) = ud.error.lock() {
                            *cell = Some("stream lost remote node".into());
                        }
                        ud.dead.store(true, Ordering::Relaxed);
                    }
                })
                .drained(|_s, ud| {
                    ud.drained_seq.fetch_add(1, Ordering::Relaxed);
                })
                .register()?;
            let process_listener = stream
                .add_local_listener_with_user_data(Feed {
                    cons,
                    channels: neg.channels as usize,
                    paused: paused.clone(),
                    last_process_ms: Arc::clone(&last_process_ms),
                    latency_frames: latency as usize,
                    processed_once: Arc::clone(&processed_once),
                    t0,
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
            // A specific sink targets by node id — direct, no reliance
            // on the session manager honoring target.object (its
            // autoconnect would otherwise pick the default).
            stream.connect(
                spa::utils::Direction::Output,
                self.target,
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
        // connect() returns before negotiation finishes — failures land
        // asynchronously in state_changed. Wait for a decisive state so a
        // bad stream errors out here (and open_sink can fall back to CPAL)
        // instead of looking healthy until the monitor notices. Paused is
        // decisive: the driver may keep a ready stream paused until data
        // flows.
        let decisive = {
            let mut ok = false;
            for _ in 0..200 {
                let s = state.load(Ordering::Acquire);
                if s >= 2 || dead.load(Ordering::Relaxed) {
                    ok = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            ok
        };
        if !decisive || dead.load(Ordering::Relaxed) {
            // The real error (if any) is already in the cell — don't let
            // the teardown's own Unconnected clobber it.
            suppress.store(true, Ordering::Relaxed);
            {
                let _guard = tl.lock();
                let _ = stream.disconnect();
                // Listeners unlink from the stream's hook list — drop them
                // first, still under the loop lock.
                drop(state_listener);
                drop(process_listener);
                drop(stream);
                drop(pw_core);
                drop(ctx);
            }
            tl.stop();
            return Err(anyhow!("pipewire stream failed negotiation"));
        }
        // Anchor the watchdog grace at negotiation END — the decisive
        // wait itself can consume ~2s of it otherwise.
        last_process_ms.store(t0.elapsed().as_millis() as u64, Ordering::Relaxed);
        let paused_flag = paused.load(Ordering::Relaxed);
        Ok(Box::new(PipeWireSink {
            _state_listener: Box::new(state_listener),
            _process_listener: Box::new(process_listener),
            stream,
            _core: pw_core,
            _ctx: ctx,
            tl,
            feed,
            dead,
            suppress,
            paused,
            last_process_ms,
            processed_once,
            t0,
            staged,
            device_delay_frames: latency as u64,
            rate_hz: neg.rate as u64,
            error: Arc::clone(&self.error),
            state,
            drained_seq: Arc::clone(&drained_seq),
            barrier: Arc::new(DrainBarrier {
                req: std::sync::atomic::AtomicU64::new(0),
                dispatched: std::sync::atomic::AtomicU64::new(0),
                settled: std::sync::atomic::AtomicU64::new(0),
                drained_seq,
            }),
            wd_paused: AtomicBool::new(paused_flag),
        }))
    }
}

/// Fill one stream buffer from the staging ring. RT thread: never locks —
/// the ring is SPSC wait-free; an underrun zero-pads the remainder so the
/// stream keeps its timeline (same contract as the CPAL callback).
fn fill<T: PcmSample>(stream: &pw::stream::Stream, feed: &mut Feed<T>) {
    feed.last_process_ms
        .store(feed.t0.elapsed().as_millis() as u64, Ordering::Relaxed);
    feed.processed_once.store(true, Ordering::Relaxed);
    // Paused: silence WITHOUT draining — the pre-pause tail stays queued
    // so resume picks up exactly where playback stopped.
    if feed.paused.load(Ordering::Acquire) {
        let Some(mut buffer) = stream.dequeue_buffer() else {
            return;
        };
        let requested = buffer.requested() as usize;
        let datas = buffer.datas_mut();
        if datas.is_empty() {
            return;
        }
        let stride = T::BYTES * feed.channels;
        let size = datas[0]
            .data()
            .map(|s| {
                let max_frames = s.len() / stride;
                let frames = if requested > 0 {
                    requested.min(max_frames)
                } else {
                    max_frames
                };
                s[..frames * stride].fill(0);
                frames * stride
            })
            .unwrap_or(0);
        let chunk = datas[0].chunk_mut();
        *chunk.offset_mut() = 0;
        *chunk.stride_mut() = stride as _;
        *chunk.size_mut() = size as _;
        return;
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
                // Unstated request → cap at the negotiated quantum,
                // not the whole mmap region: filling the region would
                // flush the staging ring into one buffer and starve
                // the following callbacks (mpv clamps the same way).
                feed.latency_frames.min(max_frames)
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

/// Ordering barrier for drain requests. `drained` events post to the
/// main loop via pw_loop_invoke and dispatch FIFO — so after each
/// flush we queue a marker invoke on the SAME loop; when it runs,
/// every drained event posted before it has been delivered and folded
/// into `settled`. Completion then means "a drained event strictly
/// newer than the settled point", which no stale event can satisfy —
/// a stale event posts before the marker, a real one after.
struct DrainBarrier {
    /// incremented at REQUEST time — each drain gets a unique id; the
    /// marker carries it in userdata so waiters key on THEIR marker,
    /// not just any dispatch.
    req: std::sync::atomic::AtomicU64,
    /// request id of the last dispatched marker (markers dispatch
    /// FIFO, so this is monotonic).
    dispatched: std::sync::atomic::AtomicU64,
    /// drained_seq value captured at the last marker dispatch — all
    /// drained events queued before that marker are consumed here.
    /// Monotonic non-decreasing, so a later marker's stamp is always
    /// a safe (stricter) baseline.
    settled: std::sync::atomic::AtomicU64,
    drained_seq: Arc<std::sync::atomic::AtomicU64>,
}

struct BarrierUd {
    barrier: Arc<DrainBarrier>,
    req_id: u64,
}

unsafe extern "C" fn drain_barrier_cb(
    _loop: *mut spa::sys::spa_loop,
    _async: bool,
    _seq: u32,
    _data: *const std::ffi::c_void,
    _size: usize,
    ud: *mut std::ffi::c_void,
) -> std::os::raw::c_int {
    let u = Box::from_raw(ud as *mut BarrierUd);
    u.barrier
        .settled
        .store(u.barrier.drained_seq.load(Ordering::Acquire), Ordering::Release);
    u.barrier.dispatched.store(u.req_id, Ordering::Release);
    0
}

// Field order matters: struct fields drop top-to-bottom, and the
// listeners must unlink from the stream's hook list BEFORE the stream
// is destroyed — pw_stream_destroy frees the list head, so a listener
// dropped after the stream writes into freed memory.
pub struct PipeWireSink {
    /// Boxed listeners — keep the PW callbacks alive (concrete types
    /// vary with the negotiated sample format). Declared first so they
    /// drop first.
    _state_listener: Box<dyn std::any::Any>,
    _process_listener: Box<dyn std::any::Any>,
    stream: pw::stream::StreamRc,
    _core: pw::core::CoreRc,
    _ctx: pw::context::ContextRc,
    tl: pw::thread_loop::ThreadLoopRc,
    feed: FeedGuard,
    dead: Arc<AtomicBool>,
    /// Intentional teardown flag — disconnect() fires Unconnected which
    /// would otherwise look like a lost remote node and poison the
    /// shared error cell.
    suppress: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    /// Coarse ms of the last process() call since `t0`. A stream that
    /// reaches Paused but never runs (no remote node to link to) shows
    /// no explicit error — the watchdog turns that into a dead flag.
    last_process_ms: Arc<std::sync::atomic::AtomicU64>,
    t0: std::time::Instant,
    /// Frames staged but not yet delivered — respawn subtracts it so a
    /// rebuild doesn't skip the tail.
    staged: Box<dyn Fn() -> u64 + Send + Sync>,
    /// Negotiated latency quantum — the device-side delay not included
    /// in `staged` (samples already handed to the graph).
    device_delay_frames: u64,
    /// Negotiated rate — pw_time.delay is in `rate` ticks, converted
    /// back to frames at the stream's own rate.
    rate_hz: u64,
    /// Caps' shared error cell — the watchdog writes here (not just the
    /// dead flag) so a mid-playback stall reaches the monitor's
    /// device_error poll, not only the next open.
    error: Arc<Mutex<Option<String>>>,
    /// Stream state shared with the state listener — the watchdog only
    /// flags a stopped stream if the graph thinks it should be running.
    state: Arc<std::sync::atomic::AtomicU8>,
    /// True only once a real process callback ran — the negotiation-end
    /// reseed of last_process_ms can't distinguish never-scheduled from
    /// scheduled-then-stalled; this can.
    processed_once: Arc<AtomicBool>,
    /// Pause state seen by the last is_dead() call — a transition
    /// reseeds the grace window so a resume can't false-trip on a
    /// timestamp that went stale DURING the pause.
    wd_paused: AtomicBool,
    /// Monotonic counter bumped by each `drained` event — entries
    /// wait for a count greater than their request baseline (mpv's
    /// pw_stream_flush model, keyed per-request).
    drained_seq: Arc<std::sync::atomic::AtomicU64>,
    /// FIFO ordering barrier on the main loop — see DrainBarrier.
    barrier: Arc<DrainBarrier>,
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
        self.suppress.store(true, Ordering::Relaxed);
        {
            let _guard = self.tl.lock();
            let _ = self.stream.disconnect();
        }
        self.tl.stop();
    }

    fn is_dead(&self) -> bool {
        if self.dead.load(Ordering::Relaxed) {
            return true;
        }
        // Watchdog: write the error cell on trip so the monitor's
        // device_error poll sees it (the dead flag alone only matters
        // at the next open).
        let paused_now = self.paused.load(Ordering::Relaxed);
        let now = self.t0.elapsed().as_millis() as u64;
        if self.wd_paused.swap(paused_now, Ordering::Relaxed) != paused_now {
            // A pause/resume transition just happened — timestamps that
            // went stale during the pause must not trip the watchdog;
            // reseed the grace window at the transition.
            self.last_process_ms.store(now, Ordering::Relaxed);
        }
        if paused_now {
            return false;
        }
        let last = self.last_process_ms.load(Ordering::Relaxed);
        // Arms:
        //  - never scheduled: no process callback at all while expected
        //    to run (unlinked streams sit at Paused forever);
        //  - stopped mid-playback: graph still reports Streaming but
        //    callbacks stopped >2.5s ago. A merely suspended stream sits
        //    at Paused with processed_once set — PipeWire resumes it.
        //    Tradeoff: a *permanently* suspended stream (processed once,
        //    parked at Paused forever, no Unconnected event) is silently
        //    tolerated — the false-positive class is worse than a dead
        //    silence the user can resolve by re-selecting the device.
        let state = self.state.load(Ordering::Acquire);
        let never = !self.processed_once.load(Ordering::Relaxed);
        // `last` is the negotiation-end anchor (or a pause-transition
        // reseed) under !processed_once — the grace must measure from
        // there, not from open-start t0: a ~2s decisive wait would
        // leave the never-arm <0.5s to see its first callback.
        let stale = (never || state == 3) && now.saturating_sub(last) > 2500;
        if stale {
            if let Ok(mut cell) = self.error.lock() {
                *cell = Some("stream never scheduled (no process callbacks)".into());
            }
            self.dead.store(true, Ordering::Relaxed);
            return true;
        }
        false
    }

    fn staged_frames(&self) -> u64 {
        (self.staged)()
    }

    fn device_delay_frames(&self) -> u64 {
        // The same accounting mpv's ao_pipewire does: `delay` is the
        // stream-to-device latency in `rate` ticks (usually 1/rate —
        // docs: delay*num/denom seconds) and `buffered` is the
        // converter's own backlog in frames. `queued` is not usable
        // here — it sums pw_buffer.size values the app must set, and
        // pipewire-rs exposes no size setter. Fall back to the
        // negotiated quantum if the query fails.
        // tl.lock() on the 20ms monitor path — a bounded struct read
        // only. This MUST stay non-blocking: it's the only monitor →
        // thread-loop-lock edge, so nothing inside may wait on the
        // monitor back.
        let _g = self.tl.lock();
        self.stream
            .time()
            .map(|t| {
                let rate = t.rate();
                let delay_secs =
                    t.delay().max(0) as f64 * rate.num as f64 / rate.denom.max(1) as f64;
                (delay_secs * self.rate_hz as f64).round() as u64 + t.buffered()
            })
            .unwrap_or(self.device_delay_frames)
    }

    fn format_rate_hz(&self) -> u64 {
        self.rate_hz
    }

    fn request_drain(&self) -> Option<u64> {
        // Marker FIRST, then flush — both under tl. Every stale event
        // was queued before the marker (the loop can't dispatch while
        // we hold tl, and no event can post between marker and flush:
        // a drain completion needs the queue empty, and the queued
        // tail keeps it non-empty). A real completion can only post
        // after the flush → after the marker → it always counts.
        let _g = self.tl.lock();
        let tag = self.barrier.req.fetch_add(1, Ordering::AcqRel) + 1;
        unsafe {
            let l = pw::sys::pw_thread_loop_get_loop(self.tl.as_raw_ptr());
            if l.is_null() || (*l).loop_.is_null() {
                return None;
            }
            let lp = (*l).loop_;
            let methods =
                (*lp).iface.cb.funcs as *const spa::sys::spa_loop_methods;
            let invoke = (*methods).invoke?;
            let ud = Box::into_raw(Box::new(BarrierUd {
                barrier: Arc::clone(&self.barrier),
                req_id: tag,
            })) as *mut std::ffi::c_void;
            let r = invoke(
                (*lp).iface.cb.data,
                Some(drain_barrier_cb),
                spa::sys::SPA_ID_INVALID,
                std::ptr::null(),
                0,
                false,
                ud,
            );
            if r < 0 {
                // Marker never queued — reclaim the userdata and
                // report unsupported so the caller falls back to the
                // deadline path rather than waiting forever.
                drop(Box::from_raw(ud as *mut BarrierUd));
                return None;
            }
        }
        self.stream.flush(true).ok()?;
        Some(tag)
    }

    fn drained_since(&self, baseline: u64) -> bool {
        // OUR marker must have run (proves every event queued before
        // this request was delivered and folded into `settled`), then
        // EITHER a strictly newer drained event, OR a post-marker
        // process-callback stall — `drained` latches `draining`
        // upstream, stopping process() for good, so the callback
        // going quiet IS the completion signal (covers PipeWire's
        // notification coalescing, which can suppress our event when
        // an old one was still pending).
        if self.barrier.dispatched.load(Ordering::Acquire) < baseline {
            return false;
        }
        if self.drained_seq.load(Ordering::Acquire)
            > self.barrier.settled.load(Ordering::Acquire)
        {
            return true;
        }
        // ~4 quanta of silence from the RT callback = drained.
        let stall_ms = 2048 * 4000 / self.rate_hz + 40;
        let last = self.last_process_ms.load(Ordering::Acquire);
        self.t0
            .elapsed()
            .as_millis()
            .saturating_sub(last as u128)
            > stall_ms as u128
    }

    fn resume(&self) {
        // A drain leaves the stream deactivated AND stops the process
        // callback for good — pw_stream_set_active clears BOTH the
        // `draining` and `drained` states, which also CANCELS any
        // pending drain, so no completion can arrive after this call.
        // Reactivate + reseed the watchdog anchor.
        {
            let _g = self.tl.lock();
            let _ = self.stream.set_active(true);
        }
        self.last_process_ms
            .store(self.t0.elapsed().as_millis() as u64, Ordering::Relaxed);
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
