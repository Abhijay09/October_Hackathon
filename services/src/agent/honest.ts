// Honest agent traffic: a realistic week of errands. Used to measure the false-freeze rate and as
// the shopping demo on the main wallet.
import type { Address } from "viem";
import type { Context } from "../lib/context.js";
import { toPaise } from "../lib/rupee.js";
import type { AgentClient, Outcome } from "./client.js";

export interface Errand {
  merchant: string; // Merchant id
  rupees: number;
  memo: string;
  /** Chain-time gap before this errand (the agent works at a human-ish pace). */
  gapMinutes: number;
}

export const ERRANDS: Errand[] = [
  { merchant: "apicredits", rupees: 499, memo: "LLM API credits top-up", gapMinutes: 0 },
  { merchant: "railtix", rupees: 1_250, memo: "Pune → Mumbai train ticket", gapMinutes: 15 },
  { merchant: "kirana", rupees: 2_340, memo: "Weekly groceries", gapMinutes: 20 },
  { merchant: "gadgets", rupees: 18_000, memo: "Laptop for the new intern (needs owner approval)", gapMinutes: 15 },
  { merchant: "apicredits", rupees: 199, memo: "Embedding API credits", gapMinutes: 25 },
  { merchant: "kirana", rupees: 865, memo: "Milk, bread, fruit", gapMinutes: 40 },
  { merchant: "railtix", rupees: 3_100, memo: "Return ticket, AC 2-tier", gapMinutes: 30 },
  { merchant: "kirana", rupees: 1_120, memo: "Cleaning supplies", gapMinutes: 45 },
  { merchant: "apicredits", rupees: 750, memo: "Speech-to-text credits", gapMinutes: 20 },
  { merchant: "gadgets", rupees: 2_499, memo: "Keyboard and mouse", gapMinutes: 35 },
];

export interface ErrandResult extends Errand {
  merchantName: string;
  outcome: Pick<Outcome, "kind" | "reason" | "stage" | "froze" | "pendingId">;
  expected: "settled" | "pending";
  ok: boolean;
}

export function merchantAddress(ctx: Context, id: string): Address {
  const m = ctx.dep.merchants.find((x) => x.id === id);
  if (!m) throw new Error(`unknown merchant ${id}`);
  return m.address;
}

export async function runErrands(
  ctx: Context,
  agent: AgentClient,
  errands: Errand[] = ERRANDS,
  opts: { warp?: boolean; perTxLimitPaise?: bigint } = {},
): Promise<ErrandResult[]> {
  const perTx = opts.perTxLimitPaise ?? toPaise(5_000);
  const results: ErrandResult[] = [];
  for (const e of errands) {
    if (opts.warp !== false && e.gapMinutes > 0) await ctx.warp(e.gapMinutes * 60);
    const outcome = await agent.pay(merchantAddress(ctx, e.merchant), toPaise(e.rupees));
    const expected = toPaise(e.rupees) > perTx ? "pending" : "settled";
    results.push({
      ...e,
      merchantName: ctx.dep.merchants.find((m) => m.id === e.merchant)!.name,
      outcome: {
        kind: outcome.kind,
        reason: outcome.reason,
        stage: outcome.stage,
        froze: outcome.froze,
        pendingId: outcome.pendingId,
      },
      expected,
      ok: outcome.kind === expected,
    });
  }
  return results;
}
