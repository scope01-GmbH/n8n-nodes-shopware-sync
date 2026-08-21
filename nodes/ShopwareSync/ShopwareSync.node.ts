import type {
	JsonObject,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, jsonParse } from 'n8n-workflow';

import {
	buildOperations,
	hasUnresolvedExpression,
	normalizeShopwareUrl,
	type PreparedOperation,
	type ShopwareSyncResult,
} from './GenericFunctions';

export class ShopwareSync implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Shopware Sync Api',
		name: 'shopwareSync',
		icon: { light: 'file:shopware.svg', dark: 'file:shopware.dark.svg' },
		group: ['output'],
		version: [1],
		subtitle: '={{ $parameter["action"] + ": " + $parameter["entity"] }}',
		description: 'Bulk upsert or delete Shopware 6 records through the Sync API',
		defaults: {
			name: 'Shopware Sync Api',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'shopwareSyncApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Entity',
				name: 'entity',
				type: 'string',
				required: true,
				default: 'product',
				placeholder: 'product',
				description:
					'Technical name of the Shopware entity to write, e.g. product, category, customer or product_manufacturer',
			},
			{
				displayName: 'Action',
				name: 'action',
				type: 'options',
				options: [
					{
						name: 'Create or Update',
						value: 'upsert',
						description: 'Create a new record, or update the current one if it already exists (upsert)',
						action: 'Create records or update them when the id already exists',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete records by ID or by filter criteria',
						action: 'Delete records by ID or by filter criteria',
					},
				],
				default: 'upsert',
			},
			{
				displayName: 'Delete By',
				name: 'deleteBy',
				type: 'options',
				displayOptions: {
					show: {
						action: ['delete'],
					},
				},
				options: [
					{
						name: 'Records From Input',
						value: 'records',
						description: 'Delete the records supplied by the incoming items, usually just their IDs',
					},
					{
						name: 'Filter Criteria',
						value: 'criteria',
						description:
							'Delete every record matching a filter, without needing to know the IDs. Sent as a single request.',
					},
				],
				default: 'records',
			},
			{
				displayName: 'Criteria',
				name: 'criteria',
				type: 'json',
				required: true,
				typeOptions: {
					alwaysOpenEditWindow: true,
					rows: 8,
				},
				displayOptions: {
					show: {
						action: ['delete'],
						deleteBy: ['criteria'],
					},
				},
				default: '[\n  {\n    "type": "equals",\n    "field": "active",\n    "value": false\n  }\n]',
				description:
					'Array of Shopware DAL filters. Every record matching all filters is deleted.',
			},
			{
				displayName: 'Payload Source',
				name: 'payloadSource',
				type: 'options',
				displayOptions: {
					hide: {
						action: ['delete'],
						deleteBy: ['criteria'],
					},
				},
				options: [
					{
						name: 'Input Item',
						value: 'item',
						description: 'Use the whole incoming item as one Shopware record',
					},
					{
						name: 'Field of Input Item',
						value: 'field',
						description: 'Use one field of the incoming item, which must hold an object',
					},
					{
						name: 'JSON',
						value: 'json',
						description:
							'Write the record yourself and map fields with expressions, like the JSON body of an HTTP Request node',
					},
				],
				default: 'item',
			},
			{
				displayName: 'Payload (JSON)',
				name: 'payloadJson',
				type: 'json',
				required: true,
				typeOptions: {
					// The inline result preview is a single truncated line; the edit window
					// shows the fully resolved record next to the template.
					alwaysOpenEditWindow: true,
					rows: 12,
				},
				displayOptions: {
					show: {
						payloadSource: ['json'],
					},
					hide: {
						action: ['delete'],
						deleteBy: ['criteria'],
					},
				},
				// Leading '=' puts the field in expression mode, so {{ }} is evaluated.
				default:
					'={\n  "id": "{{ $json.id }}",\n  "name": "{{ $json.name }}"\n}',
				description:
					'One Shopware record, evaluated once per incoming item. Supply an array to emit several records from a single item. Do not wrap it in entity/action/payload - those come from the fields above.',
			},
			{
				displayName: 'Payload Field',
				name: 'payloadField',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						payloadSource: ['field'],
					},
					hide: {
						action: ['delete'],
						deleteBy: ['criteria'],
					},
				},
				default: 'data',
				description: 'Name of the field holding the Shopware record',
			},
			{
				displayName: 'Batch Size',
				name: 'batchSize',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				displayOptions: {
					hide: {
						action: ['delete'],
						deleteBy: ['criteria'],
					},
				},
				default: 100,
				description:
					'How many records to send per request. Incoming items are grouped by entity and split into batches of this size.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Indexing Behavior',
						name: 'indexingBehavior',
						type: 'options',
						options: [
							{
								name: 'Index Immediately',
								value: '',
								description: 'Shopware default. Slowest, but the storefront is correct right away.',
							},
							{
								name: 'Queue Indexing',
								value: 'use-queue-indexing',
								description: 'Defer indexing to the message queue. Much faster for large imports.',
							},
							{
								name: 'Disable Indexing',
								value: 'disable-indexing',
								description:
									'Skip indexing entirely. Fastest, but you must run bin/console dal:refresh:index afterwards.',
							},
						],
						default: '',
					},
					{
						displayName: 'Skip Indexers',
						name: 'skipIndexers',
						type: 'string',
						default: '',
						placeholder: 'product.indexer,category.indexer',
						description: 'Comma-separated list of indexers to skip',
					},
					{
						displayName: 'Only Indexers',
						name: 'onlyIndexers',
						type: 'string',
						default: '',
						placeholder: 'product.indexer',
						description: 'Comma-separated list restricting indexing to these indexers only',
					},
					{
						displayName: 'Simplify',
						name: 'simplify',
						type: 'boolean',
						default: true,
						description:
							'Whether to return one compact summary per batch instead of the raw Shopware response',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('shopwareSyncApi');
		const baseUrl = normalizeShopwareUrl(credentials.url as string);

		const options = this.getNodeParameter('options', 0, {}) as IDataObject;
		const simplify = (options.simplify as boolean) ?? true;

		// Indexing controls are request headers, not part of the JSON body.
		const headers: IDataObject = { 'Content-Type': 'application/json' };
		const indexingBehavior = (options.indexingBehavior as string) ?? '';
		if (indexingBehavior !== '') {
			headers['indexing-behavior'] = indexingBehavior;
		}
		const skipIndexers = ((options.skipIndexers as string) ?? '').trim();
		if (skipIndexers !== '') {
			headers['indexing-skip'] = skipIndexers;
		}
		const onlyIndexers = ((options.onlyIndexers as string) ?? '').trim();
		if (onlyIndexers !== '') {
			headers['indexing-only'] = onlyIndexers;
		}

		const action = this.getNodeParameter('action', 0) as 'upsert' | 'delete';
		const deleteBy = this.getNodeParameter('deleteBy', 0, 'records') as string;
		const isCriteriaDelete = action === 'delete' && deleteBy === 'criteria';

		let prepared: PreparedOperation[];

		if (isCriteriaDelete) {
			// Criteria deletes describe the whole job in one operation, so the input
			// items only decide whether the node runs at all.
			const entity = this.getNodeParameter('entity', 0) as string;
			if (hasUnresolvedExpression(this.getNode().parameters.criteria)) {
				throw new NodeOperationError(
					this.getNode(),
					'Criteria contains {{ ... }} but is not in expression mode',
					{
						itemIndex: 0,
						description:
							'Hover the Criteria field and switch it from Fixed to Expression, otherwise the placeholders are sent to Shopware as literal text.',
					},
				);
			}

			const rawCriteria = this.getNodeParameter('criteria', 0) as string | IDataObject[];

			let criteria: IDataObject[];
			try {
				criteria =
					typeof rawCriteria === 'string'
						? jsonParse<IDataObject[]>(rawCriteria)
						: rawCriteria;
			} catch {
				throw new NodeOperationError(this.getNode(), 'Criteria is not valid JSON', {
					itemIndex: 0,
				});
			}

			if (!Array.isArray(criteria) || criteria.length === 0) {
				throw new NodeOperationError(
					this.getNode(),
					'Criteria must be a non-empty array of Shopware DAL filters',
					{ itemIndex: 0 },
				);
			}

			prepared = [
				{
					operation: {
						key: `delete-${entity}`,
						entity,
						action: 'delete',
						criteria,
					},
					// A criteria delete is not derived from any particular item.
					sourceItems: items.map((_, index) => index),
				},
			];
		} else {
			const batchSize = this.getNodeParameter('batchSize', 0, 100) as number;
			const records: Array<{
				entity: string;
				action: 'upsert' | 'delete';
				payload: IDataObject;
				itemIndex: number;
			}> = [];

			for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
				// Entity and action are read per item so they can be driven by expressions.
				const entity = (this.getNodeParameter('entity', itemIndex) as string).trim();
				const itemAction = this.getNodeParameter('action', itemIndex) as 'upsert' | 'delete';
				const payloadSource = this.getNodeParameter('payloadSource', itemIndex, 'item') as string;

				if (entity === '') {
					throw new NodeOperationError(this.getNode(), 'Entity must not be empty', { itemIndex });
				}

				if (payloadSource === 'json') {
					// Read per item so expressions inside the JSON resolve against that item.
					if (hasUnresolvedExpression(this.getNode().parameters.payloadJson)) {
						throw new NodeOperationError(
							this.getNode(),
							'Payload (JSON) contains {{ ... }} but is not in expression mode',
							{
								itemIndex,
								description:
									'Hover the Payload (JSON) field and switch it from Fixed to Expression, otherwise the placeholders are sent to Shopware as literal text.',
							},
						);
					}

					const raw = this.getNodeParameter('payloadJson', itemIndex) as string | IDataObject | IDataObject[];

					let parsed: IDataObject | IDataObject[];
					try {
						parsed = typeof raw === 'string' ? jsonParse<IDataObject | IDataObject[]>(raw) : raw;
					} catch {
						throw new NodeOperationError(
							this.getNode(),
							'Payload (JSON) is not valid JSON after resolving expressions',
							{ itemIndex },
						);
					}

					// An array lets one input item expand into several Shopware records.
					const rows = Array.isArray(parsed) ? parsed : [parsed];

					if (rows.length === 0) {
						throw new NodeOperationError(this.getNode(), 'Payload (JSON) is an empty array', {
							itemIndex,
						});
					}

					for (const row of rows) {
						if (row === null || typeof row !== 'object' || Array.isArray(row)) {
							throw new NodeOperationError(
								this.getNode(),
								'Payload (JSON) must be an object, or an array of objects',
								{ itemIndex },
							);
						}

						records.push({ entity, action: itemAction, payload: row, itemIndex });
					}

					continue;
				}

				let payload: IDataObject;
				if (payloadSource === 'field') {
					const field = this.getNodeParameter('payloadField', itemIndex) as string;
					const value = items[itemIndex].json[field];

					if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
						throw new NodeOperationError(
							this.getNode(),
							`Field "${field}" does not contain an object`,
							{ itemIndex },
						);
					}

					payload = value as IDataObject;
				} else {
					payload = items[itemIndex].json;
				}

				records.push({ entity, action: itemAction, payload, itemIndex });
			}

			prepared = buildOperations(records, batchSize);
		}

		for (const { operation, sourceItems } of prepared) {
			const pairedItem = sourceItems.map((item) => ({ item }));
			const requestOptions: IHttpRequestOptions = {
				method: 'POST',
				url: `${baseUrl}/api/_action/sync`,
				body: [operation],
				headers,
				json: true,
			};

			try {
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'shopwareSyncApi',
					requestOptions,
				)) as ShopwareSyncResult;

				if (simplify) {
					returnData.push({
						json: {
							key: operation.key,
							entity: operation.entity,
							action: operation.action,
							records: operation.payload?.length ?? 0,
							success: true,
							notFound: response?.notFound ?? [],
							deleted: response?.deleted ?? [],
						},
						pairedItem,
					});
				} else {
					returnData.push({ json: response as unknown as IDataObject, pairedItem });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							key: operation.key,
							entity: operation.entity,
							action: operation.action,
							records: operation.payload?.length ?? 0,
							success: false,
							error: (error as Error).message,
						},
						pairedItem,
					});
					continue;
				}

				throw new NodeApiError(this.getNode(), error as JsonObject, {
					message: `Shopware sync failed for operation "${operation.key}"`,
				});
			}
		}

		return [returnData];
	}
}
