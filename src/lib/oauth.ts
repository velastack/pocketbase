/**
 * The app's side of [pocketbase-oauth](https://github.com/velastack/pocketbase-oauth):
 * what the consent page calls, and how a resource server (an MCP endpoint,
 * say) checks the token it was sent.
 *
 * Every function takes a PocketBase client rather than making one, so it runs
 * as whoever that client is: `locals.pb` for the signed-in user's decision,
 * `locals.admin` for introspection.
 */

/** The part of a PocketBase client these helpers use. */
export type OAuthPocketBase = {
	send: (path: string, options: Record<string, unknown>) => Promise<any>;
};

/** The OAuth parameters an authorization request may carry. */
const REQUEST_PARAMS = [
	'client_id',
	'redirect_uri',
	'response_type',
	'code_challenge',
	'code_challenge_method',
	'state',
	'scope',
	'resource'
] as const;

export type OAuthClient = {
	id: string;
	name: string;
	uri: string;
	logoUri: string;
	/** Always false today: a client names itself. Show `redirectHost` with it. */
	verified: boolean;
};

/** An authorization request that may be shown to the person. */
export type ConsentRequest = {
	ok: true;
	client: OAuthClient;
	redirectUri: string;
	/** Where the person is sent back to: the one thing a client cannot make up. */
	redirectHost: string;
	/** The scopes asked for; empty when the client named none. */
	scopes: string[];
	/** The resource (RFC 8707) the token is for, or '' when none was named. */
	resource: string;
};

/**
 * An authorization request that cannot be shown. With `redirectTo`, send the
 * browser there: the client is told what was wrong. Without it the client or
 * its redirect URI could not be trusted, so show `description` and send the
 * person nowhere.
 */
export type ConsentProblem = {
	ok: false;
	error: string;
	description: string;
	redirectTo?: string;
};

export type OAuthGrant = {
	id: string;
	client: OAuthClient;
	scopes: string[];
	resource: string;
	created: string;
	lastUsed: string;
};

/** What a valid access token stands for. */
export type AccessToken = {
	/** The record id of the user who approved the client. */
	userId: string;
	/** The auth collection that user is in. */
	collection: string;
	scopes: string[];
	clientId: string;
	grantId: string;
	/** The resource the token was issued for, or null when none was named. */
	resource: string | null;
	/** Seconds since the epoch. */
	expiresAt: number;
};

const splitScope = (scope: unknown): string[] =>
	typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];

const requestParams = (params: URLSearchParams): Record<string, string> => {
	const picked: Record<string, string> = {};
	for (const name of REQUEST_PARAMS) {
		const value = params.get(name);
		if (value !== null) picked[name] = value;
	}
	return picked;
};

/** The OAuth error body of a failed call, whichever way the client threw it. */
const oauthProblem = (error: unknown): ConsentProblem | null => {
	const body = (error as { response?: Record<string, unknown> } | null)?.response;
	if (!body || typeof body.error !== 'string') return null;
	return {
		ok: false,
		error: body.error,
		description: typeof body.error_description === 'string' ? body.error_description : body.error,
		...(typeof body.redirectTo === 'string' ? { redirectTo: body.redirectTo } : {})
	};
};

/**
 * Validate the authorization request the consent page was opened with and
 * return what to show. `params` is the page's own query; `issuer` is the
 * origin the page is served on, sent back to the client so it can tell which
 * server answered.
 */
export const describeConsent = async (
	pb: OAuthPocketBase,
	params: URLSearchParams,
	issuer: string
): Promise<ConsentRequest | ConsentProblem> => {
	try {
		const res = await pb.send('/api/oauth/consent', {
			method: 'GET',
			query: { ...requestParams(params), issuer }
		});
		return {
			ok: true,
			client: res.client,
			redirectUri: res.redirectUri,
			redirectHost: res.redirectHost,
			scopes: splitScope(res.scope),
			resource: res.resource ?? ''
		};
	} catch (error) {
		const problem = oauthProblem(error);
		if (problem) return problem;
		throw error;
	}
};

/**
 * Record the signed-in user's decision and return where to send them. `pb`
 * must be that user's client. Call it from a form action, so the app's
 * cross-site request protection covers the approval.
 *
 * `scopes` is what they agreed to when the page let them choose, or the
 * default set when the client asked for none; left out, the requested scope
 * is granted as it is.
 */
export const decideConsent = async (
	pb: OAuthPocketBase,
	params: URLSearchParams,
	decision: { approve: boolean; scopes?: string[]; issuer: string }
): Promise<{ redirectTo: string } | ConsentProblem> => {
	try {
		const res = await pb.send('/api/oauth/consent', {
			method: 'POST',
			body: {
				...requestParams(params),
				approve: decision.approve,
				issuer: decision.issuer,
				...(decision.scopes ? { granted_scope: decision.scopes.join(' ') } : {})
			}
		});
		return { redirectTo: res.redirectTo };
	} catch (error) {
		const problem = oauthProblem(error);
		if (problem) return problem;
		throw error;
	}
};

/** The clients the signed-in user has approved. */
export const listGrants = async (pb: OAuthPocketBase): Promise<OAuthGrant[]> => {
	const res = await pb.send('/api/oauth/grants', { method: 'GET' });
	return (res.items as any[]).map((item) => ({
		id: item.id,
		client: item.client,
		scopes: splitScope(item.scope),
		resource: item.resource ?? '',
		created: item.created,
		lastUsed: item.lastUsed
	}));
};

/** Revoke one of the signed-in user's grants, with every token under it. */
export const revokeGrant = async (pb: OAuthPocketBase, grantId: string): Promise<void> => {
	await pb.send(`/api/oauth/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
};

/** The token of an `Authorization: Bearer …` header, or null. */
export const bearerToken = (header: string | null): string | null => {
	const match = /^Bearer +([^\s]+)$/i.exec(header ?? '');
	return match?.[1] ?? null;
};

/**
 * Ask PocketBase what an access token stands for. `admin` must be a superuser
 * client. Returns null for a token that is unknown, expired or revoked.
 *
 * This says the token is real, not that it is yours: compare `resource` with
 * your own URL (a token issued for another server must be refused) and check
 * `scopes` for what the operation needs.
 */
export const introspectAccessToken = async (
	admin: OAuthPocketBase,
	token: string
): Promise<AccessToken | null> => {
	if (!token) return null;
	const res = await admin.send('/api/oauth/introspect', { method: 'POST', body: { token } });
	if (!res?.active) return null;
	return {
		userId: res.sub,
		collection: res.collection_name,
		scopes: splitScope(res.scope),
		clientId: res.client_id,
		grantId: res.grant_id,
		resource: typeof res.aud === 'string' ? res.aud : null,
		expiresAt: res.exp
	};
};
