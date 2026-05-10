#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const backendUrl =
	process.env.ALMANAC_BACKEND_URL ?? "https://almanac.boilerroom.tech";

const server = new McpServer({
	name: "almanac",
	version: "0.1.0",
});

server.registerTool(
	"find_recipe",
	{
		title: "Find recipe",
		description:
			"Search the Almanac index for a recipe matching a natural-language intent. Optionally scope to a specific site.",
		inputSchema: {
			intent: z.string().describe("e.g. 'search one-way flights'"),
			site: z.string().optional().describe("e.g. 'google.com/travel/flights'"),
			limit: z.number().int().min(1).max(20).optional(),
		},
	},
	async ({ intent, site, limit }) => {
		const url = new URL("/recipes/search", backendUrl);
		url.searchParams.set("intent", intent);
		if (site) url.searchParams.set("site", site);
		if (limit) url.searchParams.set("limit", String(limit));
		const res = await fetch(url);
		if (!res.ok) {
			return {
				content: [
					{
						type: "text",
						text: `search failed: ${res.status} ${await res.text()}`,
					},
				],
				isError: true,
			};
		}
		const body = await res.json();
		return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
	},
);

server.registerTool(
	"get_recipe",
	{
		title: "Get recipe",
		description: "Fetch the full recipe JSON by ID.",
		inputSchema: { id: z.string() },
	},
	async ({ id }) => {
		const res = await fetch(
			new URL(`/recipes/${encodeURIComponent(id)}`, backendUrl),
		);
		if (res.status === 404) {
			return { content: [{ type: "text", text: `no recipe with id ${id}` }] };
		}
		if (!res.ok) {
			return {
				content: [
					{
						type: "text",
						text: `fetch failed: ${res.status} ${await res.text()}`,
					},
				],
				isError: true,
			};
		}
		const body = await res.json();
		return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
	},
);

server.registerTool(
	"report_failure",
	{
		title: "Report recipe failure",
		description:
			"Flag a recipe that didn't work in practice. Helps maintainers re-explore stale recipes.",
		inputSchema: {
			id: z.string(),
			reason: z.string(),
		},
	},
	async ({ id, reason }) => {
		const res = await fetch(
			new URL(`/recipes/${encodeURIComponent(id)}/failures`, backendUrl),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reason }),
			},
		);
		return {
			content: [
				{ type: "text", text: res.ok ? "reported" : `failed: ${res.status}` },
			],
			isError: !res.ok,
		};
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
