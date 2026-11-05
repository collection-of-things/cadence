import { useEffect, useRef, useState } from 'react';
import { Application, Geometry, GlProgram, Mesh, Shader, UniformGroup } from 'pixi.js';
import { session } from '../app';
import { useReducedMotion } from '../hooks';
import type { Rgb } from '../palette';
import { DEFAULT_PALETTE } from '../palette';
import { AMBIENT_FRAG, AMBIENT_VERT } from './shader';

function toVec3(rgb: Rgb): Float32Array {
  return new Float32Array([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]);
}

function gradientStyle(palette: Rgb[]): React.CSSProperties {
  const [a, b, c] = [palette[0] ?? DEFAULT_PALETTE[0], palette[1] ?? DEFAULT_PALETTE[1], palette[2] ?? DEFAULT_PALETTE[2]];
  const c1 = `rgb(${a![0] / 3 | 0} ${a![1] / 3 | 0} ${a![2] / 3 | 0})`;
  const c2 = `rgb(${b![0] / 3 | 0} ${b![1] / 3 | 0} ${b![2] / 3 | 0})`;
  const c3 = `rgb(${c![0] / 3 | 0} ${c![1] / 3 | 0} ${c![2] / 3 | 0})`;
  return { background: `radial-gradient(120% 120% at 30% 20%, ${c1}, ${c2} 55%, ${c3})` };
}

/**
 * Full-window WebGL2 ambient field. Reacts to session.runtime.fft when the
 * route provides PCM; otherwise breathes on a synthesized idle signal.
 * Under prefers-reduced-motion or on WebGL failure: static palette gradient.
 */
export function PixiBackground({ palette }: { palette: Rgb[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (reduced || failed) return;
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    let app: Application | null = null;
    let onLost: (() => void) | null = null;
    let onRestored: (() => void) | null = null;

    void (async () => {
      try {
        const a = new Application();
        await a.init({
          preference: 'webgl',
          resizeTo: host,
          backgroundAlpha: 0,
          antialias: false,
          autoDensity: true,
          // The ambient field is soft; render at <=1.25x to protect the frame
          // budget on integrated GPUs. Adaptive step-down below.
          resolution: Math.min(window.devicePixelRatio || 1, 1.25),
        });
        if (dead) {
          a.destroy(true);
          return;
        }
        app = a;
        host.appendChild(a.canvas);
        a.canvas.setAttribute('aria-hidden', 'true');

        const geometry = new Geometry({
          attributes: { aPosition: { buffer: [-1, -1, 3, -1, -1, 3], format: 'float32x2' } },
        });
        const glProgram = GlProgram.from({ name: 'cadence-ambient', vertex: AMBIENT_VERT, fragment: AMBIENT_FRAG });
        const shader = new Shader({
          glProgram,
          resources: {
            uAmbient: {
              uRes: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
              uTime: { value: 0, type: 'f32' },
              uColA: { value: toVec3(paletteRef.current[0] ?? DEFAULT_PALETTE[0]!), type: 'vec3<f32>' },
              uColB: { value: toVec3(paletteRef.current[1] ?? DEFAULT_PALETTE[1]!), type: 'vec3<f32>' },
              uColC: { value: toVec3(paletteRef.current[2] ?? DEFAULT_PALETTE[2]!), type: 'vec3<f32>' },
              uBands: { value: new Float32Array(48), type: 'vec4<f32>', size: 12 },
              uEnergy: { value: 0, type: 'f32' },
              uMotion: { value: 1, type: 'f32' },
            },
          },
        });
        const mesh = new Mesh({ geometry, shader });
        a.stage.addChild(mesh);

        interface AmbientUniforms {
          uRes: Float32Array;
          uTime: number;
          uColA: Float32Array;
          uColB: Float32Array;
          uColC: Float32Array;
          uBands: Float32Array;
          uEnergy: number;
          uMotion: number;
        }
        const uniforms = (shader.resources.uAmbient as UniformGroup).uniforms as unknown as AmbientUniforms;
        const idlePhase = { t: 0 };
        // Adaptive resolution: if the rolling frame time stays above ~19ms
        // (≈52fps), step resolution down toward 0.5x — an ambient blur can
        // lose pixels more gracefully than it can lose frames.
        let frameCost = 16.7;
        a.ticker.add((ticker) => {
          frameCost = frameCost * 0.95 + ticker.deltaMS * 0.05;
          if (frameCost > 19 && a.renderer.resolution > 0.5) {
            a.renderer.resolution = Math.max(0.5, a.renderer.resolution - 0.25);
            a.renderer.resize(host.clientWidth, host.clientHeight);
          }
        });
        a.ticker.add((ticker) => {
          const u = uniforms;
          u.uTime += ticker.deltaMS;
          const w = a.renderer.width / a.renderer.resolution;
          const h = a.renderer.height / a.renderer.resolution;
          if (u.uRes[0] !== w || u.uRes[1] !== h) {
            u.uRes[0] = w;
            u.uRes[1] = h;
          }
          // Palette colors ease toward the artwork palette.
          const pal = paletteRef.current;
          for (let i = 0; i < 3; i++) {
            const target = pal[i] ?? DEFAULT_PALETTE[i]!;
            const cur = i === 0 ? u.uColA : i === 1 ? u.uColB : u.uColC;
            for (let c = 0; c < 3; c++) {
              const cv = cur[c] ?? 0;
              cur[c] = cv + (target[c]! / 255 - cv) * 0.045;
            }
          }
          const { fft, clock } = session.runtime;
          const live = fft.generationId >= 0 && Date.now() - fft.atMs < 500;
          const bands = u.uBands;
          if (live) {
            for (let i = 0; i < 48; i++) {
              const raw = fft.bands[i] ?? 0;
              // Engine bands are dBFS (-100..0); normalize to ~0..1 for the shader.
              const target = raw <= 0 ? Math.min(1, Math.max(0, (raw + 80) / 80)) : Math.min(1, raw);
              const b = bands[i] ?? 0;
              bands[i] = b + (target - b) * 0.25;
            }
          } else {
            // Idle breathing when no PCM route feeds us.
            idlePhase.t += ticker.deltaMS * 0.001;
            for (let i = 0; i < 48; i++) {
              const idle =
                0.22 + 0.16 * Math.sin(idlePhase.t * 1.1 + i * 0.45) * Math.sin(idlePhase.t * 0.6 + i * 0.13);
              const b = bands[i] ?? 0;
              bands[i] = b + (idle - b) * 0.05;
            }
          }
          let energy = 0;
          for (let i = 0; i < 48; i++) energy += bands[i]!;
          energy /= 48;
          u.uEnergy += ((clock.playing ? energy : energy * 0.4) - u.uEnergy) * 0.1;
        });

        onLost = () => setFailed(true);
        onRestored = () => setFailed(false);
        a.canvas.addEventListener('webglcontextlost', onLost);
        a.canvas.addEventListener('webglcontextrestored', onRestored);
      } catch {
        if (!dead) setFailed(true);
      }
    })();

    return () => {
      dead = true;
      if (app) {
        const canvas = app.canvas;
        if (onLost) canvas.removeEventListener('webglcontextlost', onLost);
        if (onRestored) canvas.removeEventListener('webglcontextrestored', onRestored);
        app.destroy(true);
      }
    };
  }, [reduced, failed]);

  if (reduced || failed) return <div className="np-bg np-bg-static" style={gradientStyle(palette)} aria-hidden="true" />;
  return <div className="np-bg" ref={hostRef} aria-hidden="true" />;
}
