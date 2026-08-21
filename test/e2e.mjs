// Minimal stand-in for n8n's IExecuteFunctions so we can drive the compiled
// node against a real Shopware instance without booting the whole n8n app.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROJECT = new URL("..", import.meta.url).pathname;
const { ShopwareSync } = require(`${PROJECT}/dist/nodes/ShopwareSync/ShopwareSync.node.js`);

const SW_URL = process.env.SW_URL;
const CLIENT_ID = process.env.SW_CLIENT_ID;
const CLIENT_SECRET = process.env.SW_CLIENT_SECRET;

if (!SW_URL || !CLIENT_ID || !CLIENT_SECRET) {
	console.error(
		'Set SW_URL, SW_CLIENT_ID and SW_CLIENT_SECRET to a disposable Shopware instance.\n' +
			'This suite writes and deletes product_manufacturer records - never point it at production.',
	);
	process.exit(2);
}

const uuid = () => randomBytes(16).toString('hex');

let cachedToken = null;
async function token() {
	if (cachedToken) return cachedToken;
	const res = await fetch(`${SW_URL}/api/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'client_credentials',
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
		}),
	});
	if (!res.ok) throw new Error(`token failed: ${res.status}`);
	cachedToken = (await res.json()).access_token;
	return cachedToken;
}

// Records every outbound sync request so we can assert on batching behaviour.
const sentRequests = [];

function makeContext({ items, params }) {
	return {
		getInputData: () => items,
		getNode: () => ({
			name: 'Shopware Sync Api',
			type: 'shopwareSync',
			typeVersion: 1,
			// The node inspects raw parameters to detect fixed-mode expressions.
			parameters: params.__rawParameters ?? {},
		}),
		continueOnFail: () => params.__continueOnFail ?? false,
		getCredentials: async () => ({
			url: SW_URL,
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
		}),
		getNodeParameter: (name, _index, fallback) => {
			if (name in params) return params[name];
			if (fallback !== undefined) return fallback;
			throw new Error(`missing param: ${name}`);
		},
		helpers: {
			httpRequestWithAuthentication: async function (_credType, options) {
				sentRequests.push({
					url: options.url,
					headers: options.headers,
					body: options.body,
				});
				const res = await fetch(options.url, {
					method: options.method,
					headers: {
						...options.headers,
						Authorization: `Bearer ${await token()}`,
					},
					body: JSON.stringify(options.body),
				});
				const text = await res.text();
				if (!res.ok) {
					const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
					err.statusCode = res.status;
					throw err;
				}
				return text ? JSON.parse(text) : {};
			},
		},
	};
}

async function run(config) {
	sentRequests.length = 0;
	const ctx = makeContext(config);
	const node = new ShopwareSync();
	const out = await node.execute.call(ctx);
	return { out: out[0], requests: [...sentRequests] };
}

async function apiSearch(entity, filters) {
	const res = await fetch(`${SW_URL}/api/search/${entity}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			// Without this Shopware answers in JSON:API format, where total lives under meta.
			Accept: 'application/json',
			Authorization: `Bearer ${await token()}`,
		},
		body: JSON.stringify({ filter: filters, limit: 50 }),
	});
	return await res.json();
}

let failures = 0;
function check(label, cond, detail = '') {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
	if (!cond) failures++;
}

// ---------------------------------------------------------------------------

const PREFIX = 'n8n-sync-test-';
const ids = [uuid(), uuid(), uuid(), uuid(), uuid()];

console.log('\n=== 1. upsert 5 manufacturers, batchSize 2 (expect 3 requests) ===');
const items = ids.map((id, i) => ({
	json: { id, name: `${PREFIX}${i}` },
}));

const upsert = await run({
	items,
	params: {
		entity: 'product_manufacturer',
		action: 'upsert',
		deleteBy: 'records',
		payloadSource: 'item',
		batchSize: 2,
		options: { indexingBehavior: 'disable-indexing' },
	},
});

check('3 HTTP requests issued', upsert.requests.length === 3, `got ${upsert.requests.length}`);
check('3 output items', upsert.out.length === 3, `got ${upsert.out.length}`);
check(
	'batch sizes are 2/2/1',
	JSON.stringify(upsert.requests.map((r) => r.body[0].payload.length)) === '[2,2,1]',
	JSON.stringify(upsert.requests.map((r) => r.body[0].payload.length)),
);
check(
	'indexing-behavior header sent',
	upsert.requests[0].headers['indexing-behavior'] === 'disable-indexing',
);
check(
	'operation shape correct',
	upsert.requests[0].body[0].entity === 'product_manufacturer' &&
		upsert.requests[0].body[0].action === 'upsert' &&
		typeof upsert.requests[0].body[0].key === 'string',
);
check('all batches reported success', upsert.out.every((o) => o.json.success === true));
check(
	'pairedItem maps first batch to items 0,1',
	JSON.stringify(upsert.out[0].pairedItem) === '[{"item":0},{"item":1}]',
	JSON.stringify(upsert.out[0].pairedItem),
);

const found = await apiSearch('product-manufacturer', [
	{ type: 'contains', field: 'name', value: PREFIX },
]);
check('5 records actually written to Shopware', found.total === 5, `total=${found.total}`);

console.log('\n=== 2. mixed entities in one stream (grouping) ===');
const mixed = await run({
	items: [
		{ json: { id: uuid(), name: `${PREFIX}mfr-a` } },
		{ json: { id: uuid(), name: `${PREFIX}mfr-b` } },
	],
	params: {
		entity: 'product_manufacturer',
		action: 'upsert',
		deleteBy: 'records',
		payloadSource: 'item',
		batchSize: 100,
		options: {},
	},
});
check('single grouped request', mixed.requests.length === 1, `got ${mixed.requests.length}`);
check('grouped payload has 2 rows', mixed.requests[0].body[0].payload.length === 2);
check(
	'pairedItem carries both source items',
	JSON.stringify(mixed.out[0].pairedItem) === '[{"item":0},{"item":1}]',
);

console.log('\n=== 3. payloadSource = field ===');
const fieldRun = await run({
	items: [{ json: { data: { id: uuid(), name: `${PREFIX}field` }, ignored: 'x' } }],
	params: {
		entity: 'product_manufacturer',
		action: 'upsert',
		deleteBy: 'records',
		payloadSource: 'field',
		payloadField: 'data',
		batchSize: 100,
		options: {},
	},
});
check(
	'only the nested object is sent',
	fieldRun.requests[0].body[0].payload[0].ignored === undefined &&
		fieldRun.requests[0].body[0].payload[0].name === `${PREFIX}field`,
);

console.log('\n=== 3b. payloadSource = json (manual mapping) ===');
const jsonId = uuid();
const jsonRun = await run({
	items: [{ json: { Internal_id: jsonId, Manufacturer_name: `${PREFIX}json`, Extra: 'ignored' } }],
	params: {
		entity: 'product_manufacturer',
		action: 'upsert',
		deleteBy: 'records',
		payloadSource: 'json',
		// n8n resolves expressions before the node sees this; emulate the resolved string.
		payloadJson: JSON.stringify({ id: jsonId, name: `${PREFIX}json` }),
		batchSize: 100,
		options: {},
	},
});
check(
	'only mapped keys are sent',
	JSON.stringify(Object.keys(jsonRun.requests[0].body[0].payload[0]).sort()) === '["id","name"]',
	JSON.stringify(Object.keys(jsonRun.requests[0].body[0].payload[0])),
);
check('json payload actually written', jsonRun.out[0].json.success === true);

console.log('\n=== 3c. payloadSource = json, array expands to several records ===');
const arrRun = await run({
	items: [{ json: {} }],
	params: {
		entity: 'product_manufacturer',
		action: 'upsert',
		deleteBy: 'records',
		payloadSource: 'json',
		payloadJson: JSON.stringify([
			{ id: uuid(), name: `${PREFIX}arr-1` },
			{ id: uuid(), name: `${PREFIX}arr-2` },
		]),
		batchSize: 100,
		options: {},
	},
});
check('one item expanded to 2 records', arrRun.requests[0].body[0].payload.length === 2);
check(
	'both records pair back to item 0',
	JSON.stringify(arrRun.out[0].pairedItem) === '[{"item":0},{"item":0}]',
	JSON.stringify(arrRun.out[0].pairedItem),
);

console.log('\n=== 3d. payloadSource = json, invalid JSON is rejected ===');
try {
	await run({
		items: [{ json: {} }],
		params: {
			entity: 'product_manufacturer',
			action: 'upsert',
			deleteBy: 'records',
			payloadSource: 'json',
			payloadJson: '{ "id": not-valid }',
			batchSize: 100,
			options: {},
		},
	});
	check('invalid JSON throws', false, 'no error thrown');
} catch (e) {
	check('invalid JSON throws NodeOperationError', e.constructor.name === 'NodeOperationError', e.constructor.name);
}

console.log('\n=== 3e. fixed-mode expressions are caught before hitting Shopware ===');
try {
	await run({
		items: [{ json: { Internal_id: 'x' } }],
		params: {
			entity: 'product_manufacturer',
			action: 'upsert',
			deleteBy: 'records',
			payloadSource: 'json',
			payloadJson: '{ "id": "{{ $json.Internal_id }}" }',
			// No leading '=', i.e. the field was left in Fixed mode.
			__rawParameters: { payloadJson: '{ "id": "{{ $json.Internal_id }}" }' },
			batchSize: 100,
			options: {},
		},
	});
	check('fixed-mode expression throws', false, 'no error thrown');
} catch (e) {
	check(
		'fixed-mode expression throws before any request',
		e.constructor.name === 'NodeOperationError' && /expression mode/.test(e.message),
		e.message,
	);
}

console.log('\n=== 3f. expression mode (leading =) is not flagged ===');
const okRun = await run({
	items: [{ json: {} }],
	params: {
		entity: 'product_manufacturer',
		action: 'upsert',
		deleteBy: 'records',
		payloadSource: 'json',
		payloadJson: JSON.stringify({ id: uuid(), name: `${PREFIX}exprmode` }),
		__rawParameters: { payloadJson: '={ "id": "{{ $json.id }}" }' },
		batchSize: 100,
		options: {},
	},
});
check('expression-mode payload passes the guard', okRun.out[0].json.success === true);

console.log('\n=== 4. error handling (invalid entity) ===');
try {
	await run({
		items: [{ json: { id: uuid() } }],
		params: {
			entity: 'this_entity_does_not_exist',
			action: 'upsert',
			deleteBy: 'records',
			payloadSource: 'item',
			batchSize: 100,
			options: {},
		},
	});
	check('invalid entity throws', false, 'no error thrown');
} catch (e) {
	check('invalid entity throws NodeApiError', e.constructor.name === 'NodeApiError', e.constructor.name);
}

console.log('\n=== 5. continueOnFail collects the error instead of throwing ===');
const soft = await run({
	items: [{ json: { id: uuid() } }],
	params: {
		entity: 'this_entity_does_not_exist',
		action: 'upsert',
		deleteBy: 'records',
		payloadSource: 'item',
		batchSize: 100,
		options: {},
		__continueOnFail: true,
	},
});
check('error item emitted', soft.out.length === 1 && soft.out[0].json.success === false);
check('error message present', typeof soft.out[0].json.error === 'string' && soft.out[0].json.error.length > 0);

console.log('\n=== 6. delete by criteria (cleanup) ===');
const del = await run({
	items: [{ json: {} }],
	params: {
		entity: 'product_manufacturer',
		action: 'delete',
		deleteBy: 'criteria',
		criteria: JSON.stringify([{ type: 'contains', field: 'name', value: PREFIX }]),
		options: {},
	},
});
check('single delete request', del.requests.length === 1);
check('criteria sent, no payload', Array.isArray(del.requests[0].body[0].criteria) && del.requests[0].body[0].payload === undefined);

const after = await apiSearch('product-manufacturer', [
	{ type: 'contains', field: 'name', value: PREFIX },
]);
check('all test records removed', after.total === 0, `remaining=${after.total}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
