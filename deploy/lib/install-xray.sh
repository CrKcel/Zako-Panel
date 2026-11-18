#!/usr/bin/env bash
#
# Installs Xray-core and xray.service on Debian 12/13 when missing.
#
# Sourced by deploy/install.sh. Expects log(), warn(), die() to be defined, or
# defines simple fallbacks when invoked standalone.

XRAY_DEFAULT_MIRROR="https://github.com/XTLS/Xray-core/releases/latest/download"

xray_arch_name() {
	case "$1" in
		amd64 | x86_64) printf '64\n' ;;
		arm64 | aarch64) printf 'arm64-v8a\n' ;;
		*) return 1 ;;
	esac
}

xray_parse_dgst_sha256() {
	local dgst_file="$1"
	awk '
		/^(SHA2-256|SHA256)[[:space:]]*=/ {
			sub(/^[^=]*=[[:space:]]*/, "")
			gsub(/[[:space:]]/, "")
			print tolower($0)
			exit
		}
		/^[0-9a-fA-F]{64}([[:space:]]|$)/ {
			print tolower($1)
			exit
		}
	' "${dgst_file}"
}

xray_sha256_file() {
	local target="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "${target}" | awk '{print tolower($1)}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "${target}" | awk '{print tolower($1)}'
	else
		return 1
	fi
}

xray_fetch() {
	local url="$1"
	local dest="$2"
	if command -v curl >/dev/null 2>&1; then
		curl --proto '=https' --tlsv1.2 -fsSL "${url}" -o "${dest}"
	elif command -v wget >/dev/null 2>&1; then
		wget --https-only -qO "${dest}" "${url}"
	else
		die "curl or wget is required to download Xray"
	fi
}

xray_extract_zip() {
	local archive="$1"
	local dest_dir="$2"
	if command -v unzip >/dev/null 2>&1; then
		unzip -q -o "${archive}" -d "${dest_dir}"
	elif command -v python3 >/dev/null 2>&1; then
		python3 -m zipfile -e "${archive}" "${dest_dir}"
	else
		die "unzip or python3 is required to extract Xray archive"
	fi
}

ensure_xray_service() {
	local xray_bin="${1:-/usr/local/bin/xray}"
	local xray_config="${2:-/etc/xray/config.json}"
	local unit_path="${3:-/etc/systemd/system/xray.service}"

	if [[ -f "${unit_path}" ]]; then
		return 0
	fi

	cat >"${unit_path}" <<EOF
[Unit]
Description=Xray Service
Documentation=https://github.com/xtls
After=network.target nss-lookup.target

[Service]
User=root
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ExecStart=${xray_bin} run -config ${xray_config}
Restart=on-failure
RestartPreventExitStatus=23
LimitNPROC=10000
LimitNOFILE=1000000

[Install]
WantedBy=multi-user.target
EOF
	chmod 0644 "${unit_path}"
	systemctl daemon-reload
	systemctl enable xray.service
	log "installed and enabled ${unit_path}"
}

ensure_xray_installed() {
	local xray_bin="${1:-/usr/local/bin/xray}"
	local arch="${2:-amd64}"
	local mirror="${3:-${XRAY_MIRROR:-${XRAY_DEFAULT_MIRROR}}}"
	local xray_config="${4:-/etc/xray/config.json}"
	local unit_path="${5:-/etc/systemd/system/xray.service}"
	local share_dir="${6:-/usr/local/share/xray}"

	if [[ -x "${xray_bin}" ]]; then
		log "preserving existing ${xray_bin}"
		ensure_xray_service "${xray_bin}" "${xray_config}" "${unit_path}"
		return 0
	fi

	local xray_arch
	xray_arch="$(xray_arch_name "${arch}")" || die "unsupported architecture for Xray: ${arch}"

	mirror="${mirror%/}"
	local zip_name="Xray-linux-${xray_arch}.zip"
	local dgst_name="${zip_name}.dgst"
	local tmp
	tmp="$(mktemp -d)"
	trap 'rm -rf "${tmp}"' RETURN

	log "downloading Xray (${zip_name}) from ${mirror}"
	xray_fetch "${mirror}/${zip_name}" "${tmp}/${zip_name}" || die "failed to download ${zip_name}"
	xray_fetch "${mirror}/${dgst_name}" "${tmp}/${dgst_name}" || die "failed to download ${dgst_name}"

	local expected_sha actual_sha
	expected_sha="$(xray_parse_dgst_sha256 "${tmp}/${dgst_name}")"
	[[ -n "${expected_sha}" ]] || die "could not parse SHA256 from ${dgst_name}"
	actual_sha="$(xray_sha256_file "${tmp}/${zip_name}")" || die "sha256sum or shasum is required"
	if [[ "${expected_sha}" != "${actual_sha}" ]]; then
		die "Xray checksum mismatch (expected ${expected_sha}, got ${actual_sha})"
	fi

	mkdir -p "${tmp}/extract"
	xray_extract_zip "${tmp}/${zip_name}" "${tmp}/extract"
	[[ -f "${tmp}/extract/xray" ]] || die "extracted archive missing xray binary"

	install -d -m 0755 "$(dirname "${xray_bin}")" "${share_dir}"
	install -m 0755 -o root -g root "${tmp}/extract/xray" "${xray_bin}"
	for dat in geoip.dat geosite.dat; do
		if [[ -f "${tmp}/extract/${dat}" ]]; then
			install -m 0644 -o root -g root "${tmp}/extract/${dat}" "${share_dir}/${dat}"
		fi
	done
	log "installed ${xray_bin} (checksum verified)"

	ensure_xray_service "${xray_bin}" "${xray_config}" "${unit_path}"
}
