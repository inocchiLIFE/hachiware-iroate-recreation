import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DocumentReference, Firestore, Transaction, WriteBatch } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { AppError } from "./http";
import {
  DEFAULT_SETTINGS,
  NICKNAME_MAX,
  QUESTION_LEAD_MS,
  answerDocId,
  effectiveDeadline,
  type Answer,
  type Choice,
  type GameSettings,
  type GameState,
  type LastResult,
  type Participant,
  type Question,
  type QuestionInput,
  type RankingEntry,
  type RevealResult,
} from "../types";

// ---------------------------------------------------------------------------
// Firestore のパス
// ---------------------------------------------------------------------------
export function refs(db: Firestore = adminDb()) {
  return {
    db,
    game: db.doc("game/state") as DocumentReference<GameState>,
    participants: db.collection("participants"),
    secrets: db.collection("secrets"),
    nicknames: db.collection("nicknames"),
    answers: db.collection("answers"),
    questions: db.collection("questions"),
  };
}

const randomId = (bytes = 9) => randomBytes(bytes).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function initialState(settings: GameSettings, questionCount: number): GameState {
  return {
    gameId: randomId(6),
    status: "lobby",
    entryOpen: true,
    settings,
    questionCount,
    nextQuestionIndex: 0,
    current: null,
    reveal: null,
    aliveCount: 0,
    ranking: null,
    finalistCount: 0,
    updatedAt: Date.now(),
  };
}

/** ゲーム状態を取得（なければ初期化） */
export async function getGame(): Promise<GameState> {
  const r = refs();
  const snap = await r.game.get();
  if (snap.exists) return snap.data()!;
  const qCount = (await r.questions.count().get()).data().count;
  const state = initialState({ ...DEFAULT_SETTINGS }, qCount);
  await r.game.create(state).catch(() => undefined);
  return (await r.game.get()).data()!;
}

async function gameInTx(tx: Transaction): Promise<GameState> {
  const snap = await tx.get(refs().game);
  if (!snap.exists) throw new AppError("no_game", "ゲームが初期化されていません。管理画面を開き直してください");
  return snap.data()!;
}

async function countAlive(): Promise<number> {
  const r = refs();
  return (await r.participants.where("status", "==", "alive").count().get()).data().count;
}

async function syncAliveCount() {
  const aliveCount = await countAlive();
  await refs().game.update({ aliveCount, updatedAt: Date.now() });
  return aliveCount;
}

/** 500 件制限に収まるよう分割してバッチ書き込み */
async function commitChunked(ops: Array<(b: WriteBatch) => void>, db: Firestore) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = db.batch();
    ops.slice(i, i + 450).forEach((op) => op(batch));
    await batch.commit();
  }
}

// ---------------------------------------------------------------------------
// 参加者 API
// ---------------------------------------------------------------------------
export function normalizeNickname(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("bad_nickname", "ニックネームを入力してください");
  // 制御文字を除去し、連続する空白を 1 つにまとめる
  const name = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const len = [...name].length;
  if (len === 0) throw new AppError("bad_nickname", "ニックネームを入力してください");
  if (len > NICKNAME_MAX) throw new AppError("bad_nickname", `ニックネームは${NICKNAME_MAX}文字以内にしてください`);
  return name;
}

export async function joinGame(rawNickname: unknown) {
  const nickname = normalizeNickname(rawNickname);
  const nickKey = sha256(nickname.normalize("NFKC").toLowerCase().replace(/\s/g, "")).slice(0, 40);
  const r = refs();
  const id = randomId();
  const token = randomBytes(24).toString("base64url");
  const now = Date.now();

  // トランザクションを使わず「ゲーム状態の読み取り → create のみのバッチ」で登録する。
  // 150 人が同時に押しても game/state でロック待ちにならない。
  // ニックネームの重複は nicknames/{key} の create（既存なら失敗）で原子的に防ぐ。
  const game = await getGame(); // 未作成なら初期化
  if (game.status !== "lobby" || !game.entryOpen) {
    throw new AppError("entry_closed", "参加受付は終了しました", 409);
  }
  const p: Participant = {
    id,
    gameId: game.gameId,
    nickname,
    status: "alive",
    joinedAt: now,
    eliminatedAt: null,
    correctCount: 0,
    totalAnswerMs: 0,
    last: null,
    rank: null,
  };
  const batch = r.db.batch();
  batch.create(r.nicknames.doc(nickKey), { pid: id });
  batch.create(r.participants.doc(id), p);
  batch.create(r.secrets.doc(id), { tokenHash: sha256(token), nickKey });
  try {
    await batch.commit();
  } catch (e) {
    if ((e as { code?: number }).code === 6) {
      throw new AppError("nickname_taken", "そのニックネームは使われています。別の名前にしてください", 409);
    }
    throw e;
  }
  return { participantId: id, token, nickname, gameId: game.gameId };
}

function verifyToken(tokenHash: unknown, token: unknown): boolean {
  if (typeof tokenHash !== "string" || typeof token !== "string") return false;
  const a = Buffer.from(tokenHash);
  const b = Buffer.from(sha256(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 回答の受付。
 * - 受信時刻（サーバー時刻）で締め切りを判定し、締め切り後は無効
 * - 1 人 1 問 1 回答（answers/{q}_{pid} を create で作成するため、変更は物理的に不可）
 * - 同じ選択肢での再送（通信リトライ）は成功扱いで既存の回答を返す
 */
export async function submitAnswer(input: { pid: unknown; token: unknown; q: unknown; choice: unknown; seq?: unknown }) {
  const receivedAt = Date.now();
  const { pid, token, q, choice } = input;
  const seq = typeof input.seq === "number" && Number.isFinite(input.seq) ? input.seq : 0;
  if (typeof pid !== "string" || !/^[\w-]{6,40}$/.test(pid)) throw new AppError("bad_request", "参加者IDが不正です");
  if (typeof q !== "number" || !Number.isInteger(q)) throw new AppError("bad_request", "問題番号が不正です");
  if (choice !== "A" && choice !== "B") throw new AppError("bad_request", "選択肢が不正です");

  const r = refs();
  const ansRef = r.answers.doc(answerDocId(q, pid));
  const [gSnap, pSnap, sSnap, aSnap] = await r.db.getAll(r.game, r.participants.doc(pid), r.secrets.doc(pid), ansRef);
  if (!pSnap.exists || !sSnap.exists || !verifyToken(sSnap.get("tokenHash"), token)) {
    throw new AppError("unknown_participant", "参加者情報が見つかりません。もう一度参加登録してください", 401);
  }
  const game = gSnap.data() as GameState | undefined;
  const p = pSnap.data() as Participant;
  const existing = aSnap.exists ? (aSnap.data() as Answer) : null;

  // 同じ回答の再送（通信リトライ）は、締め切り後でも成功扱い
  if (existing && existing.choice === choice) return { ok: true, answer: existing, duplicate: true };

  const cur = game?.current;
  if (!game || game.status !== "question" || !cur || cur.index !== q) {
    if (existing) throw new AppError("closed", "締め切り後のため選び直せません", 409, { answer: existing });
    throw new AppError("not_accepting", "現在この問題の回答は受け付けていません", 409);
  }
  if (p.gameId !== game.gameId) throw new AppError("unknown_participant", "参加者情報が古くなっています", 401);
  // 端末の時計補正の誤差を見込んで、表示開始のわずか前から受け付ける
  if (receivedAt < cur.startedAt - 1000) throw new AppError("too_early", "まだ出題前です", 409);
  if (receivedAt > effectiveDeadline(cur, game.settings)) {
    throw new AppError("late", "締め切り後に届いたため無効です", 409, existing ? { answer: existing } : undefined);
  }
  const spectator = p.status !== "alive";
  if (spectator && !game.settings.spectatorAnswer) {
    throw new AppError("spectator", "脱落後は回答できません", 403);
  }
  const elapsedMs = Math.max(0, receivedAt - cur.startedAt);

  if (!existing) {
    const answer: Answer = { pid, gameId: game.gameId, q, choice, answeredAt: receivedAt, elapsedMs, spectator, seq, changes: 0 };
    try {
      await ansRef.create(answer);
      return { ok: true, answer };
    } catch (e) {
      // 同時に別の選択肢が届いて先に作成された → 選び直しとして扱う
      if ((e as { code?: number }).code !== 6) throw e;
    }
  }
  if (game.settings.allowChange === false) {
    const a = existing ?? ((await ansRef.get()).data() as Answer);
    if (a.choice === choice) return { ok: true, answer: a, duplicate: true };
    throw new AppError("already_answered", "回答の変更はできません", 409, { answer: a });
  }
  // 選び直し：端末の送信番号が新しいものだけ反映（通信の追い越しで古い選択に戻らないように）
  const answer = await r.db.runTransaction(async (tx) => {
    const a = (await tx.get(ansRef)).data() as Answer;
    if (a.choice === choice || seq <= (a.seq ?? 0)) return a;
    const next: Answer = { ...a, choice, answeredAt: receivedAt, elapsedMs, seq, changes: (a.changes ?? 0) + 1 };
    tx.set(ansRef, next);
    return next;
  });
  return { ok: true, answer };
}

/** 回答済み人数（集計クエリ count() は 1000 件まで読み取り 1 回分なので、ポーリングでも安い） */
export async function answeredCount(q: number): Promise<{ answered: number }> {
  const snap = await refs()
    .answers.where("q", "==", q)
    .where("spectator", "==", false)
    .count()
    .get();
  return { answered: snap.data().count };
}

// ---------------------------------------------------------------------------
// 問題の管理
// ---------------------------------------------------------------------------
export async function listQuestions(): Promise<Question[]> {
  const snap = await refs().questions.orderBy("order").get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<Question, "id">), id: d.id }));
}

function validateQuestion(q: Partial<QuestionInput>, i: number): QuestionInput {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const text = s(q.text);
  const choiceA = s(q.choiceA);
  const choiceB = s(q.choiceB);
  if (!text || !choiceA || !choiceB) throw new AppError("bad_question", `${i + 1}問目: 問題文と選択肢は必須です`);
  if (text.length > 300 || choiceA.length > 100 || choiceB.length > 100) {
    throw new AppError("bad_question", `${i + 1}問目: 文字数が多すぎます（問題文300字・選択肢100字まで）`);
  }
  if (q.correct !== "A" && q.correct !== "B") throw new AppError("bad_question", `${i + 1}問目: 正解は A か B です`);
  return { text, choiceA, choiceB, correct: q.correct };
}

/** 問題リストを丸ごと置き換える（管理画面の「保存」・CSV 置き換えインポート） */
export async function replaceQuestions(input: unknown): Promise<Question[]> {
  if (!Array.isArray(input)) throw new AppError("bad_request", "questions は配列で指定してください");
  if (input.length > 500) throw new AppError("bad_request", "問題は500問までです");
  const list = input.map((q, i) => validateQuestion(q as Partial<QuestionInput>, i));
  const r = refs();
  const existing = await r.questions.get();
  const ops: Array<(b: WriteBatch) => void> = existing.docs.map((d) => (b) => b.delete(d.ref));
  list.forEach((q, order) => {
    const ref = r.questions.doc();
    ops.push((b) => b.set(ref, { ...q, order }));
  });
  await commitChunked(ops, r.db);
  await getGame();
  await r.game.update({ questionCount: list.length, updatedAt: Date.now() });
  return listQuestions();
}

// ---------------------------------------------------------------------------
// 進行操作（管理画面）
// ---------------------------------------------------------------------------
export async function setEntryOpen(open: boolean) {
  const r = refs();
  await r.db.runTransaction(async (tx) => {
    const g = await gameInTx(tx);
    if (g.status !== "lobby") throw new AppError("bad_state", "出題開始後は参加受付を変更できません", 409);
    tx.update(r.game, { entryOpen: open, updatedAt: Date.now() });
  });
}

/** 出題 */
export async function startQuestion() {
  const r = refs();
  const questions = await listQuestions();
  const aliveCount = await countAlive();
  await r.db.runTransaction(async (tx) => {
    const g = await gameInTx(tx);
    if (g.status !== "lobby" && g.status !== "waiting") {
      throw new AppError("bad_state", "今は出題できません（前の問題の正解発表→「次の問題へ」を先に）", 409);
    }
    const q = questions[g.nextQuestionIndex];
    if (!q) throw new AppError("no_more_questions", "出題できる問題が残っていません", 409);
    const startedAt = Date.now() + QUESTION_LEAD_MS;
    tx.update(r.game, {
      status: "question",
      entryOpen: false,
      questionCount: questions.length,
      nextQuestionIndex: g.nextQuestionIndex + 1,
      current: {
        index: g.nextQuestionIndex,
        number: (g.current?.number ?? 0) + 1,
        text: q.text,
        choiceA: q.choiceA,
        choiceB: q.choiceB,
        startedAt,
        deadlineAt: startedAt + g.settings.timeLimitSec * 1000,
        closedAt: null,
      },
      reveal: null,
      aliveCount,
      updatedAt: Date.now(),
    });
  });
}

/** 回答締め切り（制限時間前に押した場合はその時点で締め切る） */
export async function closeQuestion() {
  const r = refs();
  await r.db.runTransaction(async (tx) => {
    const g = await gameInTx(tx);
    if (g.status !== "question" || !g.current) throw new AppError("bad_state", "出題中ではありません", 409);
    const closedAt = Math.min(Date.now(), effectiveDeadline(g.current, g.settings));
    tx.update(r.game, { status: "closed", "current.closedAt": closedAt, updatedAt: Date.now() });
  });
}

/** 正解発表：脱落判定を行う */
export async function revealAnswer() {
  const r = refs();
  const lockRef = r.db.doc("control/judge");
  // 1) 二重実行防止のロック（150 台が購読する game/state には書かず、読み取り回数を節約）
  const g = await r.db.runTransaction(async (tx) => {
    const [g, lock] = [await gameInTx(tx), await tx.get(lockRef)];
    const now = Date.now();
    const pastDeadline = g.current != null && now > effectiveDeadline(g.current, g.settings);
    if (!(g.status === "closed" || (g.status === "question" && pastDeadline)) || !g.current) {
      throw new AppError("bad_state", "回答締め切り後に正解発表してください", 409);
    }
    const key = `${g.gameId}:${g.current.index}`;
    const lockedAt = lock.get("key") === key ? Number(lock.get("at")) : 0;
    if (now - lockedAt < 60_000) throw new AppError("busy", "判定処理中です。少し待ってください", 409);
    tx.set(lockRef, { key, at: now });
    const closedAt = g.current.closedAt ?? Math.min(now, effectiveDeadline(g.current, g.settings));
    return { ...g, current: { ...g.current, closedAt } };
  });

  try {
    const cur = g.current!;
    const question = (await listQuestions())[cur.index];
    if (!question) throw new AppError("question_missing", "出題中の問題が問題リストから削除されています", 409);
    const correct = question.correct;
    const limit = effectiveDeadline(cur, g.settings);
    const timeLimitMs = g.settings.timeLimitSec * 1000;

    const [aliveSnap, ansSnap] = await Promise.all([
      r.participants.where("status", "==", "alive").get(),
      r.answers.where("q", "==", cur.index).get(),
    ]);
    const answers = new Map<string, Answer>();
    for (const d of ansSnap.docs) {
      const a = d.data() as Answer;
      if (a.gameId === g.gameId && a.answeredAt <= limit) answers.set(a.pid, a);
    }

    const alive = aliveSnap.docs.map((d) => d.data() as Participant);
    let countA = 0;
    let countB = 0;
    let survivors = 0;
    for (const p of alive) {
      const a = answers.get(p.id);
      if (a?.choice === "A") countA++;
      if (a?.choice === "B") countB++;
      if (a?.choice === correct) survivors++;
    }
    const allRevived = alive.length > 0 && survivors === 0;

    const ops: Array<(b: WriteBatch) => void> = [];
    for (const p of alive) {
      const a = answers.get(p.id);
      const isCorrect = a?.choice === correct;
      const last: LastResult = {
        index: cur.index,
        choice: a?.choice ?? null,
        result: !a ? "noanswer" : isCorrect ? "correct" : "wrong",
        revived: allRevived,
      };
      const ref = r.participants.doc(p.id);
      if (isCorrect) {
        ops.push((b) =>
          b.update(ref, { last, correctCount: p.correctCount + 1, totalAnswerMs: p.totalAnswerMs + a!.elapsedMs }),
        );
      } else if (allRevived) {
        // 全員脱落 → この問題の脱落はなかったことに（未回答は制限時間ぶんを加算して順位付け）
        ops.push((b) => b.update(ref, { last, totalAnswerMs: p.totalAnswerMs + (a ? a.elapsedMs : timeLimitMs) }));
      } else {
        ops.push((b) => b.update(ref, { last, status: "out", eliminatedAt: cur.number }));
      }
    }

    const reveal: RevealResult = {
      index: cur.index,
      number: cur.number,
      correct,
      countA,
      countB,
      noAnswer: alive.length - countA - countB,
      aliveBefore: alive.length,
      survivors: allRevived ? alive.length : survivors,
      eliminated: allRevived ? 0 : alive.length - survivors,
      allRevived,
    };
    // 参加者の更新とゲーム状態の更新を（可能なら）同じバッチで原子的に反映する
    ops.push((b) =>
      b.update(r.game, {
        status: "revealed",
        "current.closedAt": cur.closedAt,
        reveal,
        aliveCount: reveal.survivors,
        updatedAt: Date.now(),
      }),
    );
    await commitChunked(ops, r.db);
    return reveal;
  } finally {
    await lockRef.set({ key: null, at: 0 });
  }
}

/** 次の問題へ（出題待ち状態にする） */
export async function goNext() {
  const r = refs();
  await r.db.runTransaction(async (tx) => {
    const g = await gameInTx(tx);
    if (g.status !== "revealed") throw new AppError("bad_state", "正解発表の後に押してください", 409);
    tx.update(r.game, { status: "waiting", updatedAt: Date.now() });
  });
}

/** ゲーム終了：順位を確定して勝者を発表 */
export async function finishGame() {
  const r = refs();
  const g = await getGame();
  if (g.status !== "revealed" && g.status !== "waiting") {
    throw new AppError("bad_state", "正解発表の後に終了してください", 409);
  }
  const all = (await r.participants.get()).docs.map((d) => d.data() as Participant);
  // 生存者：累計回答時間が短い順 → 脱落者：後で脱落した順
  const sorted = all.sort((a, b) => {
    if (a.status !== b.status) return a.status === "alive" ? -1 : 1;
    if (a.status === "out" && a.eliminatedAt !== b.eliminatedAt) return (b.eliminatedAt ?? 0) - (a.eliminatedAt ?? 0);
    if (a.correctCount !== b.correctCount) return b.correctCount - a.correctCount;
    return a.totalAnswerMs - b.totalAnswerMs;
  });
  const key = (p: Participant) => `${p.status}|${p.status === "out" ? p.eliminatedAt : ""}|${p.correctCount}|${p.totalAnswerMs}`;
  const ranks: number[] = [];
  sorted.forEach((p, i) => (ranks[i] = i > 0 && key(p) === key(sorted[i - 1]) ? ranks[i - 1] : i + 1));

  const ranking: RankingEntry[] = sorted.slice(0, 20).map((p, i) => ({
    id: p.id,
    nickname: p.nickname,
    rank: ranks[i],
    alive: p.status === "alive",
    totalAnswerMs: p.totalAnswerMs,
    correctCount: p.correctCount,
  }));
  const ops: Array<(b: WriteBatch) => void> = sorted.map((p, i) => (b) =>
    b.update(r.participants.doc(p.id), { rank: ranks[i] }),
  );
  ops.push((b) =>
    b.update(r.game, {
      status: "finished",
      ranking,
      finalistCount: sorted.filter((p) => p.status === "alive").length,
      updatedAt: Date.now(),
    }),
  );
  await commitChunked(ops, r.db);
}

/** ゲーム全体のリセット（問題と設定は残す） */
export async function resetGame() {
  const r = refs();
  const g = await getGame();
  await Promise.all([
    r.db.recursiveDelete(r.answers),
    r.db.recursiveDelete(r.participants),
    r.db.recursiveDelete(r.secrets),
    r.db.recursiveDelete(r.nicknames),
  ]);
  const qCount = (await r.questions.count().get()).data().count;
  await r.game.set(initialState(g.settings, qCount));
}

export async function updateSettings(input: Partial<GameSettings>) {
  const r = refs();
  const g = await getGame();
  const s: GameSettings = { ...g.settings };
  if (input.timeLimitSec !== undefined) {
    const v = Number(input.timeLimitSec);
    if (!Number.isFinite(v) || v < 3 || v > 120) throw new AppError("bad_settings", "制限時間は3〜120秒です");
    s.timeLimitSec = Math.round(v);
  }
  if (input.graceMs !== undefined) {
    const v = Number(input.graceMs);
    if (!Number.isFinite(v) || v < 0 || v > 3000) throw new AppError("bad_settings", "猶予は0〜3000msです");
    s.graceMs = Math.round(v);
  }
  if (input.spectatorAnswer !== undefined) s.spectatorAnswer = Boolean(input.spectatorAnswer);
  if (input.allowChange !== undefined) s.allowChange = Boolean(input.allowChange);
  await r.game.update({ settings: s, updatedAt: Date.now() });
  return s;
}

// ---------------------------------------------------------------------------
// 参加者の個別操作（管理画面）
// ---------------------------------------------------------------------------
export async function setParticipantStatus(pid: unknown, alive: boolean) {
  if (typeof pid !== "string") throw new AppError("bad_request", "参加者IDが不正です");
  const r = refs();
  const ref = r.participants.doc(pid);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not_found", "参加者が見つかりません", 404);
  const g = await getGame();
  await ref.update(
    alive
      ? { status: "alive", eliminatedAt: null }
      : { status: "out", eliminatedAt: g.current?.number ?? 0 },
  );
  return syncAliveCount();
}

export async function kickParticipant(pid: unknown) {
  if (typeof pid !== "string") throw new AppError("bad_request", "参加者IDが不正です");
  const r = refs();
  const secret = await r.secrets.doc(pid).get();
  const batch = r.db.batch();
  batch.delete(r.participants.doc(pid));
  batch.delete(r.secrets.doc(pid));
  const nickKey = secret.get("nickKey");
  if (typeof nickKey === "string") batch.delete(r.nicknames.doc(nickKey));
  await batch.commit();
  return syncAliveCount();
}
