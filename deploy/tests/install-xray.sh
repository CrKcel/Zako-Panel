#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

log() { printf '[test] %s\n' "$*"; }
warn() { printf '[test] warn: %s\n' "$*" >&2; }
die() { printf '[test] error: %s\n' "$*" >&2; exit 1; }

# shellcheck source=../lib/install-xray.sh
. "${REPO_ROOT}/deploy/lib/install-xray.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

[[ "$(xray_arch_name amd64)" == "64" ]] || die "amd64 arch mapping failed"
[[ "$(xray_arch_name arm64)" == "arm64-v8a" ]] || die "arm64 arch mapping failed"

cat >"${TMP}/sample.dgst" <<'EOF'
MD5 = 1111
SHA1 = 2222
SHA2-256 = ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789
EOF
parsed="$(xray_parse_dgst_sha256 "${TMP}/sample.dgst")"
[[ "${parsed}" == "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" ]] || die "dgst parse failed: ${parsed}"

log "install-xray tests passed"
