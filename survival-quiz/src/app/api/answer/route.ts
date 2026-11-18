import { submitAnswer } from "@/lib/server/game";
import { handleError, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await readJson<{ pid?: unknown; token?: unknown; q?: unknown; choice?: unknown }>(req);
    return json(await submitAnswer({ pid: body.pid, token: body.token, q: body.q, choice: body.choice }));
  } catch (e) {
    return handleError(e);
  }
}
