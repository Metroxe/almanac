import type { Recipe, RecipeSummary } from "./recipe.js";

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"into",
	"you",
	"your",
	"find",
	"how",
	"what",
	"when",
	"where",
	"get",
	"use",
	"via",
]);

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Nia client targets the v2 filesystem API (apigcp.trynia.ai/v2/fs).
// Setup is one-time and out of band: `POST /v2/fs` with {name, description}
// returns an id, which we pass in as `sourceId` (env: NIA_KB_ID).
//
// Write path  : PUT  /v2/fs/{source_id}/files            body: {path, body, ...}
// Read path   : GET  /v2/fs/{source_id}/read?path=...    returns file content
// Search path : POST /v2/fs/{source_id}/grep             body: {pattern}
//
// Why grep, not /v2/search? The unified search endpoint is global by design —
// even with data_sources / local_folders / source_ids set, it returns hits
// from public repos and other indexed sources, not our fs namespace. Probed
// every documented filter; none scope to a filesystem source. fs/grep is the
// only primitive that stays inside our namespace, so it's what we use for
// recipe lookup. Recipe id = file path (with .json suffix).

export interface NiaConfig {
	apiKey: string;
	sourceId: string;
	baseUrl?: string;
}

interface GrepMatch {
	path: string;
	line: string;
	line_number?: number;
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
		// Pretty-print so grep returns one match per matching field, not one per
		// recipe. Multi-keyword queries can then rank by hit count.
		await this.request("PUT", `/fs/${this.sourceId}/files`, {
			path: this.fileFor(recipe.id),
			body: JSON.stringify(recipe, null, 2),
			encoding: "utf8",
			language: "json",
		});
	}

	async search(
		query: string,
		site?: string,
		limit = 5,
	): Promise<RecipeSummary[]> {
		const terms = this.keywords(query);
		if (site) terms.push(...this.keywords(site));
		if (terms.length === 0) return [];

		// One grep call (Nia bills per call). The OR-pattern returns lines that
		// match any keyword; we then inspect each line's text to count which
		// keywords actually hit, so ranking reflects distinct-keyword coverage
		// instead of raw match count (which boilerplate like the /travel/flights
		// URL path would otherwise inflate equally across every recipe).
		const pattern = `(${terms.map(escapeRegex).join("|")})`;
		const res = await this.request<{ matches?: GrepMatch[] }>(
			"POST",
			`/fs/${this.sourceId}/grep`,
			{ pattern, ignore_case: true },
		);
		const matches = res.matches ?? [];

		const hitsByPath = new Map<string, Set<string>>();
		for (const m of matches) {
			const line = m.line.toLowerCase();
			let hits = hitsByPath.get(m.path);
			if (!hits) {
				hits = new Set();
				hitsByPath.set(m.path, hits);
			}
			for (const term of terms) {
				if (line.includes(term)) hits.add(term);
			}
		}
		const ranked = [...hitsByPath.entries()]
			.sort((a, b) => b[1].size - a[1].size)
			.slice(0, limit)
			.map(([path]) => path);

		const recipes = await Promise.all(
			ranked.map((path) => this.getRecipe(this.idForFile(path))),
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

	private keywords(input: string): string[] {
		return input
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
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
