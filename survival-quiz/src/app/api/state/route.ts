import type { NextRequest } from "next/server";
import { refs } from "@/lib/server/game";
import { AppError, handleError, json } from "@/lib/server/http";
import type { GameState } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 予備のポーリング用：ゲーム状態（Firestore で公開しているものと同じ内容）。
 * - パラメータなし：Vercel の CDN で 1 秒キャッシュするので、150 台が数秒おきに叩いても
 *   Firestore の読み取りは最大でも 1 秒に 1 回程度。
 * - ?pid=… ：リアルタイム購読が止まっていたときだけ、本人の参加者情報も一緒に返す（キャッシュなし）。
 */
export async function GET(req: NextRequest) {
  try {
    const r = refs();
    const pid = req.nextUrl.searchParams.get("pid");
    if (pid !== null) {
      if (!/^[\w-]{6,40}$/.test(pid)) throw new AppError("bad_request", "pid が不正です");
      const [g, p] = await r.db.getAll(r.game, r.participants.doc(pid));
      return json({ ok: true, game: (g.data() as GameState | undefined) ?? null, participant: p.exists ? p.data() : null });
    }
    const snap = await r.game.get();
    return Response.json(
      { ok: true, game: snap.data() ?? null },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": "max-age=1",
        },
      },
    );
  } catch (e) {
    return handleError(e);
  }
}
