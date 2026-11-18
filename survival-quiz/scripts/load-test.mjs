#!/usr/bin/env node
/**
 * 負荷テスト：ダミー参加者（ボット）を N 人動かす
 *
 * 各ボットは本物のスマホと同じように
 *   1. /api/join で参加登録
 *   2. Firestore の game/state と自分の participants/{id} をリアルタイム購読
 *   3. 出題されたらランダムな時間（制限時間内）待って /api/answer に回答
 * を行い、以下を計測します。
 *   - 状態変化（出題・締切・正解発表…）が全ボットに届くまでの遅延
 *   - 参加登録・回答 API の応答時間と失敗数
 *   - 判定の整合性（正解して受理されたボットが生存しているか など）
 *
 * --auto-host を付けると、司会者の操作（受付締切→出題→締切→正解発表→次へ→終了）も
 * 管理 API 経由で自動実行するので、1 人で本番同等の通し試験ができます。
 *
 * 使い方（詳しくは docs/LOAD_TEST.md）:
 *   node --env-file=.env.local scripts/load-test.mjs --base-url http://localhost:3000 --bots 150 --auto-host --rounds 5
 *
 * 必要な環境変数:
 *   NEXT_PUBLIC_FIREBASE_API_KEY / NEXT_PUBLIC_FIREBASE_PROJECT_ID / NEXT_PUBLIC_FIREBASE_APP_ID
 *   （エミュレーターなら NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST も）
 *   ADMIN_PASSWORD（--auto-host 時）
 */
import { parseArgs } from "node:util";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  enableNetwork,
  getFirestore,
  onSnapshot,
  terminate,
} from "firebase/firestore";

const { values: args } = parseArgs({
  options: {
    "base-url": { type: "string", default: process.env.BASE_URL ?? "http://localhost:3000" },
    bots: { type: "string", default: "150" },
    "auto-host": { type: "boolean", default: false },
    rounds: { type: "string", default: "5" },
    accuracy: { type: "string", default: "0.8" },
    "join-spread": { type: "string", default: "5000" },
    churn: { type: "string", default: "0.1" },
    "no-reset": { type: "boolean", default: false },
    "seed-questions": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
  --base-url <url>      テスト対象（既定: http://localhost:3000）
  --bots <n>            ボット数（既定: 150）
  --auto-host           司会者の操作も自動で行う（ADMIN_PASSWORD が必要）
  --rounds <n>          --auto-host 時に出題する問題数（既定: 5）
  --accuracy <0-1>      --auto-host 時の正答率（既定: 0.8。手動進行時は 50% でランダム）
  --join-spread <ms>    参加登録を何ミリ秒の間にばらけさせるか（既定: 5000。0 で一斉）
  --churn <0-1>         問題の合間に通信を切断→再接続させるボットの割合（既定: 0.1）
  --no-reset            --auto-host 時、開始前にゲームをリセットしない
  --seed-questions      --auto-host 時、問題が足りなければダミー問題を登録する
`);
  process.exit(0);
}

const BASE = args["base-url"].replace(/\/$/, "");
const N = Number(args.bots);
const ROUNDS = Number(args.rounds);
const ACCURACY = Number(args.accuracy);
const JOIN_SPREAD = Number(args["join-spread"]);
const CHURN = Number(args.churn);
const AUTO = args["auto-host"];

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
if (!firebaseConfig.projectId) {
  console.error("NEXT_PUBLIC_FIREBASE_PROJECT_ID などが未設定です。--env-file=.env.local を付けて実行してください");
  process.exit(1);
}
const EMU = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const rand = (a, b) => a + Math.random() * (b - a);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

// ---------------------------------------------------------------------------
// 計測
// ---------------------------------------------------------------------------
const metrics = {
  join: [],
  answer: [],
  propagation: {}, // status -> ms[]
  errors: {},
};
const addErr = (k) => (metrics.errors[k] = (metrics.errors[k] ?? 0) + 1);
function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function summary(name, arr) {
  if (!arr.length) return `${name.padEnd(22)} (データなし)`;
  const f = (v) => `${Math.round(v)}ms`.padStart(7);
  return `${name.padEnd(22)} n=${String(arr.length).padStart(4)}  p50=${f(pct(arr, 50))}  p95=${f(pct(arr, 95))}  p99=${f(pct(arr, 99))}  max=${f(Math.max(...arr))}`;
}

// サーバー時刻とのずれ
let offset = 0;
async function syncClock() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const { now } = await (await fetch(`${BASE}/api/time`)).json();
    const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: now + (t1 - t0) / 2 - t1 };
  }
  offset = best.offset;
}
const serverNow = () => Date.now() + offset;

async function post(path, body, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* noop */
  }
  return { status: res.status, ok: res.ok && data.ok !== false, data, headers: res.headers };
}

// ---------------------------------------------------------------------------
// ボット
// ---------------------------------------------------------------------------
const runId = Math.random().toString(36).slice(2, 5);
let correctAnswers = null; // auto-host 時のみ：index -> "A" | "B"

class Bot {
  constructor(i) {
    this.i = i;
    this.nickname = `b${runId}-${String(i).padStart(3, "0")}`;
    this.game = null;
    this.me = null;
    this.answered = new Map(); // index -> { choice, accepted, code }
    this.seenStatus = new Set();
  }

  async start() {
    this.app = initializeApp(firebaseConfig, `bot-${this.i}`);
    this.db = getFirestore(this.app);
    if (EMU) {
      const [h, p] = EMU.split(":");
      connectFirestoreEmulator(this.db, h, Number(p));
    }
    const t0 = Date.now();
    const res = await post("/api/join", { nickname: this.nickname });
    metrics.join.push(Date.now() - t0);
    if (!res.ok) {
      addErr(`join:${res.data.code ?? res.status}`);
      return false;
    }
    this.id = res.data.participantId;
    this.token = res.data.token;
    this.unsubs = [
      onSnapshot(doc(this.db, "game/state"), (s) => this.onGame(s.data())),
      onSnapshot(doc(this.db, `participants/${this.id}`), (s) => (this.me = s.data() ?? null)),
    ];
    return true;
  }

  onGame(g) {
    if (!g) return;
    const prev = this.game;
    this.game = g;
    const key = `${g.status}:${g.current?.index ?? -1}`;
    if (!prev || `${prev.status}:${prev.current?.index ?? -1}` !== key) {
      if (!this.seenStatus.has(key) && this.ready) {
        this.seenStatus.add(key);
        (metrics.propagation[g.status] ??= []).push(serverNow() - g.updatedAt);
      }
      if (g.status === "question" && g.current && !this.answered.has(g.current.index)) {
        this.scheduleAnswer(g);
      }
    }
  }

  scheduleAnswer(g) {
    const cur = g.current;
    const index = cur.index;
    this.answered.set(index, { pending: true });
    const limit = cur.deadlineAt - cur.startedAt;
    // 大半は制限時間内、約 2% はわざと締め切り直後に送って「無効」判定を確認
    const late = Math.random() < 0.02;
    const at = late ? cur.deadlineAt + g.settings.graceMs + rand(200, 800) : cur.startedAt + rand(300, limit * 0.9);
    const isAlive = this.me?.status === "alive";
    if (!isAlive && !g.settings.spectatorAnswer) return;
    let choice;
    if (correctAnswers && correctAnswers[index]) {
      const right = correctAnswers[index];
      choice = Math.random() < ACCURACY ? right : right === "A" ? "B" : "A";
    } else choice = Math.random() < 0.5 ? "A" : "B";

    // 約 20% のボットは途中で選び直す（締め切り前に反対の選択肢を送る）
    const change = !late && Math.random() < 0.2;
    const changeAt = at + rand(300, Math.max(400, cur.deadlineAt - at - 500));
    const send = async (c, seq) => {
      const t0 = Date.now();
      const res = await post("/api/answer", { pid: this.id, token: this.token, q: index, choice: c, seq });
      metrics.answer.push(Date.now() - t0);
      if (!res.ok) addErr(`answer:${res.data.code ?? res.status}${late ? "(意図的な遅刻)" : ""}`);
      return res;
    };
    setTimeout(async () => {
      try {
        let res = await send(choice, 1);
        if (change && res.ok) {
          await sleep(changeAt - serverNow());
          res = await send(choice === "A" ? "B" : "A", 2);
          if (res.ok) metrics.changes = (metrics.changes ?? 0) + 1;
        }
        // サーバーが返した最終的な回答（選び直し後）を記録
        const final = res.data.answer?.choice ?? choice;
        this.answered.set(index, { choice: final, accepted: Boolean(res.data.answer), code: res.data.code, aliveAtAnswer: isAlive, late });
      } catch (e) {
        addErr(`answer:network`);
        this.answered.set(index, { choice, accepted: false, code: "network", aliveAtAnswer: isAlive });
      }
    }, at - serverNow());
  }

  async churn() {
    await disableNetwork(this.db);
    await sleep(rand(1500, 4000));
    await enableNetwork(this.db);
  }

  async stop() {
    this.unsubs?.forEach((u) => u());
    if (this.db) await terminate(this.db).catch(() => {});
    if (this.app) await deleteApp(this.app).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 司会者（--auto-host）
// ---------------------------------------------------------------------------
let cookie = null;
async function admin(action, extra = {}) {
  const res = await post("/api/admin/action", { action, ...extra }, cookie);
  if (!res.ok) log(`  ⚠ 管理操作 ${action} 失敗: ${res.data.message ?? res.status}`);
  return res;
}
async function adminLogin() {
  if (!process.env.ADMIN_PASSWORD) throw new Error("--auto-host には ADMIN_PASSWORD が必要です");
  const res = await post("/api/admin/login", { password: process.env.ADMIN_PASSWORD });
  if (!res.ok) throw new Error(`管理ログイン失敗: ${res.data.message ?? res.status}`);
  cookie = res.headers.get("set-cookie").split(";")[0];
  await fetch(`${BASE}/api/admin/session`, { headers: { Cookie: cookie } });
}
async function adminQuestions() {
  const res = await fetch(`${BASE}/api/admin/questions`, { headers: { Cookie: cookie } });
  return (await res.json()).questions;
}

async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`タイムアウト: ${label}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
  log(`対象: ${BASE}  ボット: ${N}人  モード: ${AUTO ? "自動進行" : "手動進行（管理画面から操作してください）"}${EMU ? "  [エミュレーター]" : ""}`);
  await syncClock();
  log(`サーバー時刻とのずれ: ${Math.round(offset)}ms`);

  if (AUTO) {
    await adminLogin();
    if (!args["no-reset"]) {
      log("ゲームをリセット");
      await admin("reset");
    }
    let qs = await adminQuestions();
    if (qs.length < ROUNDS) {
      if (!args["seed-questions"]) throw new Error(`問題が ${qs.length} 問しかありません（--rounds ${ROUNDS}）。--seed-questions を付けるか問題を登録してください`);
      const extra = Array.from({ length: ROUNDS - qs.length }, (_, i) => ({
        text: `負荷テスト用ダミー問題 ${i + 1}`,
        choiceA: "こっち",
        choiceB: "あっち",
        correct: Math.random() < 0.5 ? "A" : "B",
      }));
      const res = await fetch(`${BASE}/api/admin/questions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ questions: [...qs, ...extra] }),
      });
      qs = (await res.json()).questions;
      log(`ダミー問題を ${extra.length} 問追加しました`);
    }
    correctAnswers = Object.fromEntries(qs.map((q, i) => [i, q.correct]));
  }

  // 参加登録（join-spread の間にばらけさせる）
  const bots = Array.from({ length: N }, (_, i) => new Bot(i + 1));
  const t0 = Date.now();
  const results = await Promise.all(bots.map(async (b) => (await sleep(rand(0, JOIN_SPREAD)), b.start())));
  const joined = bots.filter((_, i) => results[i]);
  log(`参加登録: ${joined.length}/${N} 成功（${((Date.now() - t0) / 1000).toFixed(1)}秒）`);
  await waitFor(() => joined.every((b) => b.game && b.me), 30000, "全ボットの購読開始");
  joined.forEach((b) => (b.ready = true));
  log("全ボットがリアルタイム購読を開始しました");

  const checks = { ok: 0, ng: 0, details: [] };
  const verifyRound = (index, reveal) => {
    for (const b of joined) {
      const a = b.answered.get(index);
      if (!a || a.pending || !a.aliveAtAnswer) continue;
      const shouldSurvive = reveal.allRevived || (a.accepted && a.choice === reveal.correct);
      const alive = b.me?.status === "alive";
      if (shouldSurvive === alive) checks.ok++;
      else {
        checks.ng++;
        checks.details.push(`${b.nickname} 第${index + 1}問: 期待=${shouldSurvive ? "生存" : "脱落"} 実際=${alive ? "生存" : "脱落"} (${JSON.stringify(a)})`);
      }
    }
  };

  if (AUTO) {
    await admin("closeEntry");
    for (let r = 0; r < ROUNDS; r++) {
      const before = joined.filter((b) => b.me?.status === "alive").length;
      await admin("start");
      const g = await (async () => {
        await waitFor(() => joined.every((b) => b.game?.status === "question"), 15000, "出題の反映");
        return joined[0].game;
      })();
      const cur = g.current;
      log(`第${cur.number}問 出題（生存 ${before}人）— 全ボットへの反映を確認`);
      await sleep(cur.deadlineAt + g.settings.graceMs - serverNow() + 300);
      await admin("close");
      await waitFor(() => joined.every((b) => { const a = b.answered.get(cur.index); return !a || !a.pending; }), 15000, "回答送信の完了");
      await sleep(300);
      const rev = await admin("reveal");
      await waitFor(() => joined.every((b) => b.game?.status === "revealed"), 15000, "正解発表の反映");
      await waitFor(
        () => joined.every((b) => b.me?.last?.index === cur.index || b.me?.status === "out"),
        15000,
        "参加者ドキュメントの反映",
      );
      const reveal = rev.data.result ?? joined[0].game.reveal;
      verifyRound(cur.index, reveal);
      log(
        `  正解 ${reveal.correct}: A=${reveal.countA} B=${reveal.countB} 未回答=${reveal.noAnswer} → 生存 ${reveal.survivors} / 脱落 ${reveal.eliminated}${reveal.allRevived ? "（全員復活）" : ""}`,
      );
      if (reveal.survivors <= 1 || r === ROUNDS - 1) break;
      await admin("next");
      await waitFor(() => joined.every((b) => b.game?.status === "waiting"), 15000, "次の問題へ の反映");
      // 一部のボットを切断→再接続させ、最新状態に戻れるか確認
      if (CHURN > 0) {
        const targets = joined.filter(() => Math.random() < CHURN);
        await Promise.all(targets.map((b) => b.churn()));
        await waitFor(() => targets.every((b) => b.game?.status === "waiting"), 15000, "再接続後の状態復帰");
        log(`  ${targets.length}体のボットを切断→再接続し、最新状態に復帰したことを確認`);
      }
      await sleep(1000);
    }
    await admin("finish");
    await waitFor(() => joined.every((b) => b.game?.status === "finished"), 15000, "終了の反映");
    const g = joined[0].game;
    log(`終了: 優勝 ${g.ranking?.[0]?.nickname ?? "なし"}（生存 ${g.finalistCount}人）`);
  } else {
    log("管理画面で進行してください。Ctrl+C で終了して結果を表示します。");
    await new Promise((resolve) => process.once("SIGINT", resolve));
  }

  // 結果
  console.log("\n================ 結果 ================");
  console.log(summary("参加登録 API", metrics.join));
  console.log(summary("回答 API", metrics.answer));
  for (const [status, arr] of Object.entries(metrics.propagation)) console.log(summary(`反映遅延: ${status}`, arr));
  if (metrics.changes) console.log(`選び直し: ${metrics.changes}回（最終回答で判定されているかを整合性チェックで確認）`);
  console.log("エラー内訳:", Object.keys(metrics.errors).length ? metrics.errors : "なし");
  if (AUTO) {
    console.log(`判定の整合性チェック: OK ${checks.ok} / NG ${checks.ng}`);
    checks.details.slice(0, 20).forEach((d) => console.log("  NG", d));
  }
  console.log("※ 反映遅延 = サーバーが状態を書き込んでからボットの購読に届くまでの時間");
  await Promise.all(bots.map((b) => b.stop()));
  process.exit(AUTO && checks.ng > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("エラー:", e.message);
  process.exit(1);
});
