//! Regression tests for the stream-rebuild deadlock + NullSink zombie
//! thread, and for generation-gated prefetch.
//!
//! The old rebuild path dropped the old sink while holding the OutputCore
//! mutex: dropping a sink joins its pull thread, which is blocked on that
//! same mutex -> deadlock (and NullSink had no Drop, so its thread became a
//! zombie). These tests exercise setDevice + fidelity rebuilds under the
//! null sink and assert both completion and that exactly one pull thread
//! survives.

mod common;

use cadence_audio::decode::PcmKind;
use cadence_audio::engine::{Engine, EngineConfig, LoadParams, SourceSpec};
use cadence_audio::sink::{DeviceCaps, Negotiated, NullCaps, resolve_positions};
use common::fixtures_dir;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn make_engine(rate: u32) -> (Arc<Engine>, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let events2 = Arc::clone(&events);
    let emit = Arc::new(move |v: Value| {
        events2.lock().unwrap().push(v);
    });
    let caps = Arc::new(NullCaps {
        rate,
        channels: 2,
        fast: false,
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
        null_dump: None,
        buffer_secs: 1.5,
        ..Default::default()
    };
    let (core, _tap, fft_cons) = Engine::make_core(neg.clone(), None);
    let sink = caps.open_stream(&neg, Arc::clone(&core)).unwrap();
    let engine = Engine::new(cfg, emit, sink, caps, fft_cons, core);
    engine.start_monitor();
    (engine, events)
}

/// Count live threads named "null-sink" in this process (Linux /proc).
#[cfg(target_os = "linux")]
fn null_sink_threads() -> usize {
    std::fs::read_dir("/proc/self/task")
        .map(|d| {
            d.filter_map(|e| {
                e.ok()
                    .and_then(|e| std::fs::read_to_string(e.path().join("comm")).ok())
            })
            .filter(|c| c.trim() == "null-sink")
            .count()
        })
        .unwrap_or(0)
}

#[cfg(not(target_os = "linux"))]
fn null_sink_threads() -> usize {
    // Can't inspect threads portably; rebuild completion is the real check.
    1
}

fn load_track(engine: &Arc<Engine>, gen: u64) {
    let a = fixtures_dir().join("gapless-a.flac");
    engine
        .load(LoadParams {
            queue_id: "qa".into(),
            generation_id: gen,
            source: SourceSpec::File { path: a },
            start_paused: false,
            position_ms: 0,
            replay_gain_db: None,
        })
        .unwrap();
}

#[test]
fn repeated_stream_rebuilds_do_not_deadlock_or_leak_threads() {
    let (engine, _events) = make_engine(48000);
    load_track(&engine, 1);

    // Run the rebuilds on a worker so a regression to "drop sink while
    // holding core" fails the assert below instead of hanging the test run.
    let eng = Arc::clone(&engine);
    let worker = std::thread::spawn(move || {
        eng.set_device(None).unwrap();
        eng.set_device(None).unwrap();
        // Fidelity on: 44.1k source wants a 44.1k stream -> real rebuild.
        eng.set_fidelity_mode(true).unwrap();
        // Fidelity off: stream returns to 48k -> second real rebuild.
        eng.set_fidelity_mode(false).unwrap();
    });
    let t0 = Instant::now();
    while !worker.is_finished() {
        assert!(
            t0.elapsed() < Duration::from_secs(15),
            "stream rebuild deadlocked (sink join under core lock?)"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    worker.join().unwrap();

    // Give any straggler a moment, then prove old pull threads were joined.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(null_sink_threads(), 1, "zombie null-sink pull thread(s)");

    engine.shutdown();
    assert_eq!(null_sink_threads(), 0, "sink thread survived shutdown");
}

#[test]
fn prefetch_rejects_stale_generation() {
    let (engine, _events) = make_engine(44100);
    load_track(&engine, 3);
    let b = fixtures_dir().join("gapless-b.flac");

    let err = engine
        .prefetch("qb", b.to_str().unwrap(), 99, None)
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("stale generation"),
        "unexpected error: {err:#}"
    );

    // Current generation is accepted.
    engine.prefetch("qb", b.to_str().unwrap(), 3, None).unwrap();
    engine.shutdown();
}
