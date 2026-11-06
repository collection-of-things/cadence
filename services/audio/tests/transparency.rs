//! Transparency null-tests for issue #1: the rendered output of the full
//! engine graph (decode -> DSP -> resample -> ring -> pull -> dump) must be
//! bit-exact against a plain ffmpeg decode whenever the device can carry the
//! source's native format, with EQ flat and ReplayGain disabled (defaults).

mod common;

use cadence_audio::decode::PcmKind;
use cadence_audio::engine::{Engine, EngineConfig, LoadParams, OutputCore, SourceSpec};
use cadence_audio::sink::{DeviceCaps, DeviceDesc, Negotiated, NullCaps, Sink};
use cadence_audio::decode::BitDepth;
use common::{decode_all, fixtures_dir};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn make_engine_with_caps(
    dump: PathBuf,
    caps: Arc<dyn DeviceCaps>,
    rate: u32,
) -> (Arc<Engine>, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let events2 = Arc::clone(&events);
    let emit = Arc::new(move |v: Value| {
        events2.lock().unwrap().push(v);
    });
    let neg = Negotiated {
        rate,
        channels: 2,
        kind: PcmKind::F32,
        device_name: caps.name(),
    };
    let cfg = EngineConfig {
        null_sink: true,
        null_rate: rate,
        null_fast: false,
        null_dump: Some(dump.clone()),
        buffer_secs: 1.5,
        ..Default::default()
    };
    let (core, _tap, fft_cons) = Engine::make_core(neg.clone(), Some(dump));
    let sink = caps.open_stream(&neg, Arc::clone(&core)).unwrap();
    let engine = Engine::new(cfg, emit, sink, caps, fft_cons, core);
    engine.start_monitor();
    (engine, events)
}

fn make_engine(dump: PathBuf, rate: u32) -> (Arc<Engine>, Arc<Mutex<Vec<Value>>>) {
    let caps = Arc::new(NullCaps {
        rate,
        channels: 2,
        fast: false,
    });
    make_engine_with_caps(dump, caps, rate)
}

fn wait_for<F: Fn(&Value) -> bool>(
    events: &Arc<Mutex<Vec<Value>>>,
    pred: F,
    timeout: Duration,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if events.lock().unwrap().iter().any(|e| pred(e)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

fn is_method(v: &Value, m: &str) -> bool {
    v.get("method").and_then(|x| x.as_str()) == Some(m)
}

fn load_file(engine: &Arc<Engine>, path: &std::path::Path, qid: &str, gen: u64, rg: Option<f64>) {
    engine
        .load(LoadParams {
            queue_id: qid.into(),
            generation_id: gen,
            source: SourceSpec::File {
                path: path.to_path_buf(),
            },
            start_paused: false,
            position_ms: 0,
            replay_gain_db: rg,
        })
        .unwrap();
}

/// Read a dump file as f32 samples.
fn read_dump(dump: &std::path::Path) -> Vec<f32> {
    std::fs::read(dump)
        .unwrap()
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Assert the rendered dump contains `reference` bit-exactly: leading zeros
/// (startup/pause), then the reference verbatim, then trailing zeros.
fn assert_contains_bit_exact(dump_pcm: &[f32], reference: &[f32], label: &str) {
    // first nonzero anchor on each side
    let d_nz = dump_pcm
        .iter()
        .position(|s| *s != 0.0)
        .expect("dump is silent");
    let r_nz = reference.iter().position(|s| *s != 0.0).unwrap_or(0);
    let align = d_nz.checked_sub(r_nz).expect("dump starts inside reference");
    // everything before the anchor must be zeros
    assert!(
        dump_pcm[..d_nz].iter().all(|s| *s == 0.0),
        "{label}: nonzero data before first reference sample"
    );
    assert!(
        align + reference.len() <= dump_pcm.len(),
        "{label}: dump shorter than reference"
    );
    let body = &dump_pcm[align..align + reference.len()];
    let max_diff = body
        .iter()
        .zip(reference.iter())
        .map(|(x, y)| (x - y).abs())
        .fold(0f32, f32::max);
    assert_eq!(max_diff, 0.0, "{label}: render diverges from ffmpeg decode");
    // trailing content after the reference must be silence
    assert!(
        dump_pcm[align + reference.len()..]
            .iter()
            .all(|s| *s == 0.0),
        "{label}: nonzero tail after track end"
    );
}

/// Every fixture the device can carry natively must render bit-exact — this
/// is the issue-#1 contract: the graph is transparent by default.
#[test]
fn render_is_bit_exact_when_device_accepts_source() {
    let dir = fixtures_dir();
    // (file, source rate, device default rate — deliberately DIFFERENT from
    // the source rate so the test also proves the engine prefers the source
    // rate over the device default when the device accepts it)
    let cases: [(&str, u32, u32); 3] = [
        ("stereo-44k1-16.flac", 44100, 48000),
        ("stereo-96k-24.flac", 96000, 48000),
        ("stereo-192k-24.flac", 192000, 48000),
    ];
    for (file, src_rate, dev_rate) in cases {
        let path = dir.join(file);
        let dump = std::env::temp_dir().join(format!(
            "cadence-null-{}-{}.f32le",
            file,
            std::process::id()
        ));
        let _ = std::fs::remove_file(&dump);
        let (engine, events) = make_engine(dump.clone(), dev_rate);
        load_file(&engine, &path, "q1", 1, None);

        // The negotiated stream must run at the SOURCE rate, not the device
        // default — honest reporting via event.output.
        let out_ok = wait_for(&events, |v| is_method(v, "event.output"), Duration::from_secs(5));
        assert!(out_ok, "{file}: no event.output");
        {
            let evs = events.lock().unwrap();
            let out = evs
                .iter()
                .rev()
                .find(|v| is_method(v, "event.output"))
                .unwrap();
            assert_eq!(
                out["params"]["sampleRateHz"],
                Value::from(src_rate),
                "{file}: stream did not open at source rate"
            );
            assert_eq!(out["params"]["channels"], Value::from(2));
            assert_eq!(out["params"]["fidelityBypass"], Value::Bool(false));
        }

        let ended = wait_for(
            &events,
            |v| is_method(v, "event.trackEnded"),
            Duration::from_secs(20),
        );
        assert!(ended, "{file}: track never ended");
        engine.shutdown();
        std::thread::sleep(Duration::from_millis(100));

        let (reference, _) = decode_all(&path, Some(2)).unwrap();
        let dump_pcm = read_dump(&dump);
        assert_contains_bit_exact(&dump_pcm, &reference, file);
    }
}

/// ReplayGain must be opt-in: disabled by default the tagged gain renders
/// bit-exact; enabled it scales by exactly the tag value.
#[test]
fn replaygain_is_transparent_when_disabled() {
    let dir = fixtures_dir();
    let path = dir.join("stereo-44k1-16.flac");
    let dump = std::env::temp_dir().join(format!("cadence-rg-{}.f32le", std::process::id()));
    let _ = std::fs::remove_file(&dump);
    let (engine, events) = make_engine(dump.clone(), 44100);

    // -6 dB tag supplied, but ReplayGain is OFF by default -> transparent.
    load_file(&engine, &path, "q1", 1, Some(-6.0));
    let ended = wait_for(
        &events,
        |v| is_method(v, "event.trackEnded"),
        Duration::from_secs(20),
    );
    assert!(ended);
    engine.shutdown();
    std::thread::sleep(Duration::from_millis(100));
    let (reference, _) = decode_all(&path, Some(2)).unwrap();
    assert_contains_bit_exact(&read_dump(&dump), &reference, "rg-disabled");
}

#[test]
fn replaygain_scales_when_enabled() {
    let dir = fixtures_dir();
    let path = dir.join("stereo-44k1-16.flac");
    let dump = std::env::temp_dir().join(format!("cadence-rgon-{}.f32le", std::process::id()));
    let _ = std::fs::remove_file(&dump);
    let (engine, events) = make_engine(dump.clone(), 44100);
    engine.set_replay_gain(true).unwrap();
    load_file(&engine, &path, "q1", 1, Some(-6.0));
    let ended = wait_for(
        &events,
        |v| is_method(v, "event.trackEnded"),
        Duration::from_secs(20),
    );
    assert!(ended);
    engine.shutdown();
    std::thread::sleep(Duration::from_millis(100));

    let (reference, _) = decode_all(&path, Some(2)).unwrap();
    let dump_pcm = read_dump(&dump);
    let d_nz = dump_pcm.iter().position(|s| *s != 0.0).unwrap();
    let r_nz = reference.iter().position(|s| *s != 0.0).unwrap_or(0);
    let align = d_nz - r_nz;
    let body = &dump_pcm[align..align + reference.len()];

    // -6 dB -> linear 0.501187…; rendered RMS / reference RMS must match it
    // within 0.05 dB, and every sample must sit within the scaled tolerance.
    let rms = |x: &[f32]| (x.iter().map(|s| (s * s) as f64).sum::<f64>() / x.len() as f64).sqrt();
    let ratio_db = 20.0 * (rms(body) / rms(&reference)).log10();
    assert!(
        (ratio_db + 6.0).abs() < 0.05,
        "rg-enabled render off by {ratio_db:.3} dB vs expected -6"
    );
    let expected_gain = 10f64.powf(-6.0 / 20.0) as f32;
    let max_dev = body
        .iter()
        .zip(reference.iter())
        .map(|(x, y)| (*x - *y * expected_gain).abs())
        .fold(0f32, f32::max);
    // f32 rounding only — must be far below audibility
    assert!(max_dev < 1e-6, "rg-enabled deviates {max_dev} from gain-scaled reference");
}

/// A device that claims native support but fails to OPEN a stream at the
/// source rate must fall back to the device default — the load succeeds on
/// the resample path, reported honestly.
#[test]
fn failed_native_open_retries_at_device_default() {
    struct FlakyCaps {
        inner: NullCaps,
        fail_rate: u32,
        opens: Arc<std::sync::atomic::AtomicU64>,
    }
    impl DeviceCaps for FlakyCaps {
        fn name(&self) -> String {
            "flaky-device".into()
        }
        fn default_rate(&self) -> u32 {
            self.inner.rate
        }
        fn default_channels(&self) -> u32 {
            self.inner.channels
        }
        // Claims to accept anything — like a plug layer that advertises
        // every rate it can convert to.
        fn accepts(&self, _r: u32, _c: u32, _d: BitDepth) -> Option<PcmKind> {
            Some(PcmKind::F32)
        }
        fn list(&self) -> Vec<DeviceDesc> {
            self.inner.list()
        }
        fn open_stream(
            &self,
            neg: &Negotiated,
            core: Arc<Mutex<OutputCore>>,
        ) -> Result<Box<dyn Sink>, anyhow::Error> {
            self.opens
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if neg.rate == self.fail_rate {
                anyhow::bail!("device refused {fail_rate}", fail_rate = neg.rate);
            }
            self.inner.open_stream(neg, core)
        }
    }

    let dir = fixtures_dir();
    let path = dir.join("stereo-44k1-16.flac");
    let dump = std::env::temp_dir().join(format!("cadence-flaky-{}.f32le", std::process::id()));
    let _ = std::fs::remove_file(&dump);
    let opens = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let caps = Arc::new(FlakyCaps {
        inner: NullCaps {
            rate: 48000,
            channels: 2,
            fast: false,
        },
        fail_rate: 44100,
        opens: Arc::clone(&opens),
    });
    let (engine, events) = make_engine_with_caps(dump.clone(), caps, 48000);
    load_file(&engine, &path, "q1", 1, None);

    let ended = wait_for(
        &events,
        |v| is_method(v, "event.trackEnded"),
        Duration::from_secs(20),
    );
    assert!(ended, "load must succeed via the default-rate fallback");

    {
        let evs = events.lock().unwrap();
        let out = evs
            .iter()
            .rev()
            .find(|v| is_method(v, "event.output"))
            .expect("no event.output");
        assert_eq!(
            out["params"]["sampleRateHz"],
            Value::from(48000),
            "fallback did not land on the device default"
        );
    }
    assert!(
        opens.load(std::sync::atomic::Ordering::SeqCst) >= 2,
        "expected a failed native open + a successful default open"
    );
    engine.shutdown();
}

/// A device that cannot run the source format falls back to its default
/// rate — the resample path — reported honestly in event.output.
#[test]
fn device_without_native_support_uses_default_rate() {
    struct LockedCaps {
        inner: NullCaps,
    }
    impl DeviceCaps for LockedCaps {
        fn name(&self) -> String {
            "locked-device".into()
        }
        fn default_rate(&self) -> u32 {
            self.inner.rate
        }
        fn default_channels(&self) -> u32 {
            self.inner.channels
        }
        fn accepts(&self, _r: u32, _c: u32, _d: BitDepth) -> Option<PcmKind> {
            None
        }
        fn list(&self) -> Vec<DeviceDesc> {
            self.inner.list()
        }
        fn open_stream(
            &self,
            neg: &Negotiated,
            core: Arc<Mutex<OutputCore>>,
        ) -> Result<Box<dyn Sink>, anyhow::Error> {
            self.inner.open_stream(neg, core)
        }
    }

    let dir = fixtures_dir();
    let path = dir.join("stereo-44k1-16.flac");
    let dump = std::env::temp_dir().join(format!("cadence-locked-{}.f32le", std::process::id()));
    let _ = std::fs::remove_file(&dump);
    let caps = Arc::new(LockedCaps {
        inner: NullCaps {
            rate: 48000,
            channels: 2,
            fast: false,
        },
    });
    let (engine, events) = make_engine_with_caps(dump.clone(), caps, 48000);
    load_file(&engine, &path, "q1", 1, None);

    let out_ok = wait_for(&events, |v| is_method(v, "event.output"), Duration::from_secs(5));
    assert!(out_ok);
    {
        let evs = events.lock().unwrap();
        let out = evs
            .iter()
            .rev()
            .find(|v| is_method(v, "event.output"))
            .unwrap();
        assert_eq!(out["params"]["sampleRateHz"], Value::from(48000));
        assert_eq!(out["params"]["fidelityBypass"], Value::Bool(false));
    }
    let ended = wait_for(
        &events,
        |v| is_method(v, "event.trackEnded"),
        Duration::from_secs(20),
    );
    assert!(ended, "track never ended through resample path");
    engine.shutdown();
    std::thread::sleep(Duration::from_millis(100));

    // Rendered at 48k: 2s of stereo -> ~96000 frames of non-silent content.
    let dump_pcm = read_dump(&dump);
    let first_nz = dump_pcm.iter().position(|s| *s != 0.0).expect("silent");
    let last_nz = dump_pcm.iter().rposition(|s| *s != 0.0).unwrap();
    let frames = (last_nz + 2 - first_nz) / 2;
    assert!(
        (frames as i64 - 96000).abs() < 2048,
        "resampled render holds {frames} frames, expected ~96000"
    );
}
