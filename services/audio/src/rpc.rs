//! Newline-delimited JSON-RPC 2.0 over stdio, per packages/protocol audio-ipc.ts.
//!
//! Events and responses share stdout under one lock, so lines never interleave.
//! Diagnostics go to stderr only.

use crate::decode::BitDepth;
use crate::engine::{Engine, LoadParams, SourceSpec};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Emitter that serializes events as single JSON lines on stdout.
pub fn stdout_emitter() -> Arc<dyn Fn(Value) + Send + Sync> {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    Arc::new(move |v: Value| {
        let mut o = out.lock().unwrap();
        let _ = writeln!(o, "{}", serde_json::to_string(&v).unwrap_or_default());
        let _ = o.flush();
    })
}

fn respond(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn respond_err(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn get_u64(p: &Value, k: &str) -> Result<u64> {
    p.get(k)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("missing/invalid param {k}"))
}

fn get_str<'a>(p: &'a Value, k: &str) -> Result<&'a str> {
    p.get(k)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing/invalid param {k}"))
}

fn parse_bit_depth(v: &Value) -> Result<BitDepth> {
    match v {
        Value::String(s) if s == "float" => Ok(BitDepth::Float),
        Value::Number(n) => n
            .as_u64()
            .map(|b| BitDepth::Int(b as u32))
            .ok_or_else(|| anyhow::anyhow!("invalid bitDepth")),
        _ => bail!("invalid bitDepth"),
    }
}

/// Run the stdio server loop until stdin closes or audio.shutdown arrives.
/// `emit` must be the same emitter the engine uses, so responses and events
/// share one stdout lock and lines can never interleave.
pub fn run_stdio(engine: Arc<Engine>, emit: Arc<dyn Fn(Value) + Send + Sync>) -> i32 {
    let stdin = std::io::stdin();
    let mut code = 0;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                emit(respond_err(&Value::Null, -32700, &format!("parse error: {e}")));
                continue;
            }
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));

        match dispatch(&engine, method, &params) {

            Ok(result) => {
                if !id.is_null() {
                    emit(respond(&id, result));
                }
            }
            Err(e) => {
                if !id.is_null() {
                    emit(respond_err(&id, -32000, &format!("{e:#}")));
                } else {
                    eprintln!("{method}: {e:#}");
                }
            }
        }
        if method == "audio.shutdown" {
            engine.shutdown();
            code = 0;
            break;
        }
    }
    engine.shutdown();
    code
}

fn dispatch(engine: &Engine, method: &str, p: &Value) -> Result<Value> {
    match method {
        "audio.ping" => Ok(engine.ping()),
        "audio.load" => {
            let source = p.get("source").context("missing source")?;
            let src = match source.get("kind").and_then(|k| k.as_str()) {
                Some("file") => SourceSpec::File {
                    path: PathBuf::from(
                        source
                            .get("path")
                            .and_then(|v| v.as_str())
                            .context("file source missing path")?,
                    ),
                },
                Some("pcm-stream") => SourceSpec::PcmStream {
                    sample_rate_hz: source
                        .get("sampleRateHz")
                        .and_then(|v| v.as_u64())
                        .context("pcm-stream missing sampleRateHz")?
                        as u32,
                    channels: source
                        .get("channels")
                        .and_then(|v| v.as_u64())
                        .context("pcm-stream missing channels")?
                        as u32,
                    bit_depth: parse_bit_depth(
                        source.get("bitDepth").context("pcm-stream missing bitDepth")?,
                    )?,
                },
                other => bail!("unknown source kind {other:?}"),
            };
            engine.load(LoadParams {
                queue_id: get_str(p, "queueId")?.to_string(),
                generation_id: get_u64(p, "generationId")?,
                source: src,
                start_paused: p.get("startPaused").and_then(|v| v.as_bool()).unwrap_or(false),
                position_ms: p.get("positionMs").and_then(|v| v.as_u64()).unwrap_or(0),
                replay_gain_db: p.get("replayGainDb").and_then(|v| v.as_f64()),
            })
        }
        "audio.prefetch" => engine.prefetch(
            get_str(p, "queueId")?,
            get_str(p, "path")?,
            get_u64(p, "generationId")?,
            p.get("replayGainDb").and_then(|v| v.as_f64()),
        ),
        "audio.play" => engine.play(get_u64(p, "generationId")?),
        "audio.pause" => engine.pause(get_u64(p, "generationId")?),
        "audio.stop" => engine.stop(get_u64(p, "generationId")?),
        "audio.seek" => engine.seek(
            get_u64(p, "generationId")?,
            get_u64(p, "positionMs")?,
        ),
        "audio.setVolume" => engine.set_volume(
            p.get("volume")
                .and_then(|v| v.as_f64())
                .context("missing volume")?,
        ),
        "audio.setFidelityMode" => engine.set_fidelity_mode(
            p.get("enabled")
                .and_then(|v| v.as_bool())
                .context("missing enabled")?,
        ),
        "audio.setEq" => {
            let bands = p
                .get("bands")
                .and_then(|b| b.as_array())
                .context("missing bands")?
                .iter()
                .map(|b| {
                    Ok((
                        b.get("freqHz").and_then(|v| v.as_f64()).context("freqHz")?,
                        b.get("gainDb").and_then(|v| v.as_f64()).context("gainDb")?,
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            engine.set_eq(&bands)
        }
        "audio.listDevices" => Ok(engine.list_devices()),
        "audio.setDevice" => {
            let name = match p.get("name") {
                Some(Value::Null) | None => None,
                Some(v) => Some(v.as_str().context("invalid name")?),
            };
            engine.set_device(name)
        }
        // NOTE: not in audio-ipc.ts — the contract comments reference
        // audio.feed for pcm-stream sources but the method is not declared.
        // Sane interpretation: {queueId, dataBase64, final?} pushing
        // little-endian PCM in the depth declared at audio.load.
        "audio.feed" => {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(get_str(p, "dataBase64")?)
                .context("bad dataBase64")?;
            let fin = p.get("final").and_then(|v| v.as_bool()).unwrap_or(false);
            let abort = p.get("abort").and_then(|v| v.as_bool()).unwrap_or(false);
            engine.feed(get_str(p, "queueId")?, &bytes, fin, abort)
        }
        "audio.shutdown" => Ok(json!({ "ok": true })),
        other => bail!("unknown method {other}"),
    }
}
