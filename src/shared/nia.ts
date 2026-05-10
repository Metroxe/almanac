import type { Recipe, RecipeSummary } from "./recipe.js";

export interface NiaConfig {
	apiKey: string;
	knowledgeBaseId: string;
	baseUrl?: string;
}

export class NiaClient {
	private readonly apiKey: string;
	private readonly knowledgeBaseId: string;
	private readonly baseUrl: string;

	constructor(config: NiaConfig) {
		this.apiKey = config.apiKey;
		this.knowledgeBaseId = config.knowledgeBaseId;
		this.baseUrl = config.baseUrl ?? "https://api.trynia.ai";
	}

	async upsertRecipe(recipe: Recipe): Promise<void> {
		// TODO: confirm exact endpoint shape with Nia. Likely:
		//   POST /v1/knowledge-bases/{kbId}/documents
		//   body: { id, content: <description>, metadata: <recipe>, tags: ["site:..."] }
		await this.request("POST", `/v1/knowledge-bases/${this.knowledgeBaseId}/documents`, {
			id: recipe.id,
			content: recipe.description,
			metadata: recipe,
			tags: [`site:${recipe.site}`, `task:${recipe.task}`],
		});
	}

	async search(query: string, site?: string, limit = 5): Promise<RecipeSummary[]> {
		// TODO: confirm semantic-search endpoint and response shape.
		const filters = site ? { tags: [`site:${site}`] } : {};
		const res = await this.request<{ results: Array<{ metadata: Recipe }> }>(
			"POST",
			`/v1/knowledge-bases/${this.knowledgeBaseId}/search`,
			{ query, limit, filters },
		);
		return res.results.map(({ metadata }) => ({
			id: metadata.id,
			site: metadata.site,
			task: metadata.task,
			description: metadata.description,
			last_verified: metadata.last_verified,
			version_hash: metadata.version_hash,
		}));
	}

	async getRecipe(id: string): Promise<Recipe | null> {
		// TODO: confirm fetch-by-id endpoint.
		const res = await this.request<{ metadata: Recipe } | null>(
			"GET",
			`/v1/knowledge-bases/${this.knowledgeBaseId}/documents/${encodeURIComponent(id)}`,
		);
		return res?.metadata ?? null;
	}

	private async request<T>(
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
			throw new Error(`Nia ${method} ${path} failed: ${res.status} ${await res.text()}`);
		}
		return (await res.json()) as T;
	}
}
