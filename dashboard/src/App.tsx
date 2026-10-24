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
import { Orb } from "./components/Logo";
import { Login } from "./components/Login";

const SECTIONS: Array<[string, string]> = [
  ["overview", "Overview"],
  ["agent", "Agent"],
  ["passbook", "Passbook"],
  ["policy", "Policy"],
  ["recovery", "Recovery"],
  ["lab", "Attack lab"],
];

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

function Dashboard({ email, onSignOut }: { email: string; onSignOut(): void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const { state, error, refresh } = useWallet(cfg);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [active, setActive] = useState<string>("overview");

  // Highlight the nav tab for the section nearest the top of the screen.
  useEffect(() => {
    if (!cfg || !state) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: "-30% 0px -60% 0px" },
    );
    SECTIONS.forEach(([id]) => document.getElementById(id) && io.observe(document.getElementById(id)!));
    return () => io.disconnect();
  }, [cfg, state === null]);

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
        <h1 className="wordmark">Alchemy</h1>
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
      <header className="topbar">
        <div className="topbar-inner">
          <Orb />
          <a className="brand-name" href="#overview">Alchemy</a>
          <nav className="nav" aria-label="Sections">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`} aria-current={active === id}>
                {label}
              </a>
            ))}
          </nav>
          <div className="account">
            <span className="who small">{email}</span>
            <button className="btn btn-small" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="page">
        <section id="overview" aria-label="Overview">
          <Hero />
          <Approvals />
          <Today />
          <div className="devbar">
            <span className="small">Demo controls</span>
            <Clock />
          </div>
        </section>
        <section id="agent" aria-label="Agent"><AgentPanel /></section>
        <section id="passbook" aria-label="Passbook"><Passbook /></section>
        <section id="policy" aria-label="Policy"><PolicyPanel /></section>
        <section id="recovery" aria-label="Recovery"><RecoveryPanel /></section>
        <AttackLab />
      </main>

      <footer className="footer muted">
        Alchemy is a prototype. The e₹ here is a simulated token on a local chain, not RBI's Digital Rupee. Limits
        follow RBI guidance as described in docs/RBI_COMPLIANCE.md. Demo keys only.
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

export default function App() {
  // undefined = still checking the session cookie, null = signed out
  const [email, setEmail] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    api.me().then((r) => setEmail(r.email)).catch(() => setEmail(null));
    const out = () => setEmail(null);
    window.addEventListener("hn:signed-out", out);
    return () => window.removeEventListener("hn:signed-out", out);
  }, []);

  if (email === undefined) return <div className="boot" aria-busy="true" />;
  if (email === null) return <Login onSignedIn={setEmail} />;
  return (
    <Dashboard
      email={email}
      onSignOut={() => {
        api.logout().finally(() => setEmail(null));
      }}
    />
  );
}
