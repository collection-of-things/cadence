//! cadence-audio — Cadence's audio service.
//!
//! Modes:
//!   cadence-audio                     stdio JSON-RPC server (default)
//!   cadence-audio --probe <file>      print stream info as JSON
//!   cadence-audio --decode <f> --out <f.f32le> [--rate Hz] [--channels N]
//!   cadence-audio --null-sink [--null-rate Hz] [--null-dump f.f32le]
//!                                   full graph against a virtual device

use anyhow::{Context, Result};
use cadence_audio::decode::{DecodeRequest, Decoder, FfmpegDecoder, PcmKind};
use cadence_audio::engine::{Engine, EngineConfig};
use cadence_audio::resample::StreamingResampler;
use cadence_audio::rpc;
use cadence_audio::sink::{self, Negotiated};
use clap::Parser;
use serde_json::json;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "cadence-audio", about = "Cadence audio service")]
struct Cli {
    /// Probe a media file and print JSON stream info.
    #[arg(long)]
    probe: Option<PathBuf>,
    /// Decode a file through the graph to raw f32le on disk (no device).
    #[arg(long)]
    decode: Option<PathBuf>,
    /// Output file for --decode (interleaved f32le).
    #[arg(long)]
    out: Option<PathBuf>,
    /// Resample target rate for --decode.
    #[arg(long)]
    rate: Option<u32>,
    /// Channel count for --decode (default: source channels).
    #[arg(long)]
    channels: Option<u32>,

    /// Run the JSON-RPC server against a virtual output device.
    #[arg(long)]
    null_sink: bool,
    /// Virtual device sample rate (default 48000).
    #[arg(long)]
    null_rate: Option<u32>,
    /// Null sink without real-time pacing (tests only).
    #[arg(long)]
    null_fast: bool,
    /// Dump all rendered frames (f32le, at negotiated rate) to this file.
    #[arg(long)]
    null_dump: Option<PathBuf>,
}

fn main() {
    let cli = Cli::parse();
    let code = match run(cli) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cadence-audio: {e:#}");
            1
        }
    };
    std::process::exit(code);
}

fn run(cli: Cli) -> Result<i32> {
    if let Some(path) = cli.probe.as_ref() {
        return probe(path);
    }
    if let Some(path) = cli.decode.as_ref() {
        let out = cli.out.as_ref().context("--decode requires --out")?;
        return decode_file(path, out, cli.rate, cli.channels);
    }
    serve(cli)
}

fn probe(path: &std::path::Path) -> Result<i32> {
    let dec = FfmpegDecoder;
    match dec.probe(path) {
        Ok(info) => {
            println!(
                "{}",
                json!({
                    "ok": true,
                    "durationMs": info.duration_ms,
                    "sampleRateHz": info.sample_rate_hz,
                    "channels": info.channels,
                    "bitDepth": serde_json::to_value(info.bit_depth)?,
                    "codec": info.codec,
                })
            );
            Ok(0)
        }
        Err(e) => {
            println!("{}", json!({ "ok": false, "error": format!("{e:#}") }));
            Ok(1)
        }
    }
}

/// decode -> (optional graph resample) -> f32le file. No device involved.
fn decode_file(
    path: &std::path::Path,
    out: &PathBuf,
    rate: Option<u32>,
    channels: Option<u32>,
) -> Result<i32> {
    let dec = FfmpegDecoder;
    let info = dec.probe(path)?;
    let ch = channels.unwrap_or(info.channels);
    let mut stream = dec.open(&DecodeRequest {
        path: path.to_path_buf(),
        seek_ms: 0,
        kind: PcmKind::F32,
        channels: Some(ch),
        info: Some(info.clone()),
    })?;
    let target = rate.unwrap_or(info.sample_rate_hz);
    let mut resampler = if target != info.sample_rate_hz {
        Some(StreamingResampler::new(info.sample_rate_hz, target, ch as usize)?)
    } else {
        None
    };

    let mut file = std::io::BufWriter::new(std::fs::File::create(out)?);
    let mut inbuf = vec![0f32; 8192];
    let mut outbuf: Vec<f32> = Vec::with_capacity(16384);
    loop {
        let n = stream.read_f32(&mut inbuf)?;
        if n == 0 {
            break;
        }
        let n = n - (n % ch as usize);
        outbuf.clear();
        match resampler.as_mut() {
            Some(rs) => rs.push(&inbuf[..n], &mut outbuf)?,
            None => outbuf.extend_from_slice(&inbuf[..n]),
        }
        write_f32le(&mut file, &outbuf)?;
    }
    outbuf.clear();
    if let Some(rs) = resampler.as_mut() {
        rs.finish(&mut outbuf)?;
    }
    write_f32le(&mut file, &outbuf)?;
    file.flush()?;
    eprintln!(
        "decoded {} -> {} ({}Hz {}ch -> {}Hz {}ch)",
        path.display(),
        out.display(),
        info.sample_rate_hz,
        info.channels,
        target,
        ch
    );
    Ok(0)
}

fn write_f32le(w: &mut impl Write, samples: &[f32]) -> std::io::Result<()> {
    for s in samples {
        w.write_all(&s.to_le_bytes())?;
    }
    Ok(())
}

fn serve(cli: Cli) -> Result<i32> {
    let cfg = EngineConfig {
        null_sink: cli.null_sink,
        null_rate: cli.null_rate.unwrap_or(48000),
        null_kind: PcmKind::F32,
        null_fast: cli.null_fast,
        null_dump: cli.null_dump.clone(),
        ..Default::default()
    };

    let caps = match sink::initial_caps(&cfg) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("audio: no usable output device ({e:#}); RPC stays up");
            Arc::new(sink::UnavailableCaps {
                reason: format!("{e:#}"),
            })
        }
    };

    let initial_neg = Negotiated {
        rate: caps.default_rate(),
        channels: caps.default_channels(),
        kind: caps.default_kind(),
        device_name: caps.name(),
        positions: cadence_audio::sink::resolve_positions(None, caps.default_channels()),
    };
    let (core, _tap, fft_cons) = Engine::make_core(initial_neg.clone(), cfg.null_dump.clone());
    // Open the output stream up front. If it fails (no usable device), the
    // engine stays alive: loads error honestly via event.error and a later
    // audio.setDevice can recover.
    let mut caps = caps;
    let sink_obj: Box<dyn sink::Sink> =
        match sink::open_sink(&cfg, caps.clone(), &initial_neg, &core) {
            Ok(opened) => {
                // A CPAL fallback re-negotiates against its own device
                // — commit the format and caps it actually opened, or
                // the core renders at the wrong rate.
                {
                    let mut c = core.lock().unwrap();
                    c.negotiated = opened.negotiated;
                }
                if let Some(new_caps) = opened.caps {
                    caps = new_caps;
                }
                opened.sink
            }
            Err(e) => {
                eprintln!("audio: output stream unavailable ({e:#})");
                Box::new(sink::DeadSink)
            }
        };

    let emit = rpc::stdout_emitter();
    let engine = Engine::new(
        cfg,
        Arc::clone(&emit),
        sink_obj,
        caps,
        fft_cons,
        core,
    );
    engine.start_monitor();
    Ok(rpc::run_stdio(engine, emit))
}
