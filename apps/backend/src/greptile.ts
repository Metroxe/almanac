import type { Recipe, ValidatorResult } from "@almanac/shared";

// Greptile validator. Uses the chat-style /query endpoint
// (https://docs.greptile.com — POST /query with OpenAI-format messages over an
// indexed repo) as an LLM judge. The repo passed in `repositories` should be
// the almanac repo itself, so Greptile can ground its answer in the Recipe
// schema (packages/shared/src/recipe.ts) and SPEC.md.
//
// In stub mode (no GREPTILE_API_KEY), returns a pass with a clear note so dev
// flows aren't blocked.

export interface GreptileConfig {
	apiKey?: string | undefined;
	githubToken?: string | undefined;
	remote?: string | undefined;
	repository?: string | undefined;
	branch?: string | undefined;
	baseUrl?: string | undefined;
}

interface GreptileVerdict {
	pass: boolean;
	score: number;
	reason: string;
}

export class GreptileValidator {
	private readonly enabled: boolean;
	private readonly baseUrl: string;

	constructor(private readonly config: GreptileConfig) {
		this.enabled = Boolean(config.apiKey && config.repository);
		this.baseUrl = config.baseUrl ?? "https://api.greptile.com/v2";
	}

	async validate(recipe: Recipe): Promise<ValidatorResult> {
		if (!this.enabled) {
			return {
				name: "greptile",
				ok: true,
				score: 0.5,
				detail: "stub: GREPTILE_API_KEY or repository not configured",
			};
		}

		const verdict = await this.judge(recipe);
		return {
			name: "greptile",
			ok: verdict.pass,
			score: verdict.score,
			detail: verdict.reason,
		};
	}

	private async judge(recipe: Recipe): Promise<GreptileVerdict> {
		const prompt = [
			"You are validating a submitted Almanac Recipe for the site index.",
			"",
			"Use the Recipe Zod schema in packages/shared/src/recipe.ts and the rubric",
			"in SPEC.md as your ground truth. Score the submission on:",
			"",
			"1. Schema correctness (fields, types, required vs optional).",
			"2. Whether fastest_path.template is a plausible URL pattern for the site.",
			"3. Whether selectors in fallback_recipe / extraction look like real",
			"   selectors (not invented).",
			"4. Whether description is detailed enough for semantic retrieval.",
			"",
			"Respond with ONLY a JSON object on a single line:",
			'{"pass": boolean, "score": number 0-1, "reason": "short string"}',
			"",
			"Submitted recipe:",
			"```json",
			JSON.stringify(recipe, null, 2),
			"```",
		].join("\n");

		const res = await fetch(`${this.baseUrl}/query`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.config.apiKey}`,
				...(this.config.githubToken
					? { "x-github-token": this.config.githubToken }
					: {}),
			},
			body: JSON.stringify({
				messages: [{ id: "judge-1", role: "user", content: prompt }],
				repositories: [
					{
						remote: this.config.remote ?? "github",
						repository: this.config.repository,
						branch: this.config.branch ?? "main",
					},
				],
				stream: false,
			}),
		});

		if (!res.ok) {
			throw new Error(
				`Greptile /query failed: ${res.status} ${await res.text()}`,
			);
		}

		const body = (await res.json()) as { message?: string };
		const text = body.message ?? "";
		const match = text.match(/\{[^}]*"pass"[^}]*\}/);
		if (!match) {
			return {
				pass: false,
				score: 0,
				reason: `no JSON in response: ${text.slice(0, 200)}`,
			};
		}
		try {
			const parsed = JSON.parse(match[0]) as GreptileVerdict;
			return {
				pass: Boolean(parsed.pass),
				score: Number(parsed.score ?? 0),
				reason: String(parsed.reason ?? ""),
			};
		} catch {
			return { pass: false, score: 0, reason: `unparsable JSON: ${match[0]}` };
		}
	}
}
