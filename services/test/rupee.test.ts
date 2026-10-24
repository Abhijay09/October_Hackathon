import { describe, expect, it } from "vitest";
import { formatINR, formatINRCompact, toPaise } from "../src/lib/rupee.js";
import { istDay, RBI, secondsToIstMidnight } from "../src/lib/rbi.js";

describe("rupee", () => {
  it("parses rupees into integer paise", () => {
    expect(toPaise(499)).toBe(49_900n);
    expect(toPaise("1,50,000.5")).toBe(1_50_00_050n);
    expect(toPaise("₹18,000")).toBe(18_00_000n);
    expect(toPaise(15_000n)).toBe(15_00_000n);
    expect(() => toPaise("12.345")).toThrow();
    expect(() => toPaise("-5")).toThrow();
  });

  it("formats with Indian lakh/crore grouping", () => {
    expect(formatINR(49_900n)).toBe("₹499.00");
    expect(formatINR(toPaise(1_50_000))).toBe("₹1,50,000.00");
    expect(formatINR(toPaise(1_23_45_678) + 5n)).toBe("₹1,23,45,678.05");
    expect(formatINR(-toPaise(20))).toBe("-₹20.00");
  });

  it("formats compactly", () => {
    expect(formatINRCompact(toPaise(2_00_000))).toBe("₹2 L");
    expect(formatINRCompact(toPaise(1_50_00_000))).toBe("₹1.5 Cr");
    expect(formatINRCompact(toPaise(499))).toBe("₹499");
  });
});

describe("RBI limits", () => {
  it("mirror the on-chain constants", () => {
    expect(RBI.AFA_EXEMPT_LIMIT).toBe(toPaise(15_000));
    expect(RBI.HARD_PER_TX_CAP).toBe(toPaise(1_00_000));
    expect(RBI.WALLET_HOLDING_CAP).toBe(toPaise(2_00_000));
  });

  it("rolls the day at IST midnight (18:30 UTC)", () => {
    const utc1829 = Date.UTC(2026, 9, 24, 18, 29) / 1000;
    const utc1831 = Date.UTC(2026, 9, 24, 18, 31) / 1000;
    expect(istDay(utc1831)).toBe(istDay(utc1829) + 1);
    expect(secondsToIstMidnight(utc1829)).toBe(60);
  });
});
