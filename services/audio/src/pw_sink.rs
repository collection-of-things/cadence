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
//! RT thread never touches `OutputCore`'s mutex.

use crate::decode::BitDepth;
use crate::engine::OutputCore;
use crate::sink::{spawn_feed, DeviceCaps, DeviceDesc, Negotiated, PcmSample, Sink};
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
fn enumerate_sinks() -> Result<Vec<(u32, String)>> {
    let tl = unsafe {
        // Safety: see with_core — same loop discipline.
        pw::thread_loop::ThreadLoopRc::new(Some("cadence-pw-ctl"), None)
    }?;
    tl.start();
    let found = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(u32, String)>::new()));
    {
        let _guard = tl.lock();
        let ctx = pw::context::ContextRc::new(&tl, None)?;
        let core = ctx.connect_rc(None)?;
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
    }
    // Let the loop dispatch the initial global burst.
    std::thread::sleep(std::time::Duration::from_millis(250));
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

    fn open_stream(&self, neg: &Negotiated, core: Arc<Mutex<OutputCore>>) -> Result<Box<dyn Sink>> {
        match neg.kind {
            PcmKind::F32 => self.open_typed::<f32>(neg, core, OutputCore::pull_f32),
            PcmKind::S32 => self.open_typed::<i32>(neg, core, OutputCore::pull_s32),
            PcmKind::S16 => self.open_typed::<i16>(neg, core, OutputCore::pull_s16),
        }
    }
}

/// What the process callback needs: drain the staging ring into each buffer.
struct Feed<T> {
    cons: crate::ringbuf::Consumer<T>,
    channels: usize,
    error: Arc<Mutex<Option<String>>>,
}

impl PipeWireCaps {
    fn open_typed<T: PcmSample>(
        &self,
        neg: &Negotiated,
        core: Arc<Mutex<OutputCore>>,
        pull: fn(&mut OutputCore, &mut [T]),
    ) -> Result<Box<dyn Sink>> {
        // ~60ms staging ring: decouples the RT callback from the core mutex
        // without adding audible latency to the graph.
        let capacity = (neg.rate as usize * neg.channels as usize / 16).max(8192);
        let (cons, feed_stop, feed_join) = spawn_feed(&core, pull, capacity);

        let dead = Arc::new(AtomicBool::new(false));
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
            let stream = pw::stream::StreamRc::new(
                pw_core.clone(),
                "Cadence",
                properties! {
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
                },
            )?;
            let err = Arc::clone(&self.error);
            let dead_cb = Arc::clone(&dead);
            let listener = stream
                .add_local_listener_with_user_data(Feed {
                    cons,
                    channels: neg.channels as usize,
                    error: err,
                })
                .state_changed(move |_s, ud, _old, new| {
                    if let pw::stream::StreamState::Error(e) = new {
                        dead_cb.store(true, Ordering::Relaxed);
                        *ud.error.lock().unwrap() = Some(e);
                    }
                })
                .process(|stream, feed| fill::<T>(stream, feed))
                .register()?;

            let mut info = spa::param::audio::AudioInfoRaw::new();
            info.set_format(spa_format(neg.kind));
            info.set_rate(neg.rate);
            info.set_channels(neg.channels);
            // Position left UNPOSITIONED — PipeWire infers the standard
            // layout from the channel count.
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
                self.target,
                pw::stream::StreamFlags::AUTOCONNECT
                    | pw::stream::StreamFlags::MAP_BUFFERS
                    | pw::stream::StreamFlags::RT_PROCESS,
                &mut params,
            )?;
            Ok((ctx, pw_core, stream, listener))
        })();
        let (ctx, pw_core, stream, listener) = match built {
            Ok(v) => v,
            Err(e) => {
                feed_stop.store(true, Ordering::Relaxed);
                tl.stop();
                let _ = feed_join.join();
                return Err(e);
            }
        };
        Ok(Box::new(PipeWireSink {
            stream,
            _listener: Box::new(listener),
            _core: pw_core,
            _ctx: ctx,
            tl,
            feed_stop,
            feed_join: Some(feed_join),
            dead,
        }))
    }
}

/// Fill one stream buffer from the staging ring. RT thread: never locks —
/// the ring is SPSC wait-free; an underrun zero-pads the remainder so the
/// stream keeps its timeline (same contract as the CPAL callback).
fn fill<T: PcmSample>(stream: &pw::stream::Stream, feed: &mut Feed<T>) {
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
    /// Boxed listener — keeps the PW callbacks alive (concrete type varies
    /// with the negotiated sample format).
    _listener: Box<dyn std::any::Any>,
    _core: pw::core::CoreRc,
    _ctx: pw::context::ContextRc,
    tl: pw::thread_loop::ThreadLoopRc,
    feed_stop: Arc<AtomicBool>,
    feed_join: Option<std::thread::JoinHandle<()>>,
    dead: Arc<AtomicBool>,
}

// StreamRc/ThreadLoopRc are Rc-based (!Send) — the same portability
// constraint cpal documents for its Stream handle. The Cadence engine only
// touches the sink from the control thread while PW's own loop thread runs
// the callbacks, so moving the handle between threads is sound here.
unsafe impl Send for PipeWireSink {}

impl Sink for PipeWireSink {
    fn stop(&mut self) {
        self.feed_stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.feed_join.take() {
            let _ = j.join();
        }
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
