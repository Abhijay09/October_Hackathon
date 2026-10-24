// HyperNexus services: ERC-4337 bundler + paymaster JSON-RPC (/rpc) and the dashboard REST API (/api).
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodeFunctionData, erc20Abi, getAddress, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AgentClient } from "./agent/client.js";
import { ATTACKS, runAttack } from "./agent/attacks.js";
import { evaluate, REPORT_FILE } from "./agent/evaluate.js";
import { ERRANDS, merchantAddress, runErrands } from "./agent/honest.js";
import { Auth, AuthError, clearedCookie, sessionCookie } from "./lib/auth.js";
import { BundlerError } from "./lib/bundler.js";
import { abis, devKey, ROOT } from "./lib/chain.js";
import { createContext } from "./lib/context.js";
import { saveDeployment } from "./lib/deployment.js";
import { toJson } from "./lib/json.js";
import { PaymasterRefusal } from "./lib/paymaster.js";
import { allowedRecipients, buildPolicy } from "./lib/policy.js";
import { RBI } from "./lib/rbi.js";
import { toPaise } from "./lib/rupee.js";
import { fromRpc, userOpHash } from "./lib/userop.js";

const PORT = Number(process.env.PORT ?? 4337);
// Render (and any container host) needs 0.0.0.0; locally we stay on loopback.
const HOST = process.env.HOST ?? "127.0.0.1";
const DASHBOARD_DIST = resolve(ROOT, "dashboard/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Serve the built dashboard (production). Unknown paths fall back to index.html. */
function serveStatic(pathname: string, res: ServerResponse): boolean {
  if (!existsSync(DASHBOARD_DIST)) return false;
  let file = resolve(DASHBOARD_DIST, "." + decodeURIComponent(pathname));
  if (!file.startsWith(DASHBOARD_DIST + sep) && file !== DASHBOARD_DIST) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = resolve(DASHBOARD_DIST, "index.html");
  if (!existsSync(file)) return false;
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(readFileSync(file));
  return true;
}
const ctx = createContext();
const auth = new Auth({
  dbPath: resolve(ROOT, "services/data/users.sqlite"),
  secret: process.env.JWT_SECRET,
});

/** Behind Render's proxy the real client IP and scheme arrive in forwarded headers. */
const clientIp = (req: IncomingMessage) =>
  String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
const isHttps = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https";
const { dep } = ctx;
let agent = new AgentClient(ctx, dep.contracts.wallet, dep.devKeys.agent);
let pendingRotation: Hex | null = null;
let busy: string | null = null;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (busy) throw new HttpError(409, `busy: ${busy} is running`);
  busy = name;
  try {
    return await fn();
  } finally {
    busy = null;
  }
}

// ------------------------------------------------------------------ JSON-RPC

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "eth_chainId":
      return `0x${dep.chainId.toString(16)}`;
    case "eth_supportedEntryPoints":
      return [dep.contracts.entryPoint];
    case "pm_getPaymasterStubData":
      return { paymasterAndData: ctx.paymaster.stubData() };
    case "pm_getPaymasterData": {
      const op = fromRpc(params[0] as Record<string, string>);
      return { paymasterAndData: await ctx.paymaster.sign(op) };
    }
    case "eth_sendUserOperation": {
      const op = fromRpc(params[0] as Record<string, string>);
      const receipt = await ctx.bundler.send(op);
      return receipt.userOpHash;
    }
    case "eth_getUserOperationReceipt": {
      const r = ctx.bundler.receipt(params[0] as Hex);
      return r ? { userOpHash: r.userOpHash, success: r.success, actualGasCost: r.actualGasCost, receipt: { transactionHash: r.txHash } } : null;
    }
    case "hn_userOpHash": {
      const op = fromRpc(params[0] as Record<string, string>);
      return userOpHash(op, dep.contracts.entryPoint, dep.chainId);
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

// ------------------------------------------------------------------ REST

type Handler = (body: any) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "GET /api/health": async () => ({ ok: true, busy }),

  "GET /api/config": async () => ({
    chainId: dep.chainId,
    rpcUrl: dep.rpcUrl,
    contracts: dep.contracts,
    // newDevice: where guardians move ownership in the recovery demo (the owner's "new phone").
    accounts: { ...dep.accounts, agent: agent.address, newDevice: privateKeyToAccount(devKey(15)).address },
    merchants: dep.merchants,
    rbi: Object.fromEntries(Object.entries(RBI).map(([k, v]) => [k, v.toString()])),
    // Local-chain demo keys so the dashboard can act as owner and guardians. Never do this for real.
    devKeys: { owner: dep.devKeys.owner, guardians: dep.devKeys.guardians },
  }),

  "GET /api/policy": async () => ({ root: ctx.policy.root, recipients: allowedRecipients(ctx.policy) }),

  /** Preview the root for a new merchant allowlist (the owner then calls setPolicyRoot). */
  "POST /api/policy/preview": async ({ merchants }) => {
    const tree = buildPolicy(dep.contracts.rupee, parseAddresses(merchants));
    return { root: tree.root };
  },

  /** Adopt the new allowlist once its root is live on-chain. */
  "POST /api/policy/commit": async ({ merchants }) => {
    const tree = buildPolicy(dep.contracts.rupee, parseAddresses(merchants));
    const onchain = await ctx.publicClient.readContract({ address: dep.contracts.wallet, abi: abis.wallet, functionName: "policyRoot" });
    if (onchain !== tree.root) throw new HttpError(409, "on-chain policy root does not match; send setPolicyRoot first");
    ctx.setPolicy(tree);
    return { root: tree.root };
  },

  "POST /api/agent/pay": async ({ merchantId, rupees }) => {
    if (!(Number(rupees) > 0)) throw new HttpError(400, "rupees must be > 0");
    return exclusive("agent payment", () => agent.pay(merchantAddress(ctx, merchantId), toPaise(rupees)));
  },

  "POST /api/agent/errands": async () =>
    exclusive("shopping list", async () => ({ results: await runErrands(ctx, agent, ERRANDS.slice(0, 4)) })),

  /** Prompt-inject the live agent: it tries to send funds to the attacker. */
  "POST /api/agent/hijack": async () =>
    exclusive("hijack", async () => {
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [dep.accounts.attacker, toPaise(25_000)],
      });
      return agent.call(dep.contracts.rupee, data);
    }),

  /** Step 1 of key rotation: mint a new session key; the owner then calls unfreeze(old, new). */
  "POST /api/agent/rotate": async () => {
    pendingRotation = generatePrivateKey();
    return { from: agent.address, to: privateKeyToAccount(pendingRotation).address };
  },

  "POST /api/agent/rotate/commit": async () => {
    if (!pendingRotation) throw new HttpError(400, "no rotation in progress");
    const next = privateKeyToAccount(pendingRotation).address;
    const session = (await ctx.publicClient.readContract({
      address: dep.contracts.wallet,
      abi: abis.wallet,
      functionName: "sessions",
      args: [next],
    })) as readonly [boolean, ...unknown[]];
    if (!session[0]) throw new HttpError(409, "new key is not an active session yet");
    dep.devKeys.agent = pendingRotation;
    dep.accounts.agent = next;
    saveDeployment(dep);
    agent = new AgentClient(ctx, dep.contracts.wallet, pendingRotation);
    pendingRotation = null;
    return { agent: next };
  },

  "GET /api/attacks": async () => ATTACKS.map(({ id, title, vector, defence }) => ({ id, title, vector, defence })),

  "POST /api/lab/run": async () => exclusive("attack lab", () => evaluate(ctx)),

  "POST /api/lab/attack": async ({ id }) => {
    const def = ATTACKS.find((a) => a.id === id);
    if (!def) throw new HttpError(404, `unknown attack ${id}`);
    return exclusive(`attack ${id}`, () => runAttack(ctx, def));
  },

  "GET /api/lab/report": async () => {
    if (!existsSync(REPORT_FILE)) throw new HttpError(404, "no report yet");
    return JSON.parse(readFileSync(REPORT_FILE, "utf8"));
  },

  "GET /api/paymaster": async () => {
    const w = dep.contracts.wallet;
    const [quota, spent, deposit] = await Promise.all([
      ctx.publicClient.readContract({ address: dep.contracts.paymaster, abi: abis.paymaster, functionName: "quotaOf", args: [w] }),
      ctx.publicClient.readContract({ address: dep.contracts.paymaster, abi: abis.paymaster, functionName: "gasSpent", args: [w] }),
      ctx.publicClient.readContract({ address: dep.contracts.paymaster, abi: abis.paymaster, functionName: "getDeposit" }),
    ]);
    return { quota, spent, deposit, ...ctx.paymaster.stats(w) };
  },

  /** Local-chain only: move chain time forward (IST day resets, 48h recovery timelock). */
  "POST /api/dev/warp": async ({ seconds }) => {
    const s = Number(seconds);
    if (!(s > 0 && s <= 30 * 86_400)) throw new HttpError(400, "seconds must be in (0, 30 days]");
    await ctx.warp(s);
    return { chainTime: await ctx.chainNow() };
  },
};

function parseAddresses(list: unknown): Address[] {
  if (!Array.isArray(list) || list.some((a) => typeof a !== "string" || !isAddress(a))) {
    throw new HttpError(400, "merchants must be an array of addresses");
  }
  return list.map((a) => getAddress(a));
}

// ------------------------------------------------------------------ HTTP plumbing

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new HttpError(413, "body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(toJson(body));
}

async function authRoute(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const secure = isHttps(req);
  if (pathname === "/api/auth/me" && req.method === "GET") {
    const session = await auth.sessionFromCookieHeader(req.headers.cookie);
    return session ? send(res, 200, { email: session.email }) : send(res, 401, { error: "Not signed in." });
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    return send(res, 200, { ok: true }, { "set-cookie": clearedCookie(secure) });
  }
  if ((pathname === "/api/auth/login" || pathname === "/api/auth/register") && req.method === "POST") {
    const { email, password } = await readBody(req);
    const ip = clientIp(req);
    const session =
      pathname === "/api/auth/login" ? await auth.login(email, password, ip) : await auth.register(email, password, ip);
    const token = await auth.issue(session);
    return send(res, 200, { email: session.email }, { "set-cookie": sessionCookie(token, secure) });
  }
  return send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
  if (req.method === "OPTIONS") return send(res, 204, null, url.pathname === "/rpc" ? cors : {});
  try {
    if (url.pathname === "/rpc" && req.method === "POST") {
      const { id, method, params = [] } = await readBody(req);
      try {
        return send(res, 200, { jsonrpc: "2.0", id, result: await rpc(method, params) }, cors);
      } catch (err) {
        const code = err instanceof BundlerError ? err.code : err instanceof PaymasterRefusal ? -32501 : ((err as any).code ?? -32603);
        return send(res, 200, { jsonrpc: "2.0", id, error: { code, message: (err as Error).message } }, cors);
      }
    }
    if (url.pathname.startsWith("/api/auth/")) return await authRoute(req, res, url.pathname);

    // Everything below needs a signed-in user, except the health check and the public static files.
    const needsLogin = url.pathname === "/chain" || (url.pathname.startsWith("/api/") && url.pathname !== "/api/health");
    if (needsLogin && !(await auth.sessionFromCookieHeader(req.headers.cookie))) {
      return send(res, 401, { error: "Sign in to continue." });
    }

    // The dashboard talks to the chain through this path (Vite does the same in development).
    if (url.pathname === "/chain" && req.method === "POST") {
      const upstream = await fetch(dep.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await readBody(req)),
      });
      res.writeHead(upstream.status, { "content-type": "application/json" });
      return void res.end(await upstream.text());
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      if (req.method === "GET" && !url.pathname.startsWith("/api") && serveStatic(url.pathname, res)) return;
      return send(res, 404, { error: "not found" });
    }
    return send(res, 200, await handler(req.method === "POST" ? await readBody(req) : {}));
  } catch (err) {
    const status = err instanceof HttpError || err instanceof AuthError ? err.status : 500;
    if (status === 500) console.error(err);
    return send(res, status, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HyperNexus services on http://${HOST}:${PORT}  (bundler + paymaster at /rpc, API at /api)`);
  console.log(`Wallet ${dep.contracts.wallet}  agent ${agent.address}`);
});
