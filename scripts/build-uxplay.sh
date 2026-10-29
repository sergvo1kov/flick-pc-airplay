#!/usr/bin/env bash
# Builds the UxPlay AirPlay core in an MSYS2 UCRT64 shell.
# Usage: scripts/build-uxplay.sh [workdir]   -> <workdir>/UxPlay/build/uxplay.exe
set -euo pipefail

# Pinned to a known commit: UxPlay 1.74 ships its own mDNS responder on
# Windows, so Apple's Bonjour does not have to be installed.
UXPLAY_REPO="https://github.com/FDH2/UxPlay.git"
UXPLAY_COMMIT="${UXPLAY_COMMIT:-534e2cc0e558d6c94bcc66964f8fc13ad73a6cdc}"
WORK="${1:-.uxplay-build}"

mkdir -p "$WORK"
cd "$WORK"
if [ ! -d UxPlay/.git ]; then
  git clone --filter=blob:none "$UXPLAY_REPO" UxPlay
fi
cd UxPlay
git fetch --quiet origin "$UXPLAY_COMMIT" || true
git checkout --quiet --force "$UXPLAY_COMMIT"
git clean -fdxq

# Patch: unbuffered stdout. Flick AirPlay reads UxPlay's console through a pipe;
# without this, "connection request ..." lines sit in a 4 KB buffer for minutes.
if ! grep -q 'setvbuf(stdout, NULL, _IONBF, 0);' uxplay.cpp; then
  sed -i '0,/^    std::vector<char> server_hw_addr;/s//    setvbuf(stdout, NULL, _IONBF, 0);\n    std::vector<char> server_hw_addr;/' uxplay.cpp
fi
grep -q 'setvbuf(stdout, NULL, _IONBF, 0);' uxplay.cpp || { echo "stdout patch failed to apply"; exit 1; }

mkdir -p build
cd build
cmake -G Ninja -DCMAKE_BUILD_TYPE=Release ..
ninja
ls -la uxplay.exe
./uxplay.exe -v || true
