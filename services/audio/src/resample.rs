//! Resample decision logic + a streaming rubato wrapper.
//!
//! Decision rules (pure function, unit-tested):
//! - Fidelity mode ON and the device accepts the source format natively ->
//!   bypass everything (no resample, no DSP). `fidelity_bypass = true`.
//! - Otherwise resample only when source rate != negotiated output rate.

use anyhow::Result;
use rubato::{FftFixedIn, Resampler};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResamplePlan {
    /// Samples flow through unchanged.
    Passthrough,
    /// Resample from src to dst rate.
    Resample { from: u32, to: u32 },
}

/// Decide whether a track at `src_rate`/`src_depth` may bypass processing.
///
/// `fidelity_on`: user requested strict local bypass.
/// `device_accepts_native`: negotiated output already runs at the source's
///   native rate/channels in a format that preserves its bit depth.
/// `out_rate`: the negotiated output stream rate (== src_rate when bypassing).
///
/// Returns (plan, fidelity_bypass). `fidelity_bypass` is reported honestly in
/// event.output — true only when the strict mode actually bypassed end-to-end.
pub fn plan(
    src_rate: u32,
    out_rate: u32,
    fidelity_on: bool,
    device_accepts_native: bool,
) -> (ResamplePlan, bool) {
    if fidelity_on && device_accepts_native {
        debug_assert_eq!(src_rate, out_rate, "bypass implies negotiated == src rate");
        return (ResamplePlan::Passthrough, true);
    }
    if src_rate == out_rate {
        (ResamplePlan::Passthrough, false)
    } else {
        (ResamplePlan::Resample { from: src_rate, to: out_rate }, false)
    }
}

/// Stateful streaming resampler over deinterleaved channels.
/// Feed interleaved f32; drained output is interleaved at the target rate.
pub struct StreamingResampler {
    inner: FftFixedIn<f32>,
    channels: usize,
    in_q: Vec<VecDeque<f32>>,
    /// total input frames pushed so far
    fed: u64,
    /// raw output frames produced (includes leading group delay)
    produced: u64,
    /// leading group-delay frames dropped (rubato output_delay)
    delay: usize,
    /// delay frames dropped so far
    skipped: usize,
}

impl StreamingResampler {
    pub fn new(from: u32, to: u32, channels: usize) -> Result<Self> {
        // ~46ms chunks at 44.1k; sub_chunks=2 keeps FFT sizes modest
        let inner = FftFixedIn::new(from as usize, to as usize, 2048, 2, channels)?;
        let delay = inner.output_delay();
        Ok(StreamingResampler {
            inner,
            channels,
            in_q: vec![VecDeque::new(); channels],
            fed: 0,
            produced: 0,
            delay,
            skipped: 0,
        })
    }

    /// Total output frames implied by `input_frames` at the fixed ratio.
    pub fn expected_output_for(&self, input_frames: u64) -> u64 {
        let ratio = self.inner.output_frames_next() as f64
            / self.inner.input_frames_next().max(1) as f64;
        (input_frames as f64 * ratio).round() as u64
    }

    /// Push interleaved source frames; returns interleaved output frames.
    pub fn push(&mut self, interleaved: &[f32], out: &mut Vec<f32>) -> Result<()> {
        for (i, s) in interleaved.iter().enumerate() {
            self.in_q[i % self.channels].push_back(*s);
        }
        self.fed += (interleaved.len() / self.channels) as u64;
        self.drain(out)
    }

    /// Flush remaining input (zero-pads the final chunk and pushes the
    /// resampler's delay tail out). Call once at EOF.
    ///
    /// `process_partial(None)` would produce (zero) output forever, so the
    /// tail flush stops once we've emitted the frames the input implied.
    pub fn finish(&mut self, out: &mut Vec<f32>) -> Result<()> {
        self.drain(out)?;
        let leftover = self.in_q[0].len();
        if leftover > 0 {
            let chans: Vec<Vec<f32>> = self
                .in_q
                .iter_mut()
                .map(|q| q.drain(..).collect())
                .collect();
            let res = self.inner.process_partial(Some(&chans), None)?;
            self.emit(&res, out);
        }
        // The full signal is `fed`-implied output frames, shifted out by the
        // group delay skipped at the front. Flush the tail until raw output
        // reaches delay+expected, then trim any zero-padding overshoot.
        let expected = self.expected_output_for(self.fed);
        let target = self.delay as u64 + expected;
        for _ in 0..64 {
            if self.produced >= target {
                break;
            }
            let before = self.produced;
            let res = self.inner.process_partial::<Vec<f32>>(None, None)?;
            self.emit(&res, out);
            if self.produced == before {
                break;
            }
        }
        // Zero-padding during partial flushes can overshoot the signal;
        // trim the tail so the stream ends exactly where the input ended.
        let overshoot = self.produced.saturating_sub(target);
        if overshoot > 0 {
            let drop = (overshoot as usize) * self.channels;
            if drop <= out.len() {
                out.truncate(out.len() - drop);
            }
        }
        Ok(())
    }

    fn drain(&mut self, out: &mut Vec<f32>) -> Result<()> {
        loop {
            let need = self.inner.input_frames_next();
            if self.in_q[0].len() < need {
                return Ok(());
            }
            let chans: Vec<Vec<f32>> = self
                .in_q
                .iter_mut()
                .map(|q| q.drain(..need).collect())
                .collect();
            let res = self.inner.process(&chans, None)?;
            self.emit(&res, out);
        }
    }

    fn emit(&mut self, chans: &[Vec<f32>], out: &mut Vec<f32>) {
        let n = chans.iter().map(|c| c.len()).max().unwrap_or(0);
        self.produced += n as u64;
        for f in 0..n {
            // Drop leading group-delay frames so streams start on signal.
            if self.skipped < self.delay {
                self.skipped += 1;
                continue;
            }
            for c in chans.iter() {
                out.push(c.get(f).copied().unwrap_or(0.0));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_bypass_in_fidelity() {
        let (p, bypass) = plan(96000, 96000, true, true);
        assert_eq!(p, ResamplePlan::Passthrough);
        assert!(bypass);
    }

    #[test]
    fn decision_fidelity_without_device_support_resamples() {
        let (p, bypass) = plan(96000, 48000, true, false);
        assert_eq!(p, ResamplePlan::Resample { from: 96000, to: 48000 });
        assert!(!bypass);
    }

    #[test]
    fn decision_equal_rates_passthrough_not_bypass() {
        let (p, bypass) = plan(44100, 44100, false, false);
        assert_eq!(p, ResamplePlan::Passthrough);
        assert!(!bypass, "passthrough is not fidelity bypass");
    }

    #[test]
    fn decision_different_rates_resamples() {
        let (p, _) = plan(44100, 48000, false, false);
        assert_eq!(p, ResamplePlan::Resample { from: 44100, to: 48000 });
    }

    #[test]
    fn resample_tone_changes_rate_not_pitch() {
        let from = 44100u32;
        let to = 48000u32;
        let n_in = (from / 10) as usize; // 100ms of 440Hz mono
        let input: Vec<f32> = (0..n_in)
            .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / from as f64).sin() as f32)
            .collect();
        let mut rs = StreamingResampler::new(from, to, 1).unwrap();
        let mut out = Vec::new();
        rs.push(&input, &mut out).unwrap();
        rs.finish(&mut out).unwrap();

        let expected = (n_in as f64 * to as f64 / from as f64).round() as usize;
        let diff = (out.len() as i64 - expected as i64).abs();
        assert!(diff <= 32, "len {} vs expected {}", out.len(), expected);

        // Zero-crossing count in the steady-state middle (skip edges where
        // the resampler's ramp transient lives).
        let mid = &out[512..out.len() - 512];
        let crossings = mid
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        let expected_x = 440 * mid.len() / to as usize;
        assert!(
            (crossings as i64 - expected_x as i64).abs() <= 2,
            "pitch changed: {crossings} crossings vs ~{expected_x}"
        );
    }
}
