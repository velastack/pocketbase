import { describe, it, expect } from 'vitest';
import {
	collectionsToTypes,
	collectionToJsonSchema,
	type Collection,
	type Field
} from './process-types.js';

const field = (overrides: Partial<Field> & Pick<Field, 'name' | 'type'>): Field => ({
	id: `f_${overrides.name}`,
	system: false,
	hidden: false,
	presentable: false,
	required: false,
	...overrides
});

const leads: Collection = {
	id: 'col_leads',
	name: 'leads',
	type: 'base',
	fields: [
		field({ name: 'id', type: 'text', required: true, system: true }),
		field({ name: 'name', type: 'text', required: true }),
		field({ name: 'phone', type: 'text', required: false }),
		field({ name: 'message', type: 'text', required: false })
	]
};

// Strip whitespace so structural matching isn't tripped by ts-morph's formatter.
const compact = (s: string) => s.replace(/\s+/g, ' ');

describe('collectionsToTypes', () => {
	describe('Models', () => {
		it('emits an entry per non-system collection with collectionId/collectionName literals', () => {
			const out = compact(collectionsToTypes([leads]));
			expect(out).toContain('export type Models');
			expect(out).toContain('leads:');
			expect(out).toContain('collectionId: "col_leads"');
			expect(out).toContain('collectionName: "leads"');
		});

		it('marks required fields without ? and optional fields with ?', () => {
			const out = compact(collectionsToTypes([leads]));
			// Models block — find the leads entry's required/optional rendering.
			const models = out.slice(out.indexOf('Models'));
			expect(models).toMatch(/name:\s*string/);
			expect(models).not.toMatch(/name\?:\s*string/);
			expect(models).toMatch(/phone\?:\s*string/);
			expect(models).toMatch(/message\?:\s*string/);
		});

		it('skips collections whose names start with underscore', () => {
			const out = collectionsToTypes([
				leads,
				{
					id: 'col_pb',
					name: '_pb_users_auth_',
					type: 'auth',
					fields: [field({ name: 'email', type: 'email', required: true })]
				}
			]);
			expect(out).toContain('leads:');
			expect(out).not.toContain('_pb_users_auth_');
		});

		it('renders primitive types correctly', () => {
			const all: Collection = {
				id: 'col_all',
				name: 'all_types',
				type: 'base',
				fields: [
					field({ name: 'count', type: 'number', required: true }),
					field({ name: 'active', type: 'bool', required: true }),
					field({ name: 'created', type: 'autodate', required: true }),
					field({ name: 'meta', type: 'json', required: true }),
					field({ name: 'point', type: 'geoPoint', required: true })
				]
			};
			const models = compact(collectionsToTypes([all]));
			expect(models).toMatch(/count:\s*number/);
			expect(models).toMatch(/active:\s*boolean/);
			expect(models).toMatch(/created:\s*string/);
			expect(models).toMatch(/meta:\s*any/);
			expect(models).toMatch(/point:\s*\{\s*lat:\s*number;\s*lon:\s*number\s*\}/);
		});

		it('renders select fields as union or array of union depending on maxSelect', () => {
			const c: Collection = {
				id: 'col_s',
				name: 'sel',
				type: 'base',
				fields: [
					field({
						name: 'mood',
						type: 'select',
						required: true,
						values: ['happy', 'sad'],
						maxSelect: 1
					}),
					field({
						name: 'tags',
						type: 'select',
						required: true,
						values: ['a', 'b', 'c'],
						maxSelect: 3
					})
				]
			};
			const out = compact(collectionsToTypes([c]));
			expect(out).toMatch(/mood:\s*"happy"\s*\|\s*"sad"/);
			expect(out).toMatch(/tags:\s*Array<"a"\s*\|\s*"b"\s*\|\s*"c">/);
		});

		it('renders file fields as string or string[] in Models', () => {
			const c: Collection = {
				id: 'col_f',
				name: 'docs',
				type: 'base',
				fields: [
					field({ name: 'cover', type: 'file', required: true, maxSelect: 1 }),
					field({ name: 'gallery', type: 'file', required: true, maxSelect: 5 })
				]
			};
			const models = compact(collectionsToTypes([c]));
			// Models block (before Schemas)
			const modelsBlock = models.slice(models.indexOf('Models'), models.indexOf('Schemas'));
			expect(modelsBlock).toMatch(/cover:\s*string/);
			expect(modelsBlock).toMatch(/gallery:\s*string\[\]/);
		});

		it('renders relations and an expand entry referencing the related collection', () => {
			const users: Collection = {
				id: 'col_users',
				name: 'users',
				type: 'auth',
				fields: [
					field({ name: 'id', type: 'text', required: true, system: true }),
					field({ name: 'email', type: 'email', required: true })
				]
			};
			const posts: Collection = {
				id: 'col_posts',
				name: 'posts',
				type: 'base',
				fields: [
					field({ name: 'id', type: 'text', required: true, system: true }),
					field({
						name: 'author',
						type: 'relation',
						required: true,
						maxSelect: 1,
						collectionId: 'col_users'
					}),
					field({
						name: 'editors',
						type: 'relation',
						required: false,
						maxSelect: 10,
						collectionId: 'col_users'
					})
				]
			};
			const out = compact(collectionsToTypes([users, posts]));
			const modelsBlock = out.slice(out.indexOf('Models'), out.indexOf('Schemas'));
			expect(modelsBlock).toMatch(/author:\s*string/);
			expect(modelsBlock).toMatch(/editors\?:\s*string\[\]/);
			expect(modelsBlock).toContain('expand?:');
			// editors has maxSelect > 1, so it should be array in expand
			expect(modelsBlock).toMatch(/editors:\s*\{[^}]*email:\s*string[^}]*\}\[\]/);
			// author has maxSelect === 1, so it should be a single object
			expect(modelsBlock).toMatch(/author:\s*\{[^}]*email:\s*string[^}]*\}(?!\[\])/);
		});

		it('throws when a relation references an unknown collection id', () => {
			const orphan: Collection = {
				id: 'col_orphan',
				name: 'orphan',
				type: 'base',
				fields: [
					field({
						name: 'parent',
						type: 'relation',
						required: true,
						maxSelect: 1,
						collectionId: 'does_not_exist'
					})
				]
			};
			expect(() => collectionsToTypes([orphan])).toThrow(/does_not_exist/);
		});

		it('quotes invalid identifier field names', () => {
			const c: Collection = {
				id: 'col_q',
				name: 'odd',
				type: 'base',
				fields: [
					field({ name: 'first-name', type: 'text', required: true }),
					field({ name: '1stPlace', type: 'text', required: true }),
					field({ name: 'ok_field', type: 'text', required: true })
				]
			};
			const out = compact(collectionsToTypes([c]));
			expect(out).toContain("'first-name'");
			expect(out).toContain("'1stPlace'");
			// Valid identifiers must NOT be quoted
			expect(out).not.toContain("'ok_field'");
		});
	});

	describe('Schemas (drift detection contract)', () => {
		it('emits z.ZodType<{...}> per collection', () => {
			const out = compact(collectionsToTypes([leads]));
			expect(out).toContain('export type Schemas');
			expect(out).toMatch(/leads:\s*z\.ZodType<\{/);
		});

		// This is the contract that powers `satisfies Schemas['leads']` drift detection.
		// If a PB field is required, the generated Schemas entry MUST carry no `?`,
		// forcing the user's zod schema to also produce that key as required.
		it('preserves required/optional shape so satisfies catches drift', () => {
			const out = compact(collectionsToTypes([leads]));
			const schemasBlock = out.slice(out.indexOf('Schemas'));
			// `name` is required in PB → must be required in Schemas (no `?`)
			expect(schemasBlock).toMatch(/name:\s*string\s*[;,]/);
			expect(schemasBlock).not.toMatch(/name\?:\s*string/);
			// `phone` and `message` are optional in PB → must be optional in Schemas
			expect(schemasBlock).toMatch(/phone\?:\s*string\s*[;,]/);
			expect(schemasBlock).toMatch(/message\?:\s*string\s*[;,]/);
		});

		it('always forces id to optional regardless of PB required flag', () => {
			// In `leads`, id is marked required: true above, but Schemas must still
			// emit it as optional so users can omit it from their zod schemas
			// (PocketBase generates it server-side).
			const out = compact(collectionsToTypes([leads]));
			const schemasBlock = out.slice(out.indexOf('Schemas'));
			expect(schemasBlock).toMatch(/id\?:\s*string\s*[;,]/);
			expect(schemasBlock).not.toMatch(/\bid:\s*string\s*[;,]/);
		});

		it('always emits collectionId as an optional string in Schemas', () => {
			const out = compact(collectionsToTypes([leads]));
			const schemasBlock = out.slice(out.indexOf('Schemas'));
			expect(schemasBlock).toMatch(/collectionId\?:\s*string\s*[;,]/);
		});

		it('coerces geoPoint to string in Schemas (serialized form)', () => {
			const c: Collection = {
				id: 'col_g',
				name: 'places',
				type: 'base',
				fields: [field({ name: 'loc', type: 'geoPoint', required: true })]
			};
			const out = compact(collectionsToTypes([c]));
			const modelsBlock = out.slice(out.indexOf('Models'), out.indexOf('Schemas'));
			const schemasBlock = out.slice(out.indexOf('Schemas'));
			// Models keeps the structured form
			expect(modelsBlock).toMatch(/loc:\s*\{\s*lat:\s*number;\s*lon:\s*number\s*\}/);
			// Schemas degrades to string
			expect(schemasBlock).toMatch(/loc:\s*string\s*[;,]/);
		});

		it('renders single file as string | File in Schemas (allows upload)', () => {
			const c: Collection = {
				id: 'col_f',
				name: 'docs',
				type: 'base',
				fields: [field({ name: 'cover', type: 'file', required: true, maxSelect: 1 })]
			};
			const out = compact(collectionsToTypes([c]));
			const schemasBlock = out.slice(out.indexOf('Schemas'));
			expect(schemasBlock).toMatch(/cover:\s*string\s*\|\s*File\s*[;,]/);
		});

		it('emits +/- virtual fields for multi-file uploads', () => {
			const c: Collection = {
				id: 'col_f',
				name: 'docs',
				type: 'base',
				fields: [field({ name: 'gallery', type: 'file', required: false, maxSelect: 5 })]
			};
			const out = compact(collectionsToTypes([c]));
			const schemasBlock = out.slice(out.indexOf('Schemas'));
			expect(schemasBlock).toMatch(/gallery\?:\s*string\[\]\s*[;,]/);
			expect(schemasBlock).toContain("'gallery+'");
			expect(schemasBlock).toContain("'gallery-'");
			expect(schemasBlock).toMatch(/'gallery\+'\?:\s*File\[\]\s*[;,]/);
			expect(schemasBlock).toMatch(/'gallery-'\?:\s*string\[\]\s*[;,]/);
		});
	});

	describe('Collections', () => {
		it('maps each collection to the appropriate model class', () => {
			const out = compact(
				collectionsToTypes([
					leads,
					{
						id: 'col_users',
						name: 'users',
						type: 'auth',
						fields: [field({ name: 'email', type: 'email', required: true })]
					},
					{
						id: 'col_view',
						name: 'leads_view',
						type: 'view',
						fields: [field({ name: 'name', type: 'text', required: false })]
					}
				])
			);
			const collectionsBlock = out.slice(out.indexOf('Collections'));
			expect(collectionsBlock).toMatch(/leads:\s*BaseCollectionModel/);
			expect(collectionsBlock).toMatch(/users:\s*AuthCollectionModel/);
			expect(collectionsBlock).toMatch(/leads_view:\s*ViewCollectionModel/);
		});
	});

	describe('module + imports', () => {
		it('augments @velastack/pocketbase and imports zod', () => {
			const out = collectionsToTypes([leads]);
			expect(out).toMatch(/declare module ['"]@velastack\/pocketbase['"]/);
			expect(out).toContain('AuthCollectionModel');
			expect(out).toContain('BaseCollectionModel');
			expect(out).toContain('ViewCollectionModel');
			expect(out).toMatch(/import .* from ['"]zod['"]/);
		});
	});
});

describe('collectionToJsonSchema', () => {
	it('maps primitives to JSON Schema', () => {
		const c: Collection = {
			id: 'col',
			name: 'thing',
			type: 'base',
			fields: [
				field({ name: 'title', type: 'text', required: true }),
				field({ name: 'count', type: 'number', required: false }),
				field({ name: 'active', type: 'bool', required: false })
			]
		};
		expect(collectionToJsonSchema(c)).toEqual({
			type: 'object',
			properties: {
				title: { type: 'string' },
				count: { type: 'number' },
				active: { type: 'boolean' }
			},
			required: ['title'],
			additionalProperties: false
		});
	});

	it('attaches format hints for email/url/date', () => {
		const c: Collection = {
			id: 'col',
			name: 'contact',
			type: 'base',
			fields: [
				field({ name: 'email', type: 'email', required: true }),
				field({ name: 'site', type: 'url', required: false }),
				field({ name: 'when', type: 'date', required: false }),
				field({ name: 'created', type: 'autodate', required: false })
			]
		};
		const schema = collectionToJsonSchema(c);
		expect(schema.properties.email).toEqual({ type: 'string', format: 'email' });
		expect(schema.properties.site).toEqual({ type: 'string', format: 'uri' });
		expect(schema.properties.when).toEqual({ type: 'string', format: 'date-time' });
		expect(schema.properties.created).toEqual({ type: 'string', format: 'date-time' });
	});

	it('handles select with maxSelect=1 as enum string and >1 as bounded array', () => {
		const c: Collection = {
			id: 'col',
			name: 'sel',
			type: 'base',
			fields: [
				field({
					name: 'mood',
					type: 'select',
					required: true,
					values: ['happy', 'sad'],
					maxSelect: 1
				}),
				field({
					name: 'tags',
					type: 'select',
					required: false,
					values: ['a', 'b', 'c'],
					maxSelect: 3
				})
			]
		};
		const schema = collectionToJsonSchema(c);
		expect(schema.properties.mood).toEqual({ type: 'string', enum: ['happy', 'sad'] });
		expect(schema.properties.tags).toEqual({
			type: 'array',
			items: { type: 'string', enum: ['a', 'b', 'c'] },
			maxItems: 3
		});
	});

	it('handles file/relation as string or array with maxItems', () => {
		const c: Collection = {
			id: 'col',
			name: 'mix',
			type: 'base',
			fields: [
				field({ name: 'cover', type: 'file', required: false, maxSelect: 1 }),
				field({ name: 'gallery', type: 'file', required: false, maxSelect: 5 }),
				field({ name: 'parent', type: 'relation', required: true, maxSelect: 1 }),
				field({ name: 'children', type: 'relation', required: false, maxSelect: 99 })
			]
		};
		const schema = collectionToJsonSchema(c);
		expect(schema.properties.cover).toEqual({ type: 'string' });
		expect(schema.properties.gallery).toEqual({
			type: 'array',
			items: { type: 'string' },
			maxItems: 5
		});
		expect(schema.properties.parent).toEqual({ type: 'string' });
		expect(schema.properties.children).toEqual({
			type: 'array',
			items: { type: 'string' },
			maxItems: 99
		});
	});

	it('emits geoPoint as a constrained object', () => {
		const c: Collection = {
			id: 'col',
			name: 'places',
			type: 'base',
			fields: [field({ name: 'loc', type: 'geoPoint', required: true })]
		};
		const schema = collectionToJsonSchema(c);
		expect(schema.properties.loc).toEqual({
			type: 'object',
			properties: {
				lat: { type: 'number', minimum: -90, maximum: 90 },
				lon: { type: 'number', minimum: -180, maximum: 180 }
			},
			required: ['lat', 'lon']
		});
		expect(schema.required).toEqual(['loc']);
	});

	it('renders json as the unconstrained empty schema', () => {
		const c: Collection = {
			id: 'col',
			name: 'meta',
			type: 'base',
			fields: [field({ name: 'data', type: 'json', required: true })]
		};
		const schema = collectionToJsonSchema(c);
		expect(schema.properties.data).toEqual({});
	});

	it('only lists required fields in the required[] array', () => {
		const c: Collection = {
			id: 'col',
			name: 'r',
			type: 'base',
			fields: [
				field({ name: 'a', type: 'text', required: true }),
				field({ name: 'b', type: 'text', required: false }),
				field({ name: 'c', type: 'text', required: true })
			]
		};
		expect(collectionToJsonSchema(c).required).toEqual(['a', 'c']);
	});
});
