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
    // 会場 Wi-Fi やプロキシで WebChannel が詰まる場合に自動でロングポーリングへ切り替える
    db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
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
