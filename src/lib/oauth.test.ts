import { describe, it, expect, vi } from 'vitest';
import {
	bearerToken,
	decideConsent,
	describeConsent,
	introspectAccessToken,
	listGrants,
	revokeGrant
} from './oauth.js';

const ISSUER = 'https://app.test';

const query = new URLSearchParams({
	client_id: 'client-1',
	redirect_uri: 'https://client.test/callback',
	response_type: 'code',
	code_challenge: 'c'.repeat(43),
	code_challenge_method: 'S256',
	state: 'xyz',
	scope: 'content:read content:write',
	resource: 'https://app.test/mcp',
	// not an OAuth parameter: must never reach PocketBase as one
	approve: 'true',
	issuer: 'https://evil.test'
});

/** A PocketBase client error, as the SDK throws it. */
const failure = (response: Record<string, unknown>) =>
	Object.assign(new Error('400'), { response });

describe('describeConsent', () => {
	it('returns what the consent page shows', async () => {
		const send = vi.fn(async () => ({
			client: { id: 'client-1', name: 'Client', uri: '', logoUri: '', verified: false },
			redirectUri: 'https://client.test/callback',
			redirectHost: 'client.test',
			scope: 'content:read content:write',
			resource: 'https://app.test/mcp'
		}));

		const result = await describeConsent({ send }, query, ISSUER);

		expect(result).toMatchObject({
			ok: true,
			redirectHost: 'client.test',
			scopes: ['content:read', 'content:write'],
			resource: 'https://app.test/mcp'
		});
		const [path, options] = send.mock.calls[0] as unknown as [string, any];
		expect(path).toBe('/api/oauth/consent');
		expect(options.method).toBe('GET');
		// the page's issuer, not one smuggled in through the query
		expect(options.query.issuer).toBe(ISSUER);
		expect(options.query.approve).toBeUndefined();
		expect(options.query.client_id).toBe('client-1');
	});

	it('reports a problem the client is told about', async () => {
		const send = vi.fn(async () => {
			throw failure({
				error: 'invalid_request',
				error_description: 'A PKCE code_challenge with the S256 method is required.',
				redirectTo: 'https://client.test/callback?error=invalid_request'
			});
		});

		expect(await describeConsent({ send }, query, ISSUER)).toEqual({
			ok: false,
			error: 'invalid_request',
			description: 'A PKCE code_challenge with the S256 method is required.',
			redirectTo: 'https://client.test/callback?error=invalid_request'
		});
	});

	it('reports an untrusted client without anywhere to redirect', async () => {
		const send = vi.fn(async () => {
			throw failure({ error: 'invalid_client', error_description: 'unknown client' });
		});

		const result = await describeConsent({ send }, query, ISSUER);
		expect(result).toEqual({ ok: false, error: 'invalid_client', description: 'unknown client' });
	});

	it('rethrows anything that is not an OAuth error', async () => {
		const send = vi.fn(async () => {
			throw new Error('network down');
		});
		await expect(describeConsent({ send }, query, ISSUER)).rejects.toThrow('network down');
	});
});

describe('decideConsent', () => {
	it('posts the decision as the given client', async () => {
		const send = vi.fn(async () => ({ redirectTo: 'https://client.test/callback?code=oac_1' }));

		const result = await decideConsent({ send }, query, {
			approve: true,
			scopes: ['content:read'],
			issuer: ISSUER
		});

		expect(result).toEqual({ redirectTo: 'https://client.test/callback?code=oac_1' });
		const [path, options] = send.mock.calls[0] as unknown as [string, any];
		expect(path).toBe('/api/oauth/consent');
		expect(options.method).toBe('POST');
		expect(options.body).toMatchObject({
			client_id: 'client-1',
			code_challenge_method: 'S256',
			approve: true,
			issuer: ISSUER,
			granted_scope: 'content:read'
		});
	});

	it('takes the decision from the caller, never from the query', async () => {
		const send = vi.fn(async () => ({
			redirectTo: 'https://client.test/callback?error=access_denied'
		}));

		await decideConsent({ send }, query, { approve: false, issuer: ISSUER });

		const [, options] = send.mock.calls[0] as unknown as [string, any];
		expect(options.body.approve).toBe(false);
		expect(options.body.granted_scope).toBeUndefined();
	});
});

describe('introspectAccessToken', () => {
	it('maps an active token', async () => {
		const send = vi.fn(async () => ({
			active: true,
			sub: 'user1',
			collection_name: 'users',
			scope: 'content:read',
			client_id: 'client-1',
			grant_id: 'grant1',
			aud: 'https://app.test/mcp',
			exp: 1790000000
		}));

		expect(await introspectAccessToken({ send }, 'oat_x')).toEqual({
			userId: 'user1',
			collection: 'users',
			scopes: ['content:read'],
			clientId: 'client-1',
			grantId: 'grant1',
			resource: 'https://app.test/mcp',
			expiresAt: 1790000000
		});
		expect(send).toHaveBeenCalledWith('/api/oauth/introspect', {
			method: 'POST',
			body: { token: 'oat_x' }
		});
	});

	it('returns null for an inactive token, and for none without asking', async () => {
		const send = vi.fn(async () => ({ active: false }));
		expect(await introspectAccessToken({ send }, 'oat_x')).toBeNull();
		expect(await introspectAccessToken({ send }, '')).toBeNull();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('reports a token issued for no resource as such', async () => {
		const send = vi.fn(async () => ({ active: true, sub: 'user1', scope: '', exp: 1 }));
		expect((await introspectAccessToken({ send }, 'oat_x'))?.resource).toBeNull();
	});
});

describe('grants', () => {
	it('lists and revokes', async () => {
		const send = vi.fn(async (path: string) =>
			path === '/api/oauth/grants'
				? { items: [{ id: 'g1', client: { name: 'Client' }, scope: 'a b', resource: '' }] }
				: null
		);

		const grants = await listGrants({ send });
		expect(grants[0]).toMatchObject({ id: 'g1', scopes: ['a', 'b'] });

		await revokeGrant({ send }, 'g/1');
		expect(send).toHaveBeenLastCalledWith('/api/oauth/grants/g%2F1', { method: 'DELETE' });
	});
});

describe('bearerToken', () => {
	it('reads a Bearer header and nothing else', () => {
		expect(bearerToken('Bearer oat_abc')).toBe('oat_abc');
		expect(bearerToken('bearer oat_abc')).toBe('oat_abc');
		expect(bearerToken('Basic abc')).toBeNull();
		expect(bearerToken('Bearer')).toBeNull();
		expect(bearerToken('Bearer a b')).toBeNull();
		expect(bearerToken(null)).toBeNull();
	});
});
