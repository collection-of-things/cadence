import { useEffect, useRef } from 'react';
import { session } from '../session';
import type { UiState } from '../store';
import type { Rgb } from '../palette';
import { themeFromPalette } from '../theme';

const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';

/* Four soft colour blobs drifting over a domain-warped noise field. The
   field is rendered at a quarter of the window size and upscaled — it is
   all low frequency, so nobody can tell. */
const FRAG = `precision mediump float;
uniform vec2 uRes;uniform float uT,uMix,uGain,uMove;
uniform vec3 uP0[4];uniform vec3 uP1[4];uniform float uW[4];
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<3;i++){v+=a*noise(p);p=p*2.03+11.7;a*=.5;}return v;}
void main(){
 vec2 uv=gl_FragCoord.xy/uRes;
 vec2 p=(uv-.5)*vec2(uRes.x/uRes.y,1.)*1.15;
 vec2 warp=vec2(fbm(p*1.35+uT*.045),fbm(p*1.35-uT*.037+9.2))-.5;
 vec2 q=p+warp*.85*uMove;
 vec3 c0=mix(uP0[0],uP1[0],uMix),c1=mix(uP0[1],uP1[1],uMix),c2=mix(uP0[2],uP1[2],uMix),c3=mix(uP0[3],uP1[3],uMix);
 vec2 m0=vec2(sin(uT*.093),cos(uT*.071+1.3))*vec2(.62,.42)*uMove+warp*.35;
 vec2 m1=vec2(sin(uT*.067+2.4),cos(uT*.088+4.1))*vec2(.66,.46)*uMove-warp*.3;
 vec2 m2=vec2(sin(uT*.119+4.3),cos(uT*.097+2.6))*vec2(.5,.5)*uMove+warp*.5;
 vec2 m3=vec2(sin(uT*.052+5.6),cos(uT*.061+.7))*vec2(.6,.44)*uMove;
 float w0=exp(-3.4*dot(q-m0,q-m0))*uW[0];
 float w1=exp(-3.0*dot(q-m1,q-m1))*uW[1];
 float w2=exp(-6.5*dot(q-m2,q-m2))*uW[2];
 float w3=exp(-4.2*dot(q-m3,q-m3))*uW[3];
 vec3 col=vec3(.014,.014,.016);
 col+=c0*w0+c1*w1+c2*w2+c3*w3;
 col*=.9+.22*fbm(uv*2.4-uT*.02);
 float v=dot(uv-.5,uv-.5);
 col*=1.-.8*v;
 gl_FragColor=vec4(col*uGain,1.);}`;

type Vec3 = [number, number, number];

const unit = (c: Rgb): Vec3 => [c[0] / 255, c[1] / 255, c[2] / 255];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const fieldOf = (palette: Rgb[]): Vec3[] => themeFromPalette(palette).field.map(unit);
const flatten = (f: Vec3[]) => new Float32Array(f.flat());

/** What the field should be doing for the current app state. */
function targets(s: UiState, idle: boolean, focused: boolean): { speed: number; gain: number; move: number } {
  const playing = s.snapshot.status === 'playing';
  const immersive = s.nowPlayingExpanded && s.snapshot.current !== null;
  let speed = playing ? 1 : 0.11;
  if (idle) speed *= 0.45;
  if (!focused) speed *= 0.22;
  return { speed, gain: immersive ? 1 : playing ? 0.78 : 0.5, move: immersive ? 1.3 : 0.85 };
}

/**
 * Full-window colour field behind the whole app, tinted by the playing
 * artwork. Driven by app state, never by audio: a track change morphs the
 * colours, pausing settles the flow, Now Playing opens it up, and idle,
 * blur or a hidden window slow or stop it. Reduced motion draws one still
 * frame per change. Without WebGL the CSS wash underneath shows instead.
 */
export function Ambient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl', { alpha: false, depth: false, stencil: false, antialias: false, powerPreference: 'low-power' });
    } catch {
      gl = null;
    }
    if (!gl) return;
    const ctx = gl;

    const compile = (ctx: WebGLRenderingContext, type: number, src: string) => {
      const sh = ctx.createShader(type);
      if (!sh) throw new Error('shader');
      ctx.shaderSource(sh, src);
      ctx.compileShader(sh);
      if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) throw new Error(ctx.getShaderInfoLog(sh) ?? 'compile');
      return sh;
    };
    let uniforms: Record<'res' | 't' | 'mix' | 'gain' | 'move' | 'p0' | 'p1' | 'w', WebGLUniformLocation | null>;
    try {
      const program = ctx.createProgram();
      if (!program) throw new Error('program');
      ctx.attachShader(program, compile(ctx, ctx.VERTEX_SHADER, VERT));
      ctx.attachShader(program, compile(ctx, ctx.FRAGMENT_SHADER, FRAG));
      ctx.linkProgram(program);
      if (!ctx.getProgramParameter(program, ctx.LINK_STATUS)) throw new Error('link');
      ctx.useProgram(program);
      ctx.bindBuffer(ctx.ARRAY_BUFFER, ctx.createBuffer());
      ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
      const loc = ctx.getAttribLocation(program, 'a');
      ctx.enableVertexAttribArray(loc);
      ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);
      const u = (name: string) => ctx.getUniformLocation(program, name);
      uniforms = { res: u('uRes'), t: u('uT'), mix: u('uMix'), gain: u('uGain'), move: u('uMove'), p0: u('uP0'), p1: u('uP1'), w: u('uW') };
      ctx.uniform1fv(uniforms.w, [0.92, 0.82, 0.55, 0.68]);
    } catch {
      return;
    }
    host.classList.add('is-gl');

    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let from = fieldOf(session.store.getState().palette);
    let to = from;
    let mixT = 1;
    let time = Math.random() * 40;
    let speed = 0;
    let gain = 0;
    let move = 0.85;
    let raf = 0;
    let lastFrame = 0;
    let lastDraw = 0;
    let lastInput = performance.now();
    let focused = document.hasFocus();

    const size = () => {
      const w = Math.max(240, Math.round(innerWidth * 0.24));
      const h = Math.max(140, Math.round(innerHeight * 0.24));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.viewport(0, 0, w, h);
      }
    };
    const draw = () => {
      size();
      ctx.uniform2f(uniforms.res, canvas.width, canvas.height);
      ctx.uniform1f(uniforms.t, time);
      ctx.uniform1f(uniforms.mix, mixT);
      ctx.uniform1f(uniforms.gain, gain);
      ctx.uniform1f(uniforms.move, move);
      ctx.uniform3fv(uniforms.p0, flatten(from));
      ctx.uniform3fv(uniforms.p1, flatten(to));
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    };
    const settle = () => {
      const t = targets(session.store.getState(), false, true);
      gain = t.gain;
      move = t.move;
      mixT = 1;
      draw();
    };
    const tick = (ts: number) => {
      raf = 0;
      const dt = Math.min(0.1, (ts - (lastFrame || ts)) / 1000);
      lastFrame = ts;
      const t = targets(session.store.getState(), performance.now() - lastInput > 40_000, focused);
      speed += (t.speed - speed) * Math.min(1, dt * 1.4);
      gain += (t.gain - gain) * Math.min(1, dt * 2.2);
      move += (t.move - move) * Math.min(1, dt * 1.6);
      if (mixT < 1) mixT = Math.min(1, mixT + dt / 2.8);
      time += dt * speed * 1.15;
      // ~30fps is plenty for a field this soft.
      if (ts - lastDraw >= 33) {
        draw();
        lastDraw = ts;
      }
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };
    const kick = () => {
      if (reduced.matches) {
        settle();
        return;
      }
      if (!raf && !document.hidden) {
        lastFrame = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const unsubscribe = session.store.subscribe((s, prev) => {
      if (s.palette !== prev.palette) {
        from = from.map((c, i) => lerp3(c, to[i]!, mixT));
        to = fieldOf(s.palette);
        mixT = 0;
      }
      kick();
    });
    const onInput = () => {
      lastInput = performance.now();
    };
    const onBlur = () => {
      focused = false;
    };
    const onFocus = () => {
      focused = true;
      kick();
    };
    const onVisible = () => (document.hidden ? stop() : kick());
    const onReduced = () => (reduced.matches ? (stop(), settle()) : kick());
    addEventListener('pointermove', onInput, { passive: true });
    addEventListener('keydown', onInput);
    addEventListener('blur', onBlur);
    addEventListener('focus', onFocus);
    addEventListener('resize', kick);
    document.addEventListener('visibilitychange', onVisible);
    reduced.addEventListener('change', onReduced);
    kick();

    return () => {
      stop();
      unsubscribe();
      removeEventListener('pointermove', onInput);
      removeEventListener('keydown', onInput);
      removeEventListener('blur', onBlur);
      removeEventListener('focus', onFocus);
      removeEventListener('resize', kick);
      document.removeEventListener('visibilitychange', onVisible);
      reduced.removeEventListener('change', onReduced);
      host.classList.remove('is-gl');
    };
  }, []);

  return (
    <div className="ambient" ref={hostRef} aria-hidden="true">
      <div className="ambient-wash" />
      <canvas ref={canvasRef} />
      <div className="ambient-veil" />
    </div>
  );
}
