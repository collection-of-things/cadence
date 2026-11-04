//! DSP stage: cascaded peaking-EQ biquads + ReplayGain scalar gain.
//! Runs on interleaved f32 frames at the pipeline's processing rate.

/// Peaking EQ biquad (RBJ audio EQ cookbook), per-channel state.
/// Direct form I: y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2.
#[derive(Debug, Clone)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    /// per-channel [x1, x2, y1, y2] state, allocated lazily to channel count
    z: Vec<[f32; 4]>,
}

impl Biquad {
    pub fn peaking(freq_hz: f64, gain_db: f64, sample_rate: f64, q: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let cos = w0.cos();
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos;
        let a2 = 1.0 - alpha / a;
        Biquad {
            b0: (b0 / a0) as f32,
            b1: (b1 / a0) as f32,
            b2: (b2 / a0) as f32,
            a1: (a1 / a0) as f32,
            a2: (a2 / a0) as f32,
            z: Vec::new(),
        }
    }

    #[inline]
    fn tick(&mut self, ch: usize, x: f32) -> f32 {
        let z = &mut self.z[ch];
        let y = self.b0 * x + self.b1 * z[0] + self.b2 * z[1] - self.a1 * z[2]
            - self.a2 * z[3];
        z[1] = z[0];
        z[0] = x;
        z[3] = z[2];
        z[2] = y;
        y
    }
}

/// Cascaded EQ + gain applied to interleaved buffers.
pub struct Dsp {
    bands: Vec<Biquad>,
    /// linear gain (ReplayGain), 1.0 = unity
    gain: f32,
    channels: usize,
    /// true when nothing would change the signal; skips the work entirely
    passthrough: bool,
}

impl Dsp {
    pub fn new(
        bands: &[(f64, f64)], // (freqHz, gainDb)
        replay_gain_db: Option<f64>,
        sample_rate: u32,
        channels: usize,
    ) -> Self {
        let mut chain: Vec<Biquad> = bands
            .iter()
            .filter(|(_, g)| g.abs() > 0.01)
            .map(|&(f, g)| {
                let f = f.min(sample_rate as f64 / 2.0 - 1.0).max(10.0);
                Biquad::peaking(f, g, sample_rate as f64, 1.0)
            })
            .collect();
        for b in &mut chain {
            b.z = vec![[0.0; 4]; channels];
        }
        let gain = replay_gain_db
            .map(|db| 10f64.powf(db / 20.0) as f32)
            .unwrap_or(1.0);
        Dsp {
            passthrough: chain.is_empty() && (gain - 1.0).abs() < 1e-6,
            bands: chain,
            gain,
            channels,
        }
    }

    pub fn is_passthrough(&self) -> bool {
        self.passthrough
    }

    /// Process interleaved f32 frames in place.
    pub fn apply(&mut self, frames: &mut [f32]) {
        if self.passthrough {
            return;
        }
        let nch = self.channels.max(1);
        for (i, s) in frames.iter_mut().enumerate() {
            let ch = i % nch;
            let mut x = *s * self.gain;
            for b in self.bands.iter_mut() {
                x = b.tick(ch, x);
            }
            *s = x;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32)
            .collect()
    }

    fn rms(buf: &[f32]) -> f64 {
        (buf.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / buf.len() as f64).sqrt()
    }

    #[test]
    fn unity_eq_is_transparent() {
        let mut dsp = Dsp::new(&[(1000.0, 0.0)], None, 48000, 1);
        assert!(dsp.is_passthrough());
        let mut x = sine(440.0, 48000, 4096);
        let orig = x.clone();
        dsp.apply(&mut x);
        assert_eq!(x, orig);
    }

    #[test]
    fn boost_increases_band_energy() {
        let mut dsp = Dsp::new(&[(440.0, 12.0)], None, 48000, 1);
        let mut x = sine(440.0, 48000, 48000);
        let before = rms(&x[4800..]); // skip transient
        dsp.apply(&mut x);
        let after = rms(&x[4800..]);
        let db = 20.0 * (after / before).log10();
        assert!((db - 12.0).abs() < 0.5, "expected ~+12dB, got {db:.2}");
    }

    #[test]
    fn boost_leaves_distant_band_alone() {
        let mut dsp = Dsp::new(&[(440.0, 12.0)], None, 48000, 1);
        let mut x = sine(9000.0, 48000, 48000);
        let before = rms(&x[4800..]);
        dsp.apply(&mut x);
        let after = rms(&x[4800..]);
        let db = 20.0 * (after / before).log10();
        assert!(db.abs() < 1.0, "distant band moved {db:.2} dB");
    }

    #[test]
    fn replaygain_scales_signal() {
        let mut dsp = Dsp::new(&[], Some(-6.0), 48000, 2);
        let mut x = sine(440.0, 48000, 8192);
        let before = rms(&x);
        dsp.apply(&mut x);
        let after = rms(&x);
        let db = 20.0 * (after / before).log10();
        assert!((db + 6.0).abs() < 0.05, "expected ~-6dB, got {db:.3}");
    }

    #[test]
    fn stereo_state_is_independent() {
        let mut dsp = Dsp::new(&[(1000.0, 10.0)], None, 48000, 2);
        // left: loud sine, right: silence — right channel must stay silent
        let mut x = vec![0f32; 8192 * 2];
        for i in 0..8192 {
            x[i * 2] = (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48000.0).sin() as f32;
        }
        dsp.apply(&mut x);
        let right_max = x.iter().skip(1).step_by(2).fold(0f32, |a, b| a.max(b.abs()));
        assert_eq!(right_max, 0.0);
    }
}
