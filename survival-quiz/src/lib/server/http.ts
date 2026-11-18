import "server-only";
import { NextResponse } from "next/server";

/** 想定内のエラー（クライアントにコードとメッセージを返す） */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

export function handleError(e: unknown) {
  if (e instanceof AppError) {
    return json({ ok: false, code: e.code, message: e.message, ...e.extra }, e.status);
  }
  console.error(e);
  return json({ ok: false, code: "internal", message: "サーバーエラーが発生しました" }, 500);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError("bad_request", "リクエストの形式が正しくありません");
  }
}
