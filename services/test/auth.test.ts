import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { Auth, AuthError, hashPassword, verifyPassword } from "../src/lib/auth.js";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "hn-auth-")), "users.sqlite");
const make = (max?: number) => new Auth({ dbPath: dbPath(), secret: "test-secret-test-secret", maxAttemptsPerMinute: max });

describe("passwords", () => {
  it("hashes with a fresh salt and verifies", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("accounts", () => {
  it("registers, then signs in case-insensitively", async () => {
    const auth = make();
    const s = await auth.register("Asha@Example.com", "supersecret", "1.1.1.1");
    expect(s.email).toBe("asha@example.com");
    expect((await auth.login("ASHA@example.com", "supersecret", "1.1.1.1")).id).toBe(s.id);
  });

  it("rejects duplicates, weak passwords and bad emails", async () => {
    const auth = make();
    await auth.register("a@b.co", "supersecret", "ip");
    await expect(auth.register("a@b.co", "supersecret", "ip")).rejects.toMatchObject({ status: 409 });
    await expect(auth.register("c@d.co", "short", "ip")).rejects.toMatchObject({ status: 400 });
    await expect(auth.register("not-an-email", "supersecret", "ip")).rejects.toMatchObject({ status: 400 });
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const auth = make();
    await auth.register("a@b.co", "supersecret", "ip");
    const wrong = await auth.login("a@b.co", "nope-nope-nope", "ip").catch((e: AuthError) => e);
    const unknown = await auth.login("x@y.co", "nope-nope-nope", "ip").catch((e: AuthError) => e);
    expect(wrong).toMatchObject({ status: 401 });
    expect((unknown as AuthError).message).toBe((wrong as AuthError).message);
  });

  it("rate limits attempts per IP", async () => {
    const auth = make(3);
    for (let i = 0; i < 3; i++) await auth.login("a@b.co", "whatever1", "9.9.9.9").catch(() => {});
    await expect(auth.login("a@b.co", "whatever1", "9.9.9.9")).rejects.toMatchObject({ status: 429 });
    await expect(auth.login("a@b.co", "whatever1", "8.8.8.8")).rejects.toMatchObject({ status: 401 });
  });
});

describe("tokens", () => {
  it("round-trips a session", async () => {
    const auth = make();
    const token = await auth.issue({ id: 7, email: "a@b.co" });
    expect(await auth.verify(token)).toEqual({ id: 7, email: "a@b.co" });
    expect(await auth.sessionFromCookieHeader(`theme=dark; hn_session=${token}`)).toEqual({ id: 7, email: "a@b.co" });
  });

  it("rejects missing, tampered, wrong-secret and expired tokens", async () => {
    const auth = make();
    const token = await auth.issue({ id: 7, email: "a@b.co" });
    expect(await auth.verify(undefined)).toBeNull();
    expect(await auth.verify(token.slice(0, -2) + "xx")).toBeNull();

    const other = new Auth({ dbPath: dbPath(), secret: "a-different-secret-entirely" });
    expect(await other.verify(token)).toBeNull();

    const expired = await new SignJWT({ email: "a@b.co" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("7")
      .setIssuer("hypernexus")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode("test-secret-test-secret"));
    expect(await auth.verify(expired)).toBeNull();
  });
});
