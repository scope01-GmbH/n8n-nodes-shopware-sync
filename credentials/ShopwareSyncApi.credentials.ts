import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestHelper,
	INodeProperties,
} from 'n8n-workflow';

import { normalizeShopwareUrl } from '../nodes/ShopwareSync/GenericFunctions';

export class ShopwareSyncApi implements ICredentialType {
	name = 'shopwareSyncApi';

	displayName = 'Shopware Sync API';

	documentationUrl =
		'https://docs.shopware.com/en/shopware-6-en/settings/system/integrationen';

	icon = { light: 'file:../nodes/ShopwareSync/shopware.svg', dark: 'file:../nodes/ShopwareSync/shopware.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Shop URL',
			name: 'url',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://shop.example.com',
			description: 'Base URL of the Shopware 6 shop, without the /api suffix',
		},
		{
			displayName: 'Access Key ID',
			name: 'clientId',
			type: 'string',
			required: true,
			default: '',
			description:
				'Access key ID of a Shopware integration (Settings > System > Integrations)',
		},
		{
			displayName: 'Secret Access Key',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Secret access key of the Shopware integration',
		},
		{
			// Fetched by preAuthentication and refreshed automatically once expired.
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'hidden',
			typeOptions: { expirable: true, password: true },
			default: '',
		},
	];

	/**
	 * Exchanges the integration key pair for a bearer token.
	 *
	 * Shopware tokens are short lived (600s on 6.7), so this is marked expirable
	 * above and n8n re-runs it whenever a request comes back unauthorised.
	 */
	async preAuthentication(this: IHttpRequestHelper, credentials: Record<string, unknown>) {
		const url = normalizeShopwareUrl(credentials.url as string);

		const response = (await this.helpers.httpRequest({
			method: 'POST',
			url: `${url}/api/oauth/token`,
			body: {
				grant_type: 'client_credentials',
				client_id: credentials.clientId as string,
				client_secret: credentials.clientSecret as string,
			},
			headers: { 'Content-Type': 'application/json' },
			json: true,
		})) as { access_token?: string };

		if (!response?.access_token) {
			throw new Error('Shopware did not return an access token');
		}

		return { accessToken: response.access_token };
	}

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.url.replace(new RegExp("/+$"), "").replace(new RegExp("/api$"), "")}}',
			url: '/api/_info/version',
		},
	};
}
