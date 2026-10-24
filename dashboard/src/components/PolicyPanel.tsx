import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useApp } from "../App";
import { api } from "../lib/api";
import { write } from "../lib/chain";

/** The allowlist is a Merkle tree; only its 32-byte root lives on-chain. */
export function PolicyPanel() {
  const { cfg, state, run, busy } = useApp();
  const [allowed, setAllowed] = useState<Set<string> | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .policy()
      .then((p) => {
        const s = new Set(p.recipients.map((a) => a.toLowerCase()));
        setAllowed(s);
        setDraft(new Set(s));
      })
      .catch(() => {});
  }, [state.policyRoot]);

  if (!allowed) return null;
  const changed = draft.size !== allowed.size || [...draft].some((a) => !allowed.has(a));

  const toggle = (addr: string) => {
    const next = new Set(draft);
    next.has(addr) ? next.delete(addr) : next.add(addr);
    setDraft(next);
  };

  const save = () =>
    run("Updating allowed merchants", async () => {
      const merchants = cfg.merchants.filter((m) => draft.has(m.address.toLowerCase())).map((m) => m.address as Address);
      const { root } = await api.previewPolicy(merchants);
      await write(cfg.devKeys.owner, cfg.contracts.wallet, "setPolicyRoot", [root]);
      await api.commitPolicy(merchants);
      return `Saved. The agent can pay ${merchants.length} merchant${merchants.length === 1 ? "" : "s"}.`;
    });

  return (
    <section className="panel" aria-labelledby="policy-title">
      <div className="panel-head">
        <h2 id="policy-title">Allowed merchants</h2>
        <p className="muted small">The agent can only pay these. Paying anyone else freezes it.</p>
      </div>
      <ul className="checklist">
        {cfg.merchants.map((m) => {
          const a = m.address.toLowerCase();
          return (
            <li key={m.id}>
              <label>
                <input type="checkbox" checked={draft.has(a)} onChange={() => toggle(a)} />
                <span>
                  {m.name} <span className="muted small">{m.category}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {changed && (
        <div className="actions">
          <button className="btn btn-primary" disabled={!!busy} onClick={save}>Save allowed merchants</button>
          <button className="btn btn-quiet" onClick={() => setDraft(new Set(allowed))}>Discard</button>
        </div>
      )}
    </section>
  );
}
