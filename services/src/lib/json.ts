/** JSON with bigints as decimal strings. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), space);
}
