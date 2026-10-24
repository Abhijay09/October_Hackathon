import { REASON_INFO } from "@shared/rbi";
import { useApp } from "../App";
import { api } from "../lib/api";
import { write } from "../lib/chain";
import { formatINR, formatIST, short } from "../lib/format";
import { YinYang } from "./YinYang";

export function Hero() {
  const { cfg, state, run, busy, reloadConfig } = useApp();
  const pk = cfg.devKeys.owner;
  const w = cfg.contracts.wallet;
  const isOwner = state.owner.toLowerCase() === cfg.accounts.owner.toLowerCase();

  const status = state.fraudReportedAt
    ? { label: "Fraud reported", tone: "bad" }
    : state.frozen
      ? { label: "Agent frozen", tone: "bad" }
      : !state.session.active || state.session.validUntil < state.now
        ? { label: "No active session", tone: "warn" }
        : { label: "Agent active", tone: "ok" };

  const freezeWhy =
    state.frozen && state.lastFreezeReason !== "None"
      ? `Frozen automatically: ${REASON_INFO[state.lastFreezeReason].label.toLowerCase()}. ${REASON_INFO[state.lastFreezeReason].detail}`
      : state.frozen
        ? "You froze the agent. It can't spend until you unfreeze it."
        : null;

  const rotateAndUnfreeze = () =>
    run("Rotating the agent key", async () => {
      const { from, to } = await api.rotate();
      await write(pk, w, "unfreeze", [from, to]);
      await api.commitRotation();
      await reloadConfig();
      return `Unfrozen with a new agent key ${short(to)}. The old key no longer works.`;
    });

  return (
    <section className="hero" aria-labelledby="balance-label">
      <div className="hero-balance">
        <p id="balance-label" className="muted">Wallet balance</p>
        <p className="balance">{formatINR(state.balance)}</p>
        <p className="muted small">
          Holding cap ₹2,00,000 (RBI full-KYC PPI limit). Anything above it goes to your linked bank account, which
          holds {formatINR(state.bankBalance)}.
        </p>
      </div>

      <div className="hero-status">
        <div className="status">
          <YinYang still={state.frozen || status.tone !== "ok"} />
          <span className={`status-label status-${status.tone}`}>{status.label}</span>
        </div>
        {freezeWhy && <p className="small">{freezeWhy}</p>}
        {state.fraudReportedAt > 0 && (
          <p className="small">
            Fraud reported {formatIST(state.fraudReportedAt)} IST. Under RBI's customer-liability rules, reporting
            fast limits what you can lose.
          </p>
        )}
        {!isOwner && <p className="small warn-text">Ownership moved to {short(state.owner)} by guardian recovery.</p>}
        <div className="actions">
          {!state.frozen ? (
            <>
              <button className="btn btn-danger" disabled={!!busy || !isOwner} onClick={() => run("Freezing", async () => {
                await write(pk, w, "freeze");
                return "Agent frozen. It can't spend anything.";
              })}>
                Freeze agent
              </button>
              <button className="btn btn-quiet" disabled={!!busy || !isOwner} onClick={() => run("Reporting fraud", async () => {
                await write(pk, w, "reportFraud");
                return { tone: "warn", text: "Fraud reported and agent frozen. The report time is recorded on-chain." };
              })}>
                Report fraud
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" disabled={!!busy || !isOwner} onClick={rotateAndUnfreeze}>
                Unfreeze with a new key
              </button>
              <button className="btn btn-quiet" disabled={!!busy || !isOwner} onClick={() => run("Unfreezing", async () => {
                await write(pk, w, "unfreeze", ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"]);
                return "Agent unfrozen with the same key.";
              })}>
                Unfreeze, keep key
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
