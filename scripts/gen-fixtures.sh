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

# STEREO files for the transparency null-tests (issue #1): sweep + pink noise,
# 16-bit/44.1kHz, 24-bit/96kHz, 24-bit/192kHz — different content per channel.
stereo_sweep() { # file rate extra...
  local f="$1" rate="$2"; shift 2
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=440:duration=2:sample_rate=${rate}" \
    -f lavfi -i "sine=frequency=880:duration=2:sample_rate=${rate}" \
    -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" \
    -c:a flac "$@" "$f"
}
stereo_sweep "$OUT/stereo-44k1-16.flac" 44100 -sample_fmt s16
stereo_sweep "$OUT/stereo-96k-24.flac" 96000 -sample_fmt s32
stereo_sweep "$OUT/stereo-192k-24.flac" 192000 -sample_fmt s32

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
