import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/server/admin-auth";
import { getGame } from "@/lib/server/game";
import { handleError, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    if (!isAdmin(req)) return json({ ok: true, admin: false });
    await getGame(); // ゲーム状態ドキュメントがなければ作成
    return json({ ok: true, admin: true });
  } catch (e) {
    return handleError(e);
  }
}
