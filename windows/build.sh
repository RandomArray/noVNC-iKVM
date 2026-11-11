#!/usr/bin/env bash
# Build the noVNC-iKVM Windows launcher (a single .exe, no install needed).
# Runs on Linux, macOS or WSL with Go 1.22+ installed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
cd "${HERE}"

# Our releases are tagged ikvm-vX.Y.Z (the v1.x tags are noVNC's)
VERSION="$(git -C "${ROOT}" describe --tags --match 'ikvm-v*' --dirty 2>/dev/null || echo dev)"
VERSION="${VERSION#ikvm-}"

# The viewer files get embedded into the executable
rm -rf web
mkdir -p web
cp -r "${ROOT}/vnc.html" "${ROOT}/app" "${ROOT}/core" "${ROOT}/vendor" web/
rm -f web/app/images/icons/Makefile

# Icon, version information and manifest for Explorer. go-winres writes
# rsrc_windows_*.syso files, which "go build" links in automatically.
#   go install github.com/tc-hib/go-winres@v0.3.3
WINRES="$(command -v go-winres || echo "$(go env GOPATH)/bin/go-winres")"
if [[ -x "${WINRES}" ]]; then
    NUMVER="$(echo "${VERSION}" | grep -oE '^v?[0-9]+(\.[0-9]+){0,3}' | tr -d v || true)"
    "${WINRES}" simply \
        --arch amd64,arm64 \
        --icon icon/icon.ico \
        --manifest gui \
        --product-name "noVNC-iKVM" \
        --file-description "noVNC-iKVM - remote console for IPMI/BMC hosts" \
        --product-version "${NUMVER:-0.0.0}" \
        --file-version "${NUMVER:-0.0.0}" \
        --copyright "MPL 2.0" \
        --original-filename "noVNC-iKVM.exe"
else
    echo "go-winres not found: building without an icon" >&2
    rm -f rsrc_windows_*.syso
fi

mkdir -p dist
for arch in amd64 arm64; do
    GOOS=windows GOARCH="${arch}" CGO_ENABLED=0 go build -trimpath \
        -ldflags "-s -w -H windowsgui -X main.version=${VERSION}" \
        -o "dist/noVNC-iKVM-${arch}.exe" .
done
cp dist/noVNC-iKVM-amd64.exe dist/noVNC-iKVM.exe

ls -l dist/
