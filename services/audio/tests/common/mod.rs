use cadence_audio::decode::{DecodeRequest, Decoder, FfmpegDecoder, PcmKind};
use anyhow::Result;
use std::path::{Path, PathBuf};

pub fn fixtures_dir() -> PathBuf {
    // tests run with CWD = crate root (services/audio)
    let p = PathBuf::from("../../test/fixtures/generated");
    if p.exists() {
        p
    } else {
        PathBuf::from("test/fixtures/generated")
    }
}

/// Decode a whole file to interleaved f32 via the public decoder.
#[allow(dead_code)]
pub fn decode_all(path: &Path, channels: Option<u32>) -> Result<(Vec<f32>, u32)> {
    let d = FfmpegDecoder;
    let mut s = d.open(&DecodeRequest {
        path: path.to_path_buf(),
        seek_ms: 0,
        kind: PcmKind::F32,
        channels,
    })?;
    let mut out = Vec::new();
    let mut buf = vec![0f32; 8192];
    loop {
        let n = s.read_f32(&mut buf)?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok((out, s.info.sample_rate_hz))
}

/// Longest run of consecutive exact zeros (inserted-silence detector).
#[allow(dead_code)]
pub fn longest_zero_run(samples: &[f32]) -> usize {
    let mut best = 0;
    let mut cur = 0;
    for s in samples {
        if *s == 0.0 {
            cur += 1;
            best = best.max(cur);
        } else {
            cur = 0;
        }
    }
    best
}
