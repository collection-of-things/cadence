import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { APPLE_OUTPUT_LIMITER_JS } from "../src/adapters/providers/inject/apple-output-limiter.js";

interface Limiter {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  port: { onmessage(event: { data: { type: string } }): void };
}

function processor(rate = 48_000): Limiter {
  let Processor: (new () => Limiter) | undefined;
  runInNewContext(APPLE_OUTPUT_LIMITER_JS, {
    sampleRate: rate,
    AudioWorkletProcessor: class { port = {}; },
    registerProcessor: (_name: string, value: new () => Limiter) => { Processor = value; },
  });
  if (!Processor) throw new Error("Worklet did not register");
  return new Processor();
}

function render(p: Limiter, left: Float32Array, right: Float32Array): [Float32Array, Float32Array] {
  const l = new Float32Array(left.length);
  const r = new Float32Array(right.length);
  for (let start = 0; start < left.length; start += 128) {
    const end = Math.min(start + 128, left.length);
    p.process([[left.subarray(start, end), right.subarray(start, end)]], [[l.subarray(start, end), r.subarray(start, end)]]);
  }
  return [l, r];
}

describe("shipped Apple output worklet", () => {
  it("preserves every sample below the ceiling, including polarity and stereo timing", () => {
    const l = Float32Array.from({ length: 12_000 }, (_, i) => Math.sin(i * .19) * .8);
    const r = Float32Array.from({ length: 12_000 }, (_, i) => Math.cos(i * .37) * .6);
    const [ol, or] = render(processor(), l, r);
    expect(Array.from(ol.subarray(0, 240))).toEqual(Array(240).fill(0));
    expect(ol.subarray(240)).toEqual(l.subarray(0, l.length - 240));
    expect(or.subarray(240)).toEqual(r.subarray(0, r.length - 240));
  });

  it.each([44_100, 48_000, 96_000])("protects abrupt overshoots at %i Hz with shared stereo gain", (rate) => {
    const l = new Float32Array(rate);
    l.fill(.7);
    l[1000] = 1.092;
    l[1001] = -1.3;
    l[1800] = 20;
    const r = Float32Array.from(l, x => -x * .5);
    const [ol, or] = render(processor(rate), l, r);
    const ceiling = Math.pow(10, -.1 / 20);
    expect(Math.max(...ol.map(Math.abs))).toBeLessThanOrEqual(ceiling + 1e-7);
    expect(Math.max(...ol.map(Math.abs))).toBeGreaterThan(.98);
    expect(or).toEqual(Float32Array.from(ol, x => x === 0 ? 0 : -x * .5));
  });

  it("clears delayed old audio on a manual track replacement", () => {
    const p = processor();
    render(p, new Float32Array(128).fill(.8), new Float32Array(128).fill(-.8));
    p.port.onmessage({ data: { type: "reset" } });
    const [l, r] = render(p, new Float32Array(512), new Float32Array(512));
    expect(l.every(x => x === 0)).toBe(true);
    expect(r.every(x => x === 0)).toBe(true);
  });

  it("emits finite silence when the provider stops feeding", () => {
    const p = processor();
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    expect(p.process([[]], [[l, r]])).toBe(true);
    expect(l.every(x => x === 0)).toBe(true);
    expect(r.every(x => x === 0)).toBe(true);
  });
});
