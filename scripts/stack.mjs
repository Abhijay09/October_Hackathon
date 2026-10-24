// Brings up the local stack: Hardhat chain → deploy → services (bundler/paymaster/API) → dashboard.
//   node scripts/stack.mjs dev    everything, until Ctrl+C
//   node scripts/stack.mjs prod   chain + deploy + one server that also serves the built dashboard (Render)
//   node scripts/stack.mjs demo   chain + deploy, then the attack-lab evaluation in the terminal; exits
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "dev";
const children = [];
const colors = { chain: 35, services: 36, dashboard: 33 };

function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd: resolve(root, cwd), stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `\x1b[${colors[name]}m${name.padEnd(9)}\x1b[0m│ `;
  const pipe = (stream, out) =>
    stream.on("data", (d) =>
      d.toString().split("\n").filter(Boolean).forEach((line) => out.write(prefix + line + "\n")),
    );
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`${name} exited (${code}); stopping.`);
      stop(1);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function stop(code = 0) {
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("uncaughtException", (err) => {
  console.error(err);
  stop(1);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  stop(1);
});
process.on("SIGTERM", () => stop(0));

async function waitFor(url, body) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body } : {});
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd: resolve(root, cwd), stdio: "inherit" });
  if (r.status !== 0) stop(r.status ?? 1);
}

run("npx", ["hardhat", "build", "--quiet"], "contracts");
start("chain", "npx", ["hardhat", "node"], "contracts");
await waitFor("http://127.0.0.1:8545", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
run("npx", ["tsx", "src/deploy.ts"], "services");

const port = process.env.PORT ?? "4337";

if (mode === "demo") {
  run("npx", ["tsx", "src/agent/run-attacks.ts"], "services");
  stop(0);
} else if (mode === "prod") {
  start("services", "npx", ["tsx", "src/server.ts"], "services");
  await waitFor(`http://127.0.0.1:${port}/api/health`);
  console.log(`\n  Serving dashboard and API on port ${port}\n`);
} else {
  start("services", "npx", ["tsx", "src/server.ts"], "services");
  await waitFor(`http://127.0.0.1:${port}/api/health`);
  start("dashboard", "npx", ["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], "dashboard");
  await waitFor("http://127.0.0.1:5173");
  console.log("\n  Dashboard: http://127.0.0.1:5173   (Ctrl+C stops everything)\n");
}
