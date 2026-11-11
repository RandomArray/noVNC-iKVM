#!/usr/bin/env bash
# Build the noVNC-iKVM Windows launcher (a single .exe, no install needed).
# Runs on Linux, macOS or WSL with Go 1.22+ installed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
cd "${HERE}"

VERSION="$(git -C "${ROOT}" describe --tags --always --dirty 2>/dev/null || echo dev)"

# The viewer files get embedded into the executable
rm -rf web
mkdir -p web
cp -r "${ROOT}/vnc.html" "${ROOT}/app" "${ROOT}/core" "${ROOT}/vendor" web/
rm -f web/app/images/icons/Makefile

mkdir -p dist
for arch in amd64 arm64; do
    GOOS=windows GOARCH="${arch}" CGO_ENABLED=0 go build -trimpath \
        -ldflags "-s -w -H windowsgui -X main.version=${VERSION}" \
        -o "dist/noVNC-iKVM-${arch}.exe" .
done
cp dist/noVNC-iKVM-amd64.exe dist/noVNC-iKVM.exe

ls -l dist/
