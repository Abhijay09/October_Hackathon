import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { ROOT } from "./chain.js";

export interface Merchant {
  id: string;
  name: string;
  category: string;
  address: Address;
}

export interface Deployment {
  chainId: number;
  rpcUrl: string;
  deployedAt: number;
  contracts: {
    entryPoint: Address;
    rupee: Address;
    paymaster: Address;
    wallet: Address;
    yieldVault: Address;
  };
  accounts: {
    issuer: Address;
    owner: Address;
    bundler: Address;
    paymasterSigner: Address;
    attacker: Address;
    bank: Address;
    agent: Address;
    guardians: Address[];
  };
  /** Local-chain dev keys only (public Hardhat mnemonic + a generated agent session key). */
  devKeys: {
    issuer: Hex;
    owner: Hex;
    bundler: Hex;
    paymasterSigner: Hex;
    attacker: Hex;
    agent: Hex;
    guardians: Hex[];
  };
  merchants: Merchant[];
  /** StandardMerkleTree dump of the active policy. */
  policy: unknown;
  session: { perTxLimit: string; dailyLimit: string; maxTxPerHour: number; validUntil: number };
  paymasterQuotaWei: string;
}

export const DEPLOYMENT_FILE = resolve(ROOT, "deployments/local.json");

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`No deployment at ${DEPLOYMENT_FILE}. Run \`npm run deploy\` (with the chain running) first.`);
  }
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
}

export function saveDeployment(dep: Deployment): void {
  mkdirSync(resolve(ROOT, "deployments"), { recursive: true });
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2));
}
