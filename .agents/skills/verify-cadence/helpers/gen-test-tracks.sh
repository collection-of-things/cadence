#!/usr/bin/env bash
# Regenerate the checked-in verification library in test/fixtures/library.
# Deterministic: no randomness, fixed seeds/timestamps. The audio is
# synthesized in-repo (aevalsrc chirps) so the fixtures are unambiguously
# ours to license — see test/fixtures/library/README.md (CC0).
#
# Track design note: each track is a frequency sweep (chirp) with a tremolo
# so every instant in the waveform is unique — cross-correlating a PipeWire
# capture against the decoded file yields one unambiguous alignment offset.
# Pure tones would alias; do not replace the sweeps with steady sines.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
OUT=test/fixtures/library
mkdir -p "$OUT/signal-atlas" "$OUT/field-notes"

# chirp <out> <f_start> <f_end> <dur> <trem_hz> <extra-metadata...>
# Stereo: right channel sweeps the same range with a half-cycle phase lag
# on the tremolo — decorrelated enough to exercise stereo, still aligned.
chirp() {
  local out="$1" f0="$2" f1="$3" dur="$4" trem="$5"; shift 5
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "aevalsrc=0.30*sin(2*PI*(${f0}+(${f1}-${f0})*t/${dur})*t)*(0.70+0.30*sin(2*PI*${trem}*t))|0.30*sin(2*PI*(${f0}+(${f1}-${f0})*t/${dur})*t)*(0.70+0.30*sin(2*PI*${trem}*t+PI/2)):s=44100:d=${dur}" \
    "$@" "$out"
}

cover() { # <out.png> <bg> <fg>
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=$1:size=640x640:duration=0.04" \
    -vf "drawbox=x=80:y=80:w=480:h=480:c=$2:t=12,drawbox=x=160:y=160:w=320:h=320:c=$2:t=8,drawbox=x=290:y=240:w=60:h=180:c=$2:t=fill" \
    -frames:v 1 "$3"
}

cover 0x1a2440 0x7fd4ff /tmp/cv-art-atlas.png
cover 0x2c1f10 0xffb454 /tmp/cv-art-field.png

embed() { # <src.flac->final> <art> metadata via ffmpeg args order: in in out
  :
}

mk() { # <out.flac> <art.png> -- then chirp args re-used via globals
  :
}

track() { # out flac path, art, title, artist, album, albumartist, trackno, year, genre, f0, f1, dur, trem
  local out="$1" art="$2" title="$3" artist="$4" album="$5" aa="$6" tn="$7" year="$8" genre="$9" f0="${10}" f1="${11}" dur="${12}" trem="${13}"
  local tmp="/tmp/cv-track-$$.flac"
  chirp "$tmp" "$f0" "$f1" "$dur" "$trem" -c:a flac -sample_fmt s16
  ffmpeg -hide_banner -loglevel error -y \
    -i "$tmp" -i "$art" \
    -map 0:a -map 1:v -c:a copy -c:v png -disposition:v attached_pic \
    -metadata title="$title" -metadata artist="$artist" \
    -metadata album="$album" -metadata album_artist="$aa" \
    -metadata track="$tn" -metadata date="$year" -metadata genre="$genre" \
    "$out"
  rm -f "$tmp"
}

# Album 1 — Signal Atlas / Cadence Test Ensemble (3 tracks, ascending set)
track "$OUT/signal-atlas/01 - Beacon.flac"   /tmp/cv-art-atlas.png "Beacon"   "Cadence Test Ensemble" "Signal Atlas" "Cadence Test Ensemble" 1 2026 "Verification" 280  840 14 2.5
track "$OUT/signal-atlas/02 - Meridian.flac" /tmp/cv-art-atlas.png "Meridian" "Cadence Test Ensemble" "Signal Atlas" "Cadence Test Ensemble" 2 2026 "Verification" 640  320 14 4.0
track "$OUT/signal-atlas/03 - Vantage.flac"  /tmp/cv-art-atlas.png "Vantage"  "Cadence Test Ensemble" "Signal Atlas" "Cadence Test Ensemble" 3 2026 "Verification" 400 1600 16 3.0

# Album 2 — Field Notes / Vector Choir (2 tracks, different artist)
track "$OUT/field-notes/01 - North Field.flac" /tmp/cv-art-field.png "North Field" "Vector Choir" "Field Notes" "Vector Choir" 1 2025 "Verification" 500  700 12 1.5
track "$OUT/field-notes/02 - Cairn.flac"       /tmp/cv-art-field.png "Cairn"       "Vector Choir" "Field Notes" "Vector Choir" 2 2025 "Verification" 900  450 12 5.0

echo "Fixtures in $OUT:"
find "$OUT" -type f -name '*.flac' -exec ffprobe -v error -show_entries format_tags=title:format=duration -of default=noprint_wrappers=1 {} \; -print | paste - -
du -sh "$OUT"
