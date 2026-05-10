// Clustly task-marketplace client.
// Posts bounties, receives deliverables via webhook, approves/rejects after verification.
// Exact endpoints/payloads need to be confirmed against Clustly's task-poster API
// (their public docs only fully document agent-side endpoints).

export interface ClustlyConfig {
	apiKey: string;
	baseUrl?: string;
	live?: boolean;
}

export interface CreateTaskInput {
	title: string;
	brief: string;
	deliverableSchema: unknown;
	rubric: string;
	bountyUsdc: number;
	deadlineSeconds: number;
	metadata?: Record<string, string>;
}

export interface ClustlyTask {
	id: string;
	status:
		| "open"
		| "claimed"
		| "delivered"
		| "approved"
		| "rejected"
		| "expired";
	createdAt: string;
}

export interface ClustlyDelivery {
	taskId: string;
	deliveryId: string;
	agentId: string;
	payload: unknown;
	verifierScore?: number;
}

export class ClustlyClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly live: boolean;

	constructor(config: ClustlyConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl ?? "https://clustly.ai/api/v1";
		this.live = config.live ?? false;
	}

	async createTask(input: CreateTaskInput): Promise<ClustlyTask> {
		// In stub mode, return a fake task so the rest of the pipeline can run
		// without spending real USDC.
		if (!this.live) {
			return {
				id: `stub-${Date.now()}`,
				status: "open",
				createdAt: new Date().toISOString(),
			};
		}
		// TODO: confirm exact endpoint. Likely POST /tasks with the bounty fields.
		return await this.request<ClustlyTask>("POST", "/tasks", input);
	}

	async approveDelivery(taskId: string, deliveryId: string): Promise<void> {
		if (!this.live) return;
		// TODO: confirm endpoint shape — likely POST /tasks/:id/deliveries/:deliveryId/approve
		await this.request(
			"POST",
			`/tasks/${taskId}/deliveries/${deliveryId}/approve`,
		);
	}

	async rejectDelivery(
		taskId: string,
		deliveryId: string,
		reason: string,
	): Promise<void> {
		if (!this.live) return;
		await this.request(
			"POST",
			`/tasks/${taskId}/deliveries/${deliveryId}/reject`,
			{
				reason,
			},
		);
	}

	private async request<T = unknown>(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<T> {
		const init: RequestInit = {
			method,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.apiKey}`,
			},
		};
		if (body !== undefined) init.body = JSON.stringify(body);
		const res = await fetch(`${this.baseUrl}${path}`, init);
		if (!res.ok) {
			throw new Error(
				`Clustly ${method} ${path} failed: ${res.status} ${await res.text()}`,
			);
		}
		return (await res.json()) as T;
	}
}
