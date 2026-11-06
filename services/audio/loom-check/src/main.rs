//! Sol P1 regression: a consumer read racing clear()+write() must not
//! deliver post-clear PCM under pre-clear indices. Modeled under Loom
//! on the REAL ring code (build.rs substitutes loom atomics into
//! ../src/ringbuf.rs verbatim — this model cannot drift).
mod ringbuf {
    include!(concat!(env!("OUT_DIR"), "/ringbuf.rs"));
}
use loom::thread;

fn main() {
    let mut b = loom::model::Builder::new();
    b.preemption_bound = Some(2);
    b.check(|| {
        let (p, c) = ringbuf::channel::<u32>(8);
        assert_eq!(p.write(&[1, 2, 3, 4, 5, 6]), 6);
        let h = thread::spawn(move || {
            p.clear();
            assert_eq!(p.write(&[101, 102, 103, 104, 105, 106]), 6);
        });
        let mut out = [0; 2];
        let n = c.read(&mut out);
        assert!(
            n == 0 || out == [1, 2] || out == [101, 102],
            "accepted post-clear slice under old indices: n={n}, out={out:?}"
        );
        h.join().unwrap();
    });
    println!("loom model passed");
}
