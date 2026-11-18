#!/usr/bin/env bash
#
# Build the installable agent archive for one Linux architecture.
#
# Usage: package-release.sh <version> <amd64|arm64> <binary> <outdir>
#
# The archive has a stable top-level directory so the rolling release never
# encodes the version in a download URL.
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

log() {
	printf '[package-release] %s\n' "$*"
}

die() {
	printf '[package-release] error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: package-release.sh <version> <amd64|arm64> <binary> <outdir>

Packages the agent binary, install.sh, config example, systemd unit, polkit rule
and Xray templates as <outdir>/zako-agent-linux-<arch>.tar.gz. The archive
top-level directory is always zako-agent/.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi
if [[ $# -ne 4 ]]; then
	usage >&2
	exit 2
fi

VERSION="$1"
ARCH="$2"
BINARY_SRC="$3"
OUTDIR="$4"

case "${ARCH}" in
	amd64 | arm64) ;;
	*) die "unsupported architecture ${ARCH}; use amd64 or arm64" ;;
esac
[[ -n "${VERSION}" ]] || die "version is required"
[[ -f "${BINARY_SRC}" ]] || die "agent binary not found at ${BINARY_SRC}"

mkdir -p "${OUTDIR}"
OUTDIR="$(cd -- "${OUTDIR}" && pwd)"

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
ROOT="${STAGE}/zako-agent"
mkdir -p "${ROOT}/systemd" "${ROOT}/lib" "${ROOT}/xray" "${ROOT}/polkit"

install -m 0755 "${BINARY_SRC}" "${ROOT}/zako-agent"
install -m 0755 "${REPO_ROOT}/deploy/install.sh" "${ROOT}/install.sh"
install -m 0755 "${REPO_ROOT}/deploy/uninstall.sh" "${ROOT}/uninstall.sh"
install -m 0644 "${REPO_ROOT}/apps/agent/config.example.yaml" "${ROOT}/config.example.yaml"
install -m 0755 "${REPO_ROOT}/deploy/lib/reality-key.sh" "${ROOT}/lib/reality-key.sh"
install -m 0755 "${REPO_ROOT}/deploy/lib/install-xray.sh" "${ROOT}/lib/install-xray.sh"
install -m 0644 "${REPO_ROOT}/deploy/systemd/zako-agent.service" "${ROOT}/systemd/zako-agent.service"
install -m 0644 "${REPO_ROOT}/deploy/systemd/zako-agent-uninstall.service" "${ROOT}/systemd/zako-agent-uninstall.service"
install -m 0644 "${REPO_ROOT}/deploy/polkit/50-zako-agent-xray.rules" "${ROOT}/polkit/50-zako-agent-xray.rules"
install -m 0644 "${REPO_ROOT}/deploy/xray/config.example.json" "${ROOT}/xray/config.example.json"
install -m 0755 "${REPO_ROOT}/deploy/xray/render-config.py" "${ROOT}/xray/render-config.py"
printf '%s\n' "${VERSION}" >"${ROOT}/VERSION"
chmod 0644 "${ROOT}/VERSION"

ARCHIVE="${OUTDIR}/zako-agent-linux-${ARCH}.tar.gz"
tar -C "${STAGE}" -czf "${ARCHIVE}" zako-agent
log "wrote ${ARCHIVE}"
