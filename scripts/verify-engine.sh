#!/usr/bin/env bash
# Verifies the bundled engine works on its own, with NO access to the MSYS2
# install: every element UxPlay needs must load from the bundle, and uxplay.exe
# must start and stay up. Run in MSYS2 (for bash), not dependent on its DLLs.
# Usage: scripts/verify-engine.sh <engine_dir>
set -uo pipefail

ENGINE="$(cd "$1" && pwd)"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"   # captured before PATH is locked down
WIN_ENGINE="$(cygpath -w "$ENGINE")"
export PATH="$ENGINE/bin:/c/Windows/System32:/c/Windows:/usr/bin"
export GST_PLUGIN_PATH_1_0="$WIN_ENGINE\\lib\\gstreamer-1.0"
export GST_PLUGIN_SYSTEM_PATH_1_0="$WIN_ENGINE\\lib\\gstreamer-1.0"
export GST_PLUGIN_SCANNER_1_0="$WIN_ENGINE\\libexec\\gstreamer-1.0\\gst-plugin-scanner.exe"
REG_DIR="$(mktemp -d)"
export GST_REGISTRY_1_0="$(cygpath -w "$REG_DIR")\\registry.bin"
unset GST_PLUGIN_PATH GST_PLUGIN_SYSTEM_PATH UXPLAYRC

fail=0
# Elements for audio (ALAC/AAC) and for later screen mirroring (H.264 -> D3D11).
for el in appsrc queue volume audioconvert audioresample avdec_alac avdec_aac autoaudiosink wasapi2sink \
          fakesink h264parse avdec_h264 d3d11videosink decodebin playbin; do
  if gst-inspect-1.0.exe "$el" >/dev/null 2>&1; then
    echo "ok   $el"
  else
    echo "FAIL $el"; fail=1
  fi
done
for el in d3d12videosink d3d11h264dec jpegdec mp4mux; do
  gst-inspect-1.0.exe "$el" >/dev/null 2>&1 && echo "ok   $el (optional)" || echo "--   $el (optional, absent)"
done

echo "--- uxplay -h"
uxplay.exe -h >/dev/null 2>&1; rc=$?
# -h exits with 0 or 1 depending on version; 127/-1073741515 (0xC0000135) means a DLL is missing
if [ "$rc" -gt 1 ]; then echo "FAIL uxplay.exe could not start (exit $rc: missing DLL?)"; fail=1; else echo "ok   uxplay.exe starts"; fi

echo "--- 10 s run as a real receiver"
RT="$(mktemp -d)"
cat > "$RT/uxplay.rc" <<'EOF'
n "Flick CI Тест"
nh
vs 0
as fakesink
ca cover.jpg
md meta.txt
dacp dacp.txt
EOF
( cd "$RT" && exec uxplay.exe -rc uxplay.rc ) > "$RT/out.log" 2>&1 &
pid=$!
sleep 3
if [ -n "$NODE_BIN" ]; then "$NODE_BIN" "$SCRIPTS/ci-discovery.js" || echo "(discovery check is informational)"; fi
sleep 7
if kill -0 "$pid" 2>/dev/null; then
  echo "ok   uxplay.exe still running after 10 s"
  kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null
else
  wait "$pid"; echo "FAIL uxplay.exe exited early (code $?)"; fail=1
fi
echo "--- uxplay output"
cat "$RT/out.log"
grep -q "Flick CI Тест" "$RT/out.log" && echo "ok   UTF-8 device name read from rc file" || echo "note: device name not echoed in log"

exit $fail
