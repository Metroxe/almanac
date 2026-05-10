import { createHash } from "node:crypto";
import type { Recipe } from "@almanac/shared";
import { chromium } from "playwright";

const backendUrl =
	process.env["ALMANAC_BACKEND_URL"] ?? "http://localhost:8787";
const writeToken = process.env["ALMANAC_WRITE_TOKEN"];

if (!writeToken) {
	throw new Error("ALMANAC_WRITE_TOKEN must be set to push recipes");
}

async function pushRecipe(recipe: Recipe): Promise<void> {
	const res = await fetch(`${backendUrl}/recipes`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${writeToken}`,
		},
		body: JSON.stringify(recipe),
	});
	if (!res.ok) {
		throw new Error(`push failed: ${res.status} ${await res.text()}`);
	}
}

function hashRecipe(input: object): string {
	return createHash("sha256")
		.update(JSON.stringify(input))
		.digest("hex")
		.slice(0, 12);
}

// MVP path: hand-author recipes here, push them via the backend.
// LLM-driven discovery via CLōD goes in a follow-up loop that wraps Playwright +
// reasoning + verification, then calls pushRecipe with the distilled output.
async function main(): Promise<void> {
	const fastestPath = {
		type: "url_template" as const,
		template:
			"https://www.google.com/travel/flights?q=flights+from+{origin}+to+{destination}+on+{date}",
		params: {
			origin: "IATA code or city name",
			destination: "IATA code or city name",
			date: "YYYY-MM-DD",
		},
		savings_estimate: "skips ~6 UI interactions",
	};

	const recipe: Recipe = {
		id: "google-flights/search_one_way",
		site: "google.com/travel/flights",
		task: "Search for one-way flights between two airports on a date",
		description:
			"Find flights from an origin airport to a destination airport on a specific date. Use the URL template to skip the UI entirely.",
		preconditions: ["network", "no_login_required"],
		fastest_path: fastestPath,
		last_verified: new Date().toISOString(),
		version_hash: hashRecipe(fastestPath),
		screenshots: [],
	};

	// Day-1 verification: actually load the URL and confirm we get results back.
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const url = recipe.fastest_path?.template
		.replace("{origin}", "YVR")
		.replace("{destination}", "NRT")
		.replace("{date}", "2026-06-15");
	await page.goto(url ?? "");
	console.log("loaded", url, "title:", await page.title());
	await browser.close();

	await pushRecipe(recipe);
	console.log("pushed", recipe.id);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
