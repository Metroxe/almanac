import { z } from "zod";
import { Recipe } from "./recipe.js";

// Public submission flow:
//   1. Agent POSTs { task_id, recipe } to /submissions on the backend.
//   2. Backend runs Greptile + schema + (optional) smoke-test validators.
//   3. On pass, backend mints a stateless signed receipt and returns its URL.
//   4. Agent submits the receipt URL to Clustly as `deliverable_url`.
//   5. Maintainer (or webhook handler) verifies the receipt and approves
//      the Clustly task — USDC releases.

export const SubmissionRequest = z.object({
	task_id: z.string().min(1),
	recipe: Recipe,
	agent_handle: z.string().min(1).max(80).optional(),
	notes: z.string().max(2000).optional(),
});

export type SubmissionRequest = z.infer<typeof SubmissionRequest>;

export const SubmissionStatus = z.enum([
	"pending",
	"validating",
	"passed",
	"rejected",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

export const ValidatorResult = z.object({
	name: z.string(),
	ok: z.boolean(),
	score: z.number().min(0).max(1).optional(),
	detail: z.string().optional(),
});
export type ValidatorResult = z.infer<typeof ValidatorResult>;

export const SubmissionRecord = z.object({
	id: z.string(),
	task_id: z.string(),
	recipe_id: z.string(),
	site: z.string(),
	intent: z.string(),
	agent_handle: z.string().optional(),
	status: SubmissionStatus,
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
	validators: z.array(ValidatorResult).default([]),
	rejection_reason: z.string().optional(),
	receipt: z.string().optional(),
	receipt_url: z.string().optional(),
});
export type SubmissionRecord = z.infer<typeof SubmissionRecord>;

export const ReceiptPayload = z.object({
	sub: z.string(),
	task_id: z.string(),
	recipe_id: z.string(),
	site: z.string(),
	intent: z.string(),
	score: z.number().min(0).max(1),
	iat: z.number().int(),
	exp: z.number().int(),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayload>;
