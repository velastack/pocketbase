import type { TestContext as TestContextType } from './types.js';

// @ts-ignore
declare module 'vitest' {
	interface TestContext extends TestContextType {}
}

// @ts-ignore
declare module '@vitest/runner' {
	interface TestContext extends TestContextType {}
}
