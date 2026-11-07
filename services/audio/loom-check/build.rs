//! Generate `ringbuf.rs` from the real ring implementation — the model
//! can never drift from the code it checks. Substitutions map std
//! atomics onto loom's and strip cfg(test) code.
use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let src = Path::new("../src/ringbuf.rs");
    println!("cargo:rerun-if-changed={}", src.display());
    let mut s = fs::read_to_string(src).unwrap();
    // Cut every #[cfg(test)] item block (attr line + following item).
    // Blocks are top-level `#[cfg(test)]` markers followed by lines
    // until the next top-level `}` at column 0 — simplest robust cut:
    // drop lines from `#[cfg(test)]` through the matching `}` at col 0.
    // Attribute forms: `#[cfg(test)]` on a bare field/expression line
    // (no brace) → drop the next non-blank line only; on an item →
    // skip through its matching brace.
    let lines: Vec<&str> = s.lines().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[cfg(test)]" {
            // Pull back doc comments already emitted for the item.
            let mut keep = out.trim_end_matches('\n').len();
            while keep > 0 {
                let nl = out[..keep].rfind('\n').map(|x| x + 1).unwrap_or(0);
                let l = out[nl..keep].trim();
                if l.starts_with("///") || l.starts_with("//!")
                    || l.starts_with("#[doc")
                {
                    keep = nl.saturating_sub(1);
                } else {
                    break;
                }
            }
            out.truncate(keep + usize::from(keep > 0));
            i += 1;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            let mut depth = 0i32;
            let mut first = true;
            while i < lines.len() {
                let l = lines[i];
                depth += l.matches('{').count() as i32;
                depth -= l.matches('}').count() as i32;
                i += 1;
                if first && !l.contains('{') {
                    break; // bare field/expression — one line only
                }
                first = false;
                if depth <= 0 {
                    break;
                }
            }
            continue;
        }
        out.push_str(lines[i]);
        out.push('\n');
        i += 1;
    }
    s = out;
    // Inner doc comments can't annotate the first use — convert to //.
    s = s.replace("//!", "//");
    s = s.replace("use std::sync::atomic::{", "use loom::sync::atomic::{");
    s = s.replace("use std::sync::Arc;", "use loom::sync::Arc;");
    s = s.replace("std::sync::atomic::fence", "loom::sync::atomic::fence");
    assert!(s.contains("loom::sync::atomic::"), "atomics not substituted");
    assert!(!s.contains("std::sync::atomic"), "std atomics remain in model");
    s = s.replace("Arc::", "Arc::"); // loom::sync::Arc alias already
    let dst = Path::new(&env::var("OUT_DIR").unwrap()).join("ringbuf.rs");
    fs::write(&dst, s).unwrap();
}
