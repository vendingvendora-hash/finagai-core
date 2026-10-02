/**
 * G19 (tier filter) and G21 (response size cap) for every tool response and notification.
 */
export type Tier = "public" | "internal" | "confidential" | "highly_sensitive" | "prohibited";
const ORDER: Record<Tier, number> = { public: 0, internal: 1, confidential: 2, highly_sensitive: 3, prohibited: 4 };

/** v1 ceiling for tool responses to Julian's client (ADR-016). */
export const V1_MAX_TIER: Tier = "confidential";

export function filterByTier<T extends { classification: Tier }>(rows: readonly T[], maxTier: Tier = V1_MAX_TIER): { rows: T[]; withheld: number } {
  const kept = rows.filter((r) => ORDER[r.classification] <= ORDER[maxTier]);
  return { rows: kept, withheld: rows.length - kept.length };
}

export const DEFAULT_MAX_RESPONSE_BYTES = 48_000;

/** Keep whole items until the serialized size would exceed the cap; report truncation explicitly. */
export function capResponse<T>(items: readonly T[], maxBytes = DEFAULT_MAX_RESPONSE_BYTES): { items: T[]; truncated: boolean; omitted: number } {
  const out: T[] = [];
  let size = 2;
  for (const item of items) {
    const n = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (size + n > maxBytes) break;
    out.push(item);
    size += n;
  }
  return { items: out, truncated: out.length < items.length, omitted: items.length - out.length };
}
