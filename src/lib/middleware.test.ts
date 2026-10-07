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

	it('sets it on locals.admin, but not on the superuser login', async () => {
		const handle = handlePocketbase({
			pocketbaseUrl: POCKETBASE_URL,
			superuserEmail: 'admin@example.com',
			superuserPassword: 'secret'
		});
		const event = makeEvent('/', '/', {}, () => '203.0.113.7');

		await runHandle(handle, event);
		const forwardedFor = (path: string) => {
			const call = vi
				.mocked(event.fetch)
				.mock.calls.find(([url]) => new URL(String(url), 'http://app.test').pathname === path);
			expect(call).toBeDefined();
			return new Headers(call?.[1]?.headers).get('x-forwarded-for');
		};

		// A login that carried each visitor's address would look to PocketBase
		// like the superuser signing in from somewhere new every time.
		expect(forwardedFor('/admin/api/collections/_superusers/auth-with-password')).toBeNull();
		// The tables cache load is the admin client's first call after it.
		expect(forwardedFor('/admin/api/collections')).toBe('203.0.113.7');
	});
});
