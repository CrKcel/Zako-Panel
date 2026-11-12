import { base64Encode } from '../lib/base64';

export type UriEncoding = 'base64' | 'plain';

/**
 * The standard Base64 form encodes the complete newline-separated UTF-8 text,
 * which is what Clash and most URI importers expect.
 */
export function renderUriDocument(uris: string[], encoding: UriEncoding): string {
	const text = uris.join('\n');
	return encoding === 'base64' ? base64Encode(text) : text;
}
