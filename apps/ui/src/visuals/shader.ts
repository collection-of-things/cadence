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

  float t = uTime * 0.045 * uMotion;
  vec2 warp = vec2(
    fbm(p * 1.5 + vec2(t, -t * 0.6)),
    fbm(p * 1.5 + vec2(-t * 0.8, t * 0.5))
  );
  float f = fbm(p * 1.8 + warp * 1.35 - vec2(0.0, t * 0.4));

  float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
  float band = bandAt(ang);
  float r = length(p);

  vec3 col = mix(uColC, uColB, smoothstep(0.12, 0.72, f));
  col = mix(col, uColA, smoothstep(0.55, 0.98, f + band * 0.22));

  float lum = 0.05 + f * 0.09 + band * (0.10 + uEnergy * 0.18) * smoothstep(1.1, 0.15, r);
  col *= lum * (0.9 + uEnergy * 0.45);
  col *= 1.0 - smoothstep(0.35, 1.15, r) * 0.6;

  fragColor = vec4(col, 1.0);
}
`;
