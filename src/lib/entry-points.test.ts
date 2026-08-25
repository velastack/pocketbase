import { describe, it, expect } from 'vitest';

// Bundlers externalise this package for SSR, which means Node — not Vite —
// resolves and loads these files. Anything reachable from an entry point must
// therefore be loadable by plain Node. This caught `sveltekit-superforms`'
// root entry, which re-exports SuperDebug.svelte and made /form unloadable.
const ENTRY_POINTS = [
	'../../dist/index.js',
	'../../dist/api-key.js',
	'../../dist/form.js',
	'../../dist/testing.js'
];

describe('entry points load under plain Node', () => {
	it.each(ENTRY_POINTS)('%s', async (entry) => {
		await expect(import(/* @vite-ignore */ entry)).resolves.toBeDefined();
	});
});
