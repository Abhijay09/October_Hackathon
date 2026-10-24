import { useEffect, useState } from "react";
import { REASON_INFO, type ReasonName } from "@shared/rbi";
import { useApp } from "../App";
import { api, type Report } from "../lib/api";
import { formatINR } from "../lib/format";

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

const ENTRYPOINT_CODES: Array<[RegExp, string]> = [
  [/^AA22/, "Session expired"],
  [/^AA24/, "Signature check"],
  [/^AA25/, "Nonce (replay)"],
  [/QuotaExceeded/, "Gas quota"],
  [/^rate limit/, "Sponsor rate limit"],
  [/^gas quota/, "Gas quota"],
];

function stoppedBy(reason?: string): string {
  if (!reason) return "";
  for (const [re, label] of ENTRYPOINT_CODES) if (re.test(reason)) return label;
  const info = REASON_INFO[reason as ReasonName];
  return info ? info.label : reason;
}

export function AttackLab() {
  const { run, busy } = useApp();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    api.report().then(setReport).catch(() => {});
  }, []);

  const start = () =>
    run("Running the attack lab", async () => {
      const r = await api.runLab();
      setReport(r);
      return {
        tone: r.metrics.caught === r.metrics.attacks && r.metrics.falseFreezes === 0 ? "ok" : "bad",
        text: `${r.metrics.caught} of ${r.metrics.attacks} attacks caught. ${r.metrics.falseFreezes} honest payments frozen.`,
      };
    });

  return (
    <section id="lab" className="lab" aria-labelledby="lab-title">
      <div className="lab-head">
        <div>
          <h2 id="lab-title">Attack lab</h2>
          <p className="muted">
            Ten hijack attacks and ten honest errands, each on a fresh copy of this wallet with the same limits.
            Your real wallet isn't touched. Chain time moves forward a few hours while it runs.
          </p>
        </div>
        <button className="btn btn-primary" disabled={!!busy} onClick={start}>
          {report ? "Run again" : "Run attack lab"}
        </button>
      </div>

      {!report ? (
        <p className="empty">No results yet. Run the lab to measure the detection rate and false freezes.</p>
      ) : (
        <>
          <div className="scores">
            <p>
              <span className="score">{pct(report.metrics.detectionRate)}</span>
              <span>of attacks caught ({report.metrics.caught} of {report.metrics.attacks})</span>
            </p>
            <p>
              <span className="score">{pct(report.metrics.falseFreezeRate)}</span>
              <span>of honest payments wrongly frozen ({report.metrics.falseFreezes} of {report.metrics.honestOps})</span>
            </p>
            <p>
              <span className="score">{formatINR(BigInt(report.metrics.attackerGainPaise))}</span>
              <span>reached the attacker</span>
            </p>
            <p>
              <span className="score">{formatINR(BigInt(report.metrics.maxContainedLossPaise))}</span>
              <span>worst loss, to an allowed merchant, within the ₹20,000 daily limit</span>
            </p>
          </div>

          <div className="ledger-scroll">
            <table className="ledger lab-table">
              <thead>
                <tr>
                  <th scope="col">Attack</th>
                  <th scope="col">What the attacker tried</th>
                  <th scope="col">Stopped by</th>
                  <th scope="col" className="num">Lost</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {report.attacks.map((a) => {
                  const last = a.outcomes[a.outcomes.length - 1];
                  return (
                    <tr key={a.id}>
                      <td className="nowrap"><strong>{a.title}</strong></td>
                      <td>
                        <span className="particulars">{a.vector}</span>
                        <span className="detail">{a.defence}{a.note ? ` ${a.note}` : ""}</span>
                      </td>
                      <td>
                        {stoppedBy(last?.reason)}
                        {last?.reason && stoppedBy(last.reason) !== last.reason && !(last.reason in REASON_INFO) && (
                          <span className="detail">{last.reason}</span>
                        )}
                      </td>
                      <td className="num">{formatINR(BigInt(a.lossPaise))}</td>
                      <td>
                        <span className={`mark ${a.caught ? "mark-ok" : "mark-bad"}`}>{a.caught ? "Caught" : "Missed"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small">Last run {new Date(report.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.</p>
        </>
      )}
    </section>
  );
}
