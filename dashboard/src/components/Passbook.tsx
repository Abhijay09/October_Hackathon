import { REASON_INFO, REASONS } from "@shared/rbi";
import { useApp } from "../App";
import { formatINR, formatIST, nameOf, short } from "../lib/format";
import type { LedgerEntry } from "../lib/useWallet";

interface Row {
  particulars: string;
  detail?: string;
  debit?: bigint;
  stamp?: { text: string; tone: "ok" | "warn" | "bad" | "info" };
}

/** Every agent action becomes a passbook line: RBI expects an alert for every transaction. */
export function Passbook() {
  const { cfg, state } = useApp();
  const status = new Map(state.pending.map((p) => [p.id.toString(), p.status]));
  const rows = state.ledger.map((e) => ({ e, row: describe(e, cfg, status) })).filter((x) => x.row);

  return (
    <section className="panel passbook" aria-labelledby="passbook-title">
      <div className="panel-head">
        <h2 id="passbook-title">Passbook</h2>
        <p className="muted small">Every payment the agent tries, newest first. Times are IST.</p>
      </div>
      {rows.length === 0 ? (
        <p className="empty">No activity yet. Ask the agent to pay a merchant to see the first entry.</p>
      ) : (
        <div className="ledger-scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Particulars</th>
                <th scope="col" className="num">Debit</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ e, row }) => (
                <tr key={e.key}>
                  <td className="nowrap muted">{formatIST(e.time)}</td>
                  <td>
                    <span className="particulars">{row!.particulars}</span>
                    {row!.detail && <span className="detail">{row!.detail}</span>}
                  </td>
                  <td className="num">{row!.debit !== undefined ? formatINR(row!.debit) : ""}</td>
                  <td>{row!.stamp && <span className={`mark mark-${row!.stamp.tone}`}>{row!.stamp.text}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const RESOLVED: Record<number, Row["stamp"]> = {
  2: { text: "Approved", tone: "ok" },
  3: { text: "Declined", tone: "info" },
};

function describe(e: LedgerEntry, cfg: ReturnType<typeof useApp>["cfg"], status: Map<string, number>): Row | null {
  const a = e.args;
  switch (e.kind) {
    case "AgentPayment":
      return { particulars: `Agent paid ${nameOf(cfg, a.recipient).name}`, debit: a.amount, stamp: { text: "Paid", tone: "ok" } };
    case "AgentBlocked": {
      const reason = REASONS[Number(a.reason)];
      const info = REASON_INFO[reason];
      const to = nameOf(cfg, a.recipient === "0x0000000000000000000000000000000000000000" ? a.target : a.recipient);
      if (reason === "OverAfaLimit") {
        return {
          particulars: `Agent asked to pay ${to.name}`,
          detail: `${formatINR(a.amount)} is above the auto-approve limit, so it needs your approval.`,
          stamp: RESOLVED[status.get(String(a.pendingId)) ?? 1] ?? { text: "Awaiting you", tone: "warn" },
        };
      }
      return {
        particulars: a.amount > 0n ? `Blocked: ${formatINR(a.amount)} to ${to.name}` : `Blocked: call to ${to.name}`,
        detail: `${info.label}. ${info.detail}`,
        stamp: { text: a.froze ? "Frozen" : "Blocked", tone: "bad" },
      };
    }
    case "PendingApproved":
      return {
        particulars: `You approved request #${a.id} to ${nameOf(cfg, a.recipient).name}`,
        debit: a.amount,
        stamp: { text: "Paid", tone: "ok" },
      };
    case "PendingRejected":
      return { particulars: `You declined request #${a.id}`, stamp: { text: "Declined", tone: "info" } };
    case "AgentFrozen":
      return Number(a.reason) === 0 ? { particulars: "You froze the agent", stamp: { text: "Frozen", tone: "bad" } } : null;
    case "AgentUnfrozen":
      return {
        particulars: a.rotatedTo !== "0x0000000000000000000000000000000000000000" ? `Agent unfrozen with new key ${short(a.rotatedTo)}` : "Agent unfrozen",
        stamp: { text: "Active", tone: "ok" },
      };
    case "FraudReported":
      return { particulars: "Fraud reported", stamp: { text: "Reported", tone: "bad" } };
    case "SessionAdded":
      return {
        particulars: `Agent session set for ${short(a.key)}`,
        detail: `Auto-approve up to ${formatINR(a.perTxLimit)}, ${formatINR(a.dailyLimit)} a day, ${a.maxTxPerHour} payments an hour`,
      };
    case "PolicyRootUpdated":
      return { particulars: "Allowed merchants updated" };
    case "OwnerExecuted":
      return { particulars: "You made a transfer from the wallet" };
    case "ReverseWaterfallSweep":
      return {
        particulars: "Moved to your linked bank account",
        detail: "Balance went over the ₹2,00,000 holding cap.",
        debit: a.amount,
        stamp: { text: "Swept", tone: "info" },
      };
    case "RecoveryProposed":
      return { particulars: `A guardian started recovery to ${short(a.newOwner)}`, stamp: { text: "Recovery", tone: "warn" } };
    case "RecoveryReady":
      return { particulars: `Recovery approved by 3 guardians; can run after ${formatIST(Number(a.executableAt))}`, stamp: { text: "48h wait", tone: "warn" } };
    case "RecoveryVetoed":
      return { particulars: "You vetoed the recovery", stamp: { text: "Vetoed", tone: "ok" } };
    case "RecoveryExecuted":
      return { particulars: `Ownership moved to ${short(a.newOwner)}`, stamp: { text: "Recovered", tone: "info" } };
    default:
      return null;
  }
}
