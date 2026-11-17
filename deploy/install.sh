#!/usr/bin/env bash
#
# zako-agent installer for Debian 12/13.
#
# Installs a prebuilt static binary, creates the service account and state
# directories, installs the systemd unit and enables it. The service is not
# started: a node token and validated config must be in place first.
#
# Usage: install.sh [path-to-zako-agent-binary]
#        ZAKO_AGENT_BINARY=/path/to/binary install.sh
set -euo pipefail
export LC_ALL=C

readonly SERVICE_USER="zako-agent"
readonly SERVICE_GROUP="zako-agent"
readonly BIN_PATH="/usr/local/bin/zako-agent"
readonly CONFIG_DIR="/etc/zako-agent"
readonly STATE_DIR="/var/lib/zako-agent"
readonly UNIT_PATH="/etc/systemd/system/zako-agent.service"
readonly TOKEN_PATH="${CONFIG_DIR}/token"
readonly CONFIG_PATH="${CONFIG_DIR}/config.yaml"
readonly REALITY_KEY="/etc/xray/reality.key"
readonly XRAY_CONFIG="/etc/xray/config.json"
readonly XRAY_BIN="${XRAY_BIN:-/usr/local/bin/xray}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=lib/reality-key.sh
. "${SCRIPT_DIR}/lib/reality-key.sh"

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
Usage: install.sh [path-to-zako-agent-binary]

Installs and enables zako-agent on Debian 12/13. The binary may be passed as the
first argument or via ZAKO_AGENT_BINARY. If omitted, the installer looks for
zako-agent next to this script, then for
apps/agent/bin/zako-agent-linux-<arch> in this repository.

The service is enabled and is not started by this script. Write the node token
issued by the panel to /etc/zako-agent/token and review
/etc/zako-agent/config.yaml first.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
	die "must be run as root"
fi
umask 077

if [[ ! -r /etc/os-release ]]; then
	die "cannot read /etc/os-release; Debian 12/13 is required"
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "debian" ]]; then
	die "unsupported distribution ${ID:-unknown}; Debian 12/13 is required"
fi
case "${VERSION_ID:-}" in
	12 | 13) ;;
	*) warn "Debian ${VERSION_ID:-unknown} is outside the tested 12/13 range" ;;
esac

case "$(uname -m)" in
	x86_64 | amd64) ARCH="amd64" ;;
	aarch64 | arm64) ARCH="arm64" ;;
	*) die "unsupported architecture $(uname -m); amd64 and arm64 are supported" ;;
esac

command -v systemctl >/dev/null 2>&1 || die "systemctl is required"

BINARY_SRC="${ZAKO_AGENT_BINARY:-${1:-}}"
if [[ -z "${BINARY_SRC}" ]]; then
	for candidate in \
		"${SCRIPT_DIR}/zako-agent" \
		"${SCRIPT_DIR}/zako-agent-linux-${ARCH}" \
		"${REPO_ROOT}/apps/agent/bin/zako-agent-linux-${ARCH}"; do
		if [[ -f "${candidate}" ]]; then
			BINARY_SRC="${candidate}"
			break
		fi
	done
fi
if [[ -z "${BINARY_SRC}" || ! -f "${BINARY_SRC}" ]]; then
	die "agent binary not found; run from an extracted release archive or build it with: cd apps/agent && CGO_ENABLED=0 GOOS=linux GOARCH=${ARCH} go build -trimpath -o bin/zako-agent-linux-${ARCH} ./cmd/zako-agent"
fi

# Replace the binary through a same-directory temporary file so an upgrade cannot
# write into the inode of an agent that is still running.
TMP_BIN="${BIN_PATH}.new.$$"
cleanup_binary() {
	if [[ -e "${TMP_BIN}" ]]; then
		rm -f "${TMP_BIN}"
	fi
}
trap cleanup_binary EXIT
install -m 0755 -o root -g root "${BINARY_SRC}" "${TMP_BIN}"
mv -f "${TMP_BIN}" "${BIN_PATH}"
trap - EXIT
log "installed ${BIN_PATH} from ${BINARY_SRC} (${ARCH})"

if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
	groupadd --system "${SERVICE_GROUP}"
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
	useradd --system \
		--gid "${SERVICE_GROUP}" \
		--home-dir "${STATE_DIR}" \
		--no-create-home \
		--shell /usr/sbin/nologin \
		"${SERVICE_USER}"
fi

install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${CONFIG_DIR}" "${STATE_DIR}"

if [[ -e "${CONFIG_PATH}" ]]; then
	log "preserving existing ${CONFIG_PATH}"
else
	config_example=""
	for candidate in \
		"${SCRIPT_DIR}/zako-agent.example.yaml" \
		"${SCRIPT_DIR}/config.example.yaml" \
		"${REPO_ROOT}/apps/agent/config.example.yaml"; do
		if [[ -f "${candidate}" ]]; then
			config_example="${candidate}"
			break
		fi
	done
	if [[ -n "${config_example}" ]]; then
		install -m 0640 -o root -g "${SERVICE_GROUP}" "${config_example}" "${CONFIG_PATH}"
		log "installed config example ${config_example} to ${CONFIG_PATH}"
	else
		warn "no config example found; create ${CONFIG_PATH} before starting the service"
	fi
fi

if [[ ! -e "${TOKEN_PATH}" ]]; then
	install -m 0600 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" /dev/null "${TOKEN_PATH}"
fi
if [[ ! -s "${TOKEN_PATH}" ]]; then
	warn "no agent token in ${TOKEN_PATH}; write the token issued by the panel before starting"
fi

if [[ ! -f "${SCRIPT_DIR}/systemd/zako-agent.service" ]]; then
	die "systemd unit not found at ${SCRIPT_DIR}/systemd/zako-agent.service"
fi
install -m 0644 -o root -g root "${SCRIPT_DIR}/systemd/zako-agent.service" "${UNIT_PATH}"
systemctl daemon-reload
systemctl enable zako-agent.service
log "installed and enabled zako-agent.service (not started)"

if [[ -x "${XRAY_BIN}" ]]; then
	install -d -m 0755 /etc/xray
	if [[ -e "${REALITY_KEY}" ]]; then
		log "preserving existing ${REALITY_KEY}"
	else
		if ! keypair="$("${XRAY_BIN}" x25519)"; then
			die "xray x25519 failed; REALITY key was not generated"
		fi
		private_key="$(parse_reality_private "${keypair}")"
		public_key="$(parse_reality_public "${keypair}")"
		if [[ -z "${private_key}" || -z "${public_key}" ]]; then
			die "could not parse xray x25519 output; REALITY key was not written"
		fi
		(umask 077; printf '%s\n' "${private_key}" >"${REALITY_KEY}")
		chown "${SERVICE_USER}:${SERVICE_GROUP}" "${REALITY_KEY}"
		chmod 0600 "${REALITY_KEY}"
		log "wrote REALITY private key to ${REALITY_KEY} (0600, ${SERVICE_USER})"
		printf 'REALITY public key: %s\n' "${public_key}"
	fi

	# P0 has no remote config delivery, so the static inbound is materialised from
	# the shipped template. Client credentials stay placeholders: the operator
	# copies them from the panel's node credential list.
	xray_template="${SCRIPT_DIR}/xray/config.example.json"
	xray_renderer="${SCRIPT_DIR}/xray/render-config.py"
	if [[ ! -f "${xray_template}" ]]; then
		warn "xray config template not found at ${xray_template}; create ${XRAY_CONFIG} manually"
	elif [[ -e "${XRAY_CONFIG}" ]]; then
		log "preserving existing ${XRAY_CONFIG}"
	elif [[ ! -s "${REALITY_KEY}" ]]; then
		warn "REALITY key is empty; ${XRAY_CONFIG} was not generated"
	elif ! command -v python3 >/dev/null 2>&1; then
		warn "python3 is required to render ${XRAY_CONFIG}; create it manually from ${xray_template}"
	elif ! short_id="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"; then
		die "could not generate a REALITY short id"
	else
		python3 "${xray_renderer}" "${xray_template}" "${XRAY_CONFIG}" "$(head -n 1 "${REALITY_KEY}")" "${short_id}"
		chown root:"${SERVICE_GROUP}" "${XRAY_CONFIG}"
		chmod 0640 "${XRAY_CONFIG}"
		log "wrote ${XRAY_CONFIG} with the REALITY private key (0640)"
		printf 'REALITY short id: %s\n' "${short_id}"
		printf 'Copy xray_email and UUID from the node credential list into %s\n' "${XRAY_CONFIG}"
	fi
else
	warn "xray not found at ${XRAY_BIN}; skipped REALITY key and Xray config generation"
fi

if systemctl is-active --quiet zako-agent.service; then
	start_hint="zako-agent.service is running; restart it to use the new binary: systemctl restart zako-agent"
else
	start_hint="Start with: systemctl start zako-agent"
fi

cat <<EOF

zako-agent is installed and enabled.
Next steps:
  1. Write the node token issued by the panel to ${TOKEN_PATH}.
     Keep the file owned by ${SERVICE_USER} and mode 0600.
  2. Review ${CONFIG_PATH}; control_plane_url, node_id and Xray paths are required.
  3. ${start_hint}
  4. Follow logs with: journalctl -u zako-agent -f
EOF
