import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi, type Address, type Hex } from "viem";
import { istDay, REASONS, type ReasonName } from "@shared/rbi";
import { publicClient, walletAbi } from "./chain";
import type { Config } from "./api";

export interface Session {
  active: boolean;
  validAfter: number;
  validUntil: number;
  maxTxPerHour: number;
  perTxLimit: bigint;
  dailyLimit: bigint;
}

export interface Pending {
  id: bigint;
  agent: Address;
  target: Address;
  recipient: Address;
  createdAt: number;
  status: number; // 1 open, 2 approved, 3 rejected
  reason: ReasonName;
  amount: bigint;
}

export interface LedgerEntry {
  key: string;
  time: number;
  kind: string;
  args: Record<string, any>;
}

export interface WalletState {
  now: number;
  balance: bigint;
  bankBalance: bigint;
  owner: Address;
  frozen: boolean;
  lastFreezeReason: ReasonName;
  fraudReportedAt: number;
  policyRoot: Hex;
  session: Session;
  spentToday: bigint;
  txThisHour: number;
  pending: Pending[];
  recovery: { newOwner: Address; executableAt: number; approvals: number; round: bigint; voted: boolean[] };
  ledger: LedgerEntry[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const blockTimes = new Map<bigint, number>();

async function read<T>(address: Address, functionName: string, args: unknown[] = []): Promise<T> {
  return publicClient.readContract({ address, abi: walletAbi, functionName, args } as never) as Promise<T>;
}

async function load(cfg: Config): Promise<WalletState> {
  const w = cfg.contracts.wallet;
  const agent = cfg.accounts.agent;
  const block = await publicClient.getBlock();
  const now = Number(block.timestamp);

  const [balance, bankBalance, owner, frozen, lastFreezeReason, fraudReportedAt, policyRoot, s, u, pendingCount, rec] =
    await Promise.all([
      publicClient.readContract({ address: cfg.contracts.rupee, abi: erc20Abi, functionName: "balanceOf", args: [w] }),
      publicClient.readContract({ address: cfg.contracts.rupee, abi: erc20Abi, functionName: "balanceOf", args: [cfg.accounts.bank] }),
      read<Address>(w, "owner"),
      read<boolean>(w, "frozen"),
      read<number>(w, "lastFreezeReason"),
      read<bigint>(w, "fraudReportedAt"),
      read<Hex>(w, "policyRoot"),
      read<readonly [boolean, number, number, number, bigint, bigint]>(w, "sessions", [agent]),
      read<readonly [bigint, bigint, number, bigint]>(w, "usage", [agent]),
      read<bigint>(w, "pendingCount"),
      read<readonly [Address, bigint, number, bigint]>(w, "recovery"),
    ]);

  const ids = Array.from({ length: Number(pendingCount) }, (_, i) => BigInt(i + 1));
  const pendingRaw = await Promise.all(ids.map((id) => read<any>(w, "getPending", [id])));
  const pending: Pending[] = pendingRaw.map((p, i) => ({
    id: ids[i],
    agent: p.agent,
    target: p.target,
    recipient: p.recipient,
    createdAt: Number(p.createdAt),
    status: Number(p.status),
    reason: REASONS[Number(p.reason)],
    amount: p.amount,
  }));

  const voted = await Promise.all(cfg.accounts.guardians.map((g) => read<boolean>(w, "recoveryVoted", [rec[3], g])));

  const events = await publicClient.getContractEvents({ address: w, abi: walletAbi, fromBlock: 0n });
  const sweeps = await publicClient.getContractEvents({
    address: cfg.contracts.rupee,
    abi: [
      {
        type: "event",
        name: "ReverseWaterfallSweep",
        inputs: [
          { indexed: true, name: "wallet", type: "address" },
          { indexed: true, name: "linkedBankAccount", type: "address" },
          { indexed: false, name: "amount", type: "uint256" },
        ],
      },
    ],
    args: { wallet: w } as never,
    fromBlock: 0n,
  });
  const all = [...events, ...sweeps];
  const missing = [...new Set(all.map((e) => e.blockNumber!))].filter((b) => !blockTimes.has(b));
  await Promise.all(
    missing.map(async (n) => blockTimes.set(n, Number((await publicClient.getBlock({ blockNumber: n })).timestamp))),
  );
  const ledger = all
    .map((e) => ({
      key: `${e.transactionHash}-${e.logIndex}`,
      time: blockTimes.get(e.blockNumber!) ?? 0,
      kind: (e as any).eventName as string,
      args: (e as any).args as Record<string, any>,
      order: Number(e.blockNumber) * 1000 + Number(e.logIndex),
    }))
    .sort((a, b) => b.order - a.order);

  const sameDay = Number(u[0]) === istDay(now);
  const sameHour = Number(u[1]) === Math.floor(now / 3600);

  return {
    now,
    balance,
    bankBalance,
    owner,
    frozen,
    lastFreezeReason: REASONS[Number(lastFreezeReason)],
    fraudReportedAt: Number(fraudReportedAt),
    policyRoot,
    session: {
      active: s[0],
      validAfter: Number(s[1]),
      validUntil: Number(s[2]),
      maxTxPerHour: Number(s[3]),
      perTxLimit: s[4],
      dailyLimit: s[5],
    },
    spentToday: sameDay ? u[3] : 0n,
    txThisHour: sameHour ? Number(u[2]) : 0,
    pending,
    recovery: {
      newOwner: rec[0],
      executableAt: Number(rec[1]),
      approvals: Number(rec[2]),
      round: rec[3],
      voted: rec[0] === ZERO ? cfg.accounts.guardians.map(() => false) : voted,
    },
    ledger,
  };
}

/** Polls the wallet's on-chain state. `refresh()` forces an immediate reload after an action. */
export function useWallet(cfg: Config | null) {
  const [state, setState] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!cfg || inFlight.current) return;
    inFlight.current = true;
    try {
      setState(await load(cfg));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [cfg]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  return { state, error, refresh };
}
