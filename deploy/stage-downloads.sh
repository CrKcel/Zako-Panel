#!/usr/bin/env bash
#
# Stage the files served by the assets-only downloads Worker.
#
# Usage: stage-downloads.sh --version <ver> --installer <file>
#        --artifacts <dir> --out <dir>
#
# The downloads Worker publishes one rolling version at stable URLs. The output
# only contains the current install.sh, SHA256SUMS, version and two archives.
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

log() {
	printf '[stage-downloads] %s\n' "$*"
}

die() {
	printf '[stage-downloads] error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: stage-downloads.sh --version <ver> --installer <file> \
         --artifacts <dir> --out <dir>

--version    Agent version embedded in the archives
--installer  Rendered network install.sh
--artifacts  Directory containing zako-agent-linux-amd64.tar.gz and
             zako-agent-linux-arm64.tar.gz
--out        Output directory for the downloads Worker assets
EOF
}

VERSION=""
INSTALLER=""
ARTIFACTS=""
OUT=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--version)
			VERSION="${2:-}"
			shift 2
			;;
		--installer)
			INSTALLER="${2:-}"
			shift 2
			;;
		--artifacts)
			ARTIFACTS="${2:-}"
			shift 2
			;;
		--out)
			OUT="${2:-}"
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			die "unknown argument: $1"
			;;
	esac
done

[[ -n "${VERSION}" ]] || die "--version is required"
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || die "invalid version ${VERSION}"
[[ -n "${INSTALLER}" && -f "${INSTALLER}" ]] || die "installer not found at ${INSTALLER}"
[[ -n "${ARTIFACTS}" && -d "${ARTIFACTS}" ]] || die "artifact directory not found at ${ARTIFACTS}"
[[ -n "${OUT}" && "${OUT}" != "/" && "${OUT}" != "." ]] || die "--out must be a directory below the filesystem root"
case "/${OUT}/" in
	*/../*) die "--out must not contain .. path components" ;;
esac

mkdir -p -- "$(dirname -- "${OUT}")"
OUT="$(cd -- "$(dirname -- "${OUT}")" && pwd)/$(basename -- "${OUT}")"
[[ "${OUT}" != "${REPO_ROOT}" ]] || die "--out must not be the repository root"

AMD64="${ARTIFACTS}/zako-agent-linux-amd64.tar.gz"
ARM64="${ARTIFACTS}/zako-agent-linux-arm64.tar.gz"
[[ -f "${AMD64}" ]] || die "missing ${AMD64}"
[[ -f "${ARM64}" ]] || die "missing ${ARM64}"
[[ -f "${REPO_ROOT}/apps/downloads/public/_headers" ]] || die "missing apps/downloads/public/_headers"

bash -n "${INSTALLER}"

CHECK_DIR="$(mktemp -d)"
STAGE_OUT=""
cleanup() {
	rm -rf "${CHECK_DIR}"
	if [[ -n "${STAGE_OUT}" && -e "${STAGE_OUT}" ]]; then
		rm -rf "${STAGE_OUT}"
	fi
}
trap cleanup EXIT

check_archive() {
	local archive="$1"
	local extract="${CHECK_DIR}/$(basename -- "${archive}")"
	rm -rf "${extract}"
	mkdir -p "${extract}"
	if ! tar -xzf "${archive}" -C "${extract}"; then
		return 1
	fi
	if [[ ! -x "${extract}/zako-agent/zako-agent" || ! -f "${extract}/zako-agent/VERSION" ]]; then
		return 1
	fi
	local embedded
	embedded="$(tr -d '\r\n' <"${extract}/zako-agent/VERSION")"
	[[ "${embedded}" == "${VERSION}" ]] || return 1
	return 0
}

check_archive "${AMD64}" || die "amd64 archive does not contain version ${VERSION}"
check_archive "${ARM64}" || die "arm64 archive does not contain version ${VERSION}"

# Build in a sibling directory so a failed run cannot leave a half-populated
# deployment target behind.
STAGE_OUT="${OUT}.tmp.$$"
rm -rf "${STAGE_OUT}"
mkdir -p "${STAGE_OUT}/dl/agent"
install -m 0644 "${REPO_ROOT}/apps/downloads/public/_headers" "${STAGE_OUT}/_headers"
install -m 0755 "${INSTALLER}" "${STAGE_OUT}/dl/agent/install.sh"
install -m 0644 "${AMD64}" "${STAGE_OUT}/dl/agent/zako-agent-linux-amd64.tar.gz"
install -m 0644 "${ARM64}" "${STAGE_OUT}/dl/agent/zako-agent-linux-arm64.tar.gz"
printf '%s\n' "${VERSION}" >"${STAGE_OUT}/dl/agent/version"
chmod 0644 "${STAGE_OUT}/dl/agent/version"

hash_files() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$@"
	else
		shasum -a 256 "$@"
	fi
}

verify_checksums() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum -c SHA256SUMS
	else
		shasum -a 256 -c SHA256SUMS
	fi
}

(
	cd "${STAGE_OUT}/dl/agent"
	hash_files install.sh zako-agent-linux-amd64.tar.gz zako-agent-linux-arm64.tar.gz >SHA256SUMS
	chmod 0644 SHA256SUMS
	verify_checksums >/dev/null
)

if [[ -n "$(find "${STAGE_OUT}" -type f \( -name token -o -name 'state.db*' -o -name reality.key -o -name .dev.vars \) -print -quit)" ]]; then
	die "staged assets contain a secret or state file"
fi

rm -rf "${OUT}"
mv "${STAGE_OUT}" "${OUT}"
STAGE_OUT=""

log "staged agent ${VERSION} at ${OUT}"
find "${OUT}" -type f | sort
