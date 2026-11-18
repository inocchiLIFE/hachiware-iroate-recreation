import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let db: Firestore | null = null;

function app(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    // エミュレーター使用時は認証情報不要
    return initializeApp({ projectId: projectId || "demo-survival-quiz" });
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin の環境変数（FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY）が未設定です",
    );
  }
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}

/** サーバー専用の Firestore（Admin SDK。セキュリティルールを経由しない） */
export function adminDb(): Firestore {
  if (db) return db;
  db = getFirestore(app());
  // サーバーレス環境でのコールドスタートを短くするため gRPC ではなく REST を使う
  // （エミュレーターは REST モードだと認証情報を要求するため gRPC のまま）
  db.settings({ preferRest: !process.env.FIRESTORE_EMULATOR_HOST, ignoreUndefinedProperties: true });
  return db;
}
