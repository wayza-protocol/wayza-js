import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class WayzaApi implements ICredentialType {
	name = 'wayzaApi';

	displayName = 'Wayza API';

	documentationUrl = 'https://wayza.com';

	icon = { light: 'file:../nodes/Wayza/wayza.svg', dark: 'file:../nodes/Wayza/wayza.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: "Your agent's Wayza connector key (starts with fam_) or an OAuth access token",
		},
		{
			displayName: 'Home URL',
			name: 'home',
			type: 'string',
			default: 'https://wayza.com',
			required: true,
			description: 'The Wayza home this key belongs to. Answers must be signed by this home.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.home.replace(/\\/+$/, "")}}/wayza/v0',
			url: '/approvals',
			method: 'GET',
		},
	};
}
