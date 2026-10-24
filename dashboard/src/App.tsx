import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, type Config } from "./lib/api";
import { useWallet, type WalletState } from "./lib/useWallet";
import { Hero } from "./components/Hero";
import { Passbook } from "./components/Passbook";
import { Today } from "./components/Today";
import { Approvals } from "./components/Approvals";
import { AgentPanel } from "./components/AgentPanel";
import { PolicyPanel } from "./components/PolicyPanel";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { AttackLab } from "./components/AttackLab";
import { Clock } from "./components/Clock";

interface Toast {
  id: number;
  tone: "ok" | "warn" | "bad";
  text: string;
}

interface Ctx {
  cfg: Config;
  state: WalletState;
  refresh(): Promise<void>;
  reloadConfig(): Promise<void>;
  busy: string | null;
  /** Run an action with a busy label; its returned string (if any) becomes a toast. */
  run(label: string, fn: () => Promise<string | { tone: Toast["tone"]; text: string } | void>): Promise<void>;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const { state, error, refresh } = useWallet(cfg);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const reloadConfig = useCallback(async () => {
    try {
      setCfg(await api.config());
      setCfgError(null);
    } catch (err) {
      setCfgError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    reloadConfig();
  }, [reloadConfig]);

  useEffect(() => {
    if (!cfg) {
      const t = setInterval(reloadConfig, 3000);
      return () => clearInterval(t);
    }
  }, [cfg, reloadConfig]);

  const toast = (tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  };

  const run: Ctx["run"] = async (label, fn) => {
    setBusy(label);
    try {
      const result = await fn();
      if (typeof result === "string") toast("ok", result);
      else if (result) toast(result.tone, result.text);
    } catch (err) {
      toast("bad", (err as Error).message);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (!cfg || !state) {
    return (
      <div className="boot">
        <h1 className="wordmark">HyperNexus</h1>
        <p>{cfgError || error ? "Waiting for the local chain and services…" : "Opening the passbook…"}</p>
        {(cfgError || error) && (
          <p className="muted">
            Start everything with <code>npm run dev</code> from the project root. ({cfgError ?? error})
          </p>
        )}
      </div>
    );
  }

  return (
    <AppCtx.Provider value={{ cfg, state, refresh, reloadConfig, busy, run }}>
      <header className="masthead">
        <div className="brand">
          <span className="wordmark">HyperNexus</span>
          <span className="muted">Agent wallet, paying in simulated e₹ on a local chain</span>
        </div>
        <Clock />
      </header>

      <Hero />

      <main className="layout">
        <div className="col-main">
          <Approvals />
          <Passbook />
        </div>
        <aside className="col-side">
          <Today />
          <AgentPanel />
          <PolicyPanel />
          <RecoveryPanel />
        </aside>
      </main>

      <AttackLab />

      <footer className="footer muted">
        Prototype. The e₹ here is a simulated token on a local chain, not RBI's Digital Rupee. Limits follow RBI
        guidance as described in docs/RBI_COMPLIANCE.md. Demo keys only.
      </footer>

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
      {busy && <div className="busy">{busy}…</div>}
    </AppCtx.Provider>
  );
}
