#!/usr/bin/env bash
#
# Standalone zako-agent uninstaller for Debian 12/13.
#
# Prefer `sudo zako-agent uninstall` when the binary is intact; this script serves
# as a fallback if the binary is missing or damaged.
set -euo pipefail
export LC_ALL=C

REMOVE_XRAY=0
LOCAL_ONLY=0
CONFIG_PATH="/etc/zako-agent/config.yaml"

usage() {
	cat <<'EOF'
Usage: uninstall.sh [options]

Stops and removes zako-agent from the node. Run as root.

Options:
  --remove-xray      Also stop and remove Xray-core and /etc/xray
  --local-only       Skip notifying the control plane
  --config <path>    Path to config.yaml (default: /etc/zako-agent/config.yaml)
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--remove-xray)
			REMOVE_XRAY=1
			shift
			;;
		--local-only)
			LOCAL_ONLY=1
			shift
			;;
		--config)
			CONFIG_PATH="${2:-}"
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			printf '[zako-agent] error: unknown option: %s\n' "$1" >&2
			exit 1
			;;
	esac
done

if [[ "${EUID}" -ne 0 ]]; then
	printf '[zako-agent] error: must be run as root\n' >&2
	exit 1
fi

if [[ -x /usr/local/bin/zako-agent ]]; then
	args=(uninstall --config "${CONFIG_PATH}" --yes)
	if [[ "${REMOVE_XRAY}" -eq 1 ]]; then
		args+=(--remove-xray)
	fi
	if [[ "${LOCAL_ONLY}" -eq 1 ]]; then
		args+=(--local-only)
	fi
	exec /usr/local/bin/zako-agent "${args[@]}"
fi

systemctl stop zako-agent.service 2>/dev/null || true
systemctl disable zako-agent.service 2>/dev/null || true

if [[ "${REMOVE_XRAY}" -eq 1 ]]; then
	systemctl stop xray.service 2>/dev/null || true
	systemctl disable xray.service 2>/dev/null || true
	rm -f /etc/systemd/system/xray.service /usr/local/bin/xray
	rm -rf /usr/local/share/xray /etc/xray
fi

rm -f /etc/systemd/system/zako-agent.service \
	/etc/systemd/system/zako-agent-uninstall.service \
	/etc/systemd/system/zako-agent-update.service \
	/etc/polkit-1/rules.d/50-zako-agent-xray.rules \
	/usr/local/bin/zako-agent \
	/usr/local/bin/zako-agent.bak
rm -rf "$(dirname -- "${CONFIG_PATH}")" /var/lib/zako-agent

systemctl daemon-reload 2>/dev/null || true

if [[ "${REMOVE_XRAY}" -eq 1 || ! -f /etc/systemd/system/xray.service ]]; then
	userdel zako-agent 2>/dev/null || true
	groupdel zako-agent 2>/dev/null || true
fi

printf '[zako-agent] uninstall complete\n'
