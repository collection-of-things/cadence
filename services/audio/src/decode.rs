//! Decoding behind a `Decoder` trait.
//!
//! The shipping backend shells out to `ffprobe`/`ffmpeg` so the crate has no
//! link-time dependency on libav*. An in-process ffmpeg-next backend can be
//! added later by implementing the same trait. ffmpeg's demuxer already
//! applies gapless trim metadata (encoder delay/padding), so the sample stream
//! we get is the gapless-correct one and we must not trim further.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

/// Sample format carried through the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcmKind {
    /// 32-bit float interleaved (f32le). Exact for sources up to 24-bit int.
    F32,
    /// 32-bit signed integer interleaved (s32le). Preserves 24/32-bit int PCM.
    S32,
    /// 16-bit signed integer interleaved (s16le). For devices whose only
    /// supported formats are i16 — bit-exact for <=16-bit sources.
    S16,
}

impl PcmKind {
    pub fn ffmpeg_format(self) -> &'static str {
        match self {
            PcmKind::F32 => "f32le",
            PcmKind::S32 => "s32le",
            PcmKind::S16 => "s16le",
        }
    }
    pub fn codec_name(self) -> &'static str {
        match self {
            PcmKind::F32 => "pcm_f32le",
            PcmKind::S32 => "pcm_s32le",
            PcmKind::S16 => "pcm_s16le",
        }
    }
}

/// Reported to the coordinator as `bitDepth` in event.output / probe results.
/// Serializes as a number or "float", matching the TS contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitDepth {
    Int(u32),
    Float,
}

impl serde::Serialize for BitDepth {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            BitDepth::Int(b) => s.serialize_u32(*b),
            BitDepth::Float => s.serialize_str("float"),
        }
    }
}

impl BitDepth {
    /// Can `fmt` carry this depth bit-exactly?
    pub fn preserved_by(self, fmt: PcmKind) -> bool {
        match self {
            BitDepth::Float => fmt == PcmKind::F32,
            BitDepth::Int(bits) => match fmt {
                PcmKind::F32 => bits <= 24, // f32 mantissa is exactly 24 bits
                PcmKind::S32 => bits <= 32,
                PcmKind::S16 => bits <= 16,
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub codec: String,
    pub duration_ms: u64,
    pub sample_rate_hz: u32,
    pub channels: u32,
    pub bit_depth: BitDepth,
}

#[derive(Debug, Deserialize)]
struct FfprobeOut {
    streams: Option<Vec<FfprobeStream>>,
    format: Option<FfprobeFormat>,
}
#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    bits_per_raw_sample: Option<String>,
    bits_per_sample: Option<u32>,
    sample_fmt: Option<String>,
    duration: Option<String>,
}
#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

/// ffprobe a media file and return stream info for the first audio stream.
pub fn probe_file(path: &Path) -> Result<AudioInfo> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("failed to spawn ffprobe")?;
    if !out.status.success() {
        bail!(
            "ffprobe failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let parsed: FfprobeOut =
        serde_json::from_slice(&out.stdout).context("parsing ffprobe JSON")?;
    let streams = parsed.streams.unwrap_or_default();
    let stream = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"))
        .ok_or_else(|| anyhow!("no audio stream in {}", path.display()))?;

    let sample_rate_hz = stream
        .sample_rate
        .as_deref()
        .unwrap_or("0")
        .parse::<u32>()
        .unwrap_or(0);
    let duration_ms = stream
        .duration
        .as_deref()
        .or(parsed.format.and_then(|f| f.duration).as_deref())
        .and_then(|d| d.parse::<f64>().ok())
        .map(|d| (d * 1000.0).round() as u64)
        .unwrap_or(0);

    let bits = stream
        .bits_per_raw_sample
        .as_deref()
        .and_then(|b| b.parse::<u32>().ok())
        .or(stream.bits_per_sample)
        .filter(|b| *b > 0);
    let bit_depth = match stream.sample_fmt.as_deref() {
        Some(f) if f.starts_with('d') || f.starts_with('f') => BitDepth::Float,
        _ => match bits {
            Some(b) if b > 32 => BitDepth::Int(32),
            Some(b) => BitDepth::Int(b),
            None => BitDepth::Int(16), // e.g. mp3 reports no depth; decoded as s16-ish
        },
    };

    if sample_rate_hz == 0 {
        bail!("could not determine sample rate for {}", path.display());
    }
    Ok(AudioInfo {
        codec: stream.codec_name.clone().unwrap_or_else(|| "unknown".into()),
        duration_ms,
        sample_rate_hz,
        channels: stream.channels.unwrap_or(2),
        bit_depth,
    })
}

/// A live decode: PCM samples streamed from a subprocess stdout.
/// Killing is handled on Drop so a stalled ffmpeg never outlives its track.
pub struct DecodeStream {
    pub info: AudioInfo,
    pub kind: PcmKind,
    child: Child,
    stdout: BufReader<ChildStdout>,
}

impl DecodeStream {
    /// Read up to `buf.len()` samples. Returns count read (0 = EOF).
    pub fn read_f32(&mut self, buf: &mut [f32]) -> std::io::Result<usize> {
        debug_assert_eq!(self.kind, PcmKind::F32);
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, buf.len() * 4)
        };
        let n = read_full(&mut self.stdout, bytes)?;
        Ok(n / 4)
    }

    pub fn read_s32(&mut self, buf: &mut [i32]) -> std::io::Result<usize> {
        debug_assert_eq!(self.kind, PcmKind::S32);
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, buf.len() * 4)
        };
        let n = read_full(&mut self.stdout, bytes)?;
        Ok(n / 4)
    }
}

/// Read until buf is full or EOF; returns bytes read (multiple of 4 enforced by caller).
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

impl Drop for DecodeStream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Clone)]
pub struct DecodeRequest {
    pub path: PathBuf,
    /// Decode starting at this offset (ms). Uses ffmpeg input seek.
    pub seek_ms: u64,
    pub kind: PcmKind,
    /// Channel remix target (e.g. device channels). None = source channels.
    pub channels: Option<u32>,
}

/// Pluggable decode backend.
pub trait Decoder: Send + Sync {
    fn probe(&self, path: &Path) -> Result<AudioInfo>;
    fn open(&self, req: &DecodeRequest) -> Result<DecodeStream>;
}

#[derive(Debug, Default)]
pub struct FfmpegDecoder;

impl Decoder for FfmpegDecoder {
    fn probe(&self, path: &Path) -> Result<AudioInfo> {
        probe_file(path)
    }

    fn open(&self, req: &DecodeRequest) -> Result<DecodeStream> {
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-v", "error", "-nostdin", "-hide_banner"]);
        if req.seek_ms > 0 {
            cmd.args(["-ss", &format!("{:.3}", req.seek_ms as f64 / 1000.0)]);
        }
        cmd.arg("-i").arg(&req.path);
        if let Some(ch) = req.channels {
            cmd.args(["-ac", &ch.to_string()]);
        }
        cmd.args(["-acodec", req.kind.codec_name()])
            .args(["-f", req.kind.ffmpeg_format()])
            .arg("-") // stdout
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().context("failed to spawn ffmpeg")?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("ffmpeg stdout missing"))?;
        let info = self.probe(&req.path)?;
        Ok(DecodeStream {
            info,
            kind: req.kind,
            child,
            stdout: BufReader::with_capacity(1 << 16, stdout),
        })
    }
}

/// Decode a whole file to an interleaved f32 Vec. Test/helper path.
#[cfg(test)]
pub fn decode_to_f32(path: &Path, channels: Option<u32>) -> Result<(Vec<f32>, AudioInfo)> {
    decode_to_f32_at(path, 0, channels)
}

/// Decode a whole file from `seek_ms` to an interleaved f32 Vec.
#[cfg(test)]
pub fn decode_to_f32_at(
    path: &Path,
    seek_ms: u64,
    channels: Option<u32>,
) -> Result<(Vec<f32>, AudioInfo)> {
    let d = FfmpegDecoder;
    let mut s = d.open(&DecodeRequest {
        path: path.to_path_buf(),
        seek_ms,
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
    Ok((out, s.info.clone()))
}
