import type { RequestEvent } from '@sveltejs/kit';
import PocketBase from 'pocketbase-sveltekit';

type Config = {
	adminPath: string;
};

export const authRefresh = async (config: Config, event: RequestEvent) => {
	const pb = new PocketBase(config.adminPath, null, 'en-US', event.fetch);
	pb.authStore.loadFromCookie(event.request.headers.get('cookie') || '');

	if (pb.authStore.isValid) {
		try {
			await pb.collection('users').authRefresh();
		} catch (e) {
			pb.authStore.clear();
		}
	}

	const response = new Response('OK');

	response.headers.append(
		'set-cookie',
		pb.authStore.exportToCookie({
			sameSite: 'Lax'
		})
	);

	return response;
};
