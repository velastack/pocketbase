import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { handlePocketbase } from './middleware.js';

const POCKETBASE_URL = 'http://pocketbase.test';

/**
 * Minimal stand-in for a SvelteKit request event. `route.id` is what the
 * protected-route redirect keys off, so tests set it to whatever route SvelteKit
 * would have matched for the path.
 */
const makeEvent = (
	path: string,
	routeId: string | null,
	headers: HeadersInit = {},
	getClientAddress: () => string = () => '127.0.0.1'
) => {
	const url = new URL(path, 'http://app.test');
	const request = new Request(url, { headers });

	// The PocketBase clients inside the hook call `event.fetch` against the
	// admin path. Nothing here needs those calls to succeed, so a 404 keeps the
	// superuser login and the tables cache in their "unavailable" branches.
	const eventFetch = vi.fn(async () => new Response('{}', { status: 404 }));

	return {
		url,
		request,
		route: { id: routeId },
		fetch: eventFetch as unknown as typeof fetch,
		locals: {},
		cookies: {} as RequestEvent['cookies'],
		params: {},
		platform: undefined,
		getClientAddress,
		isDataRequest: false,
		isSubRequest: false,
		setHeaders: () => {}
	} as unknown as RequestEvent;
};

const runHandle = async (handle: ReturnType<typeof handlePocketbase>, event: RequestEvent) => {
	const resolve = vi.fn(async () => new Response('resolved page', { status: 200 }));
	const res = await handle({ event, resolve });
	return { res, resolve };
};

describe('handlePocketbase API routes with API keys enabled', () => {
	// `proxy()` forwards to PocketBase with the global fetch.
	let upstream: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		upstream = vi.fn(async (input: URL | RequestInfo) => {
			const url = input instanceof URL ? input : new URL(String(input));
			return new Response(JSON.stringify({ proxied: url.pathname }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		});
		vi.stubGlobal('fetch', upstream);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const config = {
		pocketbaseUrl: POCKETBASE_URL,
		auth: { protectedRoutes: ['/(app)'] },
		api: { enabled: true, apiKeys: { enabled: true } }
	};

	it('proxies a PocketBase API path even when it collides with a protected page route', async () => {
		// Velastack has `(app)/[team_slug]/[project_slug]`, so SvelteKit matches
		// `/api/health` to that protected route. The request carries no session
		// cookie and no API key, which must fall back to PocketBase's own auth,
		// not the login redirect.
		const handle = handlePocketbase(config);
		const event = makeEvent('/api/health', '/(app)/[team_slug]/[project_slug]');

		const { res, resolve } = await runHandle(handle, event);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ proxied: '/api/health' });
		expect(upstream).toHaveBeenCalledTimes(1);
		const [firstCall] = upstream.mock.calls;
		expect(String(firstCall?.[0])).toBe(`${POCKETBASE_URL}/api/health`);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('matches the response from the same path with API keys disabled', async () => {
		const withKeys = handlePocketbase(config);
		const withoutKeys = handlePocketbase({
			...config,
			api: { enabled: true, apiKeys: { enabled: false } }
		});
		const routeId = '/(app)/[team_slug]/[project_slug]';

		const a = await runHandle(withKeys, makeEvent('/api/health', routeId));
		const b = await runHandle(withoutKeys, makeEvent('/api/health', routeId));

		expect([a.res.status, await a.res.json()]).toEqual([b.res.status, await b.res.json()]);
	});

	it('still redirects unauthenticated requests for real protected pages', async () => {
		const handle = handlePocketbase(config);
		const event = makeEvent('/dashboard', '/(app)/dashboard');

		const { res, resolve } = await runHandle(handle, event);

		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/login?redirect=%2Fdashboard');
		expect(upstream).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('handlePocketbase plugin webhooks', () => {
	let upstream: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		upstream = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', upstream);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const signedPost = (path: string) => {
		const event = makeEvent(path, null);
		const request = new Request(event.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-velastack-signature': 't=1,v1=abc' },
			body: '{"id":"evt_1"}'
		});
		return { ...event, request } as RequestEvent;
	};

	it('proxies the WhatsApp webhook with its body and signature, with the API proxy off', async () => {
		// the default config: no `api`, as the auth pattern sets it up
		const handle = handlePocketbase({ pocketbaseUrl: POCKETBASE_URL });

		const { res, resolve } = await runHandle(handle, signedPost('/api/whatsapp/webhook'));

		expect(res.status).toBe(204);
		expect(resolve).not.toHaveBeenCalled();
		const [url, init] = upstream.mock.calls[0] as [URL, RequestInit & { headers: Headers }];
		expect(String(url)).toBe(`${POCKETBASE_URL}/api/whatsapp/webhook`);
		expect(init.method).toBe('POST');
		expect(init.headers.get('x-velastack-signature')).toBe('t=1,v1=abc');
		expect(await new Response(init.body).text()).toBe('{"id":"evt_1"}');
	});

	it("leaves the app's own routes next to it alone", async () => {
		const handle = handlePocketbase({ pocketbaseUrl: POCKETBASE_URL });

		for (const path of ['/api/whatsapp/v1/webhook', '/api/whatsapp/webhook/x']) {
			const { resolve } = await runHandle(handle, signedPost(path));
			expect(resolve).toHaveBeenCalled();
		}
		expect(upstream).not.toHaveBeenCalled();
	});
});

describe('handlePocketbase forwards the visitor address to PocketBase', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Run the hook for a page, then have the page call PocketBase as `locals.pb`. */
	const healthCheckHeaders = async (event: RequestEvent) => {
		const handle = handlePocketbase({ pocketbaseUrl: POCKETBASE_URL });
		await runHandle(handle, event);
		await event.locals.pb.health.check().catch(() => {});

		const call = vi
			.mocked(event.fetch)
			.mock.calls.find(([url]) => String(url).endsWith('/api/health'));
		expect(call).toBeDefined();
		return new Headers(call?.[1]?.headers);
	};

	it("sets X-Forwarded-For on the request's client from getClientAddress()", async () => {
		const event = makeEvent('/', '/', {}, () => '203.0.113.7');

		const headers = await healthCheckHeaders(event);

		expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
	});

	it('leaves the header off when there is no client address', async () => {
		// adapter-node throws when ADDRESS_HEADER is set and the request lacks it.
		const event = makeEvent('/', '/', {}, () => {
			throw new Error('Address header was specified but is absent from request');
		});

		const headers = await healthCheckHeaders(event);

		expect(headers.has('x-forwarded-for')).toBe(false);
	});
});

describe('handlePocketbase signs the superuser in directly', () => {
	const SUPERUSERS = 'pbc_3142635823';

	/** An unsigned JWT with the claims the SDK's auth store reads. */
	const makeToken = (expiresInSeconds: number) => {
		const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
		return `${encode({ alg: 'HS256' })}.${encode({ id: 'su1', collectionId: SUPERUSERS, type: 'auth', exp })}.sig`;
	};

	const record = {
		id: 'su1',
		collectionId: SUPERUSERS,
		collectionName: '_superusers',
		email: 'admin@example.com'
	};

	/**
	 * PocketBase itself, reached by the global fetch. Each sign-in or refresh
	 * hands out the next token from `tokens`.
	 */
	let upstream: ReturnType<typeof vi.fn>;
	let tokens: string[];

	const upstreamCalls = (suffix: string) =>
		upstream.mock.calls.filter(([url]) => String(url).endsWith(suffix));

	beforeEach(() => {
		tokens = [];
		upstream = vi.fn(async (input: URL | RequestInfo) => {
			const url = String(input);
			if (url.includes('/api/collections/_superusers/auth-')) {
				const token = tokens.shift() ?? makeToken(24 * 60 * 60);
				return new Response(JSON.stringify({ token, record }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response('{}', { status: 404 });
		});
		vi.stubGlobal('fetch', upstream);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const config = {
		pocketbaseUrl: POCKETBASE_URL,
		superuserEmail: 'admin@example.com',
		superuserPassword: 'secret'
	};

	it('signs in against pocketbaseUrl with the global fetch, carrying no visitor address', async () => {
		const handle = handlePocketbase(config);
		const event = makeEvent('/', '/', {}, () => '203.0.113.7');

		await runHandle(handle, event);

		// Through `event.fetch` the login would leave by the admin proxy, which
		// stamps the visitor's address on it: PocketBase would then record the
		// superuser as signing in from wherever that visitor was and send a
		// "login from a new location" alert.
		const [login] = upstreamCalls('/api/collections/_superusers/auth-with-password');
		expect(String(login?.[0])).toBe(
			`${POCKETBASE_URL}/api/collections/_superusers/auth-with-password`
		);
		expect(new Headers(login?.[1]?.headers).has('x-forwarded-for')).toBe(false);
		const viaApp = vi
			.mocked(event.fetch)
			.mock.calls.filter(([url]) => String(url).includes('/_superusers/auth-'));
		expect(viaApp).toHaveLength(0);

		// The request's admin client gets the session, and its own calls still
		// say who is asking.
		expect(event.locals.admin.authStore.isValid).toBe(true);
		await event.locals.admin.health.check().catch(() => {});
		const health = vi
			.mocked(event.fetch)
			.mock.calls.find(([url]) => String(url).endsWith('/api/health'));
		expect(new Headers(health?.[1]?.headers).get('x-forwarded-for')).toBe('203.0.113.7');
	});

	it('reuses the cached session for later requests', async () => {
		const handle = handlePocketbase(config);

		await runHandle(
			handle,
			makeEvent('/', '/', {}, () => '203.0.113.7')
		);
		await runHandle(
			handle,
			makeEvent('/', '/', {}, () => '198.51.100.9')
		);

		expect(upstreamCalls('/auth-with-password')).toHaveLength(1);
		expect(upstreamCalls('/auth-refresh')).toHaveLength(0);
	});

	it('refreshes the session before it expires rather than signing in again', async () => {
		const soon = makeToken(30 * 60);
		const renewed = makeToken(24 * 60 * 60);
		tokens = [soon, renewed];
		const handle = handlePocketbase(config);

		await runHandle(handle, makeEvent('/', '/'));
		const event = makeEvent('/', '/');
		await runHandle(handle, event);

		expect(upstreamCalls('/auth-with-password')).toHaveLength(1);
		const [refresh] = upstreamCalls('/auth-refresh');
		expect(new Headers(refresh?.[1]?.headers).get('authorization')).toBe(soon);
		expect(new Headers(refresh?.[1]?.headers).has('x-forwarded-for')).toBe(false);
		expect(event.locals.admin.authStore.token).toBe(renewed);
	});

	it('signs in with the password again once the cached session has expired', async () => {
		tokens = [makeToken(-60)];
		const handle = handlePocketbase(config);

		await runHandle(handle, makeEvent('/', '/'));
		const event = makeEvent('/', '/');
		await runHandle(handle, event);

		expect(upstreamCalls('/auth-refresh')).toHaveLength(0);
		expect(upstreamCalls('/auth-with-password')).toHaveLength(2);
		expect(event.locals.admin.authStore.isValid).toBe(true);
	});

	it('shares one sign-in across a burst of requests', async () => {
		const handle = handlePocketbase(config);
		const events = [makeEvent('/', '/'), makeEvent('/', '/'), makeEvent('/', '/')];

		await Promise.all(events.map((event) => runHandle(handle, event)));

		expect(upstreamCalls('/auth-with-password')).toHaveLength(1);
		for (const event of events) expect(event.locals.admin.authStore.isValid).toBe(true);
	});
});
