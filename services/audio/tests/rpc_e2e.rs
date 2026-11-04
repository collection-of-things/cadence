//! End-to-end stdio JSON-RPC test against the compiled binary in null-sink
//! mode: load -> prefetch -> gapless boundary -> ended -> shutdown.

mod common;

use common::fixtures_dir;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct Rpc {
    child: Child,
    rx: mpsc::Receiver<Value>,
    /// every message received so far (responses + events)
    seen: Vec<Value>,
    stdin: std::process::ChildStdin,
    id: u64,
}

impl Rpc {
    fn spawn(extra_args: &[&str]) -> Self {
        let bin = env!("CARGO_BIN_EXE_cadence-audio");
        let mut child = Command::new(bin)
            .arg("--null-sink")
            .args(extra_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cadence-audio");
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        let stdin = child.stdin.take().unwrap();
        Rpc {
            child,
            rx,
            seen: Vec::new(),
            stdin,
            id: 0,
        }
    }

    fn send(&mut self, method: &str, params: Value) -> u64 {
        self.id += 1;
        let msg = serde_json::json!({
            "jsonrpc": "2.0", "id": self.id, "method": method, "params": params,
        });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
        self.id
    }

    fn recv_one(&mut self, timeout: Duration) -> Option<Value> {
        match self.rx.recv_timeout(timeout) {
            Ok(v) => {
                self.seen.push(v.clone());
                Some(v)
            }
            Err(_) => None,
        }
    }

    /// Wait for the response to a given request id.
    fn response(&mut self, id: u64, timeout: Duration) -> Value {
        let start = Instant::now();
        while start.elapsed() < timeout {
            match self.recv_one(Duration::from_millis(50)) {
                Some(v) => {
                    if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                        return v;
                    }
                }
                None => continue,
            }
        }
        panic!("no response for id {id}");
    }

    /// Wait until `pred` matches a live message or timeout; returns it.
    fn wait_event(&mut self, pred: impl Fn(&Value) -> bool, timeout: Duration) -> Option<Value> {
        if let Some(v) = self.seen.iter().find(|v| pred(v)) {
            return Some(v.clone());
        }
        let start = Instant::now();
        while start.elapsed() < timeout {
            match self.recv_one(Duration::from_millis(50)) {
                Some(v) => {
                    if pred(&v) {
                        return Some(v);
                    }
                }
                None => continue,
            }
        }
        None
    }

    fn has_event(&self, method: &str, pred: impl Fn(&Value) -> bool) -> bool {
        self.seen.iter().any(|v| {
            v.get("method").and_then(|m| m.as_str()) == Some(method) && pred(v)
        })
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn rpc_gapless_playback_over_stdio() {
    let dir = fixtures_dir();
    let a = dir.join("gapless-a.flac").canonicalize().unwrap();
    let b = dir.join("gapless-b.flac").canonicalize().unwrap();
    let mut rpc = Rpc::spawn(&[]); // realtime pacing — deterministic ordering

    let id = rpc.send("audio.ping", serde_json::json!({}));
    let r = rpc.response(id, Duration::from_secs(5));
    assert!(r.get("result").is_some(), "ping failed: {r}");

    let id = rpc.send(
        "audio.load",
        serde_json::json!({
            "queueId": "qa", "generationId": 11,
            "source": {"kind": "file", "path": a.to_str().unwrap()},
        }),
    );
    let r = rpc.response(id, Duration::from_secs(10));
    assert!(r.get("result").is_some(), "load failed: {r}");

    // Stale-generation prefetch must be rejected (generation-gated like
    // play/pause/stop: a skip must never install the wrong track).
    let id = rpc.send(
        "audio.prefetch",
        serde_json::json!({"queueId": "qb", "path": b.to_str().unwrap(), "generationId": 999}),
    );
    let r = rpc.response(id, Duration::from_secs(5));
    assert!(
        r.get("error").is_some(),
        "stale-generation prefetch was honored: {r}"
    );

    let id = rpc.send(
        "audio.prefetch",
        serde_json::json!({"queueId": "qb", "path": b.to_str().unwrap(), "generationId": 11}),
    );
    let r = rpc.response(id, Duration::from_secs(10));
    assert!(r.get("result").is_some(), "prefetch failed: {r}");

    // Stale-generation command must be rejected.
    let id = rpc.send("audio.pause", serde_json::json!({"generationId": 999}));
    let r = rpc.response(id, Duration::from_secs(5));
    assert!(r.get("error").is_some(), "stale generation was honored: {r}");

    // Wait for qb to end naturally (6s of audio at realtime).
    let ended = rpc.wait_event(
        |v| {
            v.get("method").and_then(|m| m.as_str()) == Some("event.trackEnded")
                && v["params"]["queueId"].as_str() == Some("qb")
        },
        Duration::from_secs(20),
    );
    assert!(ended.is_some(), "qb never ended");

    assert!(
        rpc.has_event("event.output", |_| true),
        "no event.output"
    );
    assert!(rpc.has_event("event.prefetchReady", |_| true));
    assert!(
        rpc.has_event("event.trackEnded", |v| v["params"]["queueId"] == "qa"
            && v["params"]["gapless"] == true),
        "no gapless trackEnded for qa"
    );
    assert!(
        rpc.has_event("event.trackStarted", |v| v["params"]["queueId"] == "qb"
            && v["params"]["gapless"] == true),
        "no gapless trackStarted for qb"
    );

    let id = rpc.send("audio.shutdown", serde_json::json!({}));
    let _ = rpc.response(id, Duration::from_secs(5));
    let status = rpc.child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn rpc_probe_and_decode_cli() {
    let bin = env!("CARGO_BIN_EXE_cadence-audio");
    let f = fixtures_dir().join("tone-440.flac");
    let out = Command::new(bin)
        .args(["--probe", f.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["ok"], serde_json::Value::Bool(true));
    assert_eq!(v["sampleRateHz"], serde_json::Value::from(44100));
    assert_eq!(v["codec"], serde_json::Value::from("flac"));

    let tmp = std::env::temp_dir().join(format!("cadence-cli-{}.f32le", std::process::id()));
    let out = Command::new(bin)
        .args([
            "--decode",
            f.to_str().unwrap(),
            "--out",
            tmp.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(out.status.success(), "decode failed: {:?}", out);
    let bytes = std::fs::metadata(&tmp).unwrap().len();
    assert_eq!(bytes, 44100 * 3 * 4, "unexpected decode size");
}
