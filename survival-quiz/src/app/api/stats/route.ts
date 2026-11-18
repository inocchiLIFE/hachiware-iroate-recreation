import type { NextRequest } from "next/server";
import { answeredCount } from "@/lib/server/game";
import { AppError, handleError, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** スクリーン・管理画面用：出題中の回答済み人数（生存者のみ） */
export async function GET(req: NextRequest) {
  try {
    const q = Number(req.nextUrl.searchParams.get("q"));
    if (!Number.isInteger(q) || q < 0) throw new AppError("bad_request", "q が不正です");
    return json({ ok: true, ...(await answeredCount(q)) });
  } catch (e) {
    return handleError(e);
  }
}
