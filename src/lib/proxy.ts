import type { RequestEvent } from '@sveltejs/kit';

export const proxy = async (urlPath: string, event: RequestEvent) => {
	const proxiedUrl = new URL(urlPath);

	event.request.headers.delete('connection');

	event.request.headers.delete('host');
	event.request.headers.append('host', proxiedUrl.hostname);

	event.request.headers.delete('accept-encoding');
	event.request.headers.append('accept-encoding', 'identity');

	event.request.headers.delete('content-length');

	const res = await fetch(proxiedUrl, {
		method: event.request.method,
		headers: event.request.headers,
		body: event.request.body,
		...(event.request.body
			? {
					duplex: 'half'
				}
			: {})
	});

	// TODO: Maybe handle errors with our own error page

	return new Response(res.body, {
		headers: res.headers,
		status: res.status,
		statusText: res.statusText
	});
};
