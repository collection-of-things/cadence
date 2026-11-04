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

pub fn channel<T: Copy + Default>(capacity: usize) -> (Producer<T>, Consumer<T>) {
    let s = Arc::new(Shared {
        buf: vec![T::default(); capacity],
        cap: capacity,
        head: AtomicUsize::new(0),
        tail: AtomicUsize::new(0),
        done: AtomicBool::new(false),
        abort: AtomicBool::new(false),
    });
    (Producer { s: s.clone() }, Consumer { s })
}

impl<T: Copy + Default> Producer<T> {
    /// Non-blocking write; returns number of elements written (0..=data.len()).
    pub fn write(&self, data: &[T]) -> usize {
        let head = self.s.head.load(Ordering::Acquire);
        let tail = self.s.tail.load(Ordering::Relaxed);
        let free = self.s.cap - (tail - head) - 1; // keep one slot to disambiguate full/empty
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

    pub fn is_aborted(&self) -> bool {
        self.s.abort.load(Ordering::Acquire)
    }
}

impl<T: Copy + Default> Consumer<T> {
    /// Non-blocking read; returns elements read.
    pub fn read(&self, out: &mut [T]) -> usize {
        let tail = self.s.tail.load(Ordering::Acquire);
        let head = self.s.head.load(Ordering::Relaxed);
        let n = out.len().min(tail - head);
        for i in 0..n {
            out[i] = self.s.buf[(head + i) % self.s.cap];
        }
        self.s.head.store(head + n, Ordering::Release);
        n
    }

    pub fn available(&self) -> usize {
        self.s.tail.load(Ordering::Acquire) - self.s.head.load(Ordering::Relaxed)
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
