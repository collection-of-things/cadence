//! Bounded single-producer/single-consumer ring buffer for PCM frames.
//!
//! The decode/producer side pushes interleaved samples; the output callback
//! pops them. All operations on the hot path are non-allocating and lock-free.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

struct Shared<T> {
    buf: Vec<T>,
    cap: usize,
    head: AtomicUsize, // read index
    tail: AtomicUsize, // write index
    /// Monotonic discard fence: samples below this index are stale and
    /// must never be delivered — set by Producer::clear (epoch flush).
    /// Unlike a head store, it can't be regressed by a stale reader.
    fence: AtomicUsize,
    /// Producer finished (EOF); consumer may drain remaining then end track.
    done: AtomicBool,
    /// Consumer side dropped/aborted; producer should stop writing.
    abort: AtomicBool,
}

pub struct Producer<T> {
    s: Arc<Shared<T>>,
}

impl<T> Clone for Producer<T> {
    fn clone(&self) -> Self {
        Producer { s: Arc::clone(&self.s) }
    }
}

pub struct Consumer<T> {
    s: Arc<Shared<T>>,
}

impl<T> Clone for Consumer<T> {
    fn clone(&self) -> Self {
        Consumer { s: Arc::clone(&self.s) }
    }
}

pub fn channel<T: Copy + Default>(capacity: usize) -> (Producer<T>, Consumer<T>) {
    let s = Arc::new(Shared {
        buf: vec![T::default(); capacity],
        cap: capacity,
        head: AtomicUsize::new(0),
        tail: AtomicUsize::new(0),
        fence: AtomicUsize::new(0),
        done: AtomicBool::new(false),
        abort: AtomicBool::new(false),
    });
    (Producer { s: s.clone() }, Consumer { s })
}

impl<T: Copy + Default> Producer<T> {
    /// Free slots writable without overwriting unread data.
    pub fn free_space(&self) -> usize {
        let head = self.s.head.load(Ordering::Acquire);
        let tail = self.s.tail.load(Ordering::Relaxed);
        let fence = self.s.fence.load(Ordering::Acquire);
        // Discarded data is already gone — a stale consumer store can
        // regress head, but the fence is the true floor.
        let head = head.max(fence);
        self.s.cap.saturating_sub(tail.saturating_sub(head)) - 1
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
            - 1;
        let n = data.len().min(free);
        for i in 0..n {
            let idx = (tail + i) % self.s.cap;
            // Safety of mutation: producer is the only writer for slots < tail.
            unsafe {
                let p = self.s.buf.as_ptr() as *mut T;
                p.add(idx).write(data[i]);
            }
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

impl<T: Copy + Default> Consumer<T> {
    /// Non-blocking read; returns elements read.
    pub fn read(&self, out: &mut [T]) -> usize {
        let tail = self.s.tail.load(Ordering::Acquire);
        let head = self.s.head.load(Ordering::Relaxed);
        let fence = self.s.fence.load(Ordering::Acquire);
        // start >= fence: a clear() that landed mid-read can never make
        // us serve discarded data; start >= head keeps head monotonic.
        let start = head.max(fence);
        let n = out.len().min(tail.saturating_sub(start));
        for i in 0..n {
            out[i] = self.s.buf[(start + i) % self.s.cap];
        }
        self.s.head.store(start + n, Ordering::Release);
        // A clear() landing mid-copy means what we just read was already
        // stale (and possibly torn by a wrapping producer): report the
        // head advance but give the caller nothing usable.
        if self.s.fence.load(Ordering::Acquire) > start {
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
        let start = head.max(fence);
        let avail = tail.saturating_sub(start);
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
        for i in 0..n {
            out[i] = self.s.buf[(start + i) % self.s.cap];
        }
        self.s.head.store(start + n, Ordering::Release);
        // See read(): a mid-copy clear makes this slice stale.
        if self.s.fence.load(Ordering::Acquire) > start {
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
    fn concurrent_spsc() {
        let (p, c) = channel::<u64>(1024);
        let total = 1_000_000u64;
        let t = std::thread::spawn(move || {
            let mut v = 0u64;
            while v < total {
                let chunk: Vec<u64> = (v..(v + 97).min(total)).collect();
                if !p.write_all(&chunk) {
                    return;
                }
                v += chunk.len() as u64;
            }
            p.finish();
        });
        let mut seen = 0u64;
        let mut buf = [0u64; 128];
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
