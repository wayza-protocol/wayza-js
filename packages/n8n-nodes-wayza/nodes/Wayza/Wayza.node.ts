import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	WAIT_INDEFINITELY,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject as N8nJsonObject,
} from 'n8n-workflow';

import {
	askBody,
	checkAnswer,
	expiresAtFrom,
	parseCallback,
	requirePerson,
	resultFrom,
	sentAsk,
	splitList,
	VerifyError,
	type AskInput,
	type JsonObject,
	type SentAsk,
} from './wayza';

// Keep in step with package.json (a test checks it).
export const VERSION = '0.1.3';
const USER_AGENT = `n8n-nodes-wayza/${VERSION}`;

// The { error } text Wayza sent with a failed request, wherever this n8n version put the response.
function wayzaReason(error: unknown): string | undefined {
	type Res = { data?: unknown; body?: unknown };
	const e = error as { response?: Res; cause?: { response?: Res }; context?: { data?: unknown } };
	// n8n's own NodeApiError keeps the response body in context.data.
	for (const r of [e?.response, e?.cause?.response, { data: e?.context?.data }]) {
		for (let d of [r?.data, r?.body]) {
			if (typeof d === 'string') {
				try {
					d = JSON.parse(d);
				} catch {
					continue;
				}
			}
			const msg = (d as { error?: unknown } | undefined)?.error;
			if (typeof msg === 'string' && msg) return msg;
		}
	}
	return undefined;
}

const UNIT_SECONDS: Record<string, number> = { minutes: 60, hours: 3600, days: 86400 };

interface Creds {
	apiKey: string;
	home: string;
}

function base(home: string): string {
	return `${String(home || 'https://wayza.com').replace(/\/+$/, '')}/wayza/v0`;
}

// The ask a waiting execution sent, kept in the node's static data until its answer arrives.
const PENDING_KEY = (executionId: string) => `wayza:${executionId}`;
const PENDING_MAX_AGE_MS = 32 * 86400e3; // asks expire within 30 days
// The same ask, also kept in the execution's custom data: n8n (2.x) resumes a waiting webhook with the
// workflow as it was when the execution started, so static data saved while waiting isn't there on resume.
const CUSTOM_KEY = (nodeId: string) => `wayza_${nodeId.replace(/[^A-Za-z0-9_]/g, '')}`.slice(0, 50);
type CustomData = { get(key: string): unknown; set(key: string, value: string): void };
const customDataOf = (ctx: unknown): CustomData | undefined => {
	try {
		return (ctx as { customData?: CustomData }).customData;
	} catch {
		return undefined; // no execution data in this context
	}
};

interface PendingAsk extends SentAsk {
	at: number;
}

// Not a trigger: the webhook below is this execution's resume URL (like n8n's own "send and wait" nodes),
// handed to Wayza with each ask, so there is nothing to register or delete on Wayza.
// eslint-disable-next-line @n8n/community-nodes/webhook-lifecycle-complete
export class Wayza implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Wayza: Ask a person',
		name: 'wayza',
		icon: { light: 'file:wayza.svg', dark: 'file:wayza.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["mode"] === "send" ? "Send and continue" : "Ask and wait" }}',
		description: 'Ask a real person (or another agent) through Wayza and continue on their signed answer',
		defaults: { name: 'Ask a person' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'wayzaApi', required: true }],
		usableAsTool: true,
		// Resumed by the Wayza callback, like n8n's own "send and wait" nodes.
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				responseData: '',
				path: '={{ $nodeId }}',
				restartWebhook: true,
				isFullPath: true,
			},
		],
		waitingNodeTooltip:
			'={{ $parameter["mode"] === "send" ? "" : "Waiting for the person to answer in Wayza" }}',
		properties: [
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Ask and Wait for the Answer',
						value: 'sendAndWait',
						description: 'Pause the workflow until the person answers, then output the signed answer',
						action: 'Ask a person and wait for the answer',
					},
					{
						name: 'Send and Continue',
						value: 'send',
						description: 'Send the ask and continue at once with the approval (status "waiting")',
						action: 'Send an ask and continue',
					},
				],
				default: 'sendAndWait',
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Refund £40 to order 1182?',
				description: 'The question, at most 200 characters',
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'graham@wayza.com, @ai-1f2e3d4c, someone@example.com',
				description:
					'Wayza addresses, @handles or emails, comma-separated. Another agent\'s address works too; the output\'s "as" says whether a person or an AI answered.',
			},
			{
				displayName: 'Details',
				name: 'details',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'Optional context, at most 2000 characters',
			},
			{
				displayName: 'Answer Type',
				name: 'answerType',
				type: 'options',
				options: [
					{ name: 'Approve or Decline', value: 'approval' },
					{ name: 'Pick a Choice', value: 'choices' },
					{ name: 'Typed Answer', value: 'freeText' },
				],
				default: 'approval',
			},
			{
				displayName: 'Choices',
				name: 'choices',
				type: 'string',
				default: '',
				placeholder: 'Full refund, Half, No',
				description: '2 to 10 options, comma-separated, each up to 100 characters',
				displayOptions: { show: { answerType: ['choices'] } },
			},
			{
				displayName: 'Also Allow a Typed Answer',
				name: 'allowText',
				type: 'boolean',
				default: false,
				displayOptions: { show: { answerType: ['choices'] } },
			},
			{
				displayName: 'Needs',
				name: 'needs',
				type: 'options',
				options: [
					{ name: 'Any One Person', value: 'any' },
					{ name: 'Everyone', value: 'all' },
				],
				default: 'any',
			},
			{
				displayName: 'Require a Person',
				name: 'requirePerson',
				type: 'boolean',
				default: true,
				description:
					'Whether only a human\'s answer can approve. When on, an approval given by an AI ("as" is ai, ai-on-behalf or ai-unclaimed) is output as approved: false with a "reason". Turn off only if an AI\'s approval is enough.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Limit Wait Time',
						name: 'limitWaitTime',
						type: 'fixedCollection',
						default: {},
						description: 'Expire the ask (and stop waiting) after this long. At most 30 days.',
						options: [
							{
								displayName: 'Values',
								name: 'values',
								values: [
									{ displayName: 'Amount', name: 'amount', type: 'number', typeOptions: { minValue: 1 }, default: 24 },
									{
										displayName: 'Unit',
										name: 'unit',
										type: 'options',
										options: [
											{ name: 'Minutes', value: 'minutes' },
											{ name: 'Hours', value: 'hours' },
											{ name: 'Days', value: 'days' },
										],
										default: 'hours',
									},
								],
							},
						],
					},
					{
						displayName: 'Request ID',
						name: 'requestId',
						type: 'string',
						default: '',
						description:
							'Idempotency key. A repeat returns the same approval. Defaults to a hash of the ask and this execution.',
					},
					{
						displayName: 'Callback URL',
						name: 'callback',
						type: 'string',
						default: '',
						description:
							'Send and Continue only: an https URL Wayza POSTs the signed result to once settled',
					},
					{
						displayName: 'Allow HTTP Home (Dev Only)',
						name: 'insecure',
						type: 'boolean',
						default: false,
						description: 'Whether to accept answers signed by an http:// home, e.g. a local dev server',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const mode = this.getNodeParameter('mode', 0) as string;
		const creds = (await this.getCredentials('wayzaApi')) as unknown as Creds;
		const call = async (method: IHttpRequestMethods, path: string, body?: JsonObject): Promise<JsonObject> => {
			try {
				return (await this.helpers.httpRequestWithAuthentication.call(this, 'wayzaApi', {
					method,
					url: base(creds.home) + path,
					headers: { 'User-Agent': USER_AGENT },
					body,
					json: true,
				})) as JsonObject;
			} catch (error) {
				// Show Wayza's own reason (e.g. "@x is an AI with no owner too"), not just n8n's "Bad request".
				const reason = wayzaReason(error);
				// n8n's request helper already throws a NodeApiError, and new NodeApiError(node, thatError, {message})
				// returns thatError unchanged and ignores the message. So set the reason on the error itself.
				if (error instanceof NodeApiError || (error as Error)?.constructor?.name === 'NodeApiError') {
					const apiError = error as NodeApiError;
					if (reason) {
						apiError.message = reason;
						apiError.description = `Wayza refused the request${apiError.httpCode ? ` (HTTP ${apiError.httpCode})` : ''}.`;
					}
					throw apiError;
				}
				throw new NodeApiError(this.getNode(), error as N8nJsonObject, reason ? { message: reason } : {});
			}
		};

		const readAsk = (i: number, callback?: string): { body: JsonObject; waitSeconds?: number } => {
			const answerType = this.getNodeParameter('answerType', i) as string;
			const options = this.getNodeParameter('options', i, {}) as IDataObject;
			const limit = (options.limitWaitTime as IDataObject | undefined)?.values as IDataObject | undefined;
			const waitSeconds = limit ? Number(limit.amount) * (UNIT_SECONDS[String(limit.unit)] ?? 3600) : undefined;
			const input: AskInput = {
				title: this.getNodeParameter('title', i) as string,
				to: this.getNodeParameter('to', i) as string,
				details: (this.getNodeParameter('details', i, '') as string) || undefined,
				choices: answerType === 'choices' ? splitList(this.getNodeParameter('choices', i, '') as string) : undefined,
				freeText:
					answerType === 'freeText' || (answerType === 'choices' && (this.getNodeParameter('allowText', i, false) as boolean)),
				needs: this.getNodeParameter('needs', i, 'any') as 'any' | 'all',
				requestId: (options.requestId as string) || undefined,
				expiresAt: waitSeconds ? expiresAtFrom(waitSeconds) : undefined,
				callback,
			};
			try {
				return { body: askBody(input, `${this.getExecutionId()}/${this.getNode().id}/${i}`), waitSeconds };
			} catch (error) {
				throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex: i });
			}
		};

		if (mode === 'send') {
			const out: INodeExecutionData[] = [];
			const items = this.getInputData();
			for (let i = 0; i < items.length; i++) {
				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				try {
					const { body } = readAsk(i, (options.callback as string) || undefined);
					const approval = await call('POST', '/approvals', body);
					out.push({ json: resultFrom(approval) as IDataObject, pairedItem: { item: i } });
				} catch (error) {
					if (this.continueOnFail()) {
						out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
						continue;
					}
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				}
			}
			return [out];
		}

		// Ask and wait: send one ask whose callback is this execution's resume webhook, then pause.
		const resumeUrl = (() => {
			const plain = String(this.evaluateExpression('{{ $execution.resumeUrl }}', 0));
			const nodeId = this.getNode().id;
			// Newer n8n (2.x) puts a per-execution resume token in $execution.resumeUrl (?signature=...) and,
			// for nodes that aren't n8n's own "send and wait", accepts only that token: an HMAC-signed URL
			// from getSignedResumeUrl() is refused with 401. Use the token URL, with this node's id as the path.
			const u = new URL(plain);
			if (u.searchParams.get('signature')) {
				u.pathname = `${u.pathname.replace(/\/+$/, '')}/${nodeId}`;
				return u.toString();
			}
			const signed = (this as unknown as { getSignedResumeUrl?: () => string }).getSignedResumeUrl;
			if (typeof signed === 'function') return signed.call(this);
			return `${plain}/${nodeId}`;
		})();
		const { body, waitSeconds } = readAsk(0, resumeUrl);
		const approval = await call('POST', '/approvals', body);
		// Keep what was asked with this execution, so the webhook only accepts the answer to this ask.
		let sent: SentAsk;
		try {
			sent = sentAsk(approval);
		} catch (error) {
			throw new NodeOperationError(this.getNode(), `Wayza's reply to the ask can't be checked: ${(error as Error).message}`);
		}
		// The execution's custom data survives the wait (n8n 2.x); workflow static data is only a fallback for
		// hosts without custom data, since a resumed webhook sees the workflow as it was when the run started.
		const custom = customDataOf(this);
		const kept = JSON.stringify({ id: sent.id, request: sent.request, asked_by: sent.asked_by });
		if (custom) {
			custom.set(CUSTOM_KEY(this.getNode().id), kept);
			// n8n drops custom data silently past its key limit; then no answer could ever be checked, so stop now.
			if (custom.get(CUSTOM_KEY(this.getNode().id)) !== kept) {
				throw new NodeOperationError(this.getNode(), "Couldn't keep the ask with this execution (too many custom data keys), so its answer couldn't be checked");
			}
		} else {
			const pending = this.getWorkflowStaticData('node');
			const now = Date.now();
			for (const [k, v] of Object.entries(pending)) {
				if (k.startsWith('wayza:') && now - Number((v as IDataObject)?.at ?? 0) > PENDING_MAX_AGE_MS) delete pending[k];
			}
			pending[PENDING_KEY(this.getExecutionId())] = { ...sent, at: now } as unknown as IDataObject;
		}
		// Wait a minute past the ask's own expiry so the "expired" callback normally arrives first.
		const waitTill = waitSeconds ? new Date(Date.now() + (waitSeconds + 60) * 1000) : WAIT_INDEFINITELY;
		await this.putExecutionToWait(waitTill);
		return [this.getInputData()];
	}

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData() as unknown as JsonObject;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const res = this.getResponseObject();
		const pending = this.getWorkflowStaticData('node');
		const key = PENDING_KEY(this.getExecutionId());
		let sent: PendingAsk | undefined;
		const kept = customDataOf(this)?.get(CUSTOM_KEY(this.getNode().id));
		try {
			if (typeof kept === 'string') sent = JSON.parse(kept) as PendingAsk;
		} catch {
			sent = undefined;
		}
		sent ??= pending[key] as unknown as PendingAsk | undefined;
		if (!sent) {
			res.status(401).json({ error: 'No ask from this execution is waiting for an answer' });
			return { noWebhookResponse: true };
		}
		let result: JsonObject;
		try {
			// Always verified: anyone with the resume URL could otherwise forge an answer.
			const creds = (await this.getCredentials('wayzaApi')) as unknown as Creds;
			result = await parseCallback(body, {
				home: creds.home || 'https://wayza.com',
				insecure: options.insecure === true,
				fetchJson: async (url) => await this.helpers.httpRequest({ method: 'GET', url, json: true, headers: { 'User-Agent': USER_AGENT } }),
			});
			// A genuine answer to some other ask (or to this one, asked differently) is refused too.
			checkAnswer(result.signed_answer as JsonObject | null, sent);
		} catch (error) {
			// Not a genuine answer: refuse it and keep waiting.
			const message = error instanceof VerifyError ? error.message : 'Could not verify the answer';
			res.status(401).json({ error: message });
			return { noWebhookResponse: true };
		}
		if (result.status === 'waiting') {
			res.status(202).json({ ok: true, note: 'Still waiting' });
			return { noWebhookResponse: true };
		}
		delete pending[key];
		if (this.getNodeParameter('requirePerson', true) !== false) result = requirePerson(result);
		return {
			webhookResponse: { ok: true },
			workflowData: [[{ json: result as IDataObject }]],
		};
	}
}
