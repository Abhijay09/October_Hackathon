import { REASON_INFO, RBI } from "@shared/rbi";
import { useApp } from "../App";
import { write } from "../lib/chain";
import { duration, formatINR, nameOf } from "../lib/format";

const TTL = 24 * 3600;

/** Out-of-policy requests wait here. Approving is the "additional factor of authentication". */
export function Approvals() {
  const { cfg, state, run, busy } = useApp();
  const open = state.pending.filter((p) => p.status === 1 && p.createdAt + TTL > state.now);
  if (open.length === 0) return null;

  return (
    <section className="panel approvals" aria-labelledby="approvals-title">
      <div className="panel-head">
        <h2 id="approvals-title">Waiting for your approval</h2>
        <p className="muted small">Nothing moves until you decide. Requests lapse after 24 hours.</p>
      </div>
      <ul className="slips">
        {open.map((p) => {
          const to = nameOf(cfg, p.recipient === "0x0000000000000000000000000000000000000000" ? p.target : p.recipient);
          const benign = p.reason === "OverAfaLimit";
          const selfCall = p.reason === "SelfCall";
          const overCap = p.amount > RBI.HARD_PER_TX_CAP;
          return (
            <li key={p.id.toString()} className={`slip ${benign ? "" : "slip-alarm"}`}>
              <div className="slip-main">
                <p className="slip-amount">{p.amount > 0n ? formatINR(p.amount) : "No amount"}</p>
                <p>
                  to <strong className={to.known ? "" : "bad-text"}>{to.name}</strong>
                </p>
                <p className="small muted">
                  Request #{p.id.toString()}. {REASON_INFO[p.reason].detail} Lapses in {duration(p.createdAt + TTL - state.now)}.
                </p>
                {!benign && (
                  <p className="small bad-text">
                    This looks like a hijack attempt, and the agent was frozen. Only approve if you asked for it.
                  </p>
                )}
                {overCap && <p className="small bad-text">Above the ₹1,00,000 per-transaction cap, so it can't be approved.</p>}
              </div>
              <div className="slip-actions">
                <button
                  className={`btn ${benign ? "btn-primary" : "btn-quiet"}`}
                  disabled={!!busy || selfCall || overCap}
                  onClick={() =>
                    run("Approving", async () => {
                      await write(cfg.devKeys.owner, cfg.contracts.wallet, "approvePending", [p.id]);
                      return `Approved. ${formatINR(p.amount)} paid to ${to.name}.`;
                    })
                  }
                >
                  Approve payment
                </button>
                <button
                  className="btn btn-quiet"
                  disabled={!!busy}
                  onClick={() =>
                    run("Declining", async () => {
                      await write(cfg.devKeys.owner, cfg.contracts.wallet, "rejectPending", [p.id]);
                      return `Declined request #${p.id}.`;
                    })
                  }
                >
                  Decline
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
