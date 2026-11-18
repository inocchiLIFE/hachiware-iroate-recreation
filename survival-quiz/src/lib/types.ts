// クライアント・サーバー共通の型定義

export type Choice = "A" | "B";

/**
 * ゲームの進行状態
 * lobby    : 参加受付中（entryOpen=false なら受付締切・開始待ち）
 * question : 出題中（回答受付中）
 * closed   : 回答締め切り（正解発表待ち）
 * revealed : 正解発表済み
 * waiting  : 次の問題の出題待ち
 * finished : 終了（勝者発表）
 */
export type GameStatus =
  | "lobby"
  | "question"
  | "closed"
  | "revealed"
  | "waiting"
  | "finished";

export interface GameSettings {
  /** 制限時間（秒） */
  timeLimitSec: number;
  /** 通信遅延の猶予（ミリ秒）。締切時刻 + 猶予 までにサーバーへ届いた回答を有効にする */
  graceMs: number;
  /** 脱落者（観戦者）も回答ボタンを押せるか（判定には影響しない） */
  spectatorAnswer: boolean;
}

export interface CurrentQuestion {
  /** 問題リスト上のインデックス（0 始まり） */
  index: number;
  /** 何問目か（1 始まり） */
  number: number;
  text: string;
  choiceA: string;
  choiceB: string;
  /** 出題時刻（サーバー時刻 ms）。全端末でこの時刻に同時に問題を表示する */
  startedAt: number;
  /** 締め切り時刻（サーバー時刻 ms） */
  deadlineAt: number;
  /** 手動で締め切った時刻（サーバー時刻 ms） */
  closedAt: number | null;
}

export interface RevealResult {
  index: number;
  number: number;
  correct: Choice;
  /** 判定対象（この問題の開始時点の生存者）のうち A / B を選んだ人数 */
  countA: number;
  countB: number;
  noAnswer: number;
  aliveBefore: number;
  survivors: number;
  eliminated: number;
  /** 全員が不正解だったため、全員復活させた */
  allRevived: boolean;
}

export interface RankingEntry {
  id: string;
  nickname: string;
  rank: number;
  alive: boolean;
  totalAnswerMs: number;
  correctCount: number;
}

export interface GameState {
  gameId: string;
  status: GameStatus;
  entryOpen: boolean;
  settings: GameSettings;
  /** 登録済みの問題数 */
  questionCount: number;
  /** 次に出題する問題のインデックス */
  nextQuestionIndex: number;
  current: CurrentQuestion | null;
  reveal: RevealResult | null;
  /** 生存者数（出題開始・正解発表・復活などのたびに更新） */
  aliveCount: number;
  ranking: RankingEntry[] | null;
  finalistCount: number;
  updatedAt: number;
}

export type ParticipantStatus = "alive" | "out";

export interface LastResult {
  index: number;
  choice: Choice | null;
  result: "correct" | "wrong" | "noanswer";
  revived: boolean;
}

export interface Participant {
  id: string;
  gameId: string;
  nickname: string;
  status: ParticipantStatus;
  joinedAt: number;
  /** 何問目で脱落したか */
  eliminatedAt: number | null;
  correctCount: number;
  /** 正解した問題の回答時間の合計（ms）。同点時の順位付けに使う */
  totalAnswerMs: number;
  last: LastResult | null;
  rank: number | null;
}

export interface Answer {
  pid: string;
  gameId: string;
  q: number;
  choice: Choice;
  answeredAt: number;
  elapsedMs: number;
  /** 回答時点で脱落済みだった（判定対象外の参考回答） */
  spectator: boolean;
}

export interface Question {
  id: string;
  order: number;
  text: string;
  choiceA: string;
  choiceB: string;
  correct: Choice;
}

export type QuestionInput = Omit<Question, "id" | "order">;

export const DEFAULT_SETTINGS: GameSettings = {
  timeLimitSec: 10,
  graceMs: 500,
  spectatorAnswer: true,
};

/** 出題ボタンを押してから全端末で問題が表示されるまでの待ち時間（ms） */
export const QUESTION_LEAD_MS = 1500;

export const NICKNAME_MAX = 12;

export const answerDocId = (q: number, pid: string) => `${q}_${pid}`;

/** 判定に使う実効締め切り（この時刻までにサーバーへ届いた回答が有効） */
export function effectiveDeadline(cur: CurrentQuestion, settings: GameSettings): number {
  const natural = cur.deadlineAt + settings.graceMs;
  return cur.closedAt == null ? natural : Math.min(natural, cur.closedAt);
}

export const STATUS_LABEL: Record<GameStatus, string> = {
  lobby: "参加受付",
  question: "出題中",
  closed: "回答締め切り",
  revealed: "正解発表",
  waiting: "次の問題待ち",
  finished: "終了",
};
