import type { Recipe } from "../shared/recipe.js";
import { Recipe as RecipeSchema } from "../shared/recipe.js";

export interface VerifyResult {
	ok: boolean;
	reason?: string;
	recipe?: Recipe;
}

// Validate a deliverable from Clustly (or any external source) before ingesting.
// Two layers:
//   1. Schema check — payload matches the Recipe shape.
//   2. Smoke test (optional, in production) — load the fastest_path URL via
//      Playwright headless, confirm a non-error page comes back. Heavy, so
//      gated behind an env flag for now.
export async function verifyDeliverable(payload: unknown): Promise<VerifyResult> {
	const parsed = RecipeSchema.safeParse(payload);
	if (!parsed.success) {
		return {
			ok: false,
			reason: `schema invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		};
	}

	if (process.env["ALMANAC_SMOKE_TEST"] === "true" && parsed.data.fastest_path) {
		const result = await smokeTestUrlTemplate(parsed.data);
		if (!result.ok) return result;
	}

	return { ok: true, recipe: parsed.data };
}

async function smokeTestUrlTemplate(recipe: Recipe): Promise<VerifyResult> {
	if (!recipe.fastest_path) return { ok: true, recipe };
	// Lazy import so the MCP/CLI bundles don't pull Playwright.
	const { chromium } = await import("playwright");
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const probe = fillTemplate(recipe.fastest_path.template, recipe.fastest_path.params);
		const res = await page.goto(probe, { timeout: 15_000 });
		if (!res || res.status() >= 400) {
			return { ok: false, reason: `smoke test got status ${res?.status()}` };
		}
		return { ok: true, recipe };
	} finally {
		await browser.close();
	}
}

function fillTemplate(template: string, params: Record<string, string>): string {
	return Object.entries(params).reduce(
		(url, [key, hint]) => url.replaceAll(`{${key}}`, sampleFor(key, hint)),
		template,
	);
}

function sampleFor(key: string, _hint: string): string {
	// Cheap probe values — good enough to confirm the URL doesn't 4xx.
	if (/origin|from/.test(key)) return "YVR";
	if (/destination|to/.test(key)) return "NRT";
	if (/date/.test(key)) return "2026-06-15";
	return "test";
}
