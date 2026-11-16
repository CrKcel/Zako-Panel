#!/usr/bin/env bash
#
# Parses the REALITY key pair printed by `xray x25519`.
#
# The output labels differ between Xray releases:
#   PrivateKey: ...        Password (PublicKey): ...   (current)
#   Private key: ...       Public key: ...             (older)
# Accept both so a pinned binary upgrade does not silently stop installation.

parse_reality_private() {
	printf '%s\n' "${1:-}" | sed -nE 's/^Private[[:space:]]*[Kk]ey[[:space:]]*:[[:space:]]*//p' | head -n 1
}

parse_reality_public() {
	printf '%s\n' "${1:-}" | sed -nE 's/^(Public[[:space:]]*[Kk]ey|Password([[:space:]]*\(Public[[:space:]]*Key\))?)[[:space:]]*:[[:space:]]*//p' | head -n 1
}
