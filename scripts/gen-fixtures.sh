#!/usr/bin/env bash
# Generate local audio fixtures with ffmpeg: FLAC, WAV, MP3, ALAC-in-M4A,
# including a gapless album pair (two tracks split from one continuous source).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=test/fixtures/generated
mkdir -p "$OUT"

tone() { # file freq dur extra...
  local f="$1" freq="$2" dur="$3"; shift 3
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=${freq}:duration=${dur}:sample_rate=44100" \
    "$@" "$f"
}

tone "$OUT/tone-440.flac" 440 3 -c:a flac
tone "$OUT/tone-880.wav" 880 3 -c:a pcm_s16le
tone "$OUT/tone-660.mp3" 660 3 -c:a libmp3lame -q:a 2
tone "$OUT/tone-550.m4a" 550 3 -c:a alac
# 24-bit/96k FLAC for fidelity-mode testing
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=330:duration=2:sample_rate=96000" \
  -c:a flac -sample_fmt s32 "$OUT/tone-330-24bit96k.flac"

# STEREO files for the transparency null-tests (issue #1): different content
# per channel, 16-bit/44.1kHz, 24-bit/96kHz, 24-bit/192kHz.
stereo_sweep() { # file rate extra...
  local f="$1" rate="$2"; shift 2
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=440:duration=2:sample_rate=${rate}" \
    -f lavfi -i "sine=frequency=880:duration=2:sample_rate=${rate}" \
    -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" \
    -c:a flac "$@" "$f"
}
stereo_sweep "$OUT/stereo-44k1-16.flac" 44100 -sample_fmt s16
# A distinct 44.1k stereo track for the transition drain test
ffmpeg -y -v error \
    -f lavfi -i "anoisesrc=color=pink:duration=1.9:sample_rate=44100:amplitude=0.6" \
    -f lavfi -i "sine=frequency=517:duration=1.9:sample_rate=44100" \
    -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" \
    -c:a flac -sample_fmt s16 "$OUT/trans-b-44k1.flac"

# The 24-bit files must contain real sub-16-bit content (the null test can
# only prove depth preservation when low bits are nonzero) — aevalsrc emits
# f32, so irrational-amplitude tones fill all 24 bits. A quiet second tone
# at a non-harmonic frequency keeps no sample on a 16-bit boundary.
stereo_24() { # file rate
  local f="$1" rate="$2"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "aevalsrc=0.3*sin(440*2*PI*t)+0.013*sin(7919*2*PI*t):s=${rate}:d=2" \
    -f lavfi -i "aevalsrc=0.3*sin(880*2*PI*t)+0.013*sin(8317*2*PI*t):s=${rate}:d=2" \
    -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" \
    -c:a flac -sample_fmt s32 "$f"
}
stereo_24 "$OUT/stereo-96k-24.flac" 96000
stereo_24 "$OUT/stereo-192k-24.flac" 192000

# 5.1 surround — six DIFFERENT tones so a channel-order desync (partial
# frames dropped from an unaligned read buffer) shows as a large diff.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=0.3*sin(440*2*PI*t):s=44100:d=2" \
  -f lavfi -i "aevalsrc=0.3*sin(661*2*PI*t):s=44100:d=2" \
  -f lavfi -i "aevalsrc=0.3*sin(883*2*PI*t):s=44100:d=2" \
  -f lavfi -i "aevalsrc=0.2*sin(1109*2*PI*t):s=44100:d=2" \
  -f lavfi -i "aevalsrc=0.25*sin(1321*2*PI*t):s=44100:d=2" \
  -f lavfi -i "aevalsrc=0.28*sin(1543*2*PI*t):s=44100:d=2" \
  -filter_complex "[0:a][1:a][2:a][3:a][4:a][5:a]amerge=inputs=6[a]" \
  -map "[a]" -c:a flac -sample_fmt s16 "$OUT/surround-44k1-16.flac"

# Gapless pair: one continuous 6s sweep split at exactly 3s.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:duration=6:sample_rate=44100" \
  -af "atrim=0:3" -c:a flac "$OUT/gapless-a.flac"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:duration=6:sample_rate=44100,atrim=3:6,asetpts=PTS-STARTPTS" \
  -c:a flac "$OUT/gapless-b.flac"

# Cover art + tagged file so music-metadata has something to chew on.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x2244aa:size=512x512:duration=0.04" -frames:v 1 "$OUT/cover.png"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=500:duration=3:sample_rate=44100" \
  -i "$OUT/cover.png" -map 0:a -map 1:v -c:a flac -c:v png \
  -metadata title="Fixture Title" -metadata artist="Fixture Artist" \
  -metadata album="Fixture Album" -metadata track="1" -metadata date="2026" \
  -disposition:v attached_pic "$OUT/tagged.flac"

echo "Fixtures in $OUT:"; ls -la "$OUT"
