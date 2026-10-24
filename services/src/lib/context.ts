import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { MiniBundler } from "./bundler.js";
import { makeClients, ROOT } from "./chain.js";
import { loadDeployment, saveDeployment, type Deployment } from "./deployment.js";
import { PaymasterService } from "./paymaster.js";
import { loadPolicy, type PolicyTree } from "./policy.js";

export interface Context extends ReturnType<typeof makeClients> {
  dep: Deployment;
  bundler: MiniBundler;
  paymaster: PaymasterService;
  policy: PolicyTree;
  setPolicy(tree: PolicyTree): void;
  chainNow(): Promise<number>;
  warp(seconds: number): Promise<void>;
}

export function createContext(opts: { dbPath?: string } = {}): Context {
  const dep = loadDeployment();
  const clients = makeClients(dep.rpcUrl, dep.chainId);
  const bundler = new MiniBundler(
    clients.publicClient,
    clients.walletFor(dep.devKeys.bundler),
    dep.contracts.entryPoint,
    dep.chainId,
  );
  const paymaster = new PaymasterService(
    clients.publicClient,
    privateKeyToAccount(dep.devKeys.paymasterSigner),
    dep.contracts.paymaster,
    { dbPath: opts.dbPath ?? resolve(ROOT, "services/data/paymaster.sqlite") },
  );

  const ctx: Context = {
    ...clients,
    dep,
    bundler,
    paymaster,
    policy: loadPolicy(dep.policy as never),
    setPolicy(tree) {
      ctx.policy = tree;
      dep.policy = tree.dump();
      saveDeployment(dep);
    },
    async chainNow() {
      const block = await clients.publicClient.getBlock();
      return Number(block.timestamp);
    },
    async warp(seconds) {
      await clients.testClient.increaseTime({ seconds });
      await clients.testClient.mine({ blocks: 1 });
    },
  };
  return ctx;
}
