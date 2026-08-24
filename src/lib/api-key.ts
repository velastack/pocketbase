import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256$';

/** Generate an API key secret — 128 bits of CSPRNG entropy. */
export const generateApiKeySecret = () => randomBytes(16).toString('hex');

/**
 * Hash an API key secret for storage in `api_keys.key_hash`.
 *
 * The secret is a high-entropy random token rather than a user-chosen password, so a
 * single SHA-256 is sufficient — there is no dictionary to attack and nothing for a
 * memory-hard KDF to defend against. The `sha256$` prefix keeps the stored value
 * self-describing so the algorithm can change later without another breaking migration.
 */
export const hashApiKey = (secret: string) =>
	PREFIX + createHash('sha256').update(secret, 'utf8').digest('base64url');

/** Constant-time check of a secret against a stored `key_hash`. */
export const verifyApiKey = (storedHash: string, secret: string) => {
	// Unrecognised or legacy (`$argon2id$…`) formats never validate.
	if (typeof storedHash !== 'string' || !storedHash.startsWith(PREFIX)) return false;

	const stored = Buffer.from(storedHash.slice(PREFIX.length), 'base64url');
	const actual = Buffer.from(hashApiKey(secret).slice(PREFIX.length), 'base64url');

	// timingSafeEqual throws on a length mismatch — guard so a malformed row returns
	// false instead of throwing.
	return stored.length === actual.length && timingSafeEqual(stored, actual);
};
