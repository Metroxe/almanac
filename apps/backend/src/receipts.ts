import { createHmac, timingSafeEqual } from "node:crypto";
import { type ReceiptPayload, ReceiptPayload as Schema } from "@almanac/shared";

// Stateless signed receipts. Token format: <base64url(payload)>.<base64url(sig)>.
// HMAC-SHA256 with ALMANAC_RECEIPT_SECRET. No DB lookup needed to verify —
// Clustly approval flow can re-check authenticity even after a backend restart.

const b64url = (buf: Buffer): string =>
	buf
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

const fromB64url = (s: string): Buffer =>
	Buffer.from(
		s.replaceAll("-", "+").replaceAll("_", "/") +
			"=".repeat((4 - (s.length % 4)) % 4),
		"base64",
	);

export class ReceiptSigner {
	constructor(private readonly secret: string) {
		if (!secret || secret.length < 16) {
			throw new Error("ALMANAC_RECEIPT_SECRET must be ≥16 chars");
		}
	}

	sign(payload: ReceiptPayload): string {
		const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
		const sig = b64url(createHmac("sha256", this.secret).update(body).digest());
		return `${body}.${sig}`;
	}

	verify(token: string): ReceiptPayload | null {
		const dot = token.indexOf(".");
		if (dot < 0) return null;
		const body = token.slice(0, dot);
		const sig = token.slice(dot + 1);
		const expected = b64url(
			createHmac("sha256", this.secret).update(body).digest(),
		);
		const a = Buffer.from(sig, "utf8");
		const b = Buffer.from(expected, "utf8");
		if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
		const parsed = Schema.safeParse(
			JSON.parse(fromB64url(body).toString("utf8")),
		);
		if (!parsed.success) return null;
		if (parsed.data.exp < Math.floor(Date.now() / 1000)) return null;
		return parsed.data;
	}
}
