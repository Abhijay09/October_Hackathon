// Indian Rupee helpers. On-chain amounts are integer paise (the simulated e₹ has 2 decimals).

export const PAISE_PER_RUPEE = 100n;

const inrFormat = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole or fractional rupees → paise. Accepts numbers or strings like "1,50,000.50" or "₹499". */
export function toPaise(rupees: number | string | bigint): bigint {
  if (typeof rupees === "bigint") return rupees * PAISE_PER_RUPEE;
  const text = String(rupees).replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error(`Invalid rupee amount: ${rupees}`);
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole) * PAISE_PER_RUPEE + BigInt(frac.padEnd(2, "0"));
}

/** Paise → "₹1,50,000.00" (Indian digit grouping: lakh / crore). */
export function formatINR(paise: bigint | number): string {
  const p = BigInt(paise);
  const negative = p < 0n;
  const abs = negative ? -p : p;
  // Format the integer part with Intl (exact for any realistic amount), append exact paise.
  const whole = inrFormat.format(Number(abs / PAISE_PER_RUPEE)).replace(/\.\d+$/, "");
  const frac = (abs % PAISE_PER_RUPEE).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Compact form for tight UI: "₹1.5 L", "₹2 Cr", "₹499". */
export function formatINRCompact(paise: bigint | number): string {
  const rupees = Number(BigInt(paise)) / 100;
  if (rupees >= 1_00_00_000) return `₹${trim(rupees / 1_00_00_000)} Cr`;
  if (rupees >= 1_00_000) return `₹${trim(rupees / 1_00_000)} L`;
  return formatINR(paise).replace(/\.00$/, "");
}

function trim(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}
