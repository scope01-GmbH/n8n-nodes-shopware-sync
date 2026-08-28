import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeShopwareErrors } from '../dist/nodes/ShopwareSync/GenericFunctions.js';

// Captured from a real rejected sync: a create missing its mandatory fields.
const validation = {
	response: {
		body: {
			errors: [
				{
					code: 'c1051bb4-d103-4f74-8988-acbcafc7fdc3',
					status: '400',
					detail: 'This value should not be blank.',
					source: { pointer: '/upsert-product/0/taxId' },
				},
				{
					code: 'c1051bb4-d103-4f74-8988-acbcafc7fdc3',
					status: '400',
					detail: 'This value should not be blank.',
					source: { pointer: '/upsert-product/0/price' },
				},
			],
		},
	},
};

// Captured from a delete-by-criteria against a shop with ProductBundles.
const forbidden = {
	cause: {
		body: {
			errors: [
				{
					code: '0',
					status: '403',
					title: 'Forbidden',
					detail:
						'Read access to nested association "bundleSalesChannels" on entity "product" not allowed for scope "crud".',
				},
			],
		},
	},
};

test('names the offending field on a validation failure', () => {
	const text = describeShopwareErrors(validation);

	assert.match(text, /This value should not be blank\./);
	assert.match(text, /at \/upsert-product\/0\/taxId/);
	assert.match(text, /at \/upsert-product\/0\/price/);
});

test('surfaces the reason behind a 403 instead of blaming credentials', () => {
	const text = describeShopwareErrors(forbidden);

	assert.match(text, /bundleSalesChannels/);
	assert.doesNotMatch(text, /credential/i);
});

test('caps a long list and counts the remainder', () => {
	const many = {
		body: {
			errors: Array.from({ length: 40 }, (_, i) => ({
				detail: 'This value should not be blank.',
				source: { pointer: `/upsert-product/${i}/taxId` },
			})),
		},
	};

	const text = describeShopwareErrors(many);

	assert.equal(text.split(';').length, 6, 'five entries plus the remainder line');
	assert.match(text, /and 35 more$/);
});

test('falls back to title when detail is absent', () => {
	assert.equal(describeShopwareErrors({ errors: [{ title: 'Forbidden' }] }), 'Forbidden');
});

test('returns undefined when there is nothing to report', () => {
	assert.equal(describeShopwareErrors(new Error('socket hang up')), undefined);
	assert.equal(describeShopwareErrors(undefined), undefined);
	assert.equal(describeShopwareErrors({ response: {} }), undefined);
});
