# Third-party components

Flick AirPlay bundles the following open-source software in `resources/engine`:

| Component | License | Source |
|---|---|---|
| UxPlay (AirPlay core, `uxplay.exe`) | GPL-3.0 | https://github.com/FDH2/UxPlay — exact commit is pinned in `scripts/build-uxplay.sh`; the only change is unbuffered stdout (one line, see that script) |
| GStreamer + plugins (base, good, bad, libav) | LGPL-2.1+ | https://gstreamer.freedesktop.org |
| FFmpeg (via gst-libav) | LGPL-2.1+ | https://ffmpeg.org |
| libplist | LGPL-2.1+ | https://github.com/libimobiledevice/libplist |
| OpenSSL | Apache-2.0 | https://www.openssl.org |

Binaries come from the MSYS2 UCRT64 repository; their license files are copied to
`resources/engine/licenses`. The desktop app is built with Electron (MIT).

Ideas for pause handling, progress anchoring and the now-playing screen were taken
from the Android receiver Flick AirPlay / PhairPlay (no code copied).
