// Chain plumbing: contract artifacts, dev accounts and viem clients.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../../..");
const ARTIFACTS = resolve(ROOT, "contracts/artifacts");

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(resolve(ARTIFACTS, path), "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode as Hex };
}

export const artifacts = {
  EntryPoint: artifact("@account-abstraction/contracts/core/EntryPoint.sol/EntryPoint.json"),
  ERupee: artifact("src/ERupee.sol/ERupee.json"),
  PolicyPaymaster: artifact("src/PolicyPaymaster.sol/PolicyPaymaster.json"),
  AgentWallet: artifact("src/AgentWallet.sol/AgentWallet.json"),
  MockYieldVault: artifact("src/mocks/MockYieldVault.sol/MockYieldVault.json"),
};

export const abis = {
  entryPoint: artifacts.EntryPoint.abi,
  rupee: artifacts.ERupee.abi,
  paymaster: artifacts.PolicyPaymaster.abi,
  wallet: artifacts.AgentWallet.abi,
  vault: artifacts.MockYieldVault.abi,
};

/** Hardhat/anvil's public test mnemonic. These keys are for the local chain only. */
const DEV_MNEMONIC = "test test test test test test test test test test test junk";

export function devKey(index: number): Hex {
  const key = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!key) throw new Error("no private key");
  return toHex(key);
}

export const DEV_ROLES = {
  issuer: 0, // deploys contracts; plays the RBI / e₹ issuer
  owner: 1,
  bundler: 2,
  paymasterSigner: 3,
  attacker: 4,
  guardians: [5, 6, 7, 8, 9],
  bank: 10, // owner's linked bank account (reverse-waterfall sweeps)
  merchants: [11, 12, 13, 14],
} as const;

export function localChain(rpcUrl: string, chainId: number) {
  return defineChain({
    id: chainId,
    name: "HyperNexus Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function makeClients(rpcUrl: string, chainId: number) {
  const chain = localChain(rpcUrl, chainId);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 200 });
  const testClient = createTestClient({ chain, transport, mode: "hardhat" });
  const walletFor = (pk: Hex) => createWalletClient({ chain, transport, account: privateKeyToAccount(pk) });
  return { chain, publicClient, testClient, walletFor };
}

export type Clients = ReturnType<typeof makeClients>;
