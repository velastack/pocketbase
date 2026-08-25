# @velastack/pocketbase

PocketBase bindings for SvelteKit. Provides a `hooks.server.ts` middleware that proxies the PocketBase admin UI and API, manages user/admin auth on `event.locals`, and (in dev) keeps your generated types in sync with the live PocketBase schema.

## Install

```sh
npm install @velastack/pocketbase
```

## Quick start

```ts
// src/hooks.server.ts
import { env } from '$env/dynamic/private';
import { handlePocketbase } from '@velastack/pocketbase';

export const handle = handlePocketbase({
	pocketbaseUrl: env.POCKETBASE_URL,
	superuserEmail: env.POCKETBASE_SUPERUSER_EMAIL,
	superuserPassword: env.POCKETBASE_SUPERUSER_PASSWORD
});
```

The middleware sets `event.locals.pb` (per-request user client) and `event.locals.admin` (superuser client, when credentials are provided).

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
	pocketbaseUrl: env.POCKETBASE_URL,
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

## Package entry points

Each subpath carries only what it needs, so importing one helper does not pull
in the others' dependencies.

| import                          | provides                                                                                      | requires                                |
| ------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| `@velastack/pocketbase`         | `handlePocketbase`, `Client`, the `App.Locals` augmentation, `Models`/`Schemas`/`Collections` | `pocketbase-sveltekit`, `@sveltejs/kit` |
| `@velastack/pocketbase/api-key` | `generateApiKeySecret`, `hashApiKey`, `verifyApiKey`                                          | nothing (`node:crypto`)                 |
| `@velastack/pocketbase/form`    | `setDefaultData`, `setPocketbaseErrors`                                                       | `sveltekit-superforms`                  |
| `@velastack/pocketbase/testing` | `TestContext` and the vitest augmentation                                                     | `@types/supertest`                      |

`sveltekit-superforms` and `@types/supertest` are **optional** peer dependencies:
install them only if you import the subpath that needs them. Importing
`/form` without `sveltekit-superforms` is a runtime `ERR_MODULE_NOT_FOUND`, not
a type error.

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
