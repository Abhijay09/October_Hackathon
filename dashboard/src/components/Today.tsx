import { useEffect, useState } from "react";
import { RBI, secondsToIstMidnight } from "@shared/rbi";
import { useApp } from "../App";
import { api, type PaymasterStats } from "../lib/api";
import { write } from "../lib/chain";
import { duration, formatINR, formatIST, toPaise } from "../lib/format";

export function Today() {
  const { cfg, state, run, busy } = useApp();
  const { session, spentToday, txThisHour, now } = state;
  const [editing, setEditing] = useState(false);
  const [perTx, setPerTx] = useState("");
  const [daily, setDaily] = useState("");
  const [perHour, setPerHour] = useState("");
  const [pm, setPm] = useState<PaymasterStats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.paymaster().then((s) => alive && setPm(s)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const pct = session.dailyLimit > 0n ? Number((spentToday * 1000n) / session.dailyLimit) / 10 : 0;
  const expired = session.validUntil < now;

  const startEdit = () => {
    setPerTx(String(Number(session.perTxLimit) / 100));
    setDaily(String(Number(session.dailyLimit) / 100));
    setPerHour(String(session.maxTxPerHour));
    setEditing(true);
  };

  const perTxPaise = safePaise(perTx);
  const dailyPaise = safePaise(daily);
  const problem =
    perTxPaise === null || dailyPaise === null || !(Number(perHour) >= 1)
      ? "Enter amounts in rupees and at least 1 payment an hour."
      : perTxPaise > RBI.AFA_EXEMPT_LIMIT
        ? "RBI allows payments without extra authentication only up to ₹15,000. Set the auto-approve limit at or below that."
        : perTxPaise === 0n
          ? "The auto-approve limit must be more than ₹0."
          : dailyPaise < perTxPaise
            ? "The daily limit can't be lower than the auto-approve limit."
            : null;

  const save = () =>
    run("Saving limits", async () => {
      await write(cfg.devKeys.owner, cfg.contracts.wallet, "setLimits", [cfg.accounts.agent, perTxPaise, dailyPaise, Number(perHour)]);
      setEditing(false);
      return "Limits saved. They apply to the agent's next payment.";
    });

  const renew = () =>
    run("Renewing session", async () => {
      await write(cfg.devKeys.owner, cfg.contracts.wallet, "addSession", [
        cfg.accounts.agent,
        now - 60,
        now + 7 * 86_400,
        session.perTxLimit || toPaise(5_000),
        session.dailyLimit || toPaise(20_000),
        session.maxTxPerHour || 5,
      ]);
      return "Agent session renewed for 7 days.";
    });

  return (
    <section className="panel" aria-labelledby="today-title">
      <div className="panel-head">
        <h2 id="today-title">Today's spending</h2>
        <p className="muted small">Resets at midnight IST, in {duration(secondsToIstMidnight(now))}.</p>
      </div>

      <p className="meter-figure">
        {formatINR(spentToday)} <span className="muted">of {formatINR(session.dailyLimit)}</span>
      </p>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Daily limit used">
        <div className={`meter-fill ${pct > 80 ? "meter-hot" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>

      {!editing ? (
        <dl className="facts">
          <div>
            <dt>Auto-approve up to</dt>
            <dd>{formatINR(session.perTxLimit)} per payment</dd>
          </div>
          <div>
            <dt>Payments this hour</dt>
            <dd>
              {txThisHour} of {session.maxTxPerHour}
            </dd>
          </div>
          <div>
            <dt>Agent session</dt>
            <dd className={expired ? "bad-text" : ""}>
              {expired ? `Expired ${formatIST(session.validUntil)}` : `Valid until ${formatIST(session.validUntil)}`}
            </dd>
          </div>
          <div>
            <dt>Gas</dt>
            <dd>
              Sponsored, so you never need ETH.{" "}
              {pm && (
                <span className="muted">
                  {((Number(pm.spent) / Number(pm.quota)) * 100).toFixed(1)}% of this wallet's quota used, {pm.refused} sponsorships refused.
                </span>
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <div className="form">
          <label>
            Auto-approve limit per payment (₹)
            <input inputMode="decimal" value={perTx} onChange={(e) => setPerTx(e.target.value)} />
            <span className="hint">RBI cap ₹15,000. Bigger payments wait for you.</span>
          </label>
          <label>
            Daily limit (₹)
            <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </label>
          <label>
            Payments per hour
            <input inputMode="numeric" value={perHour} onChange={(e) => setPerHour(e.target.value)} />
          </label>
          {problem && <p className="field-error" role="alert">{problem}</p>}
          <div className="actions">
            <button className="btn btn-primary" disabled={!!problem || !!busy} onClick={save}>Save limits</button>
            <button className="btn btn-quiet" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {!editing && (
        <div className="actions">
          <button className="btn btn-quiet" disabled={!!busy || !session.active} onClick={startEdit}>Change limits</button>
          {(expired || !session.active) && (
            <button className="btn btn-primary" disabled={!!busy} onClick={renew}>Renew session</button>
          )}
        </div>
      )}
    </section>
  );
}

function safePaise(v: string): bigint | null {
  try {
    return toPaise(v);
  } catch {
    return null;
  }
}
