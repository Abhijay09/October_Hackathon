import { useApp } from "../App";
import { api } from "../lib/api";
import { formatIST } from "../lib/format";

/** Local-chain time controls, for showing daily resets and the 48-hour recovery wait. */
export function Clock() {
  const { state, run, busy } = useApp();
  const warp = (seconds: number, label: string) =>
    run(`Moving chain time forward ${label}`, async () => {
      await api.warp(seconds);
      return `Chain time moved forward ${label}.`;
    });

  return (
    <div className="clock">
      <span className="small">
        Chain time <strong>{formatIST(state.now)} IST</strong>
      </span>
      <span className="clock-buttons">
        <button className="btn btn-small" disabled={!!busy} onClick={() => warp(3600, "1 hour")}>+1 hour</button>
        <button className="btn btn-small" disabled={!!busy} onClick={() => warp(86_400, "1 day")}>+1 day</button>
        <button className="btn btn-small" disabled={!!busy} onClick={() => warp(48 * 3600, "48 hours")}>+48 hours</button>
      </span>
    </div>
  );
}
