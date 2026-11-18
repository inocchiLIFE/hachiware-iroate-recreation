"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Timer, remaining } from "@/components/Timer";
import {
  api,
  serverNow,
  useConnectionWatch,
  useDoc,
  useGame,
  useLocalStorage,
  useNow,
  useServerClock,
} from "@/lib/client/hooks";
import {
  NICKNAME_MAX,
  type Answer,
  type Choice,
  type GameState,
  type Participant,
} from "@/lib/types";

interface Identity {
  participantId: string;
  token: string;
  nickname: string;
  gameId: string;
}

const STORAGE_KEY = "survival-quiz:identity";

/**
 * 自分の回答は端末に保存する（Firestore を購読しないことで読み取り回数を節約）。
 * サーバーが受理した回答のみ保存し、リロード後もここから復元する。
 */
function useMyAnswers(gameId: string) {
  const key = `survival-quiz:answers:${gameId}`;
  const [map, save] = useLocalStorage<Record<string, Answer>>(key);
  const get = (q: number) => map?.[String(q)] ?? null;
  const put = useCallback(
    (a: Answer) => {
      let cur: Record<string, Answer> = {};
      try {
        cur = JSON.parse(localStorage.getItem(key) ?? "{}");
      } catch {
        /* noop */
      }
      save({ ...cur, [String(a.q)]: a });
    },
    [key, save],
  );
  return { get, put };
}

export default function PlayerPage() {
  useServerClock();
  const game = useGame();
  const [me, setMe] = useLocalStorage<Identity>(STORAGE_KEY);
  const p = useDoc<Participant>(me ? `participants/${me.participantId}` : null);
  const conn = useConnectionWatch(game.fromCache);

  // ゲームがリセットされた／退場になった場合は端末の参加情報を破棄する
  useEffect(() => {
    if (!me) return;
    const gameChanged = game.data && !game.fromCache && game.data.gameId !== me.gameId;
    const removed = p.loaded && !p.fromCache && !p.data && !p.error;
    if (gameChanged || removed) setMe(null);
  }, [me, game.data, game.fromCache, p.loaded, p.fromCache, p.data, p.error, setMe]);

  let content: React.ReactNode;
  if (me === undefined || !game.loaded || (me && !p.loaded)) {
    content = <Loading />;
  } else if (!me || !p.data) {
    const canJoin = !game.data || (game.data.status === "lobby" && game.data.entryOpen);
    content = canJoin ? <JoinForm onJoined={setMe} /> : <EntryClosed game={game.data!} />;
  } else if (!game.data) {
    content = <Loading />;
  } else {
    content = <Play game={game.data} p={p.data} me={me} />;
  }

  return (
    <main className="player">
      <header className="player-head">
        {p.data ? (
          <>
            <span className="name">{p.data.nickname} さん</span>
            <span className={`badge ${p.data.status}`}>{p.data.status === "alive" ? "● 生存中" : "観戦中"}</span>
          </>
        ) : (
          <span className="name">2択サバイバルクイズ</span>
        )}
      </header>
      {conn.unstable && game.loaded && (
        <div className="conn-banner" role="status">
          {conn.online ? "サーバーと再接続しています…" : "通信が切れています。電波の良い場所でお待ちください"}
        </div>
      )}
      {content}
    </main>
  );
}

function Loading() {
  return (
    <div className="card center stack grow" style={{ justifyContent: "center" }}>
      <div className="spinner" />
      <p className="lead">読み込み中…</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 参加登録
// ---------------------------------------------------------------------------
function JoinForm({ onJoined }: { onJoined: (id: Identity) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<Identity>("/api/join", { nickname: name });
      if (res.ok) onJoined(res.data);
      else setError(res.message ?? "参加できませんでした");
    } catch {
      setError("通信に失敗しました。もう一度お試しください");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <div className="center stack" style={{ gap: 6 }}>
        <span className="hero-label">SURVIVAL QUIZ</span>
        <h1 className="title-xl">2択サバイバル<br />クイズ</h1>
        <p className="lead">間違えたら脱落。最後まで残れ！</p>
      </div>
      <label className="field">
        ニックネーム
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={NICKNAME_MAX * 2}
          placeholder={`${NICKNAME_MAX}文字まで`}
          autoComplete="nickname"
          enterKeyHint="go"
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn block" disabled={busy || name.trim() === ""}>
        {busy ? "登録中…" : "参加する"}
      </button>
      <Rules />
    </form>
  );
}

function Rules() {
  return (
    <ul className="rules">
      <li>問題ごとに A か B をタップ（制限時間内・変更不可）</li>
      <li>間違えた人・時間内に答えなかった人は脱落</li>
      <li>脱落後も観戦モードで最後まで楽しめます</li>
    </ul>
  );
}

function EntryClosed({ game }: { game: GameState }) {
  return (
    <div className="card center stack grow" style={{ justifyContent: "center" }}>
      <h1 className="title-l">参加受付は終了しました</h1>
      <p className="lead">
        {game.status === "lobby" ? "まもなくゲームが始まります。" : "ゲームが進行中です。"}
        <br />
        スクリーンでお楽しみください。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ゲーム進行中
// ---------------------------------------------------------------------------
function Play({ game, p, me }: { game: GameState; p: Participant; me: Identity }) {
  switch (game.status) {
    case "lobby":
      return (
        <div className="card center stack grow" style={{ justifyContent: "center" }}>
          <span className="hero-label">ENTRY OK</span>
          <h1 className="title-xl pop">参加登録完了！</h1>
          <p className="lead">
            <b>{p.nickname}</b> さん、開始までこのままお待ちください。
            <br />
            画面は閉じても大丈夫です（同じ端末で開き直せば復帰します）。
          </p>
          <Rules />
        </div>
      );
    case "question":
    case "closed":
      return <QuestionView key={game.current!.index} game={game} p={p} me={me} />;
    case "revealed":
      return <RevealView game={game} p={p} me={me} />;
    case "waiting":
      return (
        <div className="card center stack grow" style={{ justifyContent: "center" }}>
          <p className="qnum">第{(game.current?.number ?? 0) + 1}問</p>
          <h1 className="title-l">まもなく出題…</h1>
          <StatusLine game={game} p={p} />
        </div>
      );
    case "finished":
      return <FinishedView game={game} p={p} />;
  }
}

function StatusLine({ game, p }: { game: GameState; p: Participant }) {
  return (
    <div className="pill-row">
      <span className="pill">{p.status === "alive" ? "あなたは生存中" : `第${p.eliminatedAt}問で脱落（観戦中）`}</span>
      <span className="pill">生存者 {game.aliveCount}人</span>
    </div>
  );
}

type Pending = { choice: Choice; state: "sending" | "error"; message?: string };

function QuestionView({ game, p, me }: { game: GameState; p: Participant; me: Identity }) {
  const cur = game.current!;
  const mine = useMyAnswers(game.gameId);
  const myAnswer = { data: mine.get(cur.index) };
  const [pending, setPending] = useState<Pending | null>(null);
  const sendingRef = useRef(false);
  const now = useNow(game.status === "question", 100);

  const before = game.status === "question" && now < cur.startedAt;
  const { ms } = remaining(cur, now);
  const open = game.status === "question" && !before && ms > 0;
  const spectator = p.status !== "alive";
  const canAnswer = !spectator || game.settings.spectatorAnswer;
  const chosen: Choice | null = myAnswer.data?.choice ?? (pending?.state === "sending" ? pending.choice : null);

  const submit = useCallback(
    async (choice: Choice) => {
      if (sendingRef.current || chosen) return;
      sendingRef.current = true;
      navigator.vibrate?.(30);
      setPending({ choice, state: "sending" });
      const giveUpAt = cur.deadlineAt + game.settings.graceMs + 3000;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await api<{ answer?: Answer }>("/api/answer", {
            pid: me.participantId,
            token: me.token,
            q: cur.index,
            choice,
          });
          if ((res.ok || res.code === "already_answered") && res.data.answer) {
            // already_answered（リロード前に送信済み）の場合はサーバー側の回答が返る
            mine.put(res.data.answer);
            setPending(null);
          } else {
            setPending({ choice, state: "error", message: res.message ?? "回答を送信できませんでした" });
          }
          break;
        } catch {
          // 通信エラー：締め切りまでリトライ（同じ回答の再送はサーバーで重複扱いになるだけ）
          if (serverNow() > giveUpAt) {
            setPending({ choice, state: "error", message: "通信できず、回答を送信できませんでした" });
            break;
          }
          await new Promise((r) => setTimeout(r, Math.min(300 * (attempt + 1), 1000)));
        }
      }
      sendingRef.current = false;
    },
    [chosen, cur.deadlineAt, cur.index, game.settings.graceMs, me.participantId, me.token, mine],
  );

  if (before) {
    return (
      <div className="card center stack grow" style={{ justifyContent: "center" }}>
        <p className="qnum">第{cur.number}問</p>
        <div className="countin pop" key={Math.ceil((cur.startedAt - now) / 1000)}>
          {Math.ceil((cur.startedAt - now) / 1000)}
        </div>
        <p className="lead">{spectator ? "観戦中" : "準備はいいですか？"}</p>
      </div>
    );
  }

  let footer: React.ReactNode;
  if (myAnswer.data) {
    footer = myAnswer.data.spectator ? "参考回答しました（判定には影響しません）" : "回答しました！ 結果発表をお待ちください";
  } else if (pending?.state === "sending") footer = "送信中…";
  else if (pending?.state === "error") footer = <span className="error">{pending.message}</span>;
  else if (!open) footer = spectator ? "回答締め切り" : "回答締め切り — 時間内に回答がありませんでした";
  else if (!canAnswer) footer = "観戦中のため回答できません";
  else if (spectator) footer = "観戦中：参考回答できます（判定には影響しません）";
  else footer = "タップで回答（変更はできません）";

  return (
    <>
      <section className="card stack" style={{ gap: 8 }}>
        <div className="row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="qnum">
            第{cur.number}問{game.questionCount ? ` / 全${game.questionCount}問` : ""}
          </span>
          {spectator && <span className="badge out">観戦中</span>}
        </div>
        <p className="qtext">{cur.text}</p>
        {game.status === "question" ? <Timer cur={cur} now={now} /> : <p className="small">回答を締め切りました</p>}
      </section>
      <div className="choices">
        {(["A", "B"] as const).map((c) => (
          <button
            key={c}
            className={`choice ${c.toLowerCase()} ${chosen === c ? "picked" : ""}`}
            disabled={!open || !canAnswer || (chosen !== null && chosen !== c) || pending?.state === "error"}
            onClick={() => submit(c)}
            aria-pressed={chosen === c}
          >
            <span className="key">{c}</span>
            <span>{c === "A" ? cur.choiceA : cur.choiceB}</span>
          </button>
        ))}
      </div>
      <p className="center lead" style={{ minHeight: 24, fontWeight: 700 }}>
        {footer}
      </p>
    </>
  );
}

function RevealView({ game, p, me }: { game: GameState; p: Participant; me: Identity }) {
  const r = game.reveal!;
  const cur = game.current!;
  const myAnswer = { data: useMyAnswers(game.gameId).get(r.index) };
  const last = p.last?.index === r.index ? p.last : null;
  const myChoice = last?.choice ?? myAnswer.data?.choice ?? null;

  let head: React.ReactNode;
  if (last) {
    // この問題の判定対象だった
    if (r.allRevived) {
      head = (
        <>
          <div className="result-big revive pop">全員復活！</div>
          <p className="lead">全員が不正解だったため、この問題の脱落はなしになりました</p>
        </>
      );
    } else if (last.result === "correct") {
      head = <div className="result-big ok pop">正解！<br />生き残り</div>;
    } else {
      head = (
        <>
          <div className="result-big ng pop">{last.result === "noanswer" ? "時間切れ…" : "不正解…"}</div>
          <p className="lead">ここで脱落です。この後は観戦モードでお楽しみください</p>
        </>
      );
    }
  } else if (p.status === "out") {
    const ok = myAnswer.data ? myAnswer.data.choice === r.correct : null;
    head = (
      <>
        <div className="title-l">観戦中</div>
        {ok !== null && <p className="lead">参考回答は{ok ? "正解でした！" : "不正解でした"}</p>}
      </>
    );
  } else {
    head = <div className="title-l">正解発表</div>;
  }

  return (
    <>
      <section className="card center stack">{head}</section>
      <section className="card stack" style={{ gap: 10 }}>
        <span className="qnum">第{r.number}問</span>
        <p className="qtext" style={{ fontSize: 18 }}>{cur.text}</p>
        {(["A", "B"] as const).map((c) => (
          <div
            key={c}
            className={`choice ${c.toLowerCase()} ${myChoice === c ? "picked" : ""} ${r.correct === c ? "correct-mark" : ""}`}
            style={{ minHeight: 72, fontSize: 18, opacity: r.correct === c ? 1 : 0.4 }}
          >
            <span className="key" style={{ width: 44, height: 44, fontSize: 24 }}>{c}</span>
            <span style={{ flex: 1 }}>{c === "A" ? cur.choiceA : cur.choiceB}</span>
            <span className="num">{c === "A" ? r.countA : r.countB}人</span>
          </div>
        ))}
      </section>
      <div className="pill-row">
        <span className="pill">生存者 {r.survivors}人</span>
        {r.eliminated > 0 && <span className="pill">脱落 {r.eliminated}人</span>}
      </div>
    </>
  );
}

function FinishedView({ game, p }: { game: GameState; p: Participant }) {
  const winner = game.ranking?.[0];
  const isWinner = p.rank === 1;
  return (
    <div className="card center stack grow" style={{ justifyContent: "center" }}>
      <span className="hero-label">GAME OVER</span>
      {isWinner ? (
        <>
          <div className="result-big ok pop">🏆 優勝！</div>
          <p className="lead">おめでとうございます！</p>
        </>
      ) : (
        <>
          <h1 className="title-l">ゲーム終了</h1>
          {winner && (
            <p className="lead">
              優勝は <b>{winner.nickname}</b> さん！
            </p>
          )}
        </>
      )}
      <div className="pill-row">
        {p.rank != null && <span className="pill">あなたの順位 {p.rank}位</span>}
        <span className="pill">正解数 {p.correctCount}問</span>
        {p.status === "alive" ? (
          <span className="pill">最後まで生存！</span>
        ) : (
          <span className="pill">第{p.eliminatedAt}問で脱落</span>
        )}
      </div>
      {p.status === "alive" && game.finalistCount > 1 && (
        <p className="small">
          生存者が複数のため、累計回答時間（{(p.totalAnswerMs / 1000).toFixed(2)}秒）の短い順で順位を決めました
        </p>
      )}
    </div>
  );
}
