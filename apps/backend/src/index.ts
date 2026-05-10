import { randomUUID } from "node:crypto";
import {
	ClustlyClient,
	NiaClient,
	Recipe,
	SubmissionRequest,
} from "@almanac/shared";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { RecipeCache } from "./cache.js";
import { GreptileValidator } from "./greptile.js";
import { ReceiptSigner } from "./receipts.js";
import { SubmissionStore } from "./submissions.js";
import { verifyDeliverable } from "./verify.js";

const niaApiKey = process.env.NIA_API_KEY;
const niaKbId = process.env.NIA_KB_ID;
const writeToken = process.env.ALMANAC_WRITE_TOKEN;
const clustlyApiKey = process.env.CLUSTLY_API_KEY;
const clustlyWebhookSecret = process.env.CLUSTLY_WEBHOOK_SECRET;
const clustlyLive = process.env.CLUSTLY_LIVE === "true";
const receiptSecret = process.env.ALMANAC_RECEIPT_SECRET;
const publicBaseUrl = process.env.ALMANAC_PUBLIC_URL ?? "http://localhost:8787";
const receiptTtlSeconds = Number(process.env.ALMANAC_RECEIPT_TTL ?? 86400);
const port = Number(process.env.PORT ?? 8787);
// Resolved relative to the backend workspace's CWD (apps/backend) when
// launched via `npm run -w @almanac/backend ...`, so this lands at
// apps/backend/recipes/ regardless of how the script is invoked.
const cacheDir = process.env.ALMANAC_CACHE_DIR ?? "recipes";
const submissionsDir = process.env.ALMANAC_SUBMISSIONS_DIR ?? "submissions";

if (!niaApiKey || !niaKbId) {
	throw new Error("NIA_API_KEY and NIA_KB_ID must be set");
}
if (!writeToken) {
	throw new Error("ALMANAC_WRITE_TOKEN must be set (gates discoverer writes)");
}
if (!receiptSecret) {
	throw new Error(
		"ALMANAC_RECEIPT_SECRET must be set (signs submission receipts)",
	);
}

// Backend is the source of truth for recipes — in-memory + on-disk cache.
// Nia receives best-effort write-through so recipes are still indexed in the
// shared knowledge base for cross-host retrieval, but reads/searches never
// hit Nia at request time. This keeps the demo fast and resilient to Nia's
// 50/month free-tier rate limits on grep + read.
const cache = new RecipeCache(cacheDir);
await cache.load();
const submissions = new SubmissionStore(submissionsDir);
await submissions.load();
const nia = new NiaClient({ apiKey: niaApiKey, sourceId: niaKbId });
const clustly = clustlyApiKey
	? new ClustlyClient({ apiKey: clustlyApiKey, live: clustlyLive })
	: null;
const receipts = new ReceiptSigner(receiptSecret);
const greptile = new GreptileValidator({
	apiKey: process.env.GREPTILE_API_KEY,
	githubToken: process.env.GREPTILE_GITHUB_TOKEN,
	repository: process.env.GREPTILE_REPOSITORY,
	branch: process.env.GREPTILE_BRANCH,
	remote: process.env.GREPTILE_REMOTE,
});

const app = new Hono();
app.use("*", cors());

app.get("/healthz", (c) =>
	c.json({
		ok: true,
		clustly: !!clustly,
		clustlyLive,
		recipeCount: cache.size(),
	}),
);

app.get("/recipes/search", (c) => {
	const intent = c.req.query("intent");
	const site = c.req.query("site");
	const limit = Number(c.req.query("limit") ?? 5);
	if (!intent) return c.json({ error: "intent is required" }, 400);
	const results = cache.search(intent, site, limit);
	return c.json({ results });
});

app.get("/recipes/:id", (c) => {
	const recipe = cache.get(c.req.param("id"));
	if (!recipe) return c.json({ error: "not found" }, 404);
	c.header("cache-control", "public, max-age=300");
	return c.json(recipe);
});

app.post("/recipes", async (c) => {
	const auth = c.req.header("authorization");
	if (auth !== `Bearer ${writeToken}`) {
		return c.json({ error: "unauthorized" }, 401);
	}
	const parsed = Recipe.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{ error: "invalid recipe", details: parsed.error.issues },
			400,
		);
	}
	await cache.upsert(parsed.data);
	// Best-effort write-through to Nia. Don't block the response on rate-limit
	// or transient errors — the cache is authoritative for serving.
	nia
		.upsertRecipe(parsed.data)
		.catch((err) =>
			console.warn(`[nia upsert ${parsed.data.id}]`, (err as Error).message),
		);
	return c.json({ ok: true, id: parsed.data.id });
});

// Public submission flow. No write token required — gated by Greptile +
// schema validation. Returns a signed receipt URL the agent posts back to
// Clustly as their `deliverable_url`.
app.post("/submissions", async (c) => {
	const parsed = SubmissionRequest.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{ error: "invalid submission", details: parsed.error.issues },
			400,
		);
	}
	const { task_id, recipe, agent_handle } = parsed.data;
	const id = randomUUID();
	const now = new Date().toISOString();

	const schemaResult = {
		name: "schema",
		ok: true,
		score: 1,
		detail: "validated by SubmissionRequest.recipe (Recipe schema)",
	};

	let greptileResult: Awaited<ReturnType<typeof greptile.validate>>;
	try {
		greptileResult = await greptile.validate(recipe);
	} catch (err) {
		greptileResult = {
			name: "greptile",
			ok: false,
			score: 0,
			detail: `greptile threw: ${(err as Error).message}`,
		};
	}

	const validators = [schemaResult, greptileResult];
	const allOk = validators.every((v) => v.ok);

	if (!allOk) {
		const reason = validators
			.filter((v) => !v.ok)
			.map((v) => `${v.name}: ${v.detail ?? "failed"}`)
			.join("; ");
		const record = {
			id,
			task_id,
			recipe_id: recipe.id,
			site: recipe.site,
			intent: recipe.task,
			agent_handle,
			status: "rejected" as const,
			created_at: now,
			updated_at: now,
			validators,
			rejection_reason: reason,
		};
		await submissions.upsert(record);
		console.log("[submission rejected]", id, reason);
		return c.json({ id, status: "rejected", reason, validators }, 422);
	}

	// Cache + best-effort Nia write-through, same path as /recipes.
	await cache.upsert(recipe);
	nia
		.upsertRecipe(recipe)
		.catch((err) =>
			console.warn(`[nia upsert ${recipe.id}]`, (err as Error).message),
		);

	const iat = Math.floor(Date.now() / 1000);
	const score =
		validators.reduce((s, v) => s + (v.score ?? 0), 0) / validators.length;
	const token = receipts.sign({
		sub: id,
		task_id,
		recipe_id: recipe.id,
		site: recipe.site,
		intent: recipe.task,
		score,
		iat,
		exp: iat + receiptTtlSeconds,
	});
	const receipt_url = `${publicBaseUrl}/receipts/${id}`;

	const record = {
		id,
		task_id,
		recipe_id: recipe.id,
		site: recipe.site,
		intent: recipe.task,
		agent_handle,
		status: "passed" as const,
		created_at: now,
		updated_at: now,
		validators,
		receipt: token,
		receipt_url,
	};
	await submissions.upsert(record);
	console.log("[submission passed]", id, recipe.id);
	return c.json({
		id,
		status: "passed",
		receipt: token,
		receipt_url,
		score,
		expires_at: new Date((iat + receiptTtlSeconds) * 1000).toISOString(),
		validators,
	});
});

app.get("/submissions/:id", (c) => {
	const record = submissions.get(c.req.param("id"));
	if (!record) return c.json({ error: "not found" }, 404);
	return c.json(record);
});

app.get("/receipts/:id", (c) => {
	const record = submissions.get(c.req.param("id"));
	if (!record || record.status !== "passed" || !record.receipt) {
		return c.json({ error: "no receipt" }, 404);
	}
	const verified = receipts.verify(record.receipt);
	if (!verified) {
		return c.json({ error: "expired" }, 410);
	}
	return c.json({
		receipt: record.receipt,
		payload: verified,
		recipe_url: `${publicBaseUrl}/recipes/${encodeURIComponent(record.recipe_id)}`,
	});
});

app.post("/recipes/:id/failures", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	console.log("[failure]", id, body);
	return c.json({ ok: true });
});

const BountyRequest = z.object({
	site: z.string(),
	intent: z.string(),
	description: z.string().min(20),
	bountyUsdc: z.number().min(1).max(500).default(20),
	deadlineSeconds: z
		.number()
		.int()
		.min(3600)
		.max(7 * 86400)
		.default(86400),
});

app.post("/bounties", async (c) => {
	const auth = c.req.header("authorization");
	if (auth !== `Bearer ${writeToken}`) {
		return c.json({ error: "unauthorized" }, 401);
	}
	if (!clustly) return c.json({ error: "clustly not configured" }, 503);
	const parsed = BountyRequest.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{ error: "invalid bounty", details: parsed.error.issues },
			400,
		);
	}
	const { site, intent, description, bountyUsdc, deadlineSeconds } =
		parsed.data;
	const submitUrl = `${publicBaseUrl}/submissions`;
	const recipeSchemaUrl =
		"https://github.com/cpowroznik/almanac/blob/main/packages/shared/src/recipe.ts";
	const discovererUrl =
		"https://github.com/cpowroznik/almanac/tree/main/apps/discoverer";
	const task = await clustly.createTask({
		title: `Almanac recipe: ${site} — ${intent}`,
		brief: [
			`Produce a structured "recipe" for the intent "${intent}" on ${site}.`,
			"",
			`Hint: ${description}`,
			"",
			"== How to win this bounty ==",
			"",
			"1. Build a Recipe (JSON) for the intent above. Schema:",
			`   ${recipeSchemaUrl}`,
			"   The highest-value field is `fastest_path.template` — a URL pattern",
			"   that skips the UI entirely. Probe for it before falling back to",
			"   `fallback_recipe` UI steps.",
			"",
			"2. (Optional) Use our reference discoverer agent — Playwright + LLM —",
			"   to generate the recipe automatically:",
			`   ${discovererUrl}`,
			"   You can also build the recipe by hand or with your own tooling.",
			"",
			`3. POST your recipe to: ${submitUrl}`,
			"   Body:",
			`   { "task_id": "${"<this Clustly task id>"}", "recipe": <Recipe JSON>, "agent_handle": "<your handle>" }`,
			"   The backend runs Greptile + schema validation. On pass, you get back",
			'   { "id", "status": "passed", "receipt", "receipt_url", "expires_at" }.',
			"   On fail you get back the validator detail — fix and resubmit.",
			"",
			"4. Submit the `receipt_url` (e.g. https://<almanac>/receipts/<id>) to",
			"   this Clustly task as your `deliverable_url`. Done.",
			"",
			"The receipt is a stateless signed token; it self-verifies, no manual",
			"approval required beyond Clustly's standard poster review.",
		].join("\n"),
		deliverableSchema: Recipe.shape,
		rubric: [
			`1. deliverable_url is an https://${new URL(publicBaseUrl).host}/receipts/<uuid> URL.`,
			"2. The receipt verifies (signature + not expired) and was minted within",
			"   the bounty's deadline window.",
			"3. The receipt's `recipe_id` resolves on /recipes/:id and matches the",
			`   site "${site}" and intent "${intent}".`,
			"4. fastest_path.template is preferred over fallback_recipe — receipts",
			"   with a working URL template score higher.",
			"5. extraction.list_selector and field selectors must reference real",
			"   elements (Greptile validates this against the Recipe schema).",
		].join("\n"),
		bountyUsdc,
		deadlineSeconds,
		metadata: { site, intent },
	});
	console.log("[bounty]", task.id, site, intent, `${bountyUsdc} USDC`);
	return c.json({ task });
});

app.post("/webhooks/clustly", async (c) => {
	if (clustlyWebhookSecret) {
		const sig = c.req.header("x-clustly-signature");
		if (sig !== clustlyWebhookSecret) {
			return c.json({ error: "bad signature" }, 401);
		}
	}
	const body = (await c.req.json()) as {
		taskId?: string;
		deliveryId?: string;
		payload?: unknown;
		deliverableUrl?: string;
	};
	if (!body.taskId || !body.deliveryId) {
		return c.json({ error: "missing taskId/deliveryId" }, 400);
	}

	// Receipt path (preferred): agent submitted a /receipts/<id> URL. Look up
	// the submission, verify the signed token, approve.
	const receiptId = extractReceiptId(body.deliverableUrl);
	if (receiptId) {
		const record = submissions.get(receiptId);
		if (!record || record.status !== "passed" || !record.receipt) {
			await clustly?.rejectDelivery(
				body.taskId,
				body.deliveryId,
				"receipt not found",
			);
			return c.json({ ok: false, reason: "receipt not found" });
		}
		const verified = receipts.verify(record.receipt);
		if (!verified) {
			await clustly?.rejectDelivery(
				body.taskId,
				body.deliveryId,
				"receipt invalid or expired",
			);
			return c.json({ ok: false, reason: "receipt invalid or expired" });
		}
		await clustly?.approveDelivery(body.taskId, body.deliveryId);
		console.log(
			"[delivery accepted via receipt]",
			body.taskId,
			record.recipe_id,
		);
		return c.json({ ok: true, id: record.recipe_id });
	}

	// Legacy / direct path: payload carries the full Recipe JSON inline.
	const result = await verifyDeliverable(body.payload);
	if (!result.ok || !result.recipe) {
		console.log("[delivery rejected]", body.taskId, result.reason);
		await clustly?.rejectDelivery(
			body.taskId,
			body.deliveryId,
			result.reason ?? "invalid",
		);
		return c.json({ ok: false, reason: result.reason });
	}
	await nia.upsertRecipe(result.recipe);
	await clustly?.approveDelivery(body.taskId, body.deliveryId);
	console.log("[delivery accepted]", body.taskId, result.recipe.id);
	return c.json({ ok: true, id: result.recipe.id });
});

function extractReceiptId(url?: string): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		const m = parsed.pathname.match(/\/receipts\/([0-9a-f-]{36})$/i);
		return m?.[1] ?? null;
	} catch {
		return null;
	}
}

serve({ fetch: app.fetch, port });
console.log(`almanac backend listening on :${port}`);
