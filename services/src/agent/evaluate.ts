// Runs honest traffic and the full attack suite on fresh sandbox wallets and computes the
// Phase 2 metrics: detection rate and false-freeze rate.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { abis, ROOT } from "../lib/chain.js";
import type { Context } from "../lib/context.js";
import { toJson } from "../lib/json.js";
import { ATTACKS, runAttack, type AttackResult } from "./attacks.js";
import { runErrands, type ErrandResult } from "./honest.js";
import { deploySandbox } from "./sandbox.js";

export interface Report {
  generatedAt: string;
  chainTime: number;
  honest: ErrandResult[];
  attacks: AttackResult[];
  metrics: {
    attacks: number;
    caught: number;
    detectionRate: number;
    honestOps: number;
    falseFreezes: number;
    falseFreezeRate: number;
    honestMisrouted: number;
    attackerGainPaise: string;
    maxContainedLossPaise: string;
  };
}

export const REPORT_FILE = resolve(ROOT, "services/data/report.json");

export async function evaluate(ctx: Context, log: (msg: string) => void = () => {}): Promise<Report> {
  log("Honest traffic: 10 errands on a fresh wallet…");
  const honestBox = await deploySandbox(ctx);
  const honest = await runErrands(ctx, honestBox.agent);
  const honestFrozen = (await ctx.publicClient.readContract({
    address: honestBox.wallet,
    abi: abis.wallet,
    functionName: "frozen",
  })) as boolean;

  const attacks: AttackResult[] = [];
  for (const def of ATTACKS) {
    log(`${def.id} ${def.title}…`);
    attacks.push(await runAttack(ctx, def));
  }

  const caught = attacks.filter((a) => a.caught).length;
  const falseFreezes = honest.filter((h) => h.outcome.froze).length + (honestFrozen && !honest.some((h) => h.outcome.froze) ? 1 : 0);
  const report: Report = {
    generatedAt: new Date().toISOString(),
    chainTime: await ctx.chainNow(),
    honest,
    attacks,
    metrics: {
      attacks: attacks.length,
      caught,
      detectionRate: caught / attacks.length,
      honestOps: honest.length,
      falseFreezes,
      falseFreezeRate: falseFreezes / honest.length,
      honestMisrouted: honest.filter((h) => !h.ok).length,
      attackerGainPaise: attacks.reduce((s, a) => s + BigInt(a.attackerGainPaise), 0n).toString(),
      maxContainedLossPaise: attacks.reduce((m, a) => (BigInt(a.lossPaise) > m ? BigInt(a.lossPaise) : m), 0n).toString(),
    },
  };
  mkdirSync(resolve(ROOT, "services/data"), { recursive: true });
  writeFileSync(REPORT_FILE, toJson(report, 2));
  return report;
}
