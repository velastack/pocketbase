import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Bundlers externalise packages for SSR unless told otherwise, which means
// Node — not Vite — resolves and loads these files. Anything reachable from
// these entry points must therefore be loadable by plain Node. This caught
// `sveltekit-superforms`' root entry, which re-exports SuperDebug.svelte and
// made /form unloadable.
const NODE_ENTRY_POINTS = ['../../dist/index.js', '../../dist/api-key.js', '../../dist/testing.js'];

describe('entry points load under plain Node', () => {
	it.each(NODE_ENTRY_POINTS)('%s', async (entry) => {
		await expect(import(/* @vite-ignore */ entry)).resolves.toBeDefined();
	});
});

// superforms 3's /server entry starts with `import '$app/server'`, a module
// only SvelteKit's Vite plugin can resolve. /form is therefore Vite-only: plain
// Node rejects it, and an app has to bundle it for SSR rather than externalise
// it.
const FORM_ENTRY = '../../dist/form.js';

describe('/form is Vite-only', () => {
	it('rejects under plain Node on $app/server', async () => {
		await expect(import(/* @vite-ignore */ FORM_ENTRY)).rejects.toThrow(
			/Cannot find package '\$app'/
		);
	});

	// vite-plugin-svelte (through vitefu) puts every dependency whose `exports`
	// has a `svelte` condition into `ssr.noExternal`, so Vite bundles /form and
	// resolves `$app/server` itself.
	it('has a svelte export condition, so vite-plugin-svelte bundles it for SSR', () => {
		const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
		expect(pkg.exports['./form']).toEqual({
			types: './dist/form.d.ts',
			svelte: './dist/form.js',
			default: './dist/form.js'
		});
	});
});
