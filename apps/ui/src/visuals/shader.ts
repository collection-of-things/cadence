export const AMBIENT_VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Ambient field: a slow domain-warped fbm tinted by the artwork palette.
 * The 48 FFT bands arrive as uBands[12]; energy around the radial angle of
 * each fragment adds a restrained luminance bloom. uMotion = 0 freezes time.
 */
export const AMBIENT_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec4 uBands[12];
uniform float uEnergy;
uniform float uMotion;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 4; i++) {
    v += amp * noise(p);
    p = p * 2.03 + vec2(19.7, 7.3);
    amp *= 0.5;
  }
  return v;
}

float bandComp(vec4 v, int i) {
  if (i == 0) return v.x;
  if (i == 1) return v.y;
  if (i == 2) return v.z;
  return v.w;
}

float bandAt(float t) {
  float x = clamp(t, 0.0, 0.9999) * 12.0;
  int idx = int(floor(x));
  int c = int(fract(x) * 4.0);
  return bandComp(uBands[idx], c);
}

void main() {
  vec2 p = vUv - 0.5;
  p.x *= uRes.x / uRes.y;

  float t = uTime * 0.000012 * uMotion;
  vec2 warp = vec2(
    fbm(p * 1.1 + vec2(t, -t * 0.4)),
    fbm(p * 1.1 + vec2(-t * 0.5, t * 0.7))
  );
  float deep = fbm(p * 1.25 + warp * 1.5 + vec2(t * 0.25, -t * 0.3));
  float near = fbm(p * 1.8 - warp * 0.8 + vec2(-t * 0.65, t * 0.4));
  vec3 col = mix(uColC, uColB, smoothstep(0.18, 0.85, deep));
  col = mix(col, uColA, smoothstep(0.34, 0.84, near) * 0.7);
  float r = length(p);
  float grain = hash21(gl_FragCoord.xy + fract(uTime * 0.0001) * 100.0) - 0.5;
  col *= (0.32 + deep * 0.18) * (1.0 + uEnergy * 0.035);
  col *= 1.0 - smoothstep(0.45, 1.4, r) * 0.34;
  col += grain * 0.012;

  fragColor = vec4(col, 1.0);
}
`;
