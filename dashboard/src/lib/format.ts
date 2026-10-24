import type { Address } from "viem";
import type { Config } from "./api";

export { formatINR, formatINRCompact, toPaise } from "@shared/rupee";

const ist = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

const istTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });

export const formatIST = (unix: number) => ist.format(new Date(unix * 1000));
export const formatISTTime = (unix: number) => istTime.format(new Date(unix * 1000));

export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function duration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** Human name for an address the wallet deals with. */
export function nameOf(cfg: Config, addr?: string): { name: string; known: boolean } {
  if (!addr) return { name: "—", known: true };
  const a = addr.toLowerCase();
  const m = cfg.merchants.find((x) => x.address.toLowerCase() === a);
  if (m) return { name: m.name, known: true };
  if (a === cfg.accounts.bank.toLowerCase()) return { name: "Your linked bank account", known: true };
  if (a === cfg.contracts.wallet.toLowerCase()) return { name: "This wallet", known: false };
  if (a === "0x0000000000000000000000000000000000000000") return { name: "a contract call", known: false };
  return { name: `Unknown address ${short(addr)}`, known: false };
}
