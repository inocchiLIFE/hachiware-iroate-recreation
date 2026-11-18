import type { NextRequest } from "next/server";
import { ADMIN_COOKIE, checkPassword, createSessionToken } from "@/lib/server/admin-auth";
import { AppError, handleError, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ADMIN_PASSWORD) throw new AppError("no_password", "サーバーに ADMIN_PASSWORD が設定されていません", 500);
    const { password } = await readJson<{ password?: unknown }>(req);
    if (typeof password !== "string" || !checkPassword(password)) {
      await new Promise((r) => setTimeout(r, 800)); // 総当たり対策
      throw new AppError("bad_password", "パスワードが違います", 401);
    }
    const { token, maxAge } = createSessionToken();
    const res = json({ ok: true });
    res.cookies.set(ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge,
    });
    return res;
  } catch (e) {
    return handleError(e);
  }
}
