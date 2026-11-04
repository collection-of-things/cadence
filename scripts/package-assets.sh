#!/usr/bin/env bash
# Stage packaged assets: build the UI bundle + audio binary into the layout
# electron-builder.yml's extraResources expects:
#   resources/ui/index.html        <- apps/ui/dist
#   resources/audio/{platform}-{arch}/cadence-audio
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== build ui =="
pnpm --filter @cadence/ui build

echo "== build cadence-audio =="
cargo build --release --manifest-path services/audio/Cargo.toml

# Layout MUST match resolveAudioBinary: resources/audio/{platform}-{arch}/
case "$(uname -s)" in
  Darwin) triple="darwin-$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/')" ;;
  MINGW*|MSYS*|CYGWIN*) triple="win32-x64" ;;
  *) triple="linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" ;;
esac

exe="cadence-audio"
[ "$(uname -s | grep -c MINGW || true)" = "1" ] && exe="cadence-audio.exe"

mkdir -p "services/audio/bin/${triple}"
cp "services/audio/target/release/${exe}" "services/audio/bin/${triple}/${exe}"
echo "staged services/audio/bin/${triple}/${exe}"

# ffmpeg/ffprobe must ship beside the binary — the decoder shells out to
# them and packaged machines may not have them on PATH.
for tool in ffmpeg ffprobe; do
  if command -v "$tool" >/dev/null 2>&1; then
    cp "$(command -v "$tool")" "services/audio/bin/${triple}/"
    echo "staged ${tool}"
  else
    echo "WARN: ${tool} not found on PATH — packaged app needs it beside ${exe}" >&2
  fi
done
