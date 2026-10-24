import type { Address, Hex } from "viem";

export interface Merchant {
  id: string;
  name: string;
  category: string;
  address: Address;
}

export interface Config {
  chainId: number;
  contracts: { entryPoint: Address; rupee: Address; paymaster: Address; wallet: Address; yieldVault: Address };
  accounts: {
    owner: Address;
    agent: Address;
    attacker: Address;
    bank: Address;
    guardians: Address[];
    newDevice: Address;
  };
  merchants: Merchant[];
  devKeys: { owner: Hex; guardians: Hex[] };
}

export interface Outcome {
  kind: "settled" | "pending" | "blocked" | "rejected";
  reason?: string;
  stage?: string;
  froze?: boolean;
  pendingId?: string;
}

export interface AttackResult {
  id: string;
  title: string;
  vector: string;
  defence: string;
  caught: boolean;
  frozen: boolean;
  lossPaise: string;
  attackerGainPaise: string;
  outcomes: Outcome[];
  note?: string;
}

export interface Report {
  generatedAt: string;
  honest: Array<{ merchantName: string; rupees: number; memo: string; ok: boolean; expected: string; outcome: Outcome }>;
  attacks: AttackResult[];
  metrics: {
    attacks: number;
    caught: number;
    detectionRate: number;
    honestOps: number;
    falseFreezes: number;
    falseFreezeRate: number;
    attackerGainPaise: string;
    maxContainedLossPaise: string;
  };
}

export interface PaymasterStats {
  quota: string;
  spent: string;
  deposit: string;
  signed: number;
  refused: number;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("hn:signed-out"));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  me: () => request<{ email: string }>("GET", "/api/auth/me"),
  login: (email: string, password: string) => request<{ email: string }>("POST", "/api/auth/login", { email, password }),
  register: (email: string, password: string) => request<{ email: string }>("POST", "/api/auth/register", { email, password }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  config: () => request<Config>("GET", "/api/config"),
  pay: (merchantId: string, rupees: number) => request<Outcome>("POST", "/api/agent/pay", { merchantId, rupees }),
  errands: () => request<{ results: Array<{ merchantName: string; rupees: number; outcome: Outcome }> }>("POST", "/api/agent/errands"),
  hijack: () => request<Outcome>("POST", "/api/agent/hijack"),
  rotate: () => request<{ from: Address; to: Address }>("POST", "/api/agent/rotate"),
  commitRotation: () => request<{ agent: Address }>("POST", "/api/agent/rotate/commit"),
  previewPolicy: (merchants: Address[]) => request<{ root: Hex }>("POST", "/api/policy/preview", { merchants }),
  commitPolicy: (merchants: Address[]) => request<{ root: Hex }>("POST", "/api/policy/commit", { merchants }),
  policy: () => request<{ root: Hex; recipients: Address[] }>("GET", "/api/policy"),
  runLab: () => request<Report>("POST", "/api/lab/run"),
  report: () => request<Report>("GET", "/api/lab/report"),
  paymaster: () => request<PaymasterStats>("GET", "/api/paymaster"),
  warp: (seconds: number) => request<{ chainTime: number }>("POST", "/api/dev/warp", { seconds }),
};
