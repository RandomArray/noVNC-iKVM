#!/usr/bin/env bash
# noVNC-iKVM launcher
# Licensed under MPL 2.0 (see LICENSE.txt)
#
# Serves the viewer and proxies WebSocket connections to one or more
# BMC KVM ports (TCP 5900) using websockify in a local Python venv.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${HERE}/.venv"
WEBSOCKIFY_VERSION="0.13.0"

LISTEN="127.0.0.1"
PORT="6080"
CONFIG=""
TARGET=""

usage() {
    cat <<EOF
Usage:
  $(basename "$0") [options] BMC_HOST[:PORT]     view one BMC (KVM port defaults to 5900)
  $(basename "$0") [options] -c bmcs.conf        view any BMC listed in a file

Options:
  -c, --config FILE   File with one "name: host[:port]" line per BMC
  -p, --port PORT     Local port to serve on (default ${PORT})
  -a, --all           Listen on all interfaces instead of 127.0.0.1 only.
                      Anyone who can reach this port can reach your BMCs.
  -h, --help          Show this help

Examples:
  $(basename "$0") 192.0.2.10
  $(basename "$0") -c bmcs.conf -p 6090
EOF
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -c|--config) CONFIG="$2"; shift 2 ;;
        -p|--port)   PORT="$2"; shift 2 ;;
        -a|--all)    LISTEN="0.0.0.0"; shift ;;
        -h|--help)   usage 0 ;;
        -*)          echo "Unknown option: $1" >&2; usage 1 ;;
        *)           TARGET="$1"; shift ;;
    esac
done

if [[ -z "${TARGET}" && -z "${CONFIG}" ]] || [[ -n "${TARGET}" && -n "${CONFIG}" ]]; then
    usage 1
fi

if [[ ! -x "${VENV}/bin/websockify" ]]; then
    echo "Setting up websockify ${WEBSOCKIFY_VERSION} in ${VENV} ..."
    python3 -m venv "${VENV}"
    "${VENV}/bin/pip" install --quiet "websockify==${WEBSOCKIFY_VERSION}"
fi

if [[ "${LISTEN}" == "0.0.0.0" ]]; then
    SHOW_HOST="$(hostname -f 2>/dev/null || hostname)"
else
    SHOW_HOST="localhost"
fi
BASE="http://${SHOW_HOST}:${PORT}/vnc.html?host=${SHOW_HOST}&port=${PORT}&autoconnect=1"

if [[ -n "${CONFIG}" ]]; then
    CONFIG="$(cd "$(dirname "${CONFIG}")" && pwd)/$(basename "${CONFIG}")"
    [[ -r "${CONFIG}" ]] || { echo "Cannot read ${CONFIG}" >&2; exit 1; }
    # websockify's TokenFile wants host:port, so add the default port
    TOKENS="${HERE}/.ikvm-tokens"
    : > "${TOKENS}"
    echo "BMCs:"
    while IFS= read -r line; do
        line="${line%%#*}"
        [[ "${line}" =~ ^[[:space:]]*([A-Za-z0-9_.-]+)[[:space:]]*:[[:space:]]*([^[:space:]]+)[[:space:]]*$ ]] || continue
        name="${BASH_REMATCH[1]}"; dest="${BASH_REMATCH[2]}"
        [[ "${dest}" == *:* ]] || dest="${dest}:5900"
        echo "${name}: ${dest}" >> "${TOKENS}"
        printf "  %-16s %s&path=websockify%%3Ftoken%%3D%s\n" "${name}" "${BASE}" "${name}"
    done < "${CONFIG}"
    [[ -s "${TOKENS}" ]] || { echo "No BMCs found in ${CONFIG}" >&2; exit 1; }
    echo
    exec "${VENV}/bin/websockify" --web "${HERE}" \
        --token-plugin TokenFile --token-source "${TOKENS}" \
        "${LISTEN}:${PORT}"
else
    [[ "${TARGET}" == *:* ]] || TARGET="${TARGET}:5900"
    echo "Open: ${BASE}"
    echo "Log in with the BMC's IPMI username and password."
    echo
    exec "${VENV}/bin/websockify" --web "${HERE}" "${LISTEN}:${PORT}" "${TARGET}"
fi
