// CLI: npm run attacks: runs the evaluation against the local chain and prints the report.
import { createContext } from "../lib/context.js";
import { formatINR } from "../lib/rupee.js";
import { evaluate } from "./evaluate.js";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const ctx = createContext();
  const report = await evaluate(ctx, (m) => console.log(`  · ${m}`));

  console.log("\nHonest agent traffic");
  for (const h of report.honest) {
    const status = h.outcome.kind === "pending" ? "pending owner approval" : h.outcome.kind;
    console.log(`  ${h.ok ? "✓" : "✗"} ${formatINR(BigInt(h.rupees) * 100n).padStart(12)}  ${h.merchantName.padEnd(16)} ${status}`);
  }

  console.log("\nHijack attacks");
  for (const a of report.attacks) {
    const how = a.outcomes.map((o) => o.reason ?? o.kind).filter(Boolean).slice(-1)[0];
    const loss = BigInt(a.lossPaise) > 0n ? `  (contained loss ${formatINR(BigInt(a.lossPaise))})` : "";
    console.log(`  ${a.caught ? "✓ caught" : "✗ MISSED"}  ${a.id} ${a.title.padEnd(24)} ${how}${loss}`);
  }

  const m = report.metrics;
  console.log("\nMetrics");
  console.log(`  Detection rate     ${pct(m.detectionRate)}  (${m.caught}/${m.attacks})`);
  console.log(`  False-freeze rate  ${pct(m.falseFreezeRate)}  (${m.falseFreezes}/${m.honestOps} honest ops)`);
  console.log(`  Attacker gained    ${formatINR(BigInt(m.attackerGainPaise))}`);
  console.log(`  Max contained loss ${formatINR(BigInt(m.maxContainedLossPaise))} (daily limit ₹20,000.00)`);
  if (m.caught !== m.attacks || m.falseFreezes > 0 || m.honestMisrouted > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
