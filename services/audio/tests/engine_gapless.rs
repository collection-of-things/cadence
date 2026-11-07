//! Engine-level gapless test: run the real graph against the null sink,
//! prefetch the successor, and prove the rendered stream is sample-contiguous
//! across the track boundary (no inserted silence, no discontinuity).

mod common;

use cadence_audio::decode::PcmKind;
use cadence_audio::engine::{Engine, EngineConfig, LoadParams, SourceSpec};
use cadence_audio::sink::{DeviceCaps, Negotiated, NullCaps, resolve_positions};
use common::{decode_all, fixtures_dir, longest_zero_run};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn make_engine(dump: PathBuf, rate: u32) -> (Arc<Engine>, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let events2 = Arc::clone(&events);
    let emit = Arc::new(move |v: Value| {
        events2.lock().unwrap().push(v);
    });
    let caps = Arc::new(NullCaps {
        rate,
        channels: 2,
        fast: false, // real-time pacing keeps the producer well ahead
    });
    let neg = Negotiated {
        rate,
        channels: 2,
        kind: PcmKind::F32,
        device_name: "null-sink".into(),
        positions: resolve_positions(None, 2),
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

#[test]
fn gapless_prefetched_boundary_is_sample_contiguous() {
    let dir = fixtures_dir();
    let a = dir.join("gapless-a.flac");
    let b = dir.join("gapless-b.flac");
    let dump = std::env::temp_dir().join(format!("cadence-gapless-{}.f32le", std::process::id()));
    let _ = std::fs::remove_file(&dump);

    let rate = 44100u32;
    let (engine, events) = make_engine(dump.clone(), rate);

    engine
        .load(LoadParams {
            queue_id: "qa".into(),
            generation_id: 7,
            source: SourceSpec::File { path: a.clone() },
            start_paused: false,
            position_ms: 0,
            replay_gain_db: None,
        })
        .unwrap();
    engine
        .prefetch("qb", b.to_str().unwrap(), 7, None)
        .unwrap();

    // Wait for qb's final end (trackEnded for queueId qb).
    let ended_b = wait_for(
        &events,
        |v| {
            is_method(v, "event.trackEnded")
                && v["params"]["queueId"].as_str() == Some("qb")
        },
        Duration::from_secs(20),
    );
    assert!(ended_b, "never saw trackEnded for qb");

    // Event ordering: trackEnded(qa, gapless:true) -> trackStarted(qb, gapless:true)
    let evs = events.lock().unwrap();
    let mut ended_a = None;
    let mut started_b = None;
    for (i, v) in evs.iter().enumerate() {
        if is_method(v, "event.trackEnded") && v["params"]["queueId"].as_str() == Some("qa") {
            assert_eq!(v["params"]["gapless"], Value::Bool(true), "qa end not gapless");
            ended_a = Some(i);
        }
        if is_method(v, "event.trackStarted") && v["params"]["queueId"].as_str() == Some("qb") {
            assert_eq!(v["params"]["gapless"], Value::Bool(true), "qb start not gapless");
            started_b = Some(i);
        }
    }
    let (ea, sb) = (ended_a.expect("no trackEnded qa"), started_b.expect("no trackStarted qb"));
    assert!(ea < sb, "trackEnded must precede trackStarted");
    drop(evs);
    engine.shutdown();
    std::thread::sleep(Duration::from_millis(100));

    // ---- rendered stream analysis ----
    let raw = std::fs::read(&dump).unwrap();
    let mut dump_pcm: Vec<f32> = raw
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    // trailing zero-fill after last track ended
    while dump_pcm.last() == Some(&0.0) {
        dump_pcm.pop();
    }

    // Decode the references at the channel count the engine actually
    // negotiated (source-native channels since the null device accepts
    // them — these mono fixtures now render as a mono stream).
    let out_ch = events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|v| is_method(v, "event.output"))
        .and_then(|v| v["params"]["channels"].as_u64())
        .unwrap_or(1) as u32;
    let (dec_a, _) = decode_all(&a, Some(out_ch)).unwrap();
    let (dec_b, _) = decode_all(&b, Some(out_ch)).unwrap();

    // The rendered stream must equal decode(a) ++ decode(b) sample-exactly.
    let expected: Vec<f32> = dec_a.iter().chain(dec_b.iter()).copied().collect();

    // Align: startup underruns only insert leading zeros, and the signal
    // itself may begin with zero samples (sine starts at 0), so anchor on
    // the first nonzero of each.
    let first_nz = dump_pcm.iter().position(|s| *s != 0.0).expect("silent dump");
    let exp_nz = expected.iter().position(|s| *s != 0.0).unwrap_or(0);
    let align = first_nz - exp_nz;
    assert!(align + expected.len() <= dump_pcm.len(), "dump too short");
    let body = &dump_pcm[align..align + expected.len()];

    // No inserted silence inside the rendered pair.
    let zr = longest_zero_run(&body[exp_nz..]);
    assert!(zr <= 4, "inserted silence: zero run of {zr} samples");

    let max_diff = body
        .iter()
        .zip(expected.iter())
        .map(|(x, y)| (x - y).abs())
        .fold(0f32, f32::max);
    assert_eq!(max_diff, 0.0, "rendered stream diverges from a||b");
}

#[test]
fn natural_end_without_prefetch_reports_gapless_false() {
    let dir = fixtures_dir();
    let a = dir.join("tone-440.flac");
    let dump = std::env::temp_dir().join(format!("cadence-end-{}.f32le", std::process::id()));
    let (engine, events) = make_engine(dump, 44100);
    engine
        .load(LoadParams {
            queue_id: "qa".into(),
            generation_id: 1,
            source: SourceSpec::File { path: a },
            start_paused: false,
            position_ms: 0,
            replay_gain_db: None,
        })
        .unwrap();
    let ended = wait_for(
        &events,
        |v| is_method(v, "event.trackEnded"),
        Duration::from_secs(20),
    );
    assert!(ended);
    let evs = events.lock().unwrap();
    let e = evs.iter().find(|v| is_method(v, "event.trackEnded")).unwrap();
    assert_eq!(e["params"]["gapless"], Value::Bool(false));
    // terminal state must be stopped
    let stopped = evs
        .iter()
        .rev()
        .find(|v| is_method(v, "event.state"))
        .map(|v| v["params"]["state"].as_str().unwrap_or("?").to_string());
    assert_eq!(stopped.as_deref(), Some("stopped"));
    engine.shutdown();
}

#[test]
fn fidelity_mode_bypasses_and_reports_honestly() {
    let dir = fixtures_dir();
    let hires = dir.join("tone-330-24bit96k.flac"); // 24-bit/96k native
    let dump = std::env::temp_dir().join(format!("cadence-fid-{}.f32le", std::process::id()));
    let (engine, events) = make_engine(dump, 44100);
    engine.set_fidelity_mode(true).unwrap();
    engine
        .load(LoadParams {
            queue_id: "hi".into(),
            generation_id: 3,
            source: SourceSpec::File { path: hires },
            start_paused: false,
            position_ms: 0,
            replay_gain_db: None,
        })
        .unwrap();

    // The null device accepts the native format -> bypass, stream runs 96k.
    // (f32 carries 24-bit exactly, so the negotiated kind is "float".)
    let ok = wait_for(
        &events,
        |v| is_method(v, "event.output"),
        Duration::from_secs(5),
    );
    assert!(ok);
    let evs = events.lock().unwrap();
    let out = evs
        .iter()
        .rev()
        .find(|v| is_method(v, "event.output"))
        .unwrap();
    assert_eq!(out["params"]["fidelityBypass"], Value::Bool(true));
    assert_eq!(out["params"]["sampleRateHz"], Value::from(96000));
    assert_eq!(out["params"]["bitDepth"], Value::from("float"));
    drop(evs);

    let ended = wait_for(
        &events,
        |v| is_method(v, "event.trackEnded"),
        Duration::from_secs(15),
    );
    assert!(ended, "24/96 track never ended on bypass path");
    engine.shutdown();
}

#[test]
fn fidelity_format_mismatch_boundary_is_honest_not_gapless() {
    let dir = fixtures_dir();
    let a = dir.join("gapless-a.flac"); // 44.1k
    let b = dir.join("tone-330-24bit96k.flac"); // 96k/24-bit
    let dump = std::env::temp_dir().join(format!("cadence-mix-{}.f32le", std::process::id()));
    let (engine, events) = make_engine(dump, 44100);
    engine.set_fidelity_mode(true).unwrap();
    engine
        .load(LoadParams {
            queue_id: "qa".into(),
            generation_id: 5,
            source: SourceSpec::File { path: a },
            start_paused: false,
            position_ms: 0,
            replay_gain_db: None,
        })
        .unwrap();
    // 96k successor can't render on the 44.1k stream in strict fidelity.
    engine.prefetch("qb", b.to_str().unwrap(), 5, None).unwrap();

    let ended_b = wait_for(
        &events,
        |v| {
            is_method(v, "event.trackEnded")
                && v["params"]["queueId"].as_str() == Some("qb")
        },
        Duration::from_secs(20),
    );
    assert!(ended_b, "qb never played after reopen");

    let evs = events.lock().unwrap();
    for v in evs.iter() {
        if is_method(v, "event.trackEnded") && v["params"]["queueId"].as_str() == Some("qa") {
            assert_eq!(
                v["params"]["gapless"],
                Value::Bool(false),
                "format reopen falsely reported gapless"
            );
        }
        if is_method(v, "event.trackStarted") && v["params"]["queueId"].as_str() == Some("qb") {
            assert_eq!(v["params"]["gapless"], Value::Bool(false));
        }
    }
    // The reopened stream must run at the successor's native rate.
    let last_out = evs
        .iter()
        .rev()
        .find(|v| is_method(v, "event.output"))
        .expect("no event.output after reopen");
    assert_eq!(last_out["params"]["sampleRateHz"], Value::from(96000));
    assert_eq!(last_out["params"]["fidelityBypass"], Value::Bool(true));
    engine.shutdown();
}
