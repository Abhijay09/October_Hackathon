import { useState } from "react";
import { REASON_INFO, type ReasonName } from "@shared/rbi";
import { useApp } from "../App";
import { api, type Outcome } from "../lib/api";
import { formatINR, short, toPaise } from "../lib/format";

export function describeOutcome(o: Outcome, amount?: string): { tone: "ok" | "warn" | "bad"; text: string } {
  if (o.kind === "settled") return { tone: "ok", text: `Paid${amount ? ` ${amount}` : ""}.` };
  if (o.kind === "pending") return { tone: "warn", text: "Above the auto-approve limit. It's waiting for your approval." };
  const info = REASON_INFO[o.reason as ReasonName];
  if (o.kind === "blocked") {
    return { tone: "bad", text: `Blocked: ${info ? info.label.toLowerCase() : o.reason}.${o.froze ? " The agent is now frozen." : ""}` };
  }
  const where = o.stage === "paymaster" ? "The gas sponsor refused" : "The network refused";
  return { tone: "bad", text: `${where}: ${o.reason}.` };
}

export function AgentPanel() {
  const { cfg, run, busy } = useApp();
  const [merchant, setMerchant] = useState(cfg.merchants[0]?.id ?? "");
  const [amount, setAmount] = useState("499");

  let paise: bigint | null = null;
  try {
    paise = toPaise(amount);
  } catch {
    paise = null;
  }

  return (
    <section className="panel" aria-labelledby="agent-title">
      <div className="panel-head">
        <h2 id="agent-title">Your agent</h2>
        <p className="muted small">
          A scripted shopping bot holding session key {short(cfg.accounts.agent)}. Treat it as untrusted.
        </p>
      </div>

      <div className="form">
        <label>
          Merchant
          <select value={merchant} onChange={(e) => setMerchant(e.target.value)}>
            {cfg.merchants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.category})
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (₹)
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {paise === null && <p className="field-error">Enter an amount in rupees, like 1250 or 499.50.</p>}
        <div className="actions">
          <button
            className="btn btn-primary"
            disabled={!!busy || !paise}
            onClick={() =>
              run("Agent is paying", async () => {
                const o = await api.pay(merchant, Number(amount.replace(/,/g, "")));
                return describeOutcome(o, paise ? formatINR(paise) : undefined);
              })
            }
          >
            Ask agent to pay
          </button>
          <button
            className="btn btn-quiet"
            disabled={!!busy}
            onClick={() =>
              run("Agent is running errands", async () => {
                const { results } = await api.errands();
                const paid = results.filter((r) => r.outcome.kind === "settled").length;
                const waiting = results.filter((r) => r.outcome.kind === "pending").length;
                return `Errands done: ${paid} paid${waiting ? `, ${waiting} waiting for you` : ""}.`;
              })
            }
          >
            Run shopping list
          </button>
        </div>
      </div>

      <div className="hijack">
        <p className="small">
          <strong>Try a prompt injection.</strong> A product page tells the agent to send ₹25,000 to a "refund
          verification" address. The agent obeys; the wallet doesn't.
        </p>
        <button
          className="btn btn-danger"
          disabled={!!busy}
          onClick={() => run("Hijacking the agent", async () => describeOutcome(await api.hijack()))}
        >
          Hijack the agent
        </button>
      </div>
    </section>
  );
}
