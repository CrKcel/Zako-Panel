#!/usr/bin/env bash
#
# Checks that the installer accepts every `xray x25519` output format the
# supported Xray releases print.
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/reality-key.sh
. "${SCRIPT_DIR}/../lib/reality-key.sh"

failures=0

check() {
	local label="$1" expected="$2" actual="$3"
	if [[ "${actual}" != "${expected}" ]]; then
		printf 'FAIL %s: expected %q, got %q\n' "${label}" "${expected}" "${actual}" >&2
		failures=$((failures + 1))
	fi
}

current='PrivateKey: KMMMtD7TjPKqV6lCFdrHS7OWGF0inDBwjZOsxl9T81c
Password (PublicKey): ryMGS0Z0mHGkMfTQ0urR98HYoilUKMsO2y3oROyEzVg
Hash32: m0IFEo7vFkxNRG7sRsxmerqjVs-X3cooNdpzGJMkic0'
check current-private 'KMMMtD7TjPKqV6lCFdrHS7OWGF0inDBwjZOsxl9T81c' "$(parse_reality_private "${current}")"
check current-public 'ryMGS0Z0mHGkMfTQ0urR98HYoilUKMsO2y3oROyEzVg' "$(parse_reality_public "${current}")"

legacy='Private key: aaa
Public key: bbb'
check legacy-private 'aaa' "$(parse_reality_private "${legacy}")"
check legacy-public 'bbb' "$(parse_reality_public "${legacy}")"

check missing-public '' "$(parse_reality_public 'PrivateKey: only')"
check missing-private '' "$(parse_reality_private 'Password (PublicKey): only')"

if ((failures > 0)); then
	exit 1
fi
printf 'reality key parsing: ok\n'
