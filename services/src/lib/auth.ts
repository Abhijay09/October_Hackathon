// Email + password accounts with JWT sessions.
//  - Passwords: scrypt with a random salt per user, compared in constant time.
//  - Sessions: HS256 JWT (8h) carried in an HttpOnly, SameSite=Strict cookie, so page scripts can't read it.
//  - Users live in node:sqlite next to the paymaster log.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { jwtVerify, SignJWT } from "jose";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const COOKIE_NAME = "hn_session";
export const SESSION_SECONDS = 8 * 3600;
const ISSUER = "hypernexus";

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface Session {
  id: number;
  email: string;
}

export class Auth {
  private readonly db: DatabaseSync;
  private readonly key: Uint8Array;
  private readonly attempts = new Map<string, number[]>();
  /** Computed once so unknown emails take as long to reject as wrong passwords. */
  private decoyHash: Promise<string>;

  constructor(opts: { dbPath: string; secret?: string; maxAttemptsPerMinute?: number }) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    if (!opts.secret) console.warn("JWT_SECRET is not set: using a random secret, so sign-ins reset on restart.");
    this.key = new TextEncoder().encode(opts.secret ?? randomBytes(32).toString("hex"));
    this.maxAttempts = opts.maxAttemptsPerMinute ?? 10;
    this.decoyHash = hashPassword("decoy-password");
  }

  private maxAttempts: number;

  /** Counts a sign-in attempt for `ip`; throws 429 after too many in a minute. */
  private throttle(ip: string, now = Date.now()): void {
    const recent = (this.attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.maxAttempts) {
      this.attempts.set(ip, recent);
      throw new AuthError(429, "Too many attempts. Wait a minute and try again.");
    }
    recent.push(now);
    this.attempts.set(ip, recent);
  }

  private static normalise(email: unknown): string {
    const e = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new AuthError(400, "Enter a valid email address.");
    return e;
  }

  async register(email: unknown, password: unknown, ip: string): Promise<Session> {
    this.throttle(ip);
    const e = Auth.normalise(email);
    if (typeof password !== "string" || password.length < 8) throw new AuthError(400, "Use a password of at least 8 characters.");
    if (password.length > 200) throw new AuthError(400, "That password is too long.");
    if (this.db.prepare("SELECT 1 FROM users WHERE email = ?").get(e)) {
      throw new AuthError(409, "An account with this email already exists. Sign in instead.");
    }
    const hash = await hashPassword(password);
    const info = this.db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)").run(e, hash, Date.now());
    return { id: Number(info.lastInsertRowid), email: e };
  }

  async login(email: unknown, password: unknown, ip: string): Promise<Session> {
    this.throttle(ip);
    const e = Auth.normalise(email);
    const row = this.db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(e) as
      | { id: number; email: string; password_hash: string }
      | undefined;
    const ok = await verifyPassword(typeof password === "string" ? password : "", row?.password_hash ?? (await this.decoyHash));
    if (!row || !ok) throw new AuthError(401, "Email or password is wrong.");
    return { id: row.id, email: row.email };
  }

  async issue(session: Session): Promise<string> {
    return new SignJWT({ email: session.email })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(session.id))
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_SECONDS}s`)
      .sign(this.key);
  }

  /** Returns the session for a valid token, or null for anything missing, expired or tampered. */
  async verify(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, algorithms: ["HS256"] });
      return { id: Number(payload.sub), email: String(payload.email) };
    } catch {
      return null;
    }
  }

  sessionFromCookieHeader(header: string | undefined): Promise<Session | null> {
    const match = header?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
    return this.verify(match?.slice(COOKIE_NAME.length + 1));
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}
