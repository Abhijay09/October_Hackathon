// The agent's side: build a UserOp, get it sponsored, sign it with the session key, submit it.
// The agent is untrusted. Nothing here is a security boundary; the wallet contract is.
import { decodeEventLog, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { BundlerError } from "../lib/bundler.js";
import { abis } from "../lib/chain.js";
import type { Context } from "../lib/context.js";
import { PaymasterRefusal } from "../lib/paymaster.js";
import { proofFor, TRANSFER_SELECTOR } from "../lib/policy.js";
import { REASONS, type ReasonName } from "../lib/rbi.js";
import { newUserOp, userOpHash, type PackedUserOp } from "../lib/userop.js";

export type OutcomeKind = "settled" | "pending" | "blocked" | "rejected";

export interface Outcome {
  kind: OutcomeKind;
  /** Wallet reason (execution), or the bundler / paymaster refusal message. */
  reason?: ReasonName | string;
  stage?: "paymaster" | "bundler" | "execution";
  froze?: boolean;
  pendingId?: bigint;
  amount?: bigint;
  recipient?: Address;
  txHash?: Hex;
  gasCost?: bigint;
}

export class AgentClient {
  readonly account: PrivateKeyAccount;

  constructor(
    private readonly ctx: Context,
    readonly wallet: Address,
    agentKey: Hex,
  ) {
    this.account = privateKeyToAccount(agentKey);
  }

  get address(): Address {
    return this.account.address;
  }

  /** Pay a merchant in e₹ (paise). Uses the owner's policy to attach a Merkle proof. */
  pay(recipient: Address, paise: bigint): Promise<Outcome> {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, paise] });
    const proof = proofFor(this.ctx.policy, this.ctx.dep.contracts.rupee, TRANSFER_SELECTOR, recipient);
    return this.call(this.ctx.dep.contracts.rupee, data, proof);
  }

  async call(target: Address, data: Hex, proof: Hex[] = []): Promise<Outcome> {
    let op: PackedUserOp;
    try {
      op = await this.buildOp(this.executeAsAgent(target, data, proof));
    } catch (err) {
      if (err instanceof PaymasterRefusal) return { kind: "rejected", stage: "paymaster", reason: err.message };
      throw err;
    }
    return this.submit(op);
  }

  executeAsAgent(target: Address, data: Hex, proof: Hex[], agent: Address = this.address): Hex {
    return encodeFunctionData({ abi: abis.wallet, functionName: "executeAsAgent", args: [agent, target, data, proof] });
  }

  /** Build, sponsor and sign. `sign: false` lets attack scripts tamper before signing. */
  async buildOp(
    callData: Hex,
    opts: { sign?: boolean; nonceOffset?: bigint; bypassPaymasterPolicy?: boolean } = {},
  ): Promise<PackedUserOp> {
    const { publicClient, dep } = this.ctx;
    const nonce = (await publicClient.readContract({
      address: dep.contracts.entryPoint,
      abi: abis.entryPoint,
      functionName: "getNonce",
      args: [this.wallet, BigInt(this.address)],
    })) as bigint;
    const block = await publicClient.getBlock();
    const base = block.baseFeePerGas ?? 1_000_000_000n;
    const priority = 1_000_000_000n;
    const op = newUserOp(this.wallet, nonce + (opts.nonceOffset ?? 0n), callData, base * 2n + priority, priority);
    op.paymasterAndData = opts.bypassPaymasterPolicy
      ? await this.ctx.paymaster.signUnchecked(op)
      : await this.ctx.paymaster.sign(op);
    if (opts.sign !== false) op.signature = await this.signOp(op);
    return op;
  }

  signOp(op: PackedUserOp, chainId: number = this.ctx.dep.chainId): Promise<Hex> {
    const hash = userOpHash(op, this.ctx.dep.contracts.entryPoint, chainId);
    return this.account.signMessage({ message: { raw: hash } });
  }

  async submit(op: PackedUserOp): Promise<Outcome> {
    let receipt;
    try {
      receipt = await this.ctx.bundler.send(op);
    } catch (err) {
      if (err instanceof BundlerError) return { kind: "rejected", stage: "bundler", reason: err.message };
      throw err;
    }
    const base = { txHash: receipt.txHash, gasCost: receipt.actualGasCost, stage: "execution" as const };
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.wallet.toLowerCase()) continue;
      let ev;
      try {
        ev = decodeEventLog({ abi: abis.wallet, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      const a = ev.args as unknown as Record<string, unknown>;
      if (ev.eventName === "AgentPayment") {
        return { ...base, kind: "settled", amount: a.amount as bigint, recipient: a.recipient as Address };
      }
      if (ev.eventName === "AgentBlocked") {
        const reason = REASONS[Number(a.reason)];
        return {
          ...base,
          kind: reason === "OverAfaLimit" ? "pending" : "blocked",
          reason,
          froze: a.froze as boolean,
          pendingId: a.pendingId as bigint,
          amount: a.amount as bigint,
          recipient: a.recipient as Address,
        };
      }
    }
    return { ...base, kind: "rejected", reason: receipt.success ? "no wallet event" : "execution reverted" };
  }
}
