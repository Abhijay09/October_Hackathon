import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import walletArtifact from "../../../contracts/artifacts/src/AgentWallet.sol/AgentWallet.json";
import rupeeArtifact from "../../../contracts/artifacts/src/ERupee.sol/ERupee.json";
import paymasterArtifact from "../../../contracts/artifacts/src/PolicyPaymaster.sol/PolicyPaymaster.json";

export const walletAbi = walletArtifact.abi as Abi;
export const rupeeAbi = rupeeArtifact.abi as Abi;
export const paymasterAbi = paymasterArtifact.abi as Abi;

// The dev server proxies /chain to the local node, so the browser never needs CORS.
const rpcUrl = `${window.location.origin}/chain`;

export const chain = defineChain({
  id: 31337,
  name: "HyperNexus Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 300 });

export function signerFor(pk: Hex) {
  return createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(pk) });
}

/** Send a contract write as `pk` and wait for it. Throws a readable error on revert. */
export async function write(
  pk: Hex,
  address: Address,
  functionName: string,
  args: unknown[] = [],
  abi: Abi = walletAbi,
): Promise<Hex> {
  const client = signerFor(pk);
  try {
    const { request } = await publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: client.account,
    } as never);
    const hash = await client.writeContract(request as never);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  } catch (err) {
    throw new Error(readableError(err));
  }
}

const ERROR_TEXT: Record<string, string> = {
  InvalidLimits: "Those limits aren't allowed. Auto-approve must be ₹1–₹15,000 (RBI AFA cap) and no more than the daily limit.",
  AboveHardCap: "Above the ₹1,00,000 per-transaction cap. This payment can't be approved.",
  Expired: "This request is more than 24 hours old. Ask the agent to try again.",
  NotOpen: "This request was already handled.",
  InvalidCall: "The agent asked to call the wallet itself. That can never be approved.",
  RecoveryNotReady: "Recovery isn't ready: it needs 3 guardian approvals and 48 hours.",
  RecoveryConflict: "A recovery is already in progress.",
  AlreadyVoted: "This guardian has already approved.",
  Unauthorized: "This key isn't allowed to do that.",
  CallReverted: "The payment failed at the merchant. Nothing moved.",
};

export function readableError(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      return ERROR_TEXT[reverted.data.errorName] ?? reverted.data.errorName;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
