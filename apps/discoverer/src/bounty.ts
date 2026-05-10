// Maintainer-only: post Clustly bounties to fill the index.
// Reads a curated list of (site, intent, description) entries from
// `bounties.json` at the repo root and POSTs each through the backend.
// Editorial control stays with you — end-users never trigger bounties.

import { readFile } from "node:fs/promises";
import { z } from "zod";

const backendUrl = process.env.ALMANAC_BACKEND_URL ?? "http://localhost:8787";
const writeToken = process.env.ALMANAC_WRITE_TOKEN;

if (!writeToken) {
	throw new Error("ALMANAC_WRITE_TOKEN must be set to post bounties");
}

const BountyEntry = z.object({
	site: z.string(),
	intent: z.string(),
	description: z.string().min(20),
	bountyUsdc: z.number().min(1).max(500).optional(),
	deadlineSeconds: z
		.number()
		.int()
		.min(3600)
		.max(7 * 86400)
		.optional(),
});

const BountyFile = z.array(BountyEntry);

async function main(): Promise<void> {
	const path = process.argv[2] ?? "bounties.json";
	const raw = await readFile(path, "utf8");
	const entries = BountyFile.parse(JSON.parse(raw));
	console.log(`posting ${entries.length} bounties via ${backendUrl}`);

	for (const entry of entries) {
		const res = await fetch(`${backendUrl}/bounties`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${writeToken}`,
			},
			body: JSON.stringify(entry),
		});
		if (!res.ok) {
			console.error(
				`✗ ${entry.site} / ${entry.intent}: ${res.status} ${await res.text()}`,
			);
			continue;
		}
		const body = (await res.json()) as { task: { id: string } };
		console.log(`✓ ${entry.site} / ${entry.intent} → ${body.task.id}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
