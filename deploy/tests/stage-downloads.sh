#!/usr/bin/env bash
#
# Verifies the rolling download asset layout and its checksum invariants.
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

ARTIFACTS="${TMP}/artifacts"
mkdir -p "${ARTIFACTS}"
"${REPO_ROOT}/deploy/package-release.sh" "${VERSION}" amd64 "${BINARY}" "${ARTIFACTS}"
"${REPO_ROOT}/deploy/package-release.sh" "${VERSION}" arm64 "${BINARY}" "${ARTIFACTS}"

INSTALLER="${TMP}/install.sh"
sed "s|__AGENT_BASE_URL__|https://panel.example.com/dl/agent|g" "${REPO_ROOT}/deploy/netinstall.sh" >"${INSTALLER}"
chmod 0755 "${INSTALLER}"
bash -n "${INSTALLER}"
if grep -q '__AGENT_BASE_URL__' "${INSTALLER}"; then
	printf 'installer still contains the base URL placeholder\n' >&2
	exit 1
fi

OUT="${TMP}/out"
"${REPO_ROOT}/deploy/stage-downloads.sh" \
	--version "${VERSION}" \
	--installer "${INSTALLER}" \
	--artifacts "${ARTIFACTS}" \
	--out "${OUT}"

for expected in \
	_headers \
	dl/agent/install.sh \
	dl/agent/SHA256SUMS \
	dl/agent/version \
	dl/agent/zako-agent-linux-amd64.tar.gz \
	dl/agent/zako-agent-linux-arm64.tar.gz; do
	if [[ ! -f "${OUT}/${expected}" ]]; then
		printf 'staged output is missing %s\n' "${expected}" >&2
		exit 1
	fi
done

if [[ -e "${OUT}/dl/agent/latest" || -d "${OUT}/dl/agent/v${VERSION}" ]]; then
	printf 'staged output contains a versioned path or latest pointer\n' >&2
	exit 1
fi

[[ "$(tr -d '\r\n' <"${OUT}/dl/agent/version")" == "${VERSION}" ]] || {
	printf 'version file does not match\n' >&2
	exit 1
}
cmp -s "${INSTALLER}" "${OUT}/dl/agent/install.sh" || {
	printf 'staged installer differs from the rendered installer\n' >&2
	exit 1
}

verify_checksums() {
	local dir="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		(cd "${dir}" && sha256sum -c SHA256SUMS >/dev/null)
	else
		(cd "${dir}" && shasum -a 256 -c SHA256SUMS >/dev/null)
	fi
}
verify_checksums "${OUT}/dl/agent"

for arch in amd64 arm64; do
	extract="${TMP}/extract-${arch}"
	mkdir -p "${extract}"
	tar -xzf "${OUT}/dl/agent/zako-agent-linux-${arch}.tar.gz" -C "${extract}"
	[[ "$(tr -d '\r\n' <"${extract}/zako-agent/VERSION")" == "${VERSION}" ]] || {
		printf '%s archive VERSION does not match\n' "${arch}" >&2
		exit 1
	}
done

for header in 'must-revalidate' 'application/gzip' 'X-Content-Type-Options: nosniff'; do
	if ! grep -Fq "${header}" "${OUT}/_headers"; then
		printf '_headers is missing %s\n' "${header}" >&2
		exit 1
	fi
done

if [[ -n "$(find "${OUT}" -type f \( -name token -o -name 'state.db*' -o -name reality.key -o -name .dev.vars \) -print -quit)" ]]; then
	printf 'staged output contains a secret or state file\n' >&2
	exit 1
fi

BAD_ARTIFACTS="${TMP}/bad-artifacts"
BAD_BUILD="${TMP}/bad-build"
mkdir -p "${BAD_ARTIFACTS}" "${BAD_BUILD}/zako-agent"
printf '0.0.0\n' >"${BAD_BUILD}/zako-agent/VERSION"
cp "${BINARY}" "${BAD_BUILD}/zako-agent/zako-agent"
chmod 0755 "${BAD_BUILD}/zako-agent/zako-agent"
tar -C "${BAD_BUILD}" -czf "${BAD_ARTIFACTS}/zako-agent-linux-amd64.tar.gz" zako-agent
cp "${ARTIFACTS}/zako-agent-linux-arm64.tar.gz" "${BAD_ARTIFACTS}/zako-agent-linux-arm64.tar.gz"

if "${REPO_ROOT}/deploy/stage-downloads.sh" \
	--version "${VERSION}" \
	--installer "${INSTALLER}" \
	--artifacts "${BAD_ARTIFACTS}" \
	--out "${TMP}/bad-out" >/dev/null 2>&1; then
	printf 'staging accepted an archive with a mismatched VERSION\n' >&2
	exit 1
fi
[[ ! -e "${TMP}/bad-out" ]] || {
	printf 'staging left output after failing\n' >&2
	exit 1
}

printf 'stage-downloads test passed\n'
