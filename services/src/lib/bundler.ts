// A minimal single-op bundler for the local chain. It stands in for a production bundler such as
// Alto or Rundler: it simulates each op with eth_call of handleOps, then submits it from a funded
// account. Submissions are serialised so nonces and freezes are observed in order.
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeEventLog,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { abis } from "./chain.js";
import { userOpHash, type PackedUserOp } from "./userop.js";

export class BundlerError extends Error {
  constructor(
    message: string,
    public code = -32500,
  ) {
    super(message);
  }
}

export interface OpReceipt {
  userOpHash: Hex;
  txHash: Hex;
  success: boolean;
  actualGasCost: bigint;
  logs: Log[];
}

const innerErrorAbis: Abi[] = [abis.paymaster, abis.wallet];

/** Turn an EntryPoint revert into a readable reason such as "AA24 signature error". */
export function describeRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
      const { errorName, args = [] } = reverted.data;
      if (errorName === "FailedOp") return String(args[1]);
      if (errorName === "FailedOpWithRevert") {
        const inner = args[2] as Hex;
        for (const abi of innerErrorAbis) {
          try {
            const decoded = decodeErrorResult({ abi, data: inner });
            return `${args[1]}: ${decoded.errorName}`;
          } catch {
            /* try next */
          }
        }
        return String(args[1]);
      }
      return errorName;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

export class MiniBundler {
  private queue: Promise<unknown> = Promise.resolve();
  private receipts = new Map<Hex, OpReceipt>();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly signer: WalletClient,
    private readonly entryPoint: Address,
    private readonly chainId: number,
  ) {}

  get beneficiary(): Address {
    return this.signer.account!.address;
  }

  send(op: PackedUserOp): Promise<OpReceipt> {
    const run = this.queue.then(() => this.submit(op));
    this.queue = run.catch(() => undefined);
    return run;
  }

  receipt(hash: Hex): OpReceipt | undefined {
    return this.receipts.get(hash);
  }

  private async submit(op: PackedUserOp): Promise<OpReceipt> {
    const hash = userOpHash(op, this.entryPoint, this.chainId);
    const call = {
      address: this.entryPoint,
      abi: abis.entryPoint,
      functionName: "handleOps",
      args: [[op], this.beneficiary],
      account: this.signer.account!,
      chain: this.signer.chain,
    } as const;

    try {
      await this.publicClient.simulateContract(call);
    } catch (err) {
      throw new BundlerError(describeRevert(err));
    }

    const txHash = await this.signer.writeContract({ ...call, gas: 3_000_000n });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    let success = false;
    let actualGasCost = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.entryPoint.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: abis.entryPoint, data: log.data, topics: log.topics });
        if (ev.eventName === "UserOperationEvent") {
          const a = ev.args as unknown as { success: boolean; actualGasCost: bigint };
          success = a.success;
          actualGasCost = a.actualGasCost;
        }
      } catch {
        /* not an EntryPoint event we know */
      }
    }
    const result = { userOpHash: hash, txHash, success, actualGasCost, logs: receipt.logs };
    this.receipts.set(hash, result);
    return result;
  }
}
