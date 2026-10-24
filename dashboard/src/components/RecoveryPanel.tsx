import { useApp } from "../App";
import { write } from "../lib/chain";
import { duration, formatIST, short } from "../lib/format";

const ZERO = "0x0000000000000000000000000000000000000000";

export function RecoveryPanel() {
  const { cfg, state, run, busy } = useApp();
  const { recovery, now } = state;
  const w = cfg.contracts.wallet;
  const active = recovery.newOwner !== ZERO;
  const ready = active && recovery.executableAt > 0 && now >= recovery.executableAt;

  const vote = (i: number) =>
    run(`Guardian ${i + 1} is signing`, async () => {
      const pk = cfg.devKeys.guardians[i];
      if (!active) {
        await write(pk, w, "proposeRecovery", [cfg.accounts.newDevice]);
        return `Guardian ${i + 1} started recovery to the owner's new device.`;
      }
      await write(pk, w, "supportRecovery");
      return `Guardian ${i + 1} approved.`;
    });

  return (
    <section className="panel" aria-labelledby="recovery-title">
      <div className="panel-head">
        <h2 id="recovery-title">Guardian recovery</h2>
        <p className="muted small">
          Lost your key? 3 of your 5 guardians can move the wallet to a new device. You get 48 hours to veto.
        </p>
      </div>

      {active ? (
        <p className="small">
          Moving ownership to <strong>{short(recovery.newOwner)}</strong>. {recovery.approvals} of 3 approvals.{" "}
          {recovery.executableAt > 0 &&
            (ready ? "The 48-hour wait is over." : `Can run ${formatIST(recovery.executableAt)} IST, in ${duration(recovery.executableAt - now)}.`)}
        </p>
      ) : (
        <p className="small muted">No recovery in progress.</p>
      )}

      <ul className="guardians">
        {cfg.accounts.guardians.map((g, i) => (
          <li key={g}>
            <span>
              Guardian {i + 1} <span className="muted small">{short(g)}</span>
            </span>
            {recovery.voted[i] ? (
              <span className="mark mark-ok">Approved</span>
            ) : (
              <button className="btn btn-small" disabled={!!busy || (active && recovery.approvals >= 3)} onClick={() => vote(i)}>
                {active ? "Approve" : "Start recovery"}
              </button>
            )}
          </li>
        ))}
      </ul>

      {active && (
        <div className="actions">
          <button
            className="btn btn-danger"
            disabled={!!busy || state.owner.toLowerCase() !== cfg.accounts.owner.toLowerCase()}
            onClick={() =>
              run("Vetoing", async () => {
                await write(cfg.devKeys.owner, w, "cancelRecovery");
                return "Recovery vetoed. Your key stays the owner.";
              })
            }
          >
            Veto recovery
          </button>
          <button
            className="btn btn-quiet"
            disabled={!!busy || !ready}
            onClick={() =>
              run("Running recovery", async () => {
                await write(cfg.devKeys.guardians[0], w, "executeRecovery");
                return { tone: "warn", text: "Recovery done. The new owner controls the wallet; agent sessions were revoked." };
              })
            }
          >
            Complete recovery
          </button>
        </div>
      )}
    </section>
  );
}
