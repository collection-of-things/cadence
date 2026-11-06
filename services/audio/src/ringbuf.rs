//! Bounded single-producer/single-consumer ring buffer for PCM frames.
//!
//! The decode/producer side pushes interleaved samples; the output callback
//! pops them. All operations on the hot path are non-allocating and lock-free.
//!
//! Every slot is an atomic word stamped with the producer's clear
//! generation: a `clear()` racing a consumer's in-flight copy lets a
//! wrapping producer reuse the cleared region, and the generation tag
//! makes that torn write detectable on ANY visibility order — the
//! consumer doesn't have to rely on the fence being visible before the
//! rechecking load. Stale-but-untouched slices are still caught by the
//! post-copy fence check.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

/// Sample types storable in a ring slot (one 32-bit word each).
pub trait RingWord: Copy {
    fn to_word(self) -> u32;
    fn from_word(w: u32) -> Self;
}

impl RingWord for i32 {
    fn to_word(self) -> u32 {
        self as u32
    }
    fn from_word(w: u32) -> Self {
        w as i32
    }
}
impl RingWord for u32 {
    fn to_word(self) -> u32 {
        self
    }
    fn from_word(w: u32) -> Self {
        w
    }
}
impl RingWord for i16 {
    fn to_word(self) -> u32 {
        self as u16 as u32
    }
    fn from_word(w: u32) -> Self {
        w as u16 as i16
    }
}
impl RingWord for f32 {
    fn to_word(self) -> u32 {
        self.to_bits()
    }
    fn from_word(w: u32) -> Self {
        f32::from_bits(w)
    }
}

struct Shared {
    /// (clear generation << 32) | sample word.
    buf: Vec<AtomicU64>,
    cap: usize,
    head: AtomicUsize, // read index
    tail: AtomicUsize, // write index
    /// Monotonic discard fence: samples below this index are stale and
    /// must never be delivered — set by Producer::clear (epoch flush).
    /// Unlike a head store, it can't be regressed by a stale reader.
    fence: AtomicUsize,
    /// Clear generation — bumped by Producer::clear BEFORE the fence so
    /// every post-clear slot write carries the new tag. A consumer
    /// compares each copied slot's tag against the generation it read
    /// up front: any mismatch means the slot was written after a clear
    /// boundary — torn — regardless of fence visibility timing.
    gen: AtomicU32,
    /// Producer finished (EOF); consumer may drain remaining then end track.
    done: AtomicBool,
    /// Consumer side dropped/aborted; producer should stop writing.
    abort: AtomicBool,
    /// Test hooks fired inside the consumer's race windows — after the
    /// atomic reads (pre-copy) and between the copy and the fence
    /// re-check (post-copy) — so tests land a clear()+write() inside the
    /// interleavings deterministically.
    #[cfg(test)]
    pre_copy_hook: Option<Box<dyn Fn() + Send + Sync>>,
    #[cfg(test)]
    post_copy_hook: Option<Box<dyn Fn() + Send + Sync>>,
}

pub struct Producer<T> {
    s: Arc<Shared>,
    _t: std::marker::PhantomData<T>,
}

impl<T> Clone for Producer<T> {
    fn clone(&self) -> Self {
        Producer {
            s: Arc::clone(&self.s),
            _t: std::marker::PhantomData,
        }
    }
}

pub struct Consumer<T> {
    s: Arc<Shared>,
    _t: std::marker::PhantomData<T>,
}

impl<T> Clone for Consumer<T> {
    fn clone(&self) -> Self {
        Consumer {
            s: Arc::clone(&self.s),
            _t: std::marker::PhantomData,
        }
    }
}

pub fn channel<T: RingWord>(capacity: usize) -> (Producer<T>, Consumer<T>) {
    channel_hooked(capacity, None, None)
}

type TestHook = Option<Box<dyn Fn() + Send + Sync>>;

fn channel_hooked<T: RingWord>(
    capacity: usize,
    #[cfg_attr(not(test), allow(unused_variables))] pre_hook: TestHook,
    #[cfg_attr(not(test), allow(unused_variables))] post_hook: TestHook,
) -> (Producer<T>, Consumer<T>) {
    let s = Arc::new(Shared {
        buf: (0..capacity).map(|_| AtomicU64::new(0)).collect(),
        cap: capacity,
        head: AtomicUsize::new(0),
        tail: AtomicUsize::new(0),
        fence: AtomicUsize::new(0),
        gen: AtomicU32::new(0),
        done: AtomicBool::new(false),
        abort: AtomicBool::new(false),
        #[cfg(test)]
        pre_copy_hook: pre_hook,
        #[cfg(test)]
        post_copy_hook: post_hook,
    });
    (
        Producer {
            s: s.clone(),
            _t: std::marker::PhantomData,
        },
        Consumer {
            s,
            _t: std::marker::PhantomData,
        },
    )
}

impl<T: RingWord> Producer<T> {
    /// Free slots writable without overwriting unread data.
    pub fn free_space(&self) -> usize {
        let head = self.s.head.load(Ordering::Acquire);
        let tail = self.s.tail.load(Ordering::Relaxed);
        let fence = self.s.fence.load(Ordering::Acquire);
        // Discarded data is already gone — a stale consumer store can
        // regress head, but the fence is the true floor.
        let head = head.max(fence);
        // saturating_sub on the -1 too: a stale head/fence read can
        // inflate occupancy past cap — don't wrap to usize::MAX.
        self.s.cap.saturating_sub(tail.saturating_sub(head)).saturating_sub(1)
    }

    /// Non-blocking write; returns number of elements written (0..=data.len()).
    pub fn write(&self, data: &[T]) -> usize {
        let head = self.s.head.load(Ordering::Acquire);
        let tail = self.s.tail.load(Ordering::Relaxed);
        let fence = self.s.fence.load(Ordering::Acquire);
        // keep one slot to disambiguate full/empty; the fence floors the
        // effective head (a stale consumer store can regress head).
        let free = self
            .s
            .cap
            .saturating_sub(tail.saturating_sub(head.max(fence)))
            .saturating_sub(1);
        let n = data.len().min(free);
        let gen = self.s.gen.load(Ordering::Relaxed) as u64;
        for i in 0..n {
            // Per-word atomic store stamped with the clear generation:
            // a just-cleared slot may still be inside a consumer's
            // in-flight copy — the word-level write is defined
            // behaviour, and the tag lets the consumer prove tornness
            // without depending on fence visibility.
            self.s.buf[(tail + i) % self.s.cap]
                .store((gen << 32) | data[i].to_word() as u64, Ordering::Release);
        }
        self.s.tail.store(tail + n, Ordering::Release);
        n
    }

    /// Blocking write of the whole slice; sleeps briefly while full.
    /// Returns false if the consumer aborted (track dropped).
    pub fn write_all(&self, data: &[T]) -> bool {
        let mut off = 0;
        while off < data.len() {
            if self.s.abort.load(Ordering::Acquire) {
                return false;
            }
            off += self.write(&data[off..]);
            if off < data.len() {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        true
    }

    /// Signal end-of-stream.
    pub fn finish(&self) {
        self.s.done.store(true, Ordering::Release);
    }

    /// Discard everything currently queued — used by the staging feeder
    /// when a control change bumps the epoch: every staged sample is
    /// provably stale. Monotonic via the fence: a stale head store from
    /// a preempted consumer read can never resurrect discarded data.
    pub fn clear(&self) {
        // Bump the generation FIRST — every slot write from here on
        // carries the new tag, so a consumer mid-copy sees the torn
        // slots without needing fence visibility.
        self.s.gen.fetch_add(1, Ordering::Relaxed);
        let tail = self.s.tail.load(Ordering::Acquire);
        self.s.fence.fetch_max(tail, Ordering::AcqRel);
        // Advance head too so free_space reflects the drop. Tail is
        // monotonic, so this store is too — a stale consumer store may
        // regress head transiently, but reads and free_space floor at
        // the fence, so nothing stale is ever delivered or overwritten.
        self.s.head.store(tail, Ordering::Release);
    }

    pub fn is_aborted(&self) -> bool {
        self.s.abort.load(Ordering::Acquire)
    }
}

impl<T: RingWord> Consumer<T> {
    /// Non-blocking read; returns elements read.
    pub fn read(&self, out: &mut [T]) -> usize {
        let tail = self.s.tail.load(Ordering::Acquire);
        let head = self.s.head.load(Ordering::Relaxed);
        let fence = self.s.fence.load(Ordering::Acquire);
        // Read the generation AFTER the Acquire fence load: if the fence
        // shows a clear landed, the load sees the bumped generation —
        // fresh post-clear slots can never be mis-tagged as torn. A
        // clear landing after this point is caught per-slot instead.
        let g0 = self.s.gen.load(Ordering::Relaxed);
        // start >= fence: a clear() that landed mid-read can never make
        // us serve discarded data; start >= head keeps head monotonic.
        let start = head.max(fence);
        let n = out.len().min(tail.saturating_sub(start));
        #[cfg(test)]
        if let Some(h) = &self.s.pre_copy_hook {
            h();
        }
        let mut torn = false;
        for i in 0..n {
            let slot = self.s.buf[(start + i) % self.s.cap].load(Ordering::Acquire);
            // The slot's generation differs from the one at read start
            // → a clear bumped it and the producer rewrote this slot
            // while we were copying → the slice is torn.
            torn |= (slot >> 32) as u32 != g0;
            out[i] = T::from_word(slot as u32);
        }
        self.s.head.store(start + n, Ordering::Release);
        // A clear() landing mid-copy means what we just read was already
        // stale — torn slots are caught by the generation tag, untouched
        // stale slots by the fence re-check. Report the head advance but
        // give the caller nothing usable. The explicit Acquire fence
        // keeps the buf reads ordered before this check.
        std::sync::atomic::fence(Ordering::Acquire);
        #[cfg(test)]
        if let Some(h) = &self.s.post_copy_hook {
            h();
        }
        if torn || self.s.fence.load(Ordering::Acquire) > start {
            return 0;
        }
        n
    }

    /// Like `read` but only consumes whole `frame`-sized groups — a
    /// partial frame stays queued so the next read resumes aligned.
    /// Required for interleaved PCM: a mid-frame boundary would rotate
    /// channel assignment for the rest of the stream.
    pub fn read_aligned(&self, out: &mut [T], frame: usize) -> usize {
        if frame <= 1 {
            return self.read(out);
        }
        let tail = self.s.tail.load(Ordering::Acquire);
        let head = self.s.head.load(Ordering::Relaxed);
        let fence = self.s.fence.load(Ordering::Acquire);
        // See read(): generation after the Acquire fence load.
        let g0 = self.s.gen.load(Ordering::Relaxed);
        let start = head.max(fence);
        let avail = tail.saturating_sub(start);
        #[cfg(test)]
        if let Some(h) = &self.s.pre_copy_hook {
            h();
        }
        let mut n = out.len().min(avail) / frame * frame;
        // End of stream: a trailing partial frame must still drain or
        // the track can never finish (is_drained would stick false).
        // Re-read the tail — `avail` may be stale-mid-write and the true
        // remainder could already be frame-aligned.
        if n == 0 && self.s.done.load(Ordering::Acquire) {
            let avail2 = self.s.tail.load(Ordering::Acquire).saturating_sub(start);
            if avail2 < frame {
                n = out.len().min(avail2);
            }
        }
        let mut torn = false;
        for i in 0..n {
            let slot = self.s.buf[(start + i) % self.s.cap].load(Ordering::Acquire);
            torn |= (slot >> 32) as u32 != g0;
            out[i] = T::from_word(slot as u32);
        }
        self.s.head.store(start + n, Ordering::Release);
        // See read(): torn (generation tag) or stale (fence re-check).
        std::sync::atomic::fence(Ordering::Acquire);
        #[cfg(test)]
        if let Some(h) = &self.s.post_copy_hook {
            h();
        }
        if torn || self.s.fence.load(Ordering::Acquire) > start {
            return 0;
        }
        n
    }

    pub fn available(&self) -> usize {
        let tail = self.s.tail.load(Ordering::Acquire);
        let head = self.s.head.load(Ordering::Relaxed);
        let fence = self.s.fence.load(Ordering::Acquire);
        tail.saturating_sub(head.max(fence))
    }

    /// Producer signaled EOF and no data remains.
    pub fn is_drained(&self) -> bool {
        self.s.done.load(Ordering::Acquire) && self.available() == 0
    }

    /// Ask the producer to stop (used when the track is dropped).
    pub fn abort(&self) {
        self.s.abort.store(true, Ordering::Release);
    }
}

impl<T> Drop for Consumer<T> {
    fn drop(&mut self) {
        self.s.abort.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_roundtrip() {
        let (p, c) = channel::<f32>(8);
        assert_eq!(p.write(&[1.0, 2.0, 3.0]), 3);
        let mut out = [0.0f32; 4];
        assert_eq!(c.read(&mut out), 3);
        assert_eq!(&out[..3], &[1.0, 2.0, 3.0]);
        assert!(c.read(&mut out) == 0);
    }

    #[test]
    fn respects_capacity() {
        let (p, c) = channel::<i32>(4); // usable = 3
        assert_eq!(p.write(&[1, 2, 3, 4, 5]), 3);
        let mut out = [0i32; 8];
        assert_eq!(c.read(&mut out), 3);
        assert_eq!(p.write(&[4, 5]), 2);
        assert_eq!(c.read(&mut out), 2);
        assert_eq!(&out[..2], &[4, 5]);
    }

    #[test]
    fn wraps_around() {
        let (p, c) = channel::<u32>(4);
        let mut out = [0u32; 2];
        for cycle in 0..20u32 {
            assert_eq!(p.write(&[cycle * 10, cycle * 10 + 1]), 2);
            assert_eq!(c.read(&mut out), 2);
            assert_eq!(out, [cycle * 10, cycle * 10 + 1]);
        }
    }

    #[test]
    fn drained_after_finish() {
        let (p, c) = channel::<f32>(16);
        assert!(!c.is_drained());
        p.write(&[1.0, 2.0]);
        p.finish();
        assert!(!c.is_drained());
        let mut out = [0.0f32; 4];
        c.read(&mut out);
        assert!(c.is_drained());
    }

    #[test]
    fn blocking_write_aborts_on_drop() {
        let (p, c) = channel::<f32>(4);
        let big = vec![1.0f32; 1000];
        drop(c);
        assert!(!p.write_all(&big));
    }

    #[test]
    fn read_aligned_keeps_frame_boundary() {
        // A partial frame stays queued; the next read resumes aligned.
        let (p, c) = channel::<i16>(8);
        p.write(&[1, 2, 3]); // 1.5 frames of stereo
        let mut out = [0i16; 4];
        let n = c.read_aligned(&mut out, 2);
        assert_eq!(n, 2);
        p.write(&[4, 5, 6, 7, 8]);
        let mut out2 = [0i16; 8];
        let n2 = c.read_aligned(&mut out2, 2);
        assert_eq!(n2, 6);
        assert_eq!(&out2[..6], &[3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn read_aligned_drains_partial_at_eof() {
        let (p, c) = channel::<i16>(8);
        p.write(&[1, 2, 3]);
        p.finish();
        let mut out = [0i16; 4];
        assert_eq!(c.read_aligned(&mut out, 2), 2);
        // Trailing partial frame must drain or is_drained sticks false.
        assert_eq!(c.read_aligned(&mut out, 2), 1);
        assert!(c.is_drained());
    }

    #[test]
    fn read_clamps_head_past_clear() {
        // Simulate the read-in-flight clear: the consumer's head store
        // must never regress past the producer's clear point.
        let (p, c) = channel::<i16>(16);
        p.write(&[1, 2, 3, 4]);
        let mut out = [0i16; 2];
        assert_eq!(c.read(&mut out), 2); // consumes 1,2; head=2
        p.clear(); // head=4
        p.write(&[9, 10]); // tail=6
        let n = c.read(&mut out);
        assert_eq!(&out[..n], &[9, 10]);
    }

    #[test]
    fn clear_makes_inflight_read_stale() {
        // A clear between the consumer's loads and its fence re-check
        // must discard the whole slice — never served, never resurrected.
        let (p, c) = channel::<i16>(16);
        p.write(&[1, 2, 3, 4]);
        p.clear();
        p.write(&[9, 10]);
        let mut out = [0i16; 8];
        let n = c.read(&mut out);
        assert_eq!(&out[..n], &[9, 10]);
    }

    /// Build a channel whose Consumer fires `hook` between its copy
    /// and the post-copy fence re-check — the deterministic equivalent
    /// of a clear() preempting the read mid-copy.
    fn hooked_channel<F>(cap: usize, hook: F) -> (Producer<i16>, Consumer<i16>)
    where
        F: Fn() + Send + Sync + 'static,
    {
        channel_hooked(cap, None, Some(Box::new(hook)))
    }

    #[test]
    fn mid_copy_clear_discards_slice() {
        // clear() lands inside the consumer's copy→re-check window:
        // the read must return 0 and the next read only post-clear data.
        let cell = Arc::new(std::sync::Mutex::new(None::<Producer<i16>>));
        let once = Arc::new(AtomicBool::new(false));
        let cell2 = Arc::clone(&cell);
        let once2 = Arc::clone(&once);
        let (p, c) = hooked_channel(8, move || {
            if once2.swap(true, Ordering::Relaxed) {
                return; // fire once — later reads must pass through
            }
            let g = cell2.lock().unwrap();
            if let Some(p) = g.as_ref() {
                p.clear();
            }
        });
        *cell.lock().unwrap() = Some(p.clone());
        p.write(&[1, 2, 3, 4]);
        let mut out = [0i16; 4];
        assert_eq!(c.read(&mut out), 0, "mid-copy clear must discard");
        p.write(&[9, 10]);
        let n = c.read(&mut out);
        assert_eq!(&out[..n], &[9, 10]);
    }

    #[test]
    fn mid_copy_clear_write_discards_slice() {
        // clear() + a wrapping write inside the window: the producer
        // reuses cleared slots while the consumer is copying them —
        // the slice must still be discarded, never served torn.
        let cell = Arc::new(std::sync::Mutex::new(None::<Producer<i16>>));
        let once = Arc::new(AtomicBool::new(false));
        let cell2 = Arc::clone(&cell);
        let once2 = Arc::clone(&once);
        let (p, c) = hooked_channel(8, move || {
            if once2.swap(true, Ordering::Relaxed) {
                return;
            }
            let g = cell2.lock().unwrap();
            if let Some(p) = g.as_ref() {
                p.clear();
                p.write(&[9, 10]);
            }
        });
        *cell.lock().unwrap() = Some(p.clone());
        p.write(&[1, 2, 3, 4, 5, 6, 7]);
        let mut out = [0i16; 4];
        assert_eq!(c.read(&mut out), 0, "torn slice must be discarded");
        let n = c.read(&mut out);
        assert_eq!(&out[..n], &[9, 10]);
    }

    #[test]
    fn clear_write_in_copy_window_does_not_lose_fresh() {
        // F1 regression: a clear()+fresh-write lands INSIDE the read's
        // atomic-read→copy window. The fresh slots enter the copy span
        // with the NEW generation tag → torn → discarded — and the next
        // read must serve the fresh data (not skip it past head).
        let cell = Arc::new(std::sync::Mutex::new(None::<Producer<i16>>));
        let once = Arc::new(AtomicBool::new(false));
        let cell2 = Arc::clone(&cell);
        let once2 = Arc::clone(&once);
        let s_shared = {
            // Need a pre_copy_hook — build via channel_hooked directly.
            let (p, c) = channel_hooked::<i16>(
                8,
                Some(Box::new(move || {
                    if once2.swap(true, Ordering::Relaxed) {
                        return;
                    }
                    let g = cell2.lock().unwrap();
                    if let Some(p) = g.as_ref() {
                        p.clear();
                        p.write(&[9, 10]);
                    }
                })),
                None,
            );
            *cell.lock().unwrap() = Some(p.clone());
            (p, c)
        };
        let (p, c) = s_shared;
        p.write(&[1, 2, 3, 4]);
        let mut out = [0i16; 4];
        assert_eq!(c.read(&mut out), 0, "mid-read clear must discard");
        let n = c.read(&mut out);
        assert_eq!(&out[..n], &[9, 10]);
    }

    #[test]
    fn late_hook_leaves_clean_reads_alone() {
        // Sanity: the hook firing with NO clear inside doesn't disturb
        // an ordinary read.
        let (p, c) = hooked_channel(8, || {});
        p.write(&[1, 2, 3]);
        let mut out = [0i16; 4];
        assert_eq!(c.read(&mut out), 3);
        assert_eq!(&out[..3], &[1, 2, 3]);
    }

    #[test]
    fn concurrent_spsc() {
        let (p, c) = channel::<u32>(1024);
        let total = 1_000_000u32;
        let t = std::thread::spawn(move || {
            let mut v = 0u32;
            while v < total {
                let end = (v + 97).min(total);
                let chunk: Vec<u32> = (v..end).collect();
                if !p.write_all(&chunk) {
                    return;
                }
                v = end;
            }
            p.finish();
        });
        let mut seen = 0u32;
        let mut buf = [0u32; 128];
        loop {
            let n = c.read(&mut buf);
            for i in 0..n {
                assert_eq!(buf[i], seen);
                seen += 1;
            }
            if c.is_drained() {
                break;
            }
            if n == 0 {
                std::thread::yield_now();
            }
        }
        t.join().unwrap();
        assert_eq!(seen, total);
    }
}
