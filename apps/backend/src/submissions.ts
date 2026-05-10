import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	SubmissionRecord as Schema,
	type SubmissionRecord,
} from "@almanac/shared";

// File-backed submission store, mirrors RecipeCache. One JSON file per
// submission. Lookup by id (uuid). Used to surface status to submitters and
// to give the maintainer an audit trail before approving a Clustly task.

export class SubmissionStore {
	private readonly records = new Map<string, SubmissionRecord>();
	constructor(private readonly dir: string) {}

	async load(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		for (const name of await readdir(this.dir)) {
			if (!name.endsWith(".json")) continue;
			const raw = await readFile(join(this.dir, name), "utf8");
			const parsed = Schema.safeParse(JSON.parse(raw));
			if (parsed.success) this.records.set(parsed.data.id, parsed.data);
		}
	}

	async upsert(record: SubmissionRecord): Promise<void> {
		this.records.set(record.id, record);
		await writeFile(
			join(this.dir, `${record.id}.json`),
			JSON.stringify(record, null, 2),
			"utf8",
		);
	}

	get(id: string): SubmissionRecord | null {
		return this.records.get(id) ?? null;
	}

	findByReceipt(token: string): SubmissionRecord | null {
		for (const r of this.records.values()) {
			if (r.receipt === token) return r;
		}
		return null;
	}
}
