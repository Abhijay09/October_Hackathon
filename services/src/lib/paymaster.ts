// Off-chain half of the verifying paymaster. It decides whether to sponsor an op and signs it.
// The on-chain PolicyPaymaster enforces a hard per-wallet gas quota as the backstop, so a bug or
// compromise here can at worst burn one wallet's quota.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { concat, type Address, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { abis } from "./chain.js";
import { encodeValidity, maxCost, paymasterStatic, type PackedUserOp } from "./userop.js";

export class PaymasterRefusal extends Error {}

export interface PaymasterOptions {
  dbPath: string;
  /** Sponsorship requests allowed per wallet per minute (wall clock). */
  ratePerMinute?: number;
  /** Lifetime of a paymaster signature, in chain seconds. */
  validitySeconds?: number;
}

const DUMMY_SIGNATURE = `0x${"ff".repeat(64)}1c` as Hex;

export class PaymasterService {
  private readonly db: DatabaseSync;
  private readonly recent = new Map<string, number[]>();
  private readonly ratePerMinute: number;
  private readonly validitySeconds: number;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly signer: PrivateKeyAccount,
    readonly address: Address,
    opts: PaymasterOptions,
  ) {
    this.ratePerMinute = opts.ratePerMinute ?? 20;
    this.validitySeconds = opts.validitySeconds ?? 300;
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sponsorships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      max_cost TEXT
    )`);
  }

  /** pm_getPaymasterStubData: correctly sized placeholder for gas estimation. */
  stubData(): Hex {
    return concat([paymasterStatic(this.address), encodeValidity(0, 0), DUMMY_SIGNATURE]);
  }

  /** pm_getPaymasterData: run the sponsorship policy, then sign. */
  async sign(op: PackedUserOp): Promise<Hex> {
    const wallet = op.sender;
    const cost = maxCost(op);
    try {
      await this.checkPolicy(wallet, cost);
    } catch (err) {
      this.log(wallet, "refused", (err as Error).message, cost);
      throw err;
    }
    const data = await this.signUnchecked(op);
    this.log(wallet, "signed", null, cost);
    return data;
  }

  /**
   * Sign without running the sponsorship policy. Only the attack lab uses this, to model a
   * compromised off-chain signer and show that the on-chain quota still holds.
   */
  async signUnchecked(op: PackedUserOp): Promise<Hex> {
    const block = await this.publicClient.getBlock();
    const now = Number(block.timestamp);
    const validUntil = now + this.validitySeconds;
    const validAfter = Math.max(0, now - 60);
    const partial = concat([paymasterStatic(this.address), encodeValidity(validUntil, validAfter)]);
    const hash = (await this.publicClient.readContract({
      address: this.address,
      abi: abis.paymaster,
      functionName: "getHash",
      args: [{ ...op, paymasterAndData: partial }, validUntil, validAfter],
    })) as Hex;
    const signature = await this.signer.signMessage({ message: { raw: hash } });
    return concat([partial, signature]);
  }

  private async checkPolicy(wallet: Address, cost: bigint): Promise<void> {
    let configured: Address;
    try {
      configured = (await this.publicClient.readContract({
        address: wallet,
        abi: abis.wallet,
        functionName: "paymaster",
      })) as Address;
    } catch {
      throw new PaymasterRefusal("unknown wallet");
    }
    if (configured.toLowerCase() !== this.address.toLowerCase()) throw new PaymasterRefusal("wallet not enrolled");

    const frozen = (await this.publicClient.readContract({
      address: wallet,
      abi: abis.wallet,
      functionName: "frozen",
    })) as boolean;
    if (frozen) throw new PaymasterRefusal("wallet frozen: no sponsorship");

    const nowMs = Date.now();
    const key = wallet.toLowerCase();
    const window = (this.recent.get(key) ?? []).filter((t) => nowMs - t < 60_000);
    if (window.length >= this.ratePerMinute) {
      this.recent.set(key, window);
      throw new PaymasterRefusal(`rate limit: ${this.ratePerMinute} sponsorships/min`);
    }
    window.push(nowMs);
    this.recent.set(key, window);

    const remaining = (await this.publicClient.readContract({
      address: this.address,
      abi: abis.paymaster,
      functionName: "remainingQuota",
      args: [wallet],
    })) as bigint;
    if (remaining < cost) throw new PaymasterRefusal("gas quota exhausted");
  }

  private log(wallet: Address, decision: string, reason: string | null, cost: bigint) {
    this.db
      .prepare("INSERT INTO sponsorships (ts, wallet, decision, reason, max_cost) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), wallet.toLowerCase(), decision, reason, cost.toString());
  }

  stats(wallet?: Address) {
    const where = wallet ? "WHERE wallet = ?" : "";
    const params = wallet ? [wallet.toLowerCase()] : [];
    const rows = this.db
      .prepare(`SELECT decision, COUNT(*) AS n FROM sponsorships ${where} GROUP BY decision`)
      .all(...params) as { decision: string; n: number }[];
    const recentRefusals = this.db
      .prepare(`SELECT ts, wallet, reason FROM sponsorships ${where ? where + " AND" : "WHERE"} decision = 'refused' ORDER BY id DESC LIMIT 10`)
      .all(...params);
    return {
      signed: rows.find((r) => r.decision === "signed")?.n ?? 0,
      refused: rows.find((r) => r.decision === "refused")?.n ?? 0,
      recentRefusals,
    };
  }
}
