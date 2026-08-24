import { describe, it, expect } from 'vitest';
import { generateApiKeySecret, hashApiKey, verifyApiKey } from './api-key.js';

// A real argon2id digest produced by argon2@0.44 with its defaults, from before the
// switch to SHA-256. Kept here to pin the "legacy hashes never validate" behaviour.
const LEGACY_ARGON2_HASH =
	'$argon2id$v=19$m=65536,t=3,p=4$FhRjwrfaIokzeCdzCMmMPA$tEZf0LWHMzTTVTrGWu+qFNFCkIM70Ty7vaWmJ1Ksbic';

describe('generateApiKeySecret', () => {
	it('returns 32 hex characters', () => {
		expect(generateApiKeySecret()).toMatch(/^[0-9a-f]{32}$/);
	});

	it('returns a different secret each time', () => {
		const secrets = new Set(Array.from({ length: 100 }, () => generateApiKeySecret()));
		expect(secrets.size).toBe(100);
	});
});

describe('hashApiKey', () => {
	it('returns a prefixed base64url digest', () => {
		expect(hashApiKey('abc')).toMatch(/^sha256\$[A-Za-z0-9_-]{43}$/);
	});

	it('is stable across calls', () => {
		expect(hashApiKey('abc')).toBe(hashApiKey('abc'));
	});

	it('differs for different secrets', () => {
		expect(hashApiKey('abc')).not.toBe(hashApiKey('abd'));
	});
});

describe('verifyApiKey', () => {
	it('accepts the secret it was created from', () => {
		const secret = generateApiKeySecret();
		expect(verifyApiKey(hashApiKey(secret), secret)).toBe(true);
	});

	it('rejects a wrong secret', () => {
		expect(verifyApiKey(hashApiKey(generateApiKeySecret()), generateApiKeySecret())).toBe(false);
	});

	it('rejects a legacy argon2 hash without throwing', () => {
		expect(verifyApiKey(LEGACY_ARGON2_HASH, 'anything')).toBe(false);
	});

	it('rejects malformed stored hashes without throwing', () => {
		const secret = generateApiKeySecret();
		expect(verifyApiKey('', secret)).toBe(false);
		expect(verifyApiKey('sha256$', secret)).toBe(false);
		expect(verifyApiKey(hashApiKey(secret).slice(0, 20), secret)).toBe(false);
		expect(verifyApiKey('not-a-hash', secret)).toBe(false);
		// The stored value comes out of a PocketBase text field, so it may be missing.
		expect(verifyApiKey(undefined as unknown as string, secret)).toBe(false);
		expect(verifyApiKey(null as unknown as string, secret)).toBe(false);
	});

	it('rejects an empty secret against a real hash', () => {
		expect(verifyApiKey(hashApiKey(generateApiKeySecret()), '')).toBe(false);
	});
});
