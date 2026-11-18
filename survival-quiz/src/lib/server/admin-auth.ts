import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const ADMIN_COOKIE = "sq_admin";
const SESSION_HOURS = 12;

function secret(): string {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw new Error("ADMIN_PASSWORD が未設定です");
  return process.env.ADMIN_SESSION_SECRET || `survival-quiz:${pw}`;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function checkPassword(input: string): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false;
  // 長さの違いを隠すためハッシュ同士を比較
  const h = (s: string) => createHmac("sha256", "pw").update(s).digest("hex");
  return safeEqual(h(input), h(pw));
}

export function createSessionToken(): { token: string; maxAge: number } {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const payload = String(exp);
  return { token: `${payload}.${sign(payload)}`, maxAge: SESSION_HOURS * 3600 };
}

export function isAdmin(req: NextRequest): boolean {
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  try {
    if (!safeEqual(sig, sign(payload))) return false;
  } catch {
    return false;
  }
  return Number(payload) > Date.now();
}
