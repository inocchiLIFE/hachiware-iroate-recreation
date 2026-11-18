import { joinGame } from "@/lib/server/game";
import { handleError, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await readJson<{ nickname?: unknown }>(req);
    return json({ ok: true, ...(await joinGame(body.nickname)) });
  } catch (e) {
    return handleError(e);
  }
}
