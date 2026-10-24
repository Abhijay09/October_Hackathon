// RBI-derived limits, mirrored from contracts/src/lib/RBIRules.sol. See docs/RBI_COMPLIANCE.md.
import { toPaise } from "./rupee.js";

export const RBI = {
  /** AFA relaxation ceiling (e-mandates): agent auto-approve limit can never exceed this. */
  AFA_EXEMPT_LIMIT: toPaise(15_000),
  /** General per-transaction ceiling (UPI): even owner-approved agent payments stop here. */
  HARD_PER_TX_CAP: toPaise(1_00_000),
  /** Full-KYC PPI outstanding balance ceiling: wallet holding cap, excess swept to bank. */
  WALLET_HOLDING_CAP: toPaise(2_00_000),
  /** India Standard Time offset (UTC+05:30) for daily-limit resets. */
  IST_OFFSET_SECONDS: 5 * 3600 + 30 * 60,
} as const;

export function istDay(unixSeconds: number): number {
  return Math.floor((unixSeconds + RBI.IST_OFFSET_SECONDS) / 86_400);
}

/** Seconds until the next IST midnight, when daily limits reset. */
export function secondsToIstMidnight(unixSeconds: number): number {
  const next = (istDay(unixSeconds) + 1) * 86_400 - RBI.IST_OFFSET_SECONDS;
  return next - unixSeconds;
}

/** Order matches AgentWallet.Reason. */
export const REASONS = [
  "None",
  "OverAfaLimit",
  "SelfCall",
  "ForbiddenSelector",
  "NotAllowlisted",
  "VelocityLimit",
  "DailyLimit",
  "BalanceDrift",
  "CallFailed",
  "Frozen",
  "SessionInactive",
] as const;
export type ReasonName = (typeof REASONS)[number];

export const REASON_INFO: Record<ReasonName, { label: string; detail: string; freezes: boolean }> = {
  None: { label: "Owner action", detail: "Manual freeze or fraud report by the owner.", freezes: true },
  OverAfaLimit: {
    label: "Needs owner approval (AFA)",
    detail: "Above the agent's auto-approve limit (capped at RBI's ₹15,000 AFA relaxation).",
    freezes: false,
  },
  SelfCall: { label: "Admin call by agent", detail: "Agent tried to call the wallet's own admin functions.", freezes: true },
  ForbiddenSelector: {
    label: "Forbidden approval",
    detail: "approve / transferFrom / permit would grant standing access to funds.",
    freezes: true,
  },
  NotAllowlisted: {
    label: "Not in policy",
    detail: "Recipient or contract is not in the owner's allowlist.",
    freezes: true,
  },
  VelocityLimit: { label: "Velocity spike", detail: "Too many payments in one hour.", freezes: true },
  DailyLimit: { label: "Daily limit", detail: "Cumulative spend would exceed today's (IST) limit.", freezes: true },
  BalanceDrift: { label: "Balance drift", detail: "Call moved more e₹ than it declared.", freezes: true },
  CallFailed: { label: "Merchant call failed", detail: "Target reverted; nothing moved.", freezes: false },
  Frozen: { label: "Wallet frozen", detail: "Op executed after the agent was frozen; ignored.", freezes: false },
  SessionInactive: { label: "Session revoked", detail: "Session key no longer active.", freezes: false },
};
