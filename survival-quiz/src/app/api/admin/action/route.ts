import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/server/admin-auth";
import {
  closeQuestion,
  finishGame,
  goNext,
  kickParticipant,
  resetGame,
  revealAnswer,
  setEntryOpen,
  setParticipantStatus,
  startQuestion,
  updateSettings,
} from "@/lib/server/game";
import { AppError, handleError, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { action?: string; participantId?: unknown; settings?: Record<string, unknown> };

export async function POST(req: NextRequest) {
  try {
    if (!isAdmin(req)) throw new AppError("unauthorized", "ログインしてください", 401);
    const body = await readJson<Body>(req);
    let result: unknown = null;
    switch (body.action) {
      case "openEntry":
        await setEntryOpen(true);
        break;
      case "closeEntry":
        await setEntryOpen(false);
        break;
      case "start":
        await startQuestion();
        break;
      case "close":
        await closeQuestion();
        break;
      case "reveal":
        result = await revealAnswer();
        break;
      case "next":
        await goNext();
        break;
      case "finish":
        await finishGame();
        break;
      case "reset":
        await resetGame();
        break;
      case "settings":
        result = await updateSettings(body.settings ?? {});
        break;
      case "revive":
        result = await setParticipantStatus(body.participantId, true);
        break;
      case "eliminate":
        result = await setParticipantStatus(body.participantId, false);
        break;
      case "kick":
        result = await kickParticipant(body.participantId);
        break;
      default:
        throw new AppError("bad_action", "不明な操作です");
    }
    return json({ ok: true, result });
  } catch (e) {
    return handleError(e);
  }
}
