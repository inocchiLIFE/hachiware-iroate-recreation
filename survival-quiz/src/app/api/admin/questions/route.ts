import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/server/admin-auth";
import { listQuestions, replaceQuestions } from "@/lib/server/game";
import { AppError, handleError, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    if (!isAdmin(req)) throw new AppError("unauthorized", "ログインしてください", 401);
    return json({ ok: true, questions: await listQuestions() });
  } catch (e) {
    return handleError(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    if (!isAdmin(req)) throw new AppError("unauthorized", "ログインしてください", 401);
    const { questions } = await readJson<{ questions?: unknown }>(req);
    return json({ ok: true, questions: await replaceQuestions(questions) });
  } catch (e) {
    return handleError(e);
  }
}
