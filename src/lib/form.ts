// Imported from the /server entry, not the package root. These are server-side
// helpers for `+page.server.ts` actions, and the root entry re-exports
// SuperDebug.svelte — which makes this module unloadable by Node whenever a
// bundler externalises it for SSR.
import { setError, type SuperValidated } from 'sveltekit-superforms/server';

export const setDefaultData = (form: SuperValidated<any, any>, record: Record<string, unknown>) => {
	Object.keys(form.data).forEach((key) => {
		if (record[key] !== undefined) {
			form.data[key] = record[key];
		}
	});
};

type PocketbaseError = {
	response: {
		data: {
			[key: string]: {
				code: string;
				message: string;
				params: Record<string, unknown>;
			};
		};
	};
};

export const setPocketbaseErrors = (form: SuperValidated<any, any>, error: unknown) => {
	let pbError = error as PocketbaseError;
	Object.entries(pbError.response.data).forEach(([key, detail]) => {
		setError(form, key, detail.message);
	});
};
