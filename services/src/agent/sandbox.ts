// Fresh, fully-configured wallets for the attack lab and the evaluation, so every scenario starts
// from the same clean policy and one attack's freeze never contaminates the next measurement.
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abis, artifacts } from "../lib/chain.js";
import type { Context } from "../lib/context.js";
import { toPaise } from "../lib/rupee.js";
import { AgentClient } from "./client.js";

export interface SandboxOptions {
  fundRupees?: number;
  perTxRupees?: number;
  dailyRupees?: number;
  maxTxPerHour?: number;
  sessionSeconds?: number;
  quotaWei?: bigint;
}

export interface Sandbox {
  wallet: Address;
  agentKey: Hex;
  agent: AgentClient;
}

export async function deploySandbox(ctx: Context, opts: SandboxOptions = {}): Promise<Sandbox> {
  const { dep, publicClient, walletFor } = ctx;
  const issuer = walletFor(dep.devKeys.issuer);
  const owner = walletFor(dep.devKeys.owner);
  const wait = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });

  const deployHash = await issuer.deployContract({
    abi: artifacts.AgentWallet.abi,
    bytecode: artifacts.AgentWallet.bytecode,
    args: [dep.contracts.entryPoint, dep.contracts.rupee, dep.accounts.owner, dep.contracts.paymaster, dep.accounts.guardians],
  });
  const wallet = (await wait(deployHash)).contractAddress!;

  await wait(
    await issuer.writeContract({ address: dep.contracts.rupee, abi: abis.rupee, functionName: "registerWallet", args: [wallet, dep.accounts.bank] }),
  );
  await wait(
    await issuer.writeContract({ address: dep.contracts.rupee, abi: abis.rupee, functionName: "mint", args: [wallet, toPaise(opts.fundRupees ?? 50_000)] }),
  );
  if (opts.quotaWei !== undefined) {
    await wait(
      await issuer.writeContract({ address: dep.contracts.paymaster, abi: abis.paymaster, functionName: "setQuota", args: [wallet, opts.quotaWei] }),
    );
  }

  const agentKey = generatePrivateKey();
  const now = await ctx.chainNow();
  await wait(
    await owner.writeContract({ address: wallet, abi: abis.wallet, functionName: "setPolicyRoot", args: [ctx.policy.root] }),
  );
  await wait(
    await owner.writeContract({
      address: wallet,
      abi: abis.wallet,
      functionName: "addSession",
      args: [
        privateKeyToAccount(agentKey).address,
        now - 60,
        now + (opts.sessionSeconds ?? 7 * 86_400),
        toPaise(opts.perTxRupees ?? 5_000),
        toPaise(opts.dailyRupees ?? 20_000),
        opts.maxTxPerHour ?? 5,
      ],
    }),
  );
  return { wallet, agentKey, agent: new AgentClient(ctx, wallet, agentKey) };
}
