import PocketbaseSvelte, {
	type RecordService,
	type CollectionService,
	type CommonOptions
} from 'pocketbase-sveltekit';

import { type Agent } from 'supertest';

// This is generated and written to .svelte-kit/types/pocketbase/$types.d.ts
// @ts-ignore
import type { Models, Collections } from '@velastack/pocketbase';

// Type functions where we can return types
declare class CollectionsCrudService extends CollectionService {
	getOne<C extends keyof Collections>(id: C, options?: CommonOptions): Promise<Collections[C]>;

	update<C extends keyof Collections>(
		id: C,
		bodyParams?:
			| {
					[key: string]: any;
			  }
			| FormData,
		options?: CommonOptions
	): Promise<Collections[C]>;

	delete(id: keyof Collections, options?: CommonOptions): Promise<boolean>;
}

declare class Client extends PocketbaseSvelte {
	collections: CollectionsCrudService;
	collection<OverrideType = never, TId extends keyof Models = keyof Models>(
		idOrName: TId
	): RecordService<[OverrideType] extends [never] ? Models[TId] : OverrideType>;
}

declare global {
	namespace App {
		interface Locals {
			pb: Client;
			admin: Client;
			team: string;
			role: string;
			meta: {
				appName: string;
				appURL: string;
				senderName: string;
				senderAddress: string;
				hideControls: boolean;
			};
		}
	}
}

declare module '$env/dynamic/private' {
	export const POCKETBASE_URL: string;
}

type StripGroups<S extends string> =
	// group at start: "/(foo)/rest" → "/rest"
	S extends `/${`(${string})`}/${infer Rest}`
		? `/${StripGroups<Rest>}`
		: // group at start, no trailing slash: "/(foo)" → "/"
			S extends `/${`(${string})`}`
			? '/'
			: // group in middle: ".../(foo)/rest" → ".../rest"
				S extends `${infer Head}/${`(${string})`}/${infer Tail}`
				? `${Head}/${StripGroups<Tail>}`
				: // group at end: ".../(foo)" → "..."
					S extends `${infer Head}/${`(${string})`}`
					? Head
					: // otherwise no groups
						S;

type Normalize<S extends string> = S extends `${infer Start}[${string}]${infer Rest}`
	? `${Start}${string}${Normalize<Rest>}`
	: S;

export type Match<R extends string> = Normalize<StripGroups<R>>;

export type TestContext = {
	request: Agent;
	agent: Agent & { authenticateUser: () => Promise<void> };
	admin: App.Locals['admin'];
	pb: App.Locals['pb'];
	user: Models['users'];
};
