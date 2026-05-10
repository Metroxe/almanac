import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type Recipe, Recipe as RecipeSchema, type RecipeSummary } from "@almanac/shared";

const STOPWORDS = new Set([
	"the", "and", "for", "with", "from", "into", "you", "your",
	"find", "how", "what", "when", "where", "get", "use", "via",
]);

export class RecipeCache {
	private readonly recipes = new Map<string, Recipe>();
	constructor(private readonly dir: string) {}

	async load(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		for (const path of await walk(this.dir)) {
			if (!path.endsWith(".json")) continue;
			const raw = await readFile(path, "utf8");
			const parsed = RecipeSchema.safeParse(JSON.parse(raw));
			if (parsed.success) this.recipes.set(parsed.data.id, parsed.data);
		}
	}

	async upsert(recipe: Recipe): Promise<void> {
		this.recipes.set(recipe.id, recipe);
		const file = join(this.dir, `${recipe.id}.json`);
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, JSON.stringify(recipe, null, 2), "utf8");
	}

	get(id: string): Recipe | null {
		return this.recipes.get(id) ?? null;
	}

	size(): number {
		return this.recipes.size;
	}

	search(query: string, site?: string, limit = 5): RecipeSummary[] {
		const terms = keywords(query);
		if (site) terms.push(...keywords(site));
		if (terms.length === 0) return [];

		// Score each recipe by distinct-keyword coverage against its JSON text.
		const scored = [...this.recipes.values()]
			.map((r) => {
				const haystack = JSON.stringify(r).toLowerCase();
				let hits = 0;
				for (const term of terms) {
					if (haystack.includes(term)) hits++;
				}
				return { recipe: r, hits };
			})
			.filter(({ hits }) => hits > 0)
			.sort((a, b) => b.hits - a.hits)
			.slice(0, limit);

		return scored.map(({ recipe: r }) => ({
			id: r.id,
			site: r.site,
			task: r.task,
			description: r.description,
			last_verified: r.last_verified,
			version_hash: r.version_hash,
		}));
	}
}

function keywords(input: string): string[] {
	return input
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
}

export const _internalForTests = { keywords, walk: (d: string) => walk(d) };
export function relativeFromCacheDir(dir: string, file: string): string {
	return relative(dir, file);
}
