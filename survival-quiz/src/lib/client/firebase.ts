"use client";
import { getApps, initializeApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  disableNetwork,
  enableNetwork,
  getFirestore,
  initializeFirestore,
  type Firestore,
} from "firebase/firestore";

let db: Firestore | null = null;

/** ブラウザ用 Firestore（読み取り専用。書き込みは API 経由） */
export function clientDb(): Firestore {
  if (db) return db;
  const app =
    getApps()[0] ??
    initializeApp({
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    });
  try {
    // iPhone（Safari・LINE などすべて WebKit）では、ストリーミング接続が「つながったまま
    // 更新が届かない」状態になることがあるため、全端末でロングポーリングを使う。
    // 会場 Wi-Fi やプロキシ環境でも最も安定する方式（遅延の差は体感できない程度）。
    db = initializeFirestore(app, { experimentalForceLongPolling: true });
  } catch {
    db = getFirestore(app);
  }
  const emu = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
  if (emu) {
    const [host, port] = emu.split(":");
    connectFirestoreEmulator(db, host, Number(port));
  }
  return db;
}

/** スリープ復帰時などに接続を張り直して最新状態を取り直す */
export async function reconnect() {
  const d = clientDb();
  try {
    await disableNetwork(d);
  } finally {
    await enableNetwork(d);
  }
}
