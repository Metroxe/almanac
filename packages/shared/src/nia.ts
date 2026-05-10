import type { Recipe, RecipeSummary } from "./recipe.js";

// Nia client targets the v2 filesystem + search API (apigcp.trynia.ai/v2).
// Setup is one-time and out of band: `POST /v2/fs` with {name, description}
// returns a `source_id`, which we treat as the Almanac knowledge-base handle
// and pass in as `sourceId` (env: NIA_KB_ID).
//
// Write path  : PUT  /v2/fs/{source_id}/files            body: {path, body, ...}
// Read path   : GET  /v2/fs/{source_id}/read?path=...    returns file content
// Search path : POST /v2/search   body: {mode:"universal", query, top_k, ...}
//
// Universal search is "Vector + BM25 across all indexed sources, no LLM synthesis"
// — exactly what we want. Recipes are stored as one JSON file per recipe;
// recipe.id doubles as the file path inside the namespace.

export interface NiaConfig {
	apiKey: string;
	sourceId: string;
	baseUrl?: string;
}

interface UniversalSearchHit {
	// Best-effort shape — Nia's docs describe "relevance scores, highlighted
	// excerpts, and source metadata" but don't pin field names. We log the raw
	// response on first use to confirm and tighten this.
	score?: number;
	source_id?: string;
	path?: string;
	content?: string;
	text?: string;
	highlights?: string[];
	metadata?: Record<string, unknown>;
}

export class NiaClient {
	private readonly apiKey: string;
	private readonly sourceId: string;
	private readonly baseUrl: string;

	constructor(config: NiaConfig) {
		this.apiKey = config.apiKey;
		this.sourceId = config.sourceId;
		this.baseUrl = config.baseUrl ?? "https://apigcp.trynia.ai/v2";
	}

	async upsertRecipe(recipe: Recipe): Promise<void> {
		await this.request("PUT", `/fs/${this.sourceId}/files`, {
			path: this.fileFor(recipe.id),
			body: JSON.stringify(recipe),
			encoding: "utf8",
			language: "json",
		});
	}

	async search(
		query: string,
		site?: string,
		limit = 5,
	): Promise<RecipeSummary[]> {
		const scopedQuery = site ? `${query} site:${site}` : query;
		const res = await this.request<{
			results?: UniversalSearchHit[];
			hits?: UniversalSearchHit[];
		}>("POST", `/search`, {
			mode: "universal",
			query: scopedQuery,
			top_k: limit,
			// Restrict to our namespace when the API supports it; harmless if ignored.
			source_ids: [this.sourceId],
		});
		const hits = res.results ?? res.hits ?? [];
		const recipes = await Promise.all(
			hits.map(async (hit) => {
				if (hit.metadata && typeof hit.metadata === "object") {
					const maybe = hit.metadata as Partial<Recipe>;
					if (maybe.id && maybe.site && maybe.task && maybe.description) {
						return maybe as Recipe;
					}
				}
				const text = hit.content ?? hit.text;
				if (text) {
					try {
						return JSON.parse(text) as Recipe;
					} catch {
						// fall through to path-based fetch
					}
				}
				if (hit.path) {
					const id = this.idForFile(hit.path);
					return await this.getRecipe(id);
				}
				return null;
			}),
		);
		return recipes
			.filter((r): r is Recipe => r !== null)
			.map((r) => ({
				id: r.id,
				site: r.site,
				task: r.task,
				description: r.description,
				last_verified: r.last_verified,
				version_hash: r.version_hash,
			}));
	}

	async getRecipe(id: string): Promise<Recipe | null> {
		const path = this.fileFor(id);
		const res = await this.request<
			{ content?: string; body?: string } | string
		>(
			"GET",
			`/fs/${this.sourceId}/read?path=${encodeURIComponent(path)}`,
		).catch((err: Error) => {
			if (/\b404\b/.test(err.message)) return null;
			throw err;
		});
		if (res === null) return null;
		const raw = typeof res === "string" ? res : (res.content ?? res.body);
		if (!raw) return null;
		return JSON.parse(raw) as Recipe;
	}

	private fileFor(recipeId: string): string {
		// Recipe ids look like "google-flights/search_one_way" — already a path.
		return recipeId.endsWith(".json") ? recipeId : `${recipeId}.json`;
	}

	private idForFile(path: string): string {
		return path.replace(/\.json$/, "");
	}

	private async request<T>(
		method: "GET" | "PUT" | "POST",
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
				`Nia ${method} ${path} failed: ${res.status} ${await res.text()}`,
			);
		}
		const text = await res.text();
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			return text as unknown as T;
		}
	}
}
