#!/usr/bin/env bash
#
# zako-agent installer for Debian 12/13.
#
# Installs Xray-core (if missing) and the prebuilt zako-agent binary, creates
# the service account and state directories, installs the systemd units, and
# enrolls the node with the control plane using --panel and --token.
# On an already-enrolled node, running without --panel/--token upgrades the
# binary and systemd units in place while preserving existing configuration.
#
# Usage: install.sh [path-to-zako-agent-binary] --panel <url> --token <token> [options]
#        ZAKO_AGENT_BINARY=/path/to/binary install.sh --panel <url> --token <token> [options]
set -euo pipefail
export LC_ALL=C

readonly SERVICE_USER="zako-agent"
readonly SERVICE_GROUP="zako-agent"
readonly BIN_PATH="/usr/local/bin/zako-agent"
readonly CONFIG_DIR="/etc/zako-agent"
readonly STATE_DIR="/var/lib/zako-agent"
readonly UNIT_PATH="/etc/systemd/system/zako-agent.service"
readonly UNINSTALL_UNIT_PATH="/etc/systemd/system/zako-agent-uninstall.service"
readonly UPDATE_UNIT_PATH="/etc/systemd/system/zako-agent-update.service"
readonly POLKIT_RULE="/etc/polkit-1/rules.d/50-zako-agent-xray.rules"
readonly TOKEN_PATH="${CONFIG_DIR}/token"
readonly CONFIG_PATH="${CONFIG_DIR}/config.yaml"
readonly XRAY_DIR="/etc/xray"
readonly REALITY_KEY="${XRAY_DIR}/reality.key"
XRAY_CONFIG="${XRAY_DIR}/config.json"
readonly XRAY_BIN="${XRAY_BIN:-/usr/local/bin/xray}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=lib/reality-key.sh
. "${SCRIPT_DIR}/lib/reality-key.sh"
# shellcheck source=lib/install-xray.sh
. "${SCRIPT_DIR}/lib/install-xray.sh"

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

# The agent replaces config.json through a same-directory temporary file and a
# rename, which needs write permission on the directory rather than on the file.
# Xray runs as root, so group ownership by the agent's group is enough.
ensure_xray_dir() {
	if [[ ! -d "${XRAY_DIR}" ]]; then
		install -d -m 0770 -o root -g "${SERVICE_GROUP}" "${XRAY_DIR}"
		return
	fi
	if [[ "$(stat -c '%G' "${XRAY_DIR}")" != "${SERVICE_GROUP}" ]]; then
		chgrp "${SERVICE_GROUP}" "${XRAY_DIR}"
	fi
	chmod 0770 "${XRAY_DIR}"
}

usage() {
	cat <<'EOF'
Usage: install.sh [path-to-zako-agent-binary] --panel <url> --token <token> [options]

Installs and enrolls zako-agent on Debian 12/13, and automatically installs
Xray-core if missing. Re-running without --panel/--token on an already-enrolled
node upgrades the binary and systemd units in place.

Options:
  --panel <url>        Control plane HTTPS URL for node enrollment
  --token <token>      One-time enrollment token issued by the panel
  --name <name>        Node name (defaults to hostname)
  --host <host>        Public IP or domain (auto-detected if omitted)
  --xray-mirror <url>  Override Xray-core download base URL

Existing Xray/V2Ray configuration is adopted as-is: VLESS + REALITY inbounds
become panel endpoints and other protocols are left untouched. A node without a
configuration receives the default template.
EOF
}

BINARY_ARG=""
PANEL_URL=""
ENROLL_TOKEN=""
NODE_NAME=""
NODE_HOST=""
XRAY_MIRROR="${XRAY_MIRROR:-}"

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--panel)
			PANEL_URL="${2:-}"
			shift 2
			;;
		--token)
			ENROLL_TOKEN="${2:-}"
			shift 2
			;;
		--name)
			NODE_NAME="${2:-}"
			shift 2
			;;
		--host)
			NODE_HOST="${2:-}"
			shift 2
			;;
		--xray-mirror)
			XRAY_MIRROR="${2:-}"
			shift 2
			;;
		-*)
			die "unknown option: $1"
			;;
		*)
			if [[ -z "${BINARY_ARG}" ]]; then
				BINARY_ARG="$1"
			else
				die "unexpected argument: $1"
			fi
			shift
			;;
	esac
done

if [[ -n "${PANEL_URL}" && -z "${ENROLL_TOKEN}" ]] || [[ -z "${PANEL_URL}" && -n "${ENROLL_TOKEN}" ]]; then
	die "--panel and --token must be provided together"
fi
if [[ -z "${PANEL_URL}" && -z "${ENROLL_TOKEN}" ]]; then
	if [[ ! -s "${TOKEN_PATH}" || ! -s "${CONFIG_PATH}" ]]; then
		die "--panel and --token are required for new node deployment (generate a one-time deployment command in the panel)"
	fi
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

BINARY_SRC="${ZAKO_AGENT_BINARY:-${BINARY_ARG:-}}"
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

if [[ ! -f "${SCRIPT_DIR}/systemd/zako-agent.service" ]]; then
	die "systemd unit not found at ${SCRIPT_DIR}/systemd/zako-agent.service"
fi
install -m 0644 -o root -g root "${SCRIPT_DIR}/systemd/zako-agent.service" "${UNIT_PATH}"
if [[ -f "${SCRIPT_DIR}/systemd/zako-agent-uninstall.service" ]]; then
	install -m 0644 -o root -g root "${SCRIPT_DIR}/systemd/zako-agent-uninstall.service" "${UNINSTALL_UNIT_PATH}"
fi
if [[ -f "${SCRIPT_DIR}/systemd/zako-agent-update.service" ]]; then
	install -m 0644 -o root -g root "${SCRIPT_DIR}/systemd/zako-agent-update.service" "${UPDATE_UNIT_PATH}"
fi

# Ensure polkitd is present so /etc/polkit-1/rules.d exists and the unprivileged
# agent can authorize xray restarts, self-updates, and remote uninstalls.
ensure_polkit_installed() {
	if [[ -d /etc/polkit-1/rules.d ]]; then
		return 0
	fi
	if ! command -v apt-get >/dev/null 2>&1; then
		die "/etc/polkit-1/rules.d is missing and apt-get is unavailable; install polkitd first"
	fi
	log "installing polkitd for systemd unit authorization"
	DEBIAN_FRONTEND=noninteractive apt-get update -qq || die "apt-get update failed while installing polkitd"
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq polkitd || die "failed to install polkitd"
	if [[ ! -d /etc/polkit-1/rules.d ]]; then
		die "/etc/polkit-1/rules.d is still missing after installing polkitd"
	fi
}

# The agent applies user sets through HandlerService and restarts xray.service only
# when a hot update fails. The unit runs unprivileged, so the restart is authorized
# by a polkit rule limited to that one unit instead of a sudoers entry or root.
polkit_rule="${SCRIPT_DIR}/polkit/50-zako-agent-xray.rules"
if [[ ! -f "${polkit_rule}" ]]; then
	die "polkit rule not found at ${polkit_rule}"
fi
ensure_polkit_installed
install -d -m 0755 /etc/polkit-1/rules.d
install -m 0644 -o root -g root "${polkit_rule}" "${POLKIT_RULE}"
log "installed ${POLKIT_RULE} (zako-agent may restart xray, update, and uninstall)"

systemctl daemon-reload
systemctl enable zako-agent.service
log "installed and enabled zako-agent.service (not started)"

# Common installation layouts of Xray and V2Ray. A config found in one of them is
# adopted instead of the default /etc/xray layout, so the shipped unit starts the
# document the node actually uses.
discover_xray_config() {
	local candidate
	for candidate in \
		"/etc/xray/config.json" \
		"/usr/local/etc/xray/config.json" \
		"/etc/v2ray/config.json" \
		"/usr/local/etc/v2ray/config.json"; do
		if [[ -f "${candidate}" ]]; then
			printf '%s\n' "${candidate}"
			return 0
		fi
	done
	printf '%s\n' "${XRAY_DIR}/config.json"
}

# The agent replaces config.json through a same-directory temporary file, so the
# directory of an adopted config also has to be writable by the service group.
# Existing access bits are kept: other services may still read the same directory.
ensure_config_dir() {
	local config_path="$1"
	local config_dir
	config_dir="$(dirname -- "${config_path}")"
	if [[ ! -d "${config_dir}" ]]; then
		install -d -m 0770 -o root -g "${SERVICE_GROUP}" "${config_dir}"
		return
	fi
	if [[ "$(stat -c '%G' "${config_dir}")" != "${SERVICE_GROUP}" ]]; then
		chgrp "${SERVICE_GROUP}" "${config_dir}"
	fi
	chmod g+rwx "${config_dir}"
}

XRAY_CONFIG="$(discover_xray_config)"
ensure_xray_installed "${XRAY_BIN}" "${ARCH}" "${XRAY_MIRROR:-${XRAY_DEFAULT_MIRROR}}" "${XRAY_CONFIG}"

detect_public_ip() {
	local ip=""
	for url in "https://api.ipify.org" "https://ifconfig.me/ip"; do
		if command -v curl >/dev/null 2>&1; then
			ip="$(curl --proto '=https' --tlsv1.2 -fsS --max-time 8 "${url}" 2>/dev/null | tr -d '[:space:]' || true)"
		elif command -v wget >/dev/null 2>&1; then
			ip="$(wget --https-only -qO- --timeout=8 "${url}" 2>/dev/null | tr -d '[:space:]' || true)"
		fi
		if [[ -n "${ip}" ]]; then
			printf '%s\n' "${ip}"
			return 0
		fi
	done
	return 1
}

if [[ -x "${XRAY_BIN}" ]]; then
	ensure_xray_dir
	ensure_config_dir "${XRAY_CONFIG}"
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
	fi

	if [[ -n "${PANEL_URL}" && -n "${ENROLL_TOKEN}" ]]; then
		if [[ -z "${NODE_HOST}" ]]; then
			NODE_HOST="$(detect_public_ip)" || die "could not auto-detect public IP; pass --host <ip_or_domain>"
			log "detected public host: ${NODE_HOST}"
		fi
		xray_ver="$("${XRAY_BIN}" version 2>/dev/null | head -n 1 | awk '{print $2}' || true)"
		init_args=(
			init
			--panel "${PANEL_URL}"
			--token "${ENROLL_TOKEN}"
			--host "${NODE_HOST}"
			--config "${CONFIG_PATH}"
			--token-file "${TOKEN_PATH}"
			--reality-key "${REALITY_KEY}"
			--xray-config "${XRAY_CONFIG}"
			--xray-bin "${XRAY_BIN}"
		)
		if [[ -n "${NODE_NAME}" ]]; then
			init_args+=(--name "${NODE_NAME}")
		fi
		if [[ -n "${xray_ver}" ]]; then
			init_args+=(--xray-version "${xray_ver}")
		fi

		log "enrolling node with ${PANEL_URL}"
		init_json="$("${BIN_PATH}" "${init_args[@]}")" || die "node enrollment failed"
		chown "${SERVICE_USER}:${SERVICE_GROUP}" "${TOKEN_PATH}"
		chmod 0600 "${TOKEN_PATH}"
		chown root:"${SERVICE_GROUP}" "${CONFIG_PATH}"
		chmod 0640 "${CONFIG_PATH}"

		enrolled_node_id="$(printf '%s' "${init_json}" | sed -n 's/.*"node_id":"\([^"]*\)".*/\1/p')"
		enrolled_endpoints="$(printf '%s' "${init_json}" | sed -n 's/.*"endpoint_count":\([0-9]*\).*/\1/p')"
		enrolled_config="$(printf '%s' "${init_json}" | sed -n 's/.*"xray_config_path":"\([^"]*\)".*/\1/p')"
		enrolled_created="$(printf '%s' "${init_json}" | sed -n 's/.*"created_config":\(true\|false\).*/\1/p')"

		chown root:"${SERVICE_GROUP}" "${XRAY_CONFIG}"
		chmod 0640 "${XRAY_CONFIG}"
		if [[ "${enrolled_created}" == "true" ]]; then
			log "created ${enrolled_config} from the default template"
		else
			log "adopted ${enrolled_config} (${enrolled_endpoints:-1} managed endpoint(s))"
		fi

		systemctl restart xray.service
		systemctl restart zako-agent.service
		cat <<EOF

Node enrolled and started!
  node_id:   ${enrolled_node_id}
  host:      ${NODE_HOST}
  config:    ${enrolled_config}
  endpoints: ${enrolled_endpoints:-1}
  logs:      journalctl -u zako-agent -f
EOF
		exit 0
	fi
else
	warn "xray not found at ${XRAY_BIN}; skipped REALITY key generation"
fi

if systemctl is-active --quiet zako-agent.service; then
	log "zako-agent upgraded; restart to use the new binary: systemctl restart zako-agent"
else
	log "zako-agent upgraded; start with: systemctl start zako-agent"
fi
