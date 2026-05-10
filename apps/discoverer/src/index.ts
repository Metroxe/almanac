import { createHash } from "node:crypto";
import type { Recipe } from "@almanac/shared";

const backendUrl = process.env.ALMANAC_BACKEND_URL ?? "http://localhost:8787";
const writeToken = process.env.ALMANAC_WRITE_TOKEN;

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

const now = (): string => new Date().toISOString();

function buildSearchOneWay(): Recipe {
	// `one-way+` prefix forces a true one-way result (no return date).
	// Verified 2026-05-10 via scratch/probe-oneway-prefix-oneway.png.
	const fastest_path = {
		type: "url_template" as const,
		template:
			"https://www.google.com/travel/flights?q=one-way+flights+from+{origin}+to+{destination}+on+{date}",
		params: {
			origin: "IATA code or city name (e.g. YVR or Vancouver)",
			destination: "IATA code or city name (e.g. PEK or Beijing)",
			date: "YYYY-MM-DD",
		},
		savings_estimate: "skips ~6 UI interactions",
	};
	return {
		id: "google-flights/search_one_way",
		site: "google.com/travel/flights",
		task: "Search for one-way flights between two airports on a date",
		description:
			"One-way flight search from an origin to a destination on a specific date. Use this when the user wants a single outbound flight with no return. The URL skips the UI entirely and lands on a results page with prices, airlines, durations, and emissions.",
		preconditions: ["network", "no_login_required"],
		fastest_path,
		last_verified: now(),
		version_hash: hashRecipe(fastest_path),
		screenshots: [],
	};
}

function buildSearchRoundTrip(): Recipe {
	// `+to+{return_date}` suffix selects round-trip mode and pins both legs.
	// Verified 2026-05-10 via scratch/probe-roundtrip-to-return.png.
	const fastest_path = {
		type: "url_template" as const,
		template:
			"https://www.google.com/travel/flights?q=flights+from+{origin}+to+{destination}+on+{date}+to+{return_date}",
		params: {
			origin: "IATA code or city name (e.g. YVR or Vancouver)",
			destination: "IATA code or city name (e.g. PEK or Beijing)",
			date: "YYYY-MM-DD outbound date",
			return_date: "YYYY-MM-DD return date",
		},
		savings_estimate: "skips ~8 UI interactions",
	};
	return {
		id: "google-flights/search_round_trip",
		site: "google.com/travel/flights",
		task: "Search for round-trip flights between two airports with explicit outbound and return dates",
		description:
			"Round-trip flight search from an origin to a destination with both outbound and return dates. Use this when the user wants to fly out and back. Lands directly on the results page; no UI interaction needed.",
		preconditions: ["network", "no_login_required"],
		fastest_path,
		last_verified: now(),
		version_hash: hashRecipe(fastest_path),
		screenshots: [],
	};
}

const recipes: Recipe[] = [buildSearchOneWay(), buildSearchRoundTrip()];

async function main(): Promise<void> {
	for (const recipe of recipes) {
		await pushRecipe(recipe);
		console.log(`pushed ${recipe.id}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
