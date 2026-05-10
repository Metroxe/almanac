import { z } from "zod";

export const UrlTemplateRecipe = z.object({
	type: z.literal("url_template"),
	template: z.string(),
	params: z.record(z.string(), z.string()),
	savings_estimate: z.string().optional(),
});

export const UiStep = z.object({
	action: z.enum(["goto", "click", "type", "wait_for", "press", "scroll"]),
	url: z.string().optional(),
	selector: z.string().optional(),
	value: z.string().optional(),
});

export const UiStepsRecipe = z.object({
	type: z.literal("ui_steps"),
	steps: z.array(UiStep),
});

export const Extraction = z.object({
	list_selector: z.string(),
	fields: z.record(z.string(), z.string()),
});

export const Recipe = z.object({
	id: z.string(),
	site: z.string(),
	task: z.string(),
	description: z.string(),
	preconditions: z.array(z.string()).default([]),
	fastest_path: UrlTemplateRecipe.optional(),
	fallback_recipe: UiStepsRecipe.optional(),
	extraction: Extraction.optional(),
	last_verified: z.string().datetime(),
	version_hash: z.string(),
	screenshots: z.array(z.string()).default([]),
});

export const RecipeSummary = Recipe.pick({
	id: true,
	site: true,
	task: true,
	description: true,
	last_verified: true,
	version_hash: true,
});

export type Recipe = z.infer<typeof Recipe>;
export type RecipeSummary = z.infer<typeof RecipeSummary>;
