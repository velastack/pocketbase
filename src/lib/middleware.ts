import type { Handle, RequestEvent } from '@sveltejs/kit';
import PocketBase, { SvelteKitAuthStore, type RecordModel } from 'pocketbase-sveltekit';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { authRefresh } from './auth-refresh.js';
import { proxy } from './proxy.js';
import { processTypes } from './process-types.js';

type UserAuthConfig = {
	protectedRoutes?: string[] | null;
	loginPath?: string;
};

type AuthConfig = {
	protectedRoutes?: string[] | null;
	loginPath: string;
};

const DEFAULT_AUTH_CONFIG: AuthConfig = {
	protectedRoutes: null,
	loginPath: '/login'
};

type UserApiKeysConfig = {
	enabled?: boolean;
	collection?: string;
};

type ApiKeysConfig = {
	enabled: boolean;
	collection: string;
};

const DEFAULT_API_KEYS_CONFIG: ApiKeysConfig = {
	enabled: false,
	collection: 'api_keys'
};

type UserApiConfig = {
	enabled?: boolean;
	apiKeys?: UserApiKeysConfig;
};

type ApiConfig = {
	enabled: boolean;
	apiKeys: ApiKeysConfig;
};

const DEFAULT_API_CONFIG = {
	enabled: false
};

type UserFilesConfig = {
	enabled?: boolean;
};

type FilesConfig = {
	enabled: boolean;
};

const DEFAULT_FILES_CONFIG = {
	enabled: true
};

type UserConfig = {
	pocketbaseUrl: string;
	adminPath?: string;
	superuserEmail?: string | null;
	superuserPassword?: string | null;
	auth?: UserAuthConfig;
	api?: UserApiConfig;
	files?: UserFilesConfig;
};

type Config = {
	pocketbaseUrl: string;
	adminPath: string;
	superuserEmail?: string | null;
	superuserPassword?: string | null;
	auth: AuthConfig;
	api: ApiConfig;
	files: FilesConfig;
	root?: string;
};

const DEFAULT_CONFIG = {
	pocketbaseUrl: null,
	adminPath: '/admin'
};

type HandleConfig = Handle & {
	config: Config;
};

let adminCookie: string | null = null;

// Caches
let metaCache: any = null;
let tablesCache: Set<string> = new Set();

let apiKeyCache: Record<string, { userId: string; keyId: string; token: string }> = {};

const handleAdmin = async (config: Config, { event }: { event: RequestEvent }) => {
	const isDevMode = process.env.NODE_ENV === 'development';
	const strippedPath = event.url.pathname.substring(config.adminPath.length);
	const urlPath = `${config.pocketbaseUrl}${strippedPath ? strippedPath : '/'}${event.url.search}`;

	// Handle refresh token
	if (strippedPath === '/api/refresh-token') {
		return authRefresh(config, event);
	}

	// TODO: generalize this cache busting
	// clear cached meta on settings patch
	if (strippedPath === '/api/settings' && event.request.method === 'PATCH') {
		metaCache = null;
	}

	const res = await proxy(urlPath, event);

	// Rebuild types on collection create, update, or delete
	if (isDevMode) {
		if (
			event.request.method === 'POST' ||
			event.request.method === 'PATCH' ||
			event.request.method === 'DELETE'
		) {
			if (strippedPath === '/api/collections' || /^\/api\/collections\/[^/]+$/.test(strippedPath)) {
				if (config.superuserEmail && config.superuserPassword) {
					tablesCache.clear();
					await processTypes(
						{
							pocketbaseUrl: config.pocketbaseUrl,
							superuserEmail: config.superuserEmail,
							superuserPassword: config.superuserPassword
						},
						resolve(config.root ?? process.cwd(), '.svelte-kit', 'types')
					);
					console.log('Synced types');
				}
			}
		}
	}

	return res;
};

const handleFiles = async (config: Config, { event }: { event: RequestEvent }) => {
	const urlPath = `${config.pocketbaseUrl}${event.url.pathname}${event.url.search}`;
	const res = await proxy(urlPath, event);

	return res;
};

const handleApi = async (config: Config, { event }: { event: RequestEvent }) => {
	const urlPath = `${config.pocketbaseUrl}${event.url.pathname}${event.url.search}`;
	const res = await proxy(urlPath, event);

	return res;
};

const parseApiKeyHeader = (header: string) => {
	const [type, key] = header.split(' ');
	if (type !== 'Bearer') {
		throw new Error('API key is not set');
	}

	const [keyId, keySecret] = key.split('.');
	if (!keyId || !keySecret) {
		throw new Error('API key is not valid');
	}

	return { keyId, keySecret };
};

const authorizeApiKey = async (
	config: Config,
	{ event, pb }: { event: RequestEvent; pb: PocketBase }
): Promise<{ userId: string; keyId: string; token: string }> => {
	const header = event.request.headers.get('Authorization');
	if (!header) {
		throw new Error('API key is not set');
	}

	const { keyId, keySecret } = parseApiKeyHeader(header);

	if (apiKeyCache[keyId]) {
		// TODO: check if the key is expired
		return apiKeyCache[keyId];
	}

	const collection = pb.collection(config.api.apiKeys.collection);
	const record = await collection.getOne(keyId);

	if (!record) {
		throw new Error('API key is not valid');
	}

	const isMatch = await argon2.verify(record.key_hash, keySecret);

	if (!isMatch) {
		throw new Error('API key is not valid');
	}

	const userId = record.user as string;

	if (!userId) {
		throw new Error('API key is not valid');
	}

	const impersonateClient = await pb
		.collection('users')
		.impersonate(userId, 3600, { fetch: event.fetch });
	const token = impersonateClient.authStore.token;

	apiKeyCache[keyId] = { userId, keyId, token };
	return { userId, keyId, token };
};

const pbRoutes = [
	'/api/batch',
	'/api/collections',
	'/api/realtime',
	'/api/files',
	'/api/settings',
	'/api/logs',
	'/api/crons',
	'/api/backups',
	'/api/health'
];

const isPocketbaseApiRoute = (pathname: string) => {
	return pbRoutes.some((route) => pathname.startsWith(route));
};

export const handlePocketbase = (config: UserConfig) => {
	const isDevMode = process.env.NODE_ENV === 'development';
	const resolvedAuth = { ...DEFAULT_AUTH_CONFIG, ...config.auth } satisfies AuthConfig;
	const resolvedApiKeys = {
		...DEFAULT_API_KEYS_CONFIG,
		...config.api?.apiKeys
	} satisfies ApiKeysConfig;
	const resolvedApi = {
		...DEFAULT_API_CONFIG,
		...config.api,
		apiKeys: resolvedApiKeys
	} satisfies ApiConfig;
	const resolvedFiles = { ...DEFAULT_FILES_CONFIG, ...config.files } satisfies FilesConfig;
	const resolvedConfig = {
		...DEFAULT_CONFIG,
		...config,
		auth: resolvedAuth,
		api: resolvedApi,
		files: resolvedFiles
	} satisfies Config;

	if (!resolvedConfig.pocketbaseUrl) {
		throw new Error('PocketBase URL is not set, check src/hooks.server.ts');
	}

	if (!resolvedConfig.superuserEmail && !resolvedConfig.superuserPassword) {
		console.warn(
			'Superuser email and password are not set, admin features will be disabled. Check src/hooks.server.ts'
		);
	}

	if (process.env.VITE_BUILD === 'true') {
		resolvedConfig.adminPath = resolvedConfig.pocketbaseUrl + '/';
	}

	const handle: HandleConfig = async ({ event, resolve }) => {
		// Handle admin URLs
		if (event.url.pathname.startsWith(resolvedConfig.adminPath)) {
			if (
				event.url.pathname === resolvedConfig.adminPath ||
				event.url.pathname === `${resolvedConfig.adminPath}/` ||
				event.url.pathname === `${resolvedConfig.adminPath}/_`
			) {
				return new Response(null, {
					status: 302,
					headers: {
						location: `${resolvedConfig.adminPath}/_/`
					}
				});
			}
			return await handleAdmin(resolvedConfig, { event });
		}

		// We can handle files before auth because we don't need to check if the user is authenticated
		if (resolvedConfig.files.enabled && event.url.pathname.startsWith('/api/files/')) {
			return await handleFiles(resolvedConfig, { event });
		}

		// if we have api enabled but api keys are not enabled, we can pass the request directly, pocketbase will handle auth
		// default pocketbase auth is deny-all
		if (
			resolvedConfig.api.enabled &&
			!resolvedConfig.api.apiKeys.enabled &&
			isPocketbaseApiRoute(event.url.pathname)
		) {
			return await handleApi(resolvedConfig, { event });
		}

		const pb = new PocketBase(
			resolvedConfig.adminPath,
			new SvelteKitAuthStore(),
			'en-US',
			event.fetch
		);

		let shouldClearCookie = false;
		pb.authStore.loadFromCookie(event.request.headers.get('cookie') || '');

		if (pb.authStore.isValid) {
			try {
				await pb.collection('users').authRefresh();
			} catch (e) {
				pb.authStore.clear();
				shouldClearCookie = true;
			}
		}

		// Setup admin client
		const admin = new PocketBase(
			resolvedConfig.adminPath,
			new SvelteKitAuthStore(),
			'en-US',
			event.fetch
		);

		// Authenticate admin client
		if (resolvedConfig.superuserEmail && resolvedConfig.superuserPassword) {
			let needsAuth = false;

			if (adminCookie) {
				admin.authStore.loadFromCookie(adminCookie);
				if (!admin.authStore.isValid) {
					try {
						await admin.collection('_superusers').authRefresh();
					} catch (e) {
						admin.authStore.clear();
						needsAuth = true;
					}
				}
			} else {
				needsAuth = true;
			}

			if (needsAuth) {
				try {
					await admin
						.collection('_superusers')
						.authWithPassword(resolvedConfig.superuserEmail, resolvedConfig.superuserPassword, {
							autoRefreshThreshold: 30 * 60
						});
				} catch (e) {
					console.log('handlePocketbase: error authenticating superuser', e);
				}

				adminCookie = admin.authStore.exportToCookie();
			}
		}

		// Load the tables cache
		if (!tablesCache.size) {
			try {
				const tables = await admin.collections.getFullList();
				tablesCache = new Set(tables.map((table) => table.name));
			} catch {}
		}

		// Handle oauth2 redirects directly. We have to handle this here because
		// the auth flow takes place on the client and we only get the response
		// from the server after the auth flow is complete (auth-with-oauth2)
		// So we intercept the response and login the user.
		if (
			event.url.pathname.startsWith('/api/oauth2-redirect') ||
			event.url.pathname.startsWith('/api/collections/users/auth-methods') ||
			event.url.pathname.startsWith('/api/collections/users/auth-with-oauth2') ||
			event.url.pathname.startsWith('/api/realtime')
		) {
			if (!event.url.pathname.startsWith('/api/collections/users/auth-with-oauth2')) {
				return await handleApi(resolvedConfig, { event });
			}

			// Patch in to /api/collections/users/auth-with-oauth2
			// Get the provider from the request body
			const clonedReq = event.request.clone();
			const body = await clonedReq.json();
			const { provider } = body;

			const res = await handleApi(resolvedConfig, { event });

			let data: { token: string; record: RecordModel; meta: any } | null = null;

			if (res.status === 200) {
				try {
					// Clone the original response so we can read the body
					const cloned = res.clone();
					data = await cloned.json();
				} catch {}
			}

			if (!data || !data.meta) {
				return res;
			}

			let oauthAccounts;

			try {
				oauthAccounts = await admin.collections.getOne('oauth_accounts');
			} catch {}

			if (oauthAccounts) {
				let existing;

				try {
					existing = await admin
						.collection('oauth_accounts')
						.getFirstListItem(`user="${data.record.id}" && provider="${provider}"`);
				} catch {}

				if (existing) {
					await admin.collection('oauth_accounts').delete(existing.id);
				}

				await admin.collection('oauth_accounts').create({
					user: data.record.id,
					providerId: data.meta.id,
					provider,
					accessToken: data.meta.accessToken,
					refreshToken: data.meta.refreshToken,
					avatarURL: data.meta.avatarURL,
					expiry: data.meta.expiry,
					email: data.meta.email,
					name: data.meta.name,
					username: data.meta.username,
					rawUser: data.meta.rawUser
				});
			}

			let user = data.record;

			// Download the avatar if it exists
			if (data.meta.avatarURL) {
				try {
					const existingUser = await admin.collection('users').getOne(data.record.id);

					// Don't update the user if the avatar already exists
					if (!existingUser.avatar) {
						// try downloading the avatar to a blob
						const avatar = await fetch(data.meta.avatarURL);

						// get the filename from the url
						const filename = data.meta.avatarURL.split('/').pop();
						const avatarBlob = await avatar.blob();
						const formData = new FormData();
						formData.append('avatar', avatarBlob, filename);

						// Update the user with the new avatar
						user = await admin.collection('users').update(data.record.id, formData);
					}
				} catch {}
			}

			pb.authStore.save(data.token, user);
			res.headers.set(
				'set-cookie',
				pb.authStore.exportToCookie({
					path: '/',
					httpOnly: true,
					sameSite: 'lax',
					secure: !isDevMode,
					maxAge: 60 * 60 * 24 * 30
				})
			);

			return res;
		}

		// Handle protected routes
		if (resolvedConfig.auth?.protectedRoutes) {
			for (const route of resolvedConfig.auth.protectedRoutes) {
				if (event.route.id?.startsWith(route)) {
					if (!pb.authStore.isValid) {
						return new Response(null, {
							status: 302,
							headers: {
								location: `${resolvedConfig.auth.loginPath}?redirect=${encodeURIComponent(event.url.pathname)}`,
								'Set-Cookie': 'pb_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT;'
							}
						});
					}
				}
			}
		}

		// Handle API key requests after setting up the admin client
		if (
			resolvedConfig.api.enabled &&
			resolvedConfig.api.apiKeys.enabled &&
			isPocketbaseApiRoute(event.url.pathname)
		) {
			let token;
			let keyId;

			// Authenticate the user and create the necessary headers for the API request
			try {
				const result = await authorizeApiKey(resolvedConfig, { event, pb: admin });
				token = result.token;
				keyId = result.keyId;
			} catch {
				// If we don't have a valid API key, we can let Pocketbase handle auth
				return await handleApi(resolvedConfig, { event });
			}

			// Update last_used but don't wait for it
			admin.collection('api_keys').update(keyId, {
				last_used: new Date().toISOString()
			});

			event.request.headers.set('Authorization', token);
			return await handleApi(resolvedConfig, { event });
		}

		if (!metaCache) {
			const settings = await admin.settings.getAll();
			metaCache = settings['meta'];
		}

		// Load team if we have a team cookie and the teams table
		if (tablesCache.has('teams') && pb.authStore.isValid) {
			if (event.request.headers.get('cookie')?.includes('team')) {
				const teamCookie = event.request.headers
					.get('cookie')
					?.split('; ')
					.find((cookie) => cookie.startsWith('team='));
				if (teamCookie) {
					const teamId = teamCookie.split('=')[1];

					try {
						const membership = await admin
							.collection('team_memberships')
							.getFirstListItem(`team="${teamId}" && user="${pb.authStore.record?.id}"`);
						event.locals.role = membership.role;
						event.locals.team = teamId;
					} catch {}
				}
			}
		}

		// Set the locals variables (pb, admin, meta)
		// @ts-ignore
		event.locals.pb = pb;
		// @ts-ignore
		event.locals.admin = admin;
		// @ts-ignore
		event.locals.meta = metaCache;

		// Handle all other requests
		const res = await resolve(event);

		if (shouldClearCookie) {
			res.headers.set('Set-Cookie', 'pb_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT;');
		}

		// Display our own 404 page in dev mode with prompts to create the pages
		if (isDevMode) {
			if (res.status === 404) {
				if (event.url.pathname === '/login' || event.url.pathname === '/signup') {
					return new Response(
						errorPage(404, 'Run <code>svsh enable auth</code> to create this page.'),
						{
							status: 404,
							headers: {
								'Content-Type': 'text/html'
							}
						}
					);
				}

				if (event.url.pathname === '/privacy') {
					return new Response(
						errorPage(404, 'Run <code>svsh legal privacy</code> to create this page.'),
						{
							status: 404,
							headers: {
								'Content-Type': 'text/html'
							}
						}
					);
				}

				if (event.url.pathname === '/terms') {
					return new Response(
						errorPage(404, 'Run <code>svsh legal terms</code> to create this page.'),
						{
							status: 404,
							headers: {
								'Content-Type': 'text/html'
							}
						}
					);
				}
			}
		}

		return res;
	};

	handle.config = resolvedConfig;

	return handle;
};

const errorPage = (status: number, message: string) => `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>${status}</title>

		<style>
			body {
				--bg: white;
				--fg: #222;
				--divider: #ccc;
				background: var(--bg);
				color: var(--fg);
				font-family:
					system-ui,
					-apple-system,
					BlinkMacSystemFont,
					'Segoe UI',
					Roboto,
					Oxygen,
					Ubuntu,
					Cantarell,
					'Open Sans',
					'Helvetica Neue',
					sans-serif;
				display: flex;
				align-items: center;
				justify-content: center;
				height: 100vh;
				margin: 0;
			}

			.error {
				display: flex;
				align-items: center;
				max-width: 32rem;
				margin: 0 1rem;
			}

			.status {
				font-weight: 200;
				font-size: 3rem;
				line-height: 1;
				position: relative;
				top: -0.05rem;
			}

			.message {
				border-left: 1px solid var(--divider);
				padding: 0 0 0 1rem;
				margin: 0 0 0 1rem;
				min-height: 2.5rem;
				display: flex;
				align-items: center;
			}

			.message h1 {
				font-weight: 400;
				font-size: 1em;
				margin: 0;
			}

			@media (prefers-color-scheme: dark) {
				body {
					--bg: #222;
					--fg: #ddd;
					--divider: #666;
				}
			}

			code {
				background: #f4f4f4;
				padding: 0.2em 0.4em;
				border-radius: 3px;
				font-size: 0.9em;
				font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
			}

			@media (prefers-color-scheme: dark) {
				code {
					background: #333;
				}
			}
		</style>
	</head>
	<body>
		<div class="error">
			<span class="status">${status}</span>
			<div class="message">
				<h1>${message}</h1>
			</div>
		</div>
	</body>
</html>
`;
