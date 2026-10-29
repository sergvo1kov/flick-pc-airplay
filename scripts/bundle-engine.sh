#!/usr/bin/env bash
# Packs uxplay.exe with the GStreamer runtime it needs into a self-contained
# folder that mirrors the MSYS2 layout (bin/, lib/gstreamer-1.0/, libexec/),
# so GStreamer finds its plugins relative to its own DLLs.
# Run in an MSYS2 UCRT64 shell.  Usage: scripts/bundle-engine.sh <uxplay.exe> <out_dir>
set -euo pipefail

UXPLAY_EXE="$1"
OUT="$2"
PREFIX="${MINGW_PREFIX:-/ucrt64}"

# Plugins UxPlay uses (see UxPlay renderers/*.c). "required" must exist.
REQUIRED_PLUGINS=(
  coreelements typefindfunctions            # gstreamer core
  app audioconvert audioresample volume playback   # -base
  autodetect level videofilter              # -good: autoaudiosink, level (audio pipeline), videoflip
  libav                                      # avdec_alac, avdec_aac, avdec_h264
  videoparsersbad wasapi2 d3d11              # -bad: h264parse, audio out, video out
  soup adaptivedemux2 isomp4 audioparsers   # -good: HTTPS source, hlsdemux2, fMP4, aacparse (YouTube HLS)
  mpegtsdemux                                # -bad: tsdemux (HLS .ts segments)
)
OPTIONAL_PLUGINS=(
  videoconvertscale videoconvert videoscale videorate audiorate rawparse  # -base (names vary by version)
  directsound jpeg rtp rtpmanager imagefreeze                             # -good
  pango                                                                    # -base: textoverlay (cover-art window mode only)
  wasapi d3d12 mediafoundation dxva hls dash                              # -bad
)

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib/gstreamer-1.0" "$OUT/libexec/gstreamer-1.0"

cp "$UXPLAY_EXE" "$OUT/bin/uxplay.exe"
# diagnostics tools (tiny, handy for support)
cp "$PREFIX/bin/gst-inspect-1.0.exe" "$PREFIX/bin/gst-launch-1.0.exe" "$OUT/bin/"
cp "$PREFIX/libexec/gstreamer-1.0/gst-plugin-scanner.exe" "$OUT/libexec/gstreamer-1.0/"

# The soup plugin loads libsoup at runtime (not visible to ldd), and HTTPS needs
# glib-networking's TLS module (loaded by GIO from GIO_MODULE_DIR).
cp "$PREFIX"/bin/libsoup-3.0-*.dll "$OUT/bin/"
mkdir -p "$OUT/lib/gio/modules"
cp "$PREFIX"/lib/gio/modules/*.dll "$OUT/lib/gio/modules/"
ls "$OUT/lib/gio/modules"

missing=0
for p in "${REQUIRED_PLUGINS[@]}"; do
  f="$PREFIX/lib/gstreamer-1.0/libgst${p}.dll"
  if [ -f "$f" ]; then cp "$f" "$OUT/lib/gstreamer-1.0/"; else echo "REQUIRED plugin missing: $p"; missing=1; fi
done
[ "$missing" = 0 ] || exit 1
for p in "${OPTIONAL_PLUGINS[@]}"; do
  f="$PREFIX/lib/gstreamer-1.0/libgst${p}.dll"
  if [ -f "$f" ]; then cp "$f" "$OUT/lib/gstreamer-1.0/"; else echo "optional plugin not present: $p"; fi
done

# Copy the DLL dependency closure of every exe/dll in the bundle (only DLLs that
# come from the MSYS2 prefix; Windows system DLLs stay out).
prefix_win_bin="$(cygpath -u "$PREFIX/bin")"
for round in 1 2 3 4 5 6 7 8; do
  added=0
  while IFS= read -r dll; do
    base="$(basename "$dll")"
    if [ ! -f "$OUT/bin/$base" ]; then
      cp "$dll" "$OUT/bin/"
      added=$((added + 1))
    fi
  done < <(
    find "$OUT" -iname '*.exe' -o -iname '*.dll' | while read -r f; do
      ldd "$f" 2>/dev/null | awk '{print $3}' | grep -i "^${prefix_win_bin}/" || true
    done | sort -u
  )
  echo "dependency round $round: +$added DLLs"
  [ "$added" = 0 ] && break
done

# Licenses for what we redistribute.
mkdir -p "$OUT/licenses"
for pkg in gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav ffmpeg libplist openssl; do
  d="$PREFIX/share/licenses/$pkg"
  [ -d "$d" ] && cp -r "$d" "$OUT/licenses/$pkg" || true
done

echo "bundle size: $(du -sh "$OUT" | cut -f1)"
ls "$OUT/lib/gstreamer-1.0"
echo "::notice title=Engine bundle::size $(du -sh "$OUT" | cut -f1), $(ls "$OUT/bin" | wc -l) files in bin, plugins: $(ls "$OUT/lib/gstreamer-1.0" | sed 's/^libgst//; s/\.dll$//' | tr '\n' ' ')"
