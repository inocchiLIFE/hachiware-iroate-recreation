"use client";
import type { CurrentQuestion } from "@/lib/types";

/** 出題中の残り時間（サーバー時刻基準） */
export function remaining(cur: CurrentQuestion, now: number) {
  const end = cur.closedAt != null ? Math.min(cur.deadlineAt, cur.closedAt) : cur.deadlineAt;
  const total = cur.deadlineAt - cur.startedAt;
  const ms = Math.max(0, Math.min(total, end - now));
  return { ms, sec: Math.ceil(ms / 1000), ratio: total > 0 ? ms / total : 0 };
}

export function Timer({ cur, now, className = "timer" }: { cur: CurrentQuestion; now: number; className?: string }) {
  const { sec, ratio, ms } = remaining(cur, now);
  return (
    <div className={`${className} ${ms <= 3000 ? "danger" : ""}`} role="timer" aria-live="off">
      <div className="sec">{sec}</div>
      <div className="bar">
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
