//! FFT analysis: 48 log-spaced bands (20Hz-20kHz) + peak.
//! Fed with post-graph mono f32 samples from the output tap; runs off-callback.

use rustfft::{num_complex::Complex32, Fft};
use std::collections::VecDeque;
use std::sync::Arc;

pub const FFT_BANDS: usize = 48;
const WINDOW: usize = 2048;
const FMIN: f64 = 20.0;
const FMAX: f64 = 20000.0;

/// Log-spaced band edges: edges[i] = FMIN * (FMAX/FMIN)^(i/BANDS).
/// Band i covers [edges[i], edges[i+1]) — BANDS+1 edges total.
pub fn band_edges() -> [f64; FFT_BANDS + 1] {
    let mut e = [0.0; FFT_BANDS + 1];
    let ratio = FMAX / FMIN;
    for (i, v) in e.iter_mut().enumerate() {
        *v = FMIN * ratio.powf(i as f64 / FFT_BANDS as f64);
    }
    e
}

/// Map each output band to an FFT bin range [lo, hi) for `rate`.
/// Bands narrower than one bin still get at least one bin.
pub fn band_bin_ranges(rate: u32) -> [(usize, usize); FFT_BANDS] {
    let df = rate as f64 / WINDOW as f64;
    let edges = band_edges();
    let mut out = [(0usize, 0usize); FFT_BANDS];
    let npos = WINDOW / 2;
    for i in 0..FFT_BANDS {
        let lo = (edges[i] / df).floor() as usize;
        let hi = (edges[i + 1] / df).ceil() as usize;
        let lo = lo.min(npos - 1);
        let hi = hi.max(lo + 1).min(npos);
        out[i] = (lo, hi);
    }
    out
}

pub struct FftAnalyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    bins: [(usize, usize); FFT_BANDS],
    pending: VecDeque<f32>,
    scratch: Vec<Complex32>,
}

/// One emission: band magnitudes in dBFS (<= 0, -100 = silence) + linear peak.
#[derive(Debug, Clone)]
pub struct FftFrame {
    pub bands: [f32; FFT_BANDS],
    pub peak: f32,
}

impl FftAnalyzer {
    pub fn new(rate: u32) -> Self {
        let mut planner = rustfft::FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(WINDOW);
        let window: Vec<f32> = (0..WINDOW)
            .map(|i| {
                // Hann
                0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WINDOW as f32).cos()
            })
            .collect();
        FftAnalyzer {
            fft,
            window,
            bins: band_bin_ranges(rate),
            pending: VecDeque::with_capacity(WINDOW * 2),
            scratch: vec![Complex32::ZERO; WINDOW],
        }
    }

    /// Feed mono samples; returns a frame whenever a full window is ready.
    pub fn push(&mut self, samples: &[f32]) -> Option<FftFrame> {
        self.pending.extend(samples.iter().copied());
        if self.pending.len() < WINDOW {
            return None;
        }
        let peak = self
            .pending
            .iter()
            .take(WINDOW)
            .fold(0f32, |a, s| a.max(s.abs()));
        for i in 0..WINDOW {
            let s = self.pending.pop_front().unwrap_or(0.0);
            self.scratch[i] = Complex32::new(s * self.window[i], 0.0);
        }
        self.fft.process(&mut self.scratch);

        let mut bands = [0f32; FFT_BANDS];
        for (i, (lo, hi)) in self.bins.iter().enumerate() {
            let mut mag = 0f32;
            for k in *lo..*hi {
                let m = self.scratch[k].norm();
                if m > mag {
                    mag = m;
                }
            }
            // dBFS-ish: full-scale sine -> ~0dB after window/length normalization.
            let norm = mag * 2.0 / (WINDOW as f32 * 0.5); // compensate Hann coherent gain
            let db = 20.0 * norm.max(1e-6).log10();
            bands[i] = db.clamp(-100.0, 0.0);
        }
        Some(FftFrame { bands, peak })
    }

    /// Number of queued samples waiting for a window.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_are_log_spaced_and_bounded() {
        let e = band_edges();
        assert_eq!(e[0], 20.0);
        assert!((e[FFT_BANDS] - 20000.0).abs() < 1.0);
        for i in 1..e.len() {
            assert!(e[i] > e[i - 1]);
            let r = e[i] / e[i - 1];
            let want = (1000f64).powf(1.0 / 48.0);
            assert!((r - want).abs() < 1e-9);
        }
    }

    #[test]
    fn bins_cover_spectrum_without_overlap_gaps() {
        let bins = band_bin_ranges(48000);
        let npos = WINDOW / 2;
        let mut prev_hi: usize = 0;
        for (i, (lo, hi)) in bins.iter().enumerate() {
            assert!(hi > lo, "band {i} empty");
            assert!(*hi <= npos);
            assert!(*lo >= prev_hi.saturating_sub(1));
            prev_hi = *hi;
        }
    }

    #[test]
    fn tone_lands_in_expected_band() {
        let rate = 48000u32;
        let mut a = FftAnalyzer::new(rate);
        let sig: Vec<f32> = (0..WINDOW)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / rate as f32).sin())
            .collect();
        let frame = a.push(&sig).expect("window ready");
        let (peak_band, _) = frame
            .bands
            .iter()
            .enumerate()
            .max_by(|x, y| x.1.partial_cmp(y.1).unwrap())
            .unwrap();
        let e = band_edges();
        assert!(
            1000.0 >= e[peak_band] && 1000.0 < e[peak_band + 1],
            "1kHz landed in band {peak_band} [{}, {})",
            e[peak_band],
            e[peak_band + 1]
        );
        assert!((frame.peak - 1.0).abs() < 0.01);
    }

    #[test]
    fn silence_is_floor_db() {
        let mut a = FftAnalyzer::new(48000);
        let frame = a.push(&vec![0f32; WINDOW]).unwrap();
        assert!(frame.bands.iter().all(|b| *b <= -99.0));
        assert_eq!(frame.peak, 0.0);
    }
}
