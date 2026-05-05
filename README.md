# @velastack/pocketbase

PocketBase bindings for VelaStack projects.

```ts
// hooks.server.ts
import { env } from '$env/dynamic/private';
import { handlePocketbase } from '@velastack/pocketbase';

export const handle = handlePocketbase({
	pocketbaseUrl: env.POCKETBASE_URL,
	superuserEmail: env.POCKETBASE_SUPERUSER_EMAIL,
	superuserPassword: env.POCKETBASE_SUPERUSER_PASSWORD
});
```
