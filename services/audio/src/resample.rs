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
    /// exact output:input ratio (to/from — the resampler's fixed rate)
    ratio: f64,
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
            ratio: to as f64 / from as f64,
        })
    }

    /// Total output frames implied by `input_frames` at the fixed ratio.
    pub fn expected_output_for(&self, input_frames: u64) -> u64 {
        (input_frames as f64 * self.ratio).round() as u64
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

    /// The total output must be exactly the source duration at the output
    /// rate — the tail flush emits the whole filter tail, nothing more.
    #[test]
    fn resampled_output_length_is_exact() {
        for (from, to) in [(44100u32, 48000u32), (96000, 48000), (48000, 44100), (192000, 48000)] {
            let n_in = from as usize / 4; // 250ms
            let input: Vec<f32> = (0..n_in)
                .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / from as f64).sin() as f32)
                .collect();
            let mut rs = StreamingResampler::new(from, to, 1).unwrap();
            let mut out = Vec::new();
            rs.push(&input, &mut out).unwrap();
            rs.finish(&mut out).unwrap();
            let expected = (n_in as f64 * to as f64 / from as f64).round() as usize;
            assert_eq!(
                out.len(),
                expected,
                "{from}->{to}: {} frames vs expected {expected}",
                out.len()
            );
        }
    }

    /// A clean tone through the resampler must stay a tone: no image or
    /// harmonic spur above -80 dBc in steady state. The tone is exactly
    /// bin-centered in the analysis window so leakage doesn't mask spurs.
    #[test]
    fn resampled_tone_has_no_strong_spurs() {
        const N: usize = 16384;
        let (from, to) = (44100u32, 48000u32);
        let f0 = 512.0 * to as f64 / N as f64; // 1500 Hz -> bin 512 exactly
        let n_in = from as usize / 2; // 500ms
        let input: Vec<f32> = (0..n_in)
            .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / from as f64).sin() as f32)
            .collect();
        let mut rs = StreamingResampler::new(from, to, 1).unwrap();
        let mut out = Vec::new();
        rs.push(&input, &mut out).unwrap();
        rs.finish(&mut out).unwrap();

        // steady-state middle: skip the resampler's edge transient
        let seg = &out[4096..4096 + N];
        let mut planner = rustfft::FftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(N);
        let mut buf: Vec<rustfft::num_complex::Complex64> = seg
            .iter()
            .map(|s| rustfft::num_complex::Complex64::new(*s as f64, 0.0))
            .collect();
        fft.process(&mut buf);
        let mags: Vec<f64> = buf[..=N / 2].iter().map(|c| c.norm()).collect();
        let fund = mags[512];
        let top_spur = mags
            .iter()
            .enumerate()
            .filter(|(i, _)| (*i as i64 - 512).abs() > 4)
            .map(|(_, m)| *m)
            .fold(0f64, f64::max);
        let spur_db = 20.0 * (top_spur / fund).log10();
        assert!(
            spur_db < -80.0,
            "resampler spur at {spur_db:.1} dBc (limit -80)"
        );
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
