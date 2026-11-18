"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  type DocumentData,
  type QueryConstraint,
} from "firebase/firestore";
import { clientDb, reconnect } from "./firebase";
import type { GameState, Participant } from "../types";

// ---------------------------------------------------------------------------
// Firestore のリアルタイム購読
// ---------------------------------------------------------------------------
interface DocState<T> {
  data: T | null;
  loaded: boolean;
  /** キャッシュからの表示（＝サーバーと未同期・通信断の可能性） */
  fromCache: boolean;
  error: string | null;
  /** 最後にスナップショットを受け取った時刻（端末時刻） */
  receivedAt: number;
}

export function useDoc<T = DocumentData>(path: string | null): DocState<T> {
  // state にどのパスの結果かを持たせ、パス切り替え直後に古い結果を返さないようにする
  const [state, setState] = useState<DocState<T> & { path: string | null }>({
    path: null,
    data: null,
    loaded: false,
    fromCache: false,
    error: null,
    receivedAt: 0,
  });
  useEffect(() => {
    if (!path) return;
    return onSnapshot(
      doc(clientDb(), path),
      { includeMetadataChanges: true },
      (snap) =>
        setState({
          path,
          data: snap.exists() ? (snap.data() as T) : null,
          loaded: true,
          fromCache: snap.metadata.fromCache,
          error: null,
          receivedAt: Date.now(),
        }),
      (err) =>
        setState({ path, data: null, loaded: true, fromCache: false, error: err.message, receivedAt: Date.now() }),
    );
  }, [path]);
  if (!path) return { data: null, loaded: true, fromCache: false, error: null, receivedAt: 0 };
  if (state.path !== path) return { data: null, loaded: false, fromCache: false, error: null, receivedAt: 0 };
  return state;
}

export function useCollection<T = DocumentData>(
  path: string,
  constraints: QueryConstraint[] | null,
  deps: unknown[],
): { docs: T[]; loaded: boolean } {
  const [state, setState] = useState<{ docs: T[]; loaded: boolean }>({ docs: [], loaded: false });
  useEffect(() => {
    if (!constraints) {
      setState({ docs: [], loaded: true });
      return;
    }
    return onSnapshot(
      query(collection(clientDb(), path), ...constraints),
      (snap) => setState({ docs: snap.docs.map((d) => d.data() as T), loaded: true }),
      (err) => console.error(err),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  return state;
}

const POLL_MS = 4000;

/**
 * ゲーム状態（リアルタイム購読 ＋ 予備のポーリング）。
 * リアルタイム購読が「つながっているのに更新が届かない」状態になっても、
 * 数秒おきに /api/state（CDN で 1 秒キャッシュ）を確認し、より新しい状態があればそれを表示して
 * 接続を張り直す。stale=true のときは購読が遅れている（ポーリングの値を表示中）。
 */
export function useGame(opts: { poll?: boolean } = {}) {
  const live = useDoc<GameState>("game/state");
  const [polled, setPolled] = useState<GameState | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const poll = opts.poll ?? false;

  useEffect(() => {
    if (!poll) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastReconnect = 0;
    const tick = async () => {
      clearTimeout(timer);
      try {
        const res = await fetch("/api/state");
        const d = (await res.json()) as { game?: GameState | null };
        const g = d.game;
        const liveUpdatedAt = liveRef.current.data?.updatedAt ?? 0;
        if (!stop && g && g.updatedAt > liveUpdatedAt) {
          setPolled(g);
          // 書き込みから 2 秒以上たっても購読に届いていなければ、接続が止まっていると判断
          if (serverNow() - g.updatedAt > 2000 && Date.now() - lastReconnect > 15000) {
            lastReconnect = Date.now();
            reconnect();
          }
        }
      } catch {
        /* 次回再試行 */
      }
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 1500);
    const onVis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll]);

  if (polled && (!live.data || polled.updatedAt > live.data.updatedAt)) {
    return { ...live, data: polled, loaded: true, fromCache: false, stale: true };
  }
  return { ...live, stale: false };
}

export const useParticipants = (enabled = true) =>
  useCollection<Participant>("participants", enabled ? [] : null, [enabled]);

/**
 * 出題中の回答済み人数を 1 秒ごとに取得する（スクリーン・管理画面用）。
 * 回答ドキュメントを全件購読すると 1 問あたり 150 読み取り×画面数かかるため、
 * 集計クエリ（count）を API 経由でポーリングして Firestore の無料枠を節約する。
 */
export function useAnsweredCount(q: number | null, active: boolean, intervalMs = 1000) {
  const [count, setCount] = useState<{ q: number; answered: number } | null>(null);
  useEffect(() => {
    if (q == null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/stats?q=${q}`, { cache: "no-store" });
        const data = (await res.json()) as { answered?: number };
        if (!stop && typeof data.answered === "number") setCount({ q, answered: data.answered });
      } catch {
        /* 次回再試行 */
      }
      if (!stop && active) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [q, active, intervalMs]);
  return count && count.q === q ? count.answered : null;
}

// ---------------------------------------------------------------------------
// サーバー時刻の同期
// ---------------------------------------------------------------------------
let offsetMs = 0;
let synced = false;
const listeners = new Set<() => void>();

async function syncClock() {
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < 3; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch("/api/time", { cache: "no-store" });
      const { now } = (await res.json()) as { now: number };
      const t1 = Date.now();
      const rtt = t1 - t0;
      const offset = now + rtt / 2 - t1;
      if (!best || rtt < best.rtt) best = { rtt, offset };
    } catch {
      /* 通信失敗時は前回値を使う */
    }
  }
  if (best) {
    offsetMs = best.offset;
    synced = true;
    listeners.forEach((l) => l());
  }
}

/** サーバー時刻（ms） */
export const serverNow = () => Date.now() + offsetMs;

export function useServerClock() {
  useEffect(() => {
    syncClock();
    // 時計のずれはほぼ変わらないので、再同期は 10 分ごと＋画面復帰時のみ（Vercel の実行回数を節約）
    const id = setInterval(syncClock, 600_000);
    const onVis = () => document.visibilityState === "visible" && syncClock();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => synced,
    () => false,
  );
}

/** active の間、intervalMs ごとにサーバー時刻を返して再描画する */
export function useNow(active: boolean, intervalMs = 100): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!active) return;
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return active ? now : serverNow();
}

// ---------------------------------------------------------------------------
// 通信状態の監視と再接続
// ---------------------------------------------------------------------------
export function useConnectionWatch(fromCache: boolean) {
  const [online, setOnline] = useState(true);
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => {
      setOnline(true);
      reconnect();
    };
    const off = () => setOnline(false);
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt.current = Date.now();
      else {
        // 5 秒以上バックグラウンドにいた（スリープ・アプリ切り替え）なら接続を張り直す
        if (hiddenAt.current && Date.now() - hiddenAt.current > 5000) reconnect();
        hiddenAt.current = null;
      }
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  // キャッシュ表示が 8 秒続いたら強制的に再接続
  useEffect(() => {
    if (!fromCache) return;
    const id = setTimeout(() => reconnect(), 8000);
    return () => clearTimeout(id);
  }, [fromCache]);
  return { online, unstable: !online || fromCache };
}

// ---------------------------------------------------------------------------
// API 呼び出し
// ---------------------------------------------------------------------------
export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  data: T;
}

export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* noop */
  }
  return {
    ok: res.ok && data.ok !== false,
    status: res.status,
    code: data.code as string | undefined,
    message: data.message as string | undefined,
    data: data as T,
  };
}

export function useLocalStorage<T>(key: string) {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setValue(raw ? (JSON.parse(raw) as T) : null);
    } catch {
      setValue(null);
    }
  }, [key]);
  const save = useCallback(
    (v: T | null) => {
      setValue(v);
      try {
        if (v == null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* プライベートブラウズ等で保存できない場合はメモリのみ */
      }
    },
    [key],
  );
  return [value, save] as const;
}
