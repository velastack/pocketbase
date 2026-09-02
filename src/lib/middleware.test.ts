import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { handlePocketbase } from './middleware.js';

const POCKETBASE_URL = 'http://pocketbase.test';

/**
 * Minimal stand-in for a SvelteKit request event. `route.id` is what the
 * protected-route redirect keys off, so tests set it to whatever route SvelteKit
 * would have matched for the path.
 */
const makeEvent = (path: string, routeId: string | null, headers: HeadersInit = {}) => {
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
		getClientAddress: () => '127.0.0.1',
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
