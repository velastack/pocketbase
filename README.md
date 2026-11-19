# @velastack/pocketbase

PocketBase bindings for SvelteKit. Provides a `hooks.server.ts` middleware that proxies the PocketBase admin UI and API, manages user/admin auth on `event.locals`, and (in dev) keeps your generated types in sync with the live PocketBase schema.

## Install

```sh
npm install @velastack/pocketbase
```

Requires SvelteKit 3 and Node 22.17 or later. SvelteKit 2 projects stay on
`@velastack/pocketbase@^0.3`.

## Quick start

```ts
// src/hooks.server.ts
import {
	POCKETBASE_URL,
	POCKETBASE_SUPERUSER_EMAIL,
	POCKETBASE_SUPERUSER_PASSWORD
} from '$app/env/private';
import { handlePocketbase } from '@velastack/pocketbase';

export const handle = handlePocketbase({
	pocketbaseUrl: POCKETBASE_URL,
	superuserEmail: POCKETBASE_SUPERUSER_EMAIL,
	superuserPassword: POCKETBASE_SUPERUSER_PASSWORD
});
```

SvelteKit 3 only exposes variables declared in `src/env.ts`:

```ts
// src/env.ts
import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	POCKETBASE_URL: { schema: (value) => value ?? '' },
	POCKETBASE_SUPERUSER_EMAIL: { schema: (value) => value ?? '' },
	POCKETBASE_SUPERUSER_PASSWORD: { schema: (value) => value ?? '' }
});
```

The middleware sets `event.locals.pb` (per-request user client) and `event.locals.admin` (superuser client, when credentials are provided).

The superuser signs in once per process, straight against `pocketbaseUrl` with the global fetch, and the session is refreshed an hour before it expires. Its calls on `event.locals.admin` carry the visitor's address in `X-Forwarded-For`, but the sign-in itself never does, so PocketBase does not record the superuser as logging in from wherever a visitor happened to be.

It does not read the app's name or URL from PocketBase settings. VelaStack apps keep those in code, in `src/lib/site.ts`, and `vela dev` / `vela deploy` copy the name into PocketBase's `meta.appName` for its own emails. Before 0.3.0 the middleware also set `event.locals.meta` from PocketBase's settings; import `site` from `#lib/site.js` instead.

## `handlePocketbase(config)`

| Option              | Type             | Default             | Description                                                                                                    |
| ------------------- | ---------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pocketbaseUrl`     | `string`         | _required_          | Base URL of the upstream PocketBase server.                                                                    |
| `superuserEmail`    | `string \| null` | `null`              | Superuser email. Required for the admin proxy, type sync, OAuth post-processing, and the `team`/`role` lookup. |
| `superuserPassword` | `string \| null` | `null`              | Superuser password. Pair with `superuserEmail`.                                                                |
| `adminPath`         | `string`         | `'/admin'`          | URL path under which the PocketBase admin UI is proxied. Visit `${adminPath}/_/` for the dashboard.            |
| `auth`              | `AuthConfig`     | see below           | Route protection.                                                                                              |
| `api`               | `ApiConfig`      | see below           | API proxying and API-key auth.                                                                                 |
| `files`             | `FilesConfig`    | `{ enabled: true }` | Proxy `/api/files/*` to PocketBase.                                                                            |

### `auth`

```ts
auth: {
	protectedRoutes?: string[] | null; // route ids that require a valid session
	loginPath?: string;                // default: '/login'
}
```

Unauthenticated requests to a protected route are redirected to `${loginPath}?redirect=...` and the `pb_auth` cookie is cleared.

```ts
handlePocketbase({
	pocketbaseUrl: POCKETBASE_URL,
	auth: {
		protectedRoutes: ['/(app)'],
		loginPath: '/login'
	}
});
```

### `api`

```ts
api: {
	enabled?: boolean; // default: false — when false, only the admin path is proxied
	apiKeys?: {
		enabled?: boolean;    // default: false
		collection?: string;  // default: 'api_keys' — must contain `key_hash` (SHA-256) and `user`
	};
}
```

When `api.enabled` is `true`, PocketBase API routes (`/api/batch`, `/api/collections`, `/api/realtime`, `/api/files`, `/api/settings`, `/api/logs`, `/api/crons`, `/api/backups`, `/api/health`) are proxied through SvelteKit. When `apiKeys.enabled` is also `true`, requests with `Authorization: Bearer <keyId>.<secret>` are authenticated against the configured collection and rewritten to an impersonated user token.

#### Key hashing

`key_hash` stores `sha256$<base64url>`. The secret half of an API key is a 128-bit random
token rather than a user-chosen password, so a single SHA-256 is the appropriate primitive —
there is no dictionary to attack, and a memory-hard KDF would only add a native dependency
and per-request latency.

`vela enable api-keys` scaffolds key creation for you. To issue keys yourself, use the
exported helpers so the stored format stays in sync with verification:

```ts
import { generateApiKeySecret, hashApiKey } from '@velastack/pocketbase/api-key';

const keySecret = generateApiKeySecret();
const record = await pb
	.collection('api_keys')
	.create({ key_hash: hashApiKey(keySecret), user: userId, label });

// Show this to the user once — it is not recoverable from `key_hash`.
const apiKey = `${record.id}.${keySecret}`;
```

> **Breaking change in 0.1.0.** Earlier versions stored argon2id hashes. Those no longer
> validate, and there is no migration path because the plaintext secret cannot be recovered
> from an argon2 digest. Existing API keys must be regenerated.

### `files`

```ts
files: {
	enabled?: boolean; // default: true
}
```

When enabled, `/api/files/*` is proxied directly to PocketBase without going through SvelteKit auth (files are public per PocketBase's own rules).

### `oauth`

```ts
oauth: {
	enabled?: boolean;      // default: false
	authorizePath?: string; // default: '/oauth/authorize', the app's sign-in and consent page
	scopes?: string[];      // advertised as scopes_supported
}
```

For a PocketBase with [pocketbase-oauth](https://github.com/velastack/pocketbase-oauth)
(built into [velabase](https://github.com/velastack/velabase)), which makes it an OAuth 2.1
authorization server: what lets ChatGPT, Claude and other MCP clients sign in to your app.
When enabled, the app's origin is the issuer:

- `/.well-known/oauth-authorization-server` serves the server metadata for the origin the
  request came in on, with `authorization_endpoint` pointing at `authorizePath`;
- `/api/oauth/register`, `/api/oauth/token` and `/api/oauth/revoke` are proxied to PocketBase,
  whatever the `api` config.

The consent page is yours to write, with the helpers in `@velastack/pocketbase/oauth`:

```ts
// src/routes/oauth/authorize/+page.server.ts  (a protected route: the person is signed in)
import { redirect, error } from '@sveltejs/kit';
import { describeConsent, decideConsent } from '@velastack/pocketbase/oauth';

// Anything wrong with the request is shown, never passed on: registration is
// open, so redirecting on a client's say-so would let a link to this page send
// a visitor anywhere.
const consentRequest = async (locals: App.Locals, url: URL) => {
	const request = await describeConsent(locals.pb, url.searchParams, url.origin);
	if (!request.ok) error(400, request.description);
	// A token is good at the server it names: only approve your own.
	if (request.resource !== `${url.origin}/mcp`) error(400, 'Unknown resource');
	return request;
};

export const load = async ({ locals, url, setHeaders }) => {
	const request = await consentRequest(locals, url);
	setHeaders({ 'content-security-policy': "frame-ancestors 'none'" });
	return { client: request.client, redirectHost: request.redirectHost, scopes: request.scopes };
};

export const actions = {
	// One action for both buttons: a named action's `?/name` would replace the
	// query, which is the authorization request.
	default: async ({ locals, url, request }) => {
		await consentRequest(locals, url);
		const approve = (await request.formData()).get('decision') === 'allow';
		const result = await decideConsent(locals.pb, url.searchParams, {
			approve,
			issuer: url.origin
		});
		if ('redirectTo' in result && result.redirectTo) {
			redirect(303, result.redirectTo, { external: true });
		}
		error(400, 'description' in result ? result.description : 'Invalid request');
	}
};
```

Show `client.name` with `redirectHost`: a client names itself, and where the person is sent
back to is the one thing on the page it cannot make up.

A resource server checks the token it was sent with the superuser client:

```ts
import { bearerToken, introspectAccessToken } from '@velastack/pocketbase/oauth';

const token = bearerToken(request.headers.get('authorization'));
const access = token && (await introspectAccessToken(locals.admin, token));
// null, or { userId, scopes, resource, clientId, grantId, expiresAt }
```

`introspectAccessToken` says the token is real, not that it is yours: refuse one whose
`resource` is not your own URL, and check `scopes` for what the operation needs.
`listGrants(locals.pb)` and `revokeGrant(locals.pb, id)` back a "connected apps" page.

An OAuth access token does not open PocketBase's own API: API rules know nothing about
scopes. What it may do is whatever your resource server does for it.

## Package entry points

Each subpath carries only what it needs, so importing one helper does not pull
in the others' dependencies.

| import                          | provides                                                                                                | requires                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `@velastack/pocketbase`         | `handlePocketbase`, `Client`, the `App.Locals` augmentation, `Models`/`Schemas`/`Collections`           | `pocketbase-sveltekit`, `@sveltejs/kit` |
| `@velastack/pocketbase/api-key` | `generateApiKeySecret`, `hashApiKey`, `verifyApiKey`                                                    | nothing (`node:crypto`)                 |
| `@velastack/pocketbase/oauth`   | `describeConsent`, `decideConsent`, `introspectAccessToken`, `bearerToken`, `listGrants`, `revokeGrant` | nothing                                 |
| `@velastack/pocketbase/form`    | `setDefaultData`, `setPocketbaseErrors`                                                                 | `sveltekit-superforms`                  |
| `@velastack/pocketbase/testing` | `TestContext` and the vitest augmentation                                                               | `@types/supertest`                      |

`sveltekit-superforms` and `@types/supertest` are **optional** peer dependencies:
install them only if you import the subpath that needs them. Importing
`/form` without `sveltekit-superforms` is a runtime `ERR_MODULE_NOT_FOUND`, not
a type error.

`/form` is **Vite-only**. It needs `sveltekit-superforms@^3`, whose `/server`
entry imports `$app/server`, a module only SvelteKit's Vite plugin can resolve.
`./form` carries a `svelte` export condition, so `vite-plugin-svelte` bundles the
package for SSR rather than leaving it to Node. Plain Node, a vitest run without
SvelteKit's plugin, or any other non-Vite loader fails on `$app/server`. If an
unusual install (a pnpm workspace, a transitive-only dependency) still
externalises it, add `@velastack/pocketbase` to `ssr.noExternal`.

Route-id helpers such as `Match<RouteId>` now live in
[`@velastack/kit`](https://github.com/velastack/kit), which is backend-agnostic.

## Type sync

In dev mode, schema changes made through the proxied admin UI invalidate
`.svelte-kit/types/pocketbase/$types.d.ts`, and `vela dev` regenerates it. This
requires `vela dev` to be running — under a bare `vite dev` the invalidation is
skipped, so run `vela sync` after changing collections. The file declares three types under the `@velastack/pocketbase` module:

- `Models` — the read shape of each collection (`pb.collection('leads').getOne(...)`).
- `Schemas` — a `z.ZodType<...>` per collection, used to validate user-authored zod schemas at the type level.
- `Collections` — record-service typings for `pb.collections.getOne(...)`.

The `Schemas` mapping is what catches drift between your Zod validators and the live PocketBase schema. Add `satisfies Schemas['<name>']` to any Zod schema and the file will fail to type-check whenever the collection changes:

```ts
import { z } from 'zod';
import type { Schemas } from '@velastack/pocketbase';

export const leadSchema = z.object({
	id: z.string().optional(),
	collectionId: z.string().optional(),
	name: z.string(),
	phone: z.string().optional(),
	message: z.string().optional()
}) satisfies Schemas['leads'];
```

If a field is added, removed, or its required-ness changes in PocketBase, `tsc` will reject this file until the Zod schema is updated.

Type sync runs within `vela dev` or as a one-off with `vela sync`.

## License

MIT
