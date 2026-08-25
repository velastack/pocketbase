import type { Agent } from 'supertest';

// Imported by the package's own name, not a relative path, for two reasons:
// it is the module the generated $types.d.ts augments with `Models`, and it is
// what pulls the global `App.Locals` augmentation into the test program. After
// `vela disable backend` removes hooks.server.ts, this import is the only thing
// carrying App.Locals into tests.
// @ts-ignore
import type { Models } from '@velastack/pocketbase';

/** The per-test fixture provided by the Velastack vitest setup. */
export type TestContext = {
	request: Agent;
	agent: Agent & { authenticateUser: () => Promise<void> };
	admin: App.Locals['admin'];
	pb: App.Locals['pb'];
	user: Models['users'];
};

// Importing this module — even type-only — applies the augmentation below, so
// `it('...', async (context) => ...)` is typed without annotating `context`.
// @ts-ignore
declare module 'vitest' {
	interface TestContext extends TestContextType {}
}

// vitest re-exports TestContext from its runner package, and which one resolves
// has moved between releases, so both are augmented.
// @ts-ignore
declare module '@vitest/runner' {
	interface TestContext extends TestContextType {}
}

type TestContextType = TestContext;
