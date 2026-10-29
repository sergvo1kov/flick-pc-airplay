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
REPORT=""
note() { echo "$1"; REPORT="$REPORT$1%0A"; }
# Elements UxPlay builds its audio (ALAC/AAC) and mirroring (H.264) pipelines from.
for el in appsrc queue volume level audioconvert audioresample avdec_alac avdec_aac aacparse autoaudiosink \
          fakesink h264parse h265parse avdec_h264 videoflip videoconvert videoscale rtph264pay decodebin playbin; do
  if gst-inspect-1.0.exe "$el" >/dev/null 2>&1; then
    note "ok   $el"
  else
    note "FAIL $el"; fail=1
  fi
done
# Hardware plugins: on a CI runner without GPU/sound card they may register no
# elements, so only check that the plugin DLL itself loads (all deps present).
for pl in wasapi2 d3d11; do
  if gst-inspect-1.0.exe "$pl" >/dev/null 2>&1; then
    n=$(gst-inspect-1.0.exe "$pl" 2>/dev/null | grep -c -E '^  [a-z0-9]+:' || true)
    note "ok   plugin $pl loads ($n elements on this machine)"
  else
    note "FAIL plugin $pl does not load"; fail=1
  fi
done
for el in wasapi2sink d3d11videosink d3d12videosink d3d11h264dec jpegdec mp4mux imagefreeze textoverlay; do
  gst-inspect-1.0.exe "$el" >/dev/null 2>&1 && note "ok   $el (optional)" || note "--   $el (optional/hardware, absent here)"
done

echo "--- uxplay -h"
uxplay.exe -h >/dev/null 2>&1; rc=$?
# -h exits with 0 or 1 depending on version; 127/-1073741515 (0xC0000135) means a DLL is missing
if [ "$rc" -gt 1 ]; then note "FAIL uxplay.exe could not start (exit $rc: missing DLL?)"; fail=1; else note "ok   uxplay.exe starts"; fi

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
  note "ok   uxplay.exe still running after 10 s"
  kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null
else
  wait "$pid"; note "FAIL uxplay.exe exited early (code $?)"; fail=1
fi
echo "--- uxplay output"
cat "$RT/out.log"
grep -q "Flick CI Тест" "$RT/out.log" && note "ok   UTF-8 device name read from rc file" || note "note: device name not echoed in log"

# Surface results as job annotations (readable via the API without raw logs).
OUTLOG=$(tail -n 40 "$RT/out.log" | tr -d '\r' | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
echo "::notice title=Engine check::$REPORT"
echo "::notice title=uxplay output (last 40 lines)::$OUTLOG"
[ "$fail" = 0 ] || echo "::error title=Engine check failed::$(echo "$REPORT" | sed 's/%0A/\n/g' | grep FAIL | tr '\n' ' ')"
exit $fail
