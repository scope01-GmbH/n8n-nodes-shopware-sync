import type { IDataObject } from 'n8n-workflow';

/**
 * Normalises a user supplied shop URL into a usable API base URL.
 *
 * Accepts values like `sw67.local`, `http://sw67.local/`, `https://shop.example.com/api`
 * and always returns an origin without a trailing slash and without a trailing `/api`.
 */
export function normalizeShopwareUrl(raw: string): string {
	let url = (raw ?? '').trim();

	if (url === '') {
		throw new Error('Shopware URL is empty');
	}

	if (!/^https?:\/\//i.test(url)) {
		url = `https://${url}`;
	}

	url = url.replace(/\/+$/, '');
	url = url.replace(/\/api$/i, '');

	return url;
}

/** Splits an array into chunks of at most `size` entries. */
export function chunk<T>(input: T[], size: number): T[][] {
	if (size < 1) {
		throw new Error('Batch size must be at least 1');
	}

	const out: T[][] = [];
	for (let i = 0; i < input.length; i += size) {
		out.push(input.slice(i, i + size));
	}

	return out;
}

/**
 * A single operation as accepted by `POST /api/_action/sync`.
 *
 * Shopware validates that `entity` is a non-empty string, that `action` is one of
 * `upsert`/`delete`, and that at least one of `payload`/`criteria` is non-empty.
 */
export interface ShopwareSyncOperation {
	key: string;
	entity: string;
	action: 'upsert' | 'delete';
	payload?: IDataObject[];
	criteria?: IDataObject[];
}

/** Shape of the `SyncResult` struct Shopware returns from the sync endpoint. */
export interface ShopwareSyncResult {
	data?: IDataObject;
	notFound?: IDataObject[];
	deleted?: IDataObject[];
	extensions?: IDataObject;
}

/**
 * Pairs a sync operation with the input item indexes that fed it, so the node
 * can emit correct `pairedItem` links. Batching is many-to-one: one operation
 * usually descends from many input items.
 */
export interface PreparedOperation {
	operation: ShopwareSyncOperation;
	sourceItems: number[];
}

/**
 * Groups input records into sync operations, one group per entity+action pair,
 * then splits each group into batches of at most `batchSize` records.
 *
 * Grouping keeps the request count low when a workflow mixes entities in one
 * stream (a common shape when reading a denormalised CSV), while batching keeps
 * individual requests small enough for Shopware to handle.
 */
export function buildOperations(
	records: Array<{
		entity: string;
		action: 'upsert' | 'delete';
		payload: IDataObject;
		itemIndex: number;
	}>,
	batchSize: number,
): PreparedOperation[] {
	const groups = new Map<
		string,
		{
			entity: string;
			action: 'upsert' | 'delete';
			rows: IDataObject[];
			itemIndexes: number[];
		}
	>();

	for (const record of records) {
		const groupKey = `${record.action}:${record.entity}`;
		const existing = groups.get(groupKey);

		if (existing === undefined) {
			groups.set(groupKey, {
				entity: record.entity,
				action: record.action,
				rows: [record.payload],
				itemIndexes: [record.itemIndex],
			});
		} else {
			existing.rows.push(record.payload);
			existing.itemIndexes.push(record.itemIndex);
		}
	}

	const prepared: PreparedOperation[] = [];

	for (const group of groups.values()) {
		const batches = chunk(group.rows, batchSize);
		const indexBatches = chunk(group.itemIndexes, batchSize);

		batches.forEach((rows, index) => {
			prepared.push({
				operation: {
					key:
						batches.length === 1
							? `${group.action}-${group.entity}`
							: `${group.action}-${group.entity}-${index}`,
					entity: group.entity,
					action: group.action,
					payload: rows,
				},
				sourceItems: indexBatches[index],
			});
		});
	}

	return prepared;
}

/**
 * Detects a JSON parameter left in fixed mode while containing n8n expressions.
 *
 * n8n only evaluates `{{ ... }}` when the parameter is in expression mode, which
 * it stores with a leading `=`. Without it the placeholders travel to Shopware as
 * literal text and come back as an opaque write-constraint violation, so it is
 * worth catching here and saying what to do about it.
 */
export function hasUnresolvedExpression(rawParameter: unknown): boolean {
	if (typeof rawParameter !== 'string') return false;
	if (rawParameter.startsWith('=')) return false;

	// Require a variable reference ($json, $node, ...) so literal braces in
	// content are not mistaken for a mapping mistake.
	return /\{\{\s*\$/.test(rawParameter);
}
