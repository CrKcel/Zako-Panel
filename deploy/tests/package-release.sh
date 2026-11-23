#!/usr/bin/env bash
#
# Verifies the agent archive contract used by install.sh.
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

VERSION="9.9.9"
ARCH="amd64"
BINARY="${TMP}/zako-agent"
cat >"${BINARY}" <<'EOF'
#!/bin/sh
printf 'zako-agent 9.9.9 (linux/amd64)\n'
EOF
chmod 0755 "${BINARY}"

OUT="${TMP}/out"
mkdir -p "${OUT}"
"${REPO_ROOT}/deploy/package-release.sh" "${VERSION}" "${ARCH}" "${BINARY}" "${OUT}"

ARCHIVE="${OUT}/zako-agent-linux-${ARCH}.tar.gz"
[[ -f "${ARCHIVE}" ]] || {
	printf 'missing archive %s\n' "${ARCHIVE}" >&2
	exit 1
}

LISTING="${TMP}/listing"
tar -tzf "${ARCHIVE}" >"${LISTING}"
for expected in \
	zako-agent/ \
	zako-agent/zako-agent \
	zako-agent/install.sh \
	zako-agent/config.example.yaml \
	zako-agent/systemd/zako-agent.service \
	zako-agent/polkit/50-zako-agent-xray.rules \
	zako-agent/lib/reality-key.sh \
	zako-agent/VERSION; do
	if ! grep -Fxq "${expected}" "${LISTING}"; then
		printf 'archive is missing %s\n' "${expected}" >&2
		exit 1
	fi
done

if grep -Eq '(^|/)(token|state\.db|reality\.key|\.dev\.vars)$' "${LISTING}"; then
	printf 'archive contains a secret or state file\n' >&2
	exit 1
fi

EXTRACT="${TMP}/extract"
mkdir -p "${EXTRACT}"
tar -xzf "${ARCHIVE}" -C "${EXTRACT}"
[[ -x "${EXTRACT}/zako-agent/zako-agent" ]] || {
	printf 'agent binary is not executable\n' >&2
	exit 1
}
[[ -x "${EXTRACT}/zako-agent/install.sh" ]] || {
	printf 'install.sh is not executable\n' >&2
	exit 1
}
[[ "$(tr -d '\r\n' <"${EXTRACT}/zako-agent/VERSION")" == "${VERSION}" ]] || {
	printf 'VERSION does not match\n' >&2
	exit 1
}
bash -n "${EXTRACT}/zako-agent/install.sh"

printf 'package-release test passed\n'
