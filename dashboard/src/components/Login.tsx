import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { AsciiOcean } from "../ocean/react";
import { Orb } from "./Logo";

/** Sign-in screen. The ASCII ocean behind it reacts to the cursor: fish scatter, a click splashes. */
export function Login({ onSignedIn }: { onSignedIn(email: string): void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setWorking(true);
    try {
      const { email: who } = await (mode === "login" ? api.login : api.register)(email, password);
      onSignedIn(who);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="login-page">
      <AsciiOcean className="login-ocean" sharks={[{ kind: "classic", size: 0.85 }, { kind: "classic", size: 0.6 }]} />
      <main className="login-card">
        <Orb size={104} />
        <h1 className="wordmark">Alchemy</h1>
        <p className="muted">An agent wallet that only spends what you allow, in rupees.</p>

        <div className="tabs" role="tablist" aria-label="Sign in or create an account">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`tab ${mode === m ? "tab-on" : ""}`}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
            >
              {m === "login" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>

        <form className="form" onSubmit={submit}>
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "register" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "register" && <span className="hint">At least 8 characters.</span>}
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" disabled={working}>
            {working ? "One moment…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="small muted">Move your cursor over the water. Click to make a ripple.</p>
      </main>
    </div>
  );
}
