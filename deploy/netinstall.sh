#!/usr/bin/env bash
#
# Network installer served at /dl/agent/install.sh.
#
# The release workflow replaces __AGENT_BASE_URL__ with the public download
# base. The script always installs the current rolling release and verifies the
# archive with the SHA256SUMS published in the same Worker version.
set -euo pipefail
export LC_ALL=C
umask 077

BASE_URL="__AGENT_BASE_URL__"

log() {
	printf '[zako-agent] %s\n' "$*"
}

warn() {
	printf '[zako-agent] warning: %s\n' "$*" >&2
}

die() {
	printf '[zako-agent] error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: install.sh [--base-url <https://panel.example.com/dl/agent>] --panel <https://panel.example.com> --token <enrollment_token> [options]

Downloads the current zako-agent release from the panel, verifies its SHA-256
checksum and runs the bundled installer. Run as root.

Automatically installs Xray if missing, enrolls the node with the panel, writes
configuration files, and starts xray and zako-agent services. On an
already-enrolled node, omit --panel and --token to upgrade in place.

Options:
  --base-url <url>     Override the agent download base URL
  --panel <url>        Control plane HTTPS URL for node enrollment
  --token <token>      One-time enrollment token issued by the panel
  --name <name>        Node name (defaults to hostname)
  --host <host>        Public IP or domain (auto-detected if omitted)
  --port <port>        Override VLESS port
  --sni <sni>          Override REALITY SNI
  --xray-mirror <url>  Override Xray-core download base URL
EOF
}

PASSTHROUGH_ARGS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--base-url)
			BASE_URL="${2:-}"
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			PASSTHROUGH_ARGS+=("$1")
			shift
			;;
	esac
done

if [[ "${EUID}" -ne 0 ]]; then
	die "must be run as root; use: curl -fsSL <url> | sudo bash -s"
fi

BASE_URL="${BASE_URL%/}"
while [[ "${BASE_URL}" == */ ]]; do
	BASE_URL="${BASE_URL%/}"
done
if [[ -z "${BASE_URL}" || "${BASE_URL}" == "__AGENT_BASE_"*"URL__" ]]; then
	die "this installer was not published with a download base URL; pass --base-url"
fi
if [[ ! "${BASE_URL}" =~ ^https://[A-Za-z0-9._~:/@!$+,=%-]+$ ]]; then
	die "download base URL must be an https URL without query parameters"
fi

for command_name in tar mktemp; do
	command -v "${command_name}" >/dev/null 2>&1 || die "${command_name} is required"
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
	die "curl or wget is required"
fi
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
	die "sha256sum or shasum is required"
fi

case "$(uname -m)" in
	x86_64 | amd64) ARCH="amd64" ;;
	aarch64 | arm64) ARCH="arm64" ;;
	*) die "unsupported architecture $(uname -m); amd64 and arm64 are supported" ;;
esac

fetch_to() {
	local url="$1"
	local dest="$2"
	if command -v curl >/dev/null 2>&1; then
		curl --proto '=https' --tlsv1.2 -fsSL "${url}" -o "${dest}"
	else
		wget --https-only -qO "${dest}" "${url}"
	fi
}

fetch_text() {
	local url="$1"
	if command -v curl >/dev/null 2>&1; then
		curl --proto '=https' --tlsv1.2 -fsSL "${url}"
	else
		wget --https-only -qO- "${url}"
	fi
}

verify_checksum_line() {
	local dir="$1"
	local line_file="$2"
	if command -v sha256sum >/dev/null 2>&1; then
		(cd "${dir}" && sha256sum -c "${line_file}")
	else
		(cd "${dir}" && shasum -a 256 -c "${line_file}")
	fi
}

try_install() {
	local tmp="$1"
	local version line stage embedded output

	version="$(fetch_text "${BASE_URL}/version" | tr -d '\r\n')" || return 1
	[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || return 1

	fetch_to "${BASE_URL}/SHA256SUMS" "${tmp}/SHA256SUMS" || return 1
	fetch_to "${BASE_URL}/zako-agent-linux-${ARCH}.tar.gz" "${tmp}/zako-agent-linux-${ARCH}.tar.gz" || return 1

	line="$(grep -E "[[:space:]]zako-agent-linux-${ARCH}\.tar\.gz$" "${tmp}/SHA256SUMS" || true)"
	[[ -n "${line}" ]] || return 1
	printf '%s\n' "${line}" >"${tmp}/CHECKSUM"
	verify_checksum_line "${tmp}" CHECKSUM >/dev/null || return 1

	mkdir -p "${tmp}/extract" || return 1
	tar -xzf "${tmp}/zako-agent-linux-${ARCH}.tar.gz" -C "${tmp}/extract" || return 1
	stage="${tmp}/extract/zako-agent"
	[[ -x "${stage}/zako-agent" && -f "${stage}/VERSION" && -x "${stage}/install.sh" ]] || return 1

	embedded="$(tr -d '\r\n' <"${stage}/VERSION")"
	[[ "${embedded}" == "${version}" ]] || return 1
	output="$("${stage}/zako-agent" --version)" || return 1
	[[ "${output}" == *"${version}"* && "${output}" == *"linux/${ARCH}"* ]] || return 1

	printf '%s\n' "${version}" >"${tmp}/RESOLVED_VERSION"
	printf '%s\n' "${stage}" >"${tmp}/STAGE_DIR"
	return 0
}

success=0
for attempt in 1 2; do
	tmp="$(mktemp -d)"
	if try_install "${tmp}"; then
		success=1
		break
	fi
	rm -rf "${tmp}"
	if [[ "${attempt}" -eq 1 ]]; then
		warn "download or checksum mismatch; retrying once in case a release is in progress"
	fi
done
[[ "${success}" -eq 1 ]] || die "could not download a consistent agent release; retry later"

VERSION="$(tr -d '\r\n' <"${tmp}/RESOLVED_VERSION")"
STAGE="$(cat "${tmp}/STAGE_DIR")"
trap 'rm -rf "${tmp}"' EXIT

log "installing zako-agent ${VERSION} (linux/${ARCH}) from ${BASE_URL}"
"${STAGE}/install.sh" "${STAGE}/zako-agent" "${PASSTHROUGH_ARGS[@]}"
