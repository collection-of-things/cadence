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

triple="$(python3 -c 'import platform,sys; m=platform.machine(); print({"x86_64":"x64","aarch64":"arm64"}.get(m,m)+"-"+sys.platform)' 2>/dev/null || echo "linux-x64")"
case "$(uname -s)" in
  Darwin) triple="$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/')-darwin" ;;
  MINGW*|MSYS*|CYGWIN*) triple="x64-win32" ;;
  *) triple="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')-linux" ;;
esac

exe="cadence-audio"
[ "$(uname -s | grep -c MINGW || true)" = "1" ] && exe="cadence-audio.exe"

mkdir -p "services/audio/bin/${triple}"
cp "services/audio/target/release/${exe}" "services/audio/bin/${triple}/${exe}"
echo "staged services/audio/bin/${triple}/${exe}"
