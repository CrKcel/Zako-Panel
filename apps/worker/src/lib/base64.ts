function binaryFromBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return binary;
}

export function base64Encode(value: string): string {
	return btoa(binaryFromBytes(new TextEncoder().encode(value)));
}

export function base64UrlEncode(bytes: Uint8Array): string {
	return btoa(binaryFromBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
