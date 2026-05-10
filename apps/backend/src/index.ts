import { ClustlyClient, NiaClient, Recipe } from "@almanac/shared";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { verifyDeliverable } from "./verify.js";

const niaApiKey = process.env.NIA_API_KEY;
const niaKbId = process.env.NIA_KB_ID;
const writeToken = process.env.ALMANAC_WRITE_TOKEN;
const clustlyApiKey = process.env.CLUSTLY_API_KEY;
const clustlyWebhookSecret = process.env.CLUSTLY_WEBHOOK_SECRET;
const clustlyLive = process.env.CLUSTLY_LIVE === "true";
const port = Number(process.env.PORT ?? 8787);

if (!niaApiKey || !niaKbId) {
	throw new Error("NIA_API_KEY and NIA_KB_ID must be set");
}
if (!writeToken) {
	throw new Error("ALMANAC_WRITE_TOKEN must be set (gates discoverer writes)");
}

// NIA_KB_ID is the source_id returned from `POST /v2/fs` during one-time setup.
const nia = new NiaClient({ apiKey: niaApiKey, sourceId: niaKbId });
const clustly = clustlyApiKey
	? new ClustlyClient({ apiKey: clustlyApiKey, live: clustlyLive })
	: null;

const app = new Hono();
app.use("*", cors());

app.get("/healthz", (c) =>
	c.json({ ok: true, clustly: !!clustly, clustlyLive }),
);

app.get("/recipes/search", async (c) => {
	const intent = c.req.query("intent");
	const site = c.req.query("site");
	const limit = Number(c.req.query("limit") ?? 5);
	if (!intent) return c.json({ error: "intent is required" }, 400);
	const results = await nia.search(intent, site, limit);
	return c.json({ results });
});

app.get("/recipes/:id", async (c) => {
	const recipe = await nia.getRecipe(c.req.param("id"));
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
	await nia.upsertRecipe(parsed.data);
	return c.json({ ok: true, id: parsed.data.id });
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
	const task = await clustly.createTask({
		title: `Almanac recipe: ${site} — ${intent}`,
		brief: [
			`Produce a structured "recipe" for the intent "${intent}" on ${site}.`,
			"",
			"Required deliverable: a single JSON object matching the Recipe schema.",
			"Critically, probe for URL-parameter shortcuts that skip the UI flow —",
			"this is the highest-value information you can return.",
			"",
			`User-facing description / hint: ${description}`,
		].join("\n"),
		deliverableSchema: Recipe.shape,
		rubric: [
			"1. Deliverable is valid JSON matching the Recipe schema.",
			"2. fastest_path.template is preferred over fallback_recipe — score higher",
			"   if a working URL template is included.",
			"3. extraction.list_selector and field selectors must reference real elements.",
			"4. description must be ≥100 characters and useful for semantic retrieval.",
			"5. last_verified must be within the last 24h.",
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
	};
	if (!body.taskId || !body.deliveryId) {
		return c.json({ error: "missing taskId/deliveryId" }, 400);
	}
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

serve({ fetch: app.fetch, port });
console.log(`almanac backend listening on :${port}`);
