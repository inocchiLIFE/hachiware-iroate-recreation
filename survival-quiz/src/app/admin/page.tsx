"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Timer } from "@/components/Timer";
import { questionsFromCsv, questionsToCsv } from "@/lib/csv";
import { api, useAnsweredCount, useGame, useNow, useParticipants, useServerClock } from "@/lib/client/hooks";
import {
  STATUS_LABEL,
  effectiveDeadline,
  type Choice,
  type GameSettings,
  type GameState,
  type Participant,
  type Question,
  type QuestionInput,
} from "@/lib/types";

type Msg = { kind: "err" | "info"; text: string } | null;

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ admin: boolean }>("/api/admin/session")
      .then((r) => setAuthed(Boolean(r.data.admin)))
      .catch(() => setAuthed(false));
  }, []);
  if (authed === null) return <main className="admin">読み込み中…</main>;
  if (!authed) return <Login onOk={() => setAuthed(true)} />;
  return <Dashboard onLogout={() => setAuthed(false)} />;
}

function Login({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="admin" style={{ maxWidth: 420, paddingTop: 80 }}>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await api("/api/admin/login", { password: pw });
          setBusy(false);
          if (r.ok) {
            await api("/api/admin/session");
            onOk();
          } else setErr(r.message ?? "ログインできませんでした");
        }}
      >
        <h2>管理画面ログイン</h2>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="パスワード"
          autoFocus
          autoComplete="current-password"
        />
        {err && <p className="error">{err}</p>}
        <button className="btn" disabled={busy || !pw}>
          ログイン
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------
function Dashboard({ onLogout }: { onLogout: () => void }) {
  useServerClock();
  const game = useGame();
  const [tab, setTab] = useState<"questions" | "participants" | "settings">("participants");
  const [msg, setMsg] = useState<Msg>(null);
  const [questions, setQuestions] = useState<Question[] | null>(null);

  const loadQuestions = useCallback(async () => {
    const r = await api<{ questions: Question[] }>("/api/admin/questions");
    if (r.status === 401) onLogout();
    else if (r.ok) setQuestions(r.data.questions);
    else setMsg({ kind: "err", text: r.message ?? "問題の読み込みに失敗しました" });
  }, [onLogout]);
  useEffect(() => {
    loadQuestions();
  }, [loadQuestions]);

  const act = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      const r = await api<{ result: unknown }>("/api/admin/action", { action, ...extra });
      if (r.status === 401) onLogout();
      if (!r.ok) setMsg({ kind: "err", text: r.message ?? `操作に失敗しました（${action}）` });
      else setMsg(null);
      return r;
    },
    [onLogout],
  );

  const g = game.data;
  return (
    <main className="admin">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>2択サバイバルクイズ 管理</h1>
        <div className="row">
          <a href="/screen" target="_blank" rel="noreferrer">スクリーンを開く ↗</a>
          <a href="/" target="_blank" rel="noreferrer">参加者画面 ↗</a>
        </div>
      </div>
      {game.fromCache && <div className="msg err">Firestore と再接続中…（表示が古い可能性があります）</div>}
      {msg && (
        <div className={`msg ${msg.kind}`} onClick={() => setMsg(null)} role="alert">
          {msg.text}
        </div>
      )}
      {!g ? (
        <div className="card">ゲーム状態を読み込み中…</div>
      ) : (
        <>
          <Control g={g} questions={questions} act={act} />
          <div className="tabs">
            {(
              [
                ["participants", "参加者"],
                ["questions", `問題（${questions?.length ?? "…"}）`],
                ["settings", "設定・リセット"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          {tab === "participants" && <Participants g={g} act={act} />}
          {tab === "questions" && (
            <QuestionsEditor
              g={g}
              questions={questions}
              onSaved={setQuestions}
              setMsg={setMsg}
              onUnauthorized={onLogout}
            />
          )}
          {tab === "settings" && <Settings g={g} act={act} setMsg={setMsg} onLogout={onLogout} />}
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// 進行
// ---------------------------------------------------------------------------
type Act = (action: string, extra?: Record<string, unknown>) => Promise<{ ok: boolean }>;

function Control({ g, questions, act }: { g: GameState; questions: Question[] | null; act: Act }) {
  const cur = g.current;
  const now = useNow(g.status === "question", 200);
  const answered = useAnsweredCount(cur?.index ?? null, g.status === "question");
  const [busy, setBusy] = useState<string | null>(null);
  const autoClosed = useRef<number | null>(null);

  const run = useCallback(
    async (action: string, confirmText?: string) => {
      if (confirmText && !window.confirm(confirmText)) return;
      setBusy(action);
      await act(action);
      setBusy(null);
    },
    [act],
  );

  // 制限時間（＋猶予）を過ぎたら自動で「回答締め切り」
  useEffect(() => {
    if (g.status !== "question" || !cur) return;
    if (now > effectiveDeadline(cur, g.settings) + 100 && autoClosed.current !== cur.index) {
      autoClosed.current = cur.index;
      act("close");
    }
  }, [g.status, cur, now, g.settings, act]);

  const hasNext = questions ? g.nextQuestionIndex < questions.length : true;
  const nextQ = questions?.[g.nextQuestionIndex];
  const curQ = cur ? questions?.[cur.index] : undefined;
  const lastStanding = g.status === "revealed" && g.reveal && g.reveal.survivors <= 1;

  // 次に押すべきボタン
  const suggested =
    g.status === "lobby"
      ? g.entryOpen
        ? "closeEntry"
        : "start"
      : g.status === "question"
        ? "close"
        : g.status === "closed"
          ? "reveal"
          : g.status === "revealed"
            ? lastStanding || !hasNext
              ? "finish"
              : "next"
            : g.status === "waiting"
              ? hasNext
                ? "start"
                : "finish"
              : null;

  const buttons: Array<{ action: string; label: string; sub: string; enabled: boolean; confirm?: string; cls?: string }> = [
    {
      action: g.entryOpen ? "closeEntry" : "openEntry",
      label: g.entryOpen ? "参加受付の締め切り" : "参加受付を再開",
      sub: "lobby のみ",
      enabled: g.status === "lobby",
    },
    {
      action: "start",
      label: `出題（第${(cur?.number ?? 0) + 1}問）`,
      sub: hasNext ? "1.5秒後に全端末で同時表示" : "問題が残っていません",
      enabled: (g.status === "lobby" || g.status === "waiting") && hasNext,
      confirm: g.status === "lobby" ? "出題を開始します。以降は新規参加できません。よろしいですか？" : undefined,
      cls: "primary",
    },
    { action: "close", label: "回答締め切り", sub: "時間切れで自動実行", enabled: g.status === "question" },
    { action: "reveal", label: "正解発表", sub: "脱落判定を実行", enabled: g.status === "closed", cls: "primary" },
    { action: "next", label: "次の問題へ", sub: "出題待ちにする", enabled: g.status === "revealed" },
    {
      action: "finish",
      label: "終了・勝者発表",
      sub: "順位を確定",
      enabled: g.status === "revealed" || g.status === "waiting",
      confirm: "ゲームを終了して勝者を発表します。よろしいですか？",
    },
  ];

  return (
    <section className="card">
      <div className="grid2">
        <div className="stack">
          <div className="row">
            <span className="status-chip">{STATUS_LABEL[g.status]}</span>
            {g.status === "lobby" && <b>{g.entryOpen ? "参加受付中" : "受付締切済み"}</b>}
            <span>
              生存 <b className="num">{g.aliveCount}</b>人
            </span>
            <span className="small">
              問題 {Math.min(g.nextQuestionIndex, g.questionCount)}/{g.questionCount} 出題済み
            </span>
          </div>
          <div className="flow">
            {buttons.map((b) => (
              <button
                key={b.action}
                className={`btn ${b.cls ?? ""} ${suggested === b.action ? "next" : ""}`}
                disabled={!b.enabled || busy !== null}
                onClick={() => run(b.action, b.confirm)}
              >
                {busy === b.action ? "処理中…" : b.label}
                <small>{b.sub}</small>
              </button>
            ))}
          </div>
          {lastStanding && <div className="msg info">生存者が{g.reveal!.survivors}人になりました。「終了・勝者発表」を押してください。</div>}
          {g.status === "revealed" && !hasNext && !lastStanding && (
            <div className="msg info">問題がすべて終わりました。「終了・勝者発表」で累計回答時間の短い順に順位を付けます。</div>
          )}
        </div>
        <div className="stack">
          {cur && g.status !== "lobby" && g.status !== "waiting" && g.status !== "finished" && (
            <div className="preview stack" style={{ gap: 6 }}>
              <div className="small">第{cur.number}問（出題中／直前の問題）</div>
              <b>{cur.text}</b>
              <div>
                A: {cur.choiceA} ／ B: {cur.choiceB}
                {curQ && (
                  <>
                    {" "}— 正解 <b>{curQ.correct}</b>
                  </>
                )}
              </div>
              {g.status === "question" && <Timer cur={cur} now={now} />}
              {(g.status === "question" || g.status === "closed") && (
                <div>
                  回答済み <b className="num">{answered ?? "–"}</b> / {g.aliveCount}人
                  <div className="answer-bar">
                    <i style={{ width: `${g.aliveCount ? ((answered ?? 0) / g.aliveCount) * 100 : 0}%` }} />
                  </div>
                </div>
              )}
              {g.status === "revealed" && g.reveal && (
                <div>
                  A {g.reveal.countA}人 ／ B {g.reveal.countB}人 ／ 未回答 {g.reveal.noAnswer}人 → 生存{" "}
                  <b>{g.reveal.survivors}</b>人・脱落 {g.reveal.eliminated}人
                  {g.reveal.allRevived && <b>（全員不正解のため全員復活）</b>}
                </div>
              )}
            </div>
          )}
          {g.status !== "finished" && (
            <div className="preview stack" style={{ gap: 4, borderColor: "#94a3b8", background: "#f8fafc" }}>
              <div className="small">次の問題（第{(cur?.number ?? 0) + 1}問）</div>
              {nextQ ? (
                <>
                  <b>{nextQ.text}</b>
                  <div>
                    A: {nextQ.choiceA} ／ B: {nextQ.choiceB} — 正解 <b>{nextQ.correct}</b>
                  </div>
                </>
              ) : (
                <div>問題が残っていません</div>
              )}
            </div>
          )}
          {g.status === "finished" && g.ranking && (
            <div className="preview">
              <b>最終順位</b>
              <ol style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {g.ranking.slice(0, 10).map((e) => (
                  <li key={e.id} value={e.rank}>
                    {e.nickname}（{e.alive ? `生存・累計${(e.totalAnswerMs / 1000).toFixed(2)}秒` : "脱落"}・正解{e.correctCount}）
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 参加者一覧
// ---------------------------------------------------------------------------
function Participants({ g, act }: { g: GameState; act: Act }) {
  // このタブを開いている間だけ購読（読み取り回数の節約）
  const { docs, loaded } = useParticipants(true);
  const [filter, setFilter] = useState<"all" | "alive" | "out">("all");
  const [search, setSearch] = useState("");
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return docs
      .filter((p) => filter === "all" || p.status === filter)
      .filter((p) => !s || p.nickname.toLowerCase().includes(s))
      .sort((a, b) =>
        g.status === "finished" && a.rank != null && b.rank != null ? a.rank - b.rank : a.joinedAt - b.joinedAt,
      );
  }, [docs, filter, search, g.status]);
  const alive = docs.filter((p) => p.status === "alive").length;

  const op = async (p: Participant, action: "revive" | "eliminate" | "kick") => {
    const text = {
      revive: `${p.nickname} さんを復活させますか？`,
      eliminate: `${p.nickname} さんを脱落させますか？`,
      kick: `${p.nickname} さんを退場（削除）させますか？ この端末は再参加できるようになります。`,
    }[action];
    if (window.confirm(text)) await act(action, { participantId: p.id });
  };

  return (
    <section className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>
          参加者 {docs.length}人（生存 {alive} ／ 脱落 {docs.length - alive}）
        </h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">すべて</option>
          <option value="alive">生存のみ</option>
          <option value="out">脱落のみ</option>
        </select>
        <input className="plain" type="text" placeholder="名前で検索" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!loaded ? (
        <p>読み込み中…</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>ニックネーム</th>
                <th>状態</th>
                <th>正解</th>
                <th>累計回答時間</th>
                <th>直前の回答</th>
                {g.status === "finished" && <th>順位</th>}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, i) => (
                <tr key={p.id}>
                  <td className="num">{i + 1}</td>
                  <td>{p.nickname}</td>
                  <td>
                    {p.status === "alive" ? (
                      <span className="badge alive">生存</span>
                    ) : (
                      <span className="badge out">第{p.eliminatedAt}問で脱落</span>
                    )}
                  </td>
                  <td className="num">{p.correctCount}</td>
                  <td className="num">{(p.totalAnswerMs / 1000).toFixed(2)}秒</td>
                  <td>{p.last ? `${p.last.choice ?? "未回答"}（${{ correct: "正解", wrong: "不正解", noanswer: "時間切れ" }[p.last.result]}）` : "—"}</td>
                  {g.status === "finished" && <td className="num">{p.rank}</td>}
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {p.status === "out" ? (
                        <button className="btn small primary" onClick={() => op(p, "revive")}>
                          復活
                        </button>
                      ) : (
                        <button className="btn small ghost" onClick={() => op(p, "eliminate")}>
                          脱落させる
                        </button>
                      )}
                      <button className="btn small ghost" onClick={() => op(p, "kick")}>
                        退場
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={8} className="small">
                    該当する参加者はいません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 問題の登録・編集・CSV インポート
// ---------------------------------------------------------------------------
function QuestionsEditor({
  g,
  questions,
  onSaved,
  setMsg,
  onUnauthorized,
}: {
  g: GameState;
  questions: Question[] | null;
  onSaved: (q: Question[]) => void;
  setMsg: (m: Msg) => void;
  onUnauthorized: () => void;
}) {
  const [rows, setRows] = useState<QuestionInput[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [csvMode, setCsvMode] = useState<"append" | "replace">("append");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (questions && !dirty) setRows(questions.map(({ text, choiceA, choiceB, correct }) => ({ text, choiceA, choiceB, correct })));
  }, [questions, dirty]);

  const update = (i: number, patch: Partial<QuestionInput>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const move = (i: number, d: -1 | 1) => {
    setRows((rs) => {
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i));
    setDirty(true);
  };
  const add = () => {
    setRows((rs) => [...rs, { text: "", choiceA: "", choiceB: "", correct: "A" }]);
    setDirty(true);
  };

  const save = async () => {
    if (g.status !== "lobby" && !window.confirm("ゲーム進行中です。出題済みの問題の順番を変えると進行がずれます。保存しますか？")) return;
    setSaving(true);
    const r = await api<{ questions: Question[] }>("/api/admin/questions", { questions: rows }, "PUT");
    setSaving(false);
    if (r.status === 401) return onUnauthorized();
    if (!r.ok) return setMsg({ kind: "err", text: r.message ?? "保存に失敗しました" });
    setDirty(false);
    onSaved(r.data.questions);
    setMsg({ kind: "info", text: `${r.data.questions.length}問を保存しました` });
  };

  const importCsv = async (file: File) => {
    const text = await file.text();
    const { questions: imported, errors } = questionsFromCsv(text);
    if (errors.length) {
      setMsg({ kind: "err", text: `CSV の読み込みでエラー: ${errors.slice(0, 5).join(" / ")}${errors.length > 5 ? " …" : ""}` });
      if (imported.length === 0) return;
    }
    setRows((rs) => (csvMode === "replace" ? imported : [...rs, ...imported]));
    setDirty(true);
    if (!errors.length) setMsg({ kind: "info", text: `${imported.length}問を読み込みました。「保存」を押すと反映されます` });
  };

  const download = (name: string, text: string) => {
    const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!questions) return <section className="card">読み込み中…</section>;

  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>問題 {rows.length}問 {dirty && <span style={{ color: "var(--warn)" }}>（未保存の変更あり）</span>}</h2>
        <div className="row">
          <button className="btn primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "保存中…" : "保存"}
          </button>
          {dirty && (
            <button className="btn ghost" onClick={() => setDirty(false)}>
              変更を破棄
            </button>
          )}
        </div>
      </div>
      <div className="row preview" style={{ borderColor: "#94a3b8", background: "#f8fafc" }}>
        <b>CSV インポート</b>
        <select value={csvMode} onChange={(e) => setCsvMode(e.target.value as typeof csvMode)}>
          <option value="append">末尾に追加</option>
          <option value="replace">すべて置き換え</option>
        </select>
        <button className="btn small ghost" onClick={() => fileRef.current?.click()}>
          CSV ファイルを選ぶ
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importCsv(f);
            e.target.value = "";
          }}
        />
        <button
          className="btn small ghost"
          onClick={() => download("questions-template.csv", questionsToCsv([{ text: "日本で一番高い山は？", choiceA: "富士山", choiceB: "北岳", correct: "A" }]))}
        >
          テンプレートをダウンロード
        </button>
        <button className="btn small ghost" onClick={() => download("questions.csv", questionsToCsv(rows))} disabled={rows.length === 0}>
          現在の問題を書き出し
        </button>
        <span className="small">形式：問題文,選択肢A,選択肢B,正解(A/B)　※1行目の見出しは自動で読み飛ばします（UTF-8 / Excel の「CSV UTF-8」）</span>
      </div>
      <div className="scroll qedit">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>問題文</th>
              <th style={{ width: "18%" }}>選択肢A</th>
              <th style={{ width: "18%" }}>選択肢B</th>
              <th style={{ width: 70 }}>正解</th>
              <th style={{ width: 130 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((q, i) => (
              <tr key={i} style={i < g.nextQuestionIndex && g.status !== "lobby" ? { background: "#f1f5f9" } : undefined}>
                <td className="num">{i + 1}</td>
                <td>
                  <textarea value={q.text} onChange={(e) => update(i, { text: e.target.value })} rows={2} />
                </td>
                <td>
                  <input value={q.choiceA} onChange={(e) => update(i, { choiceA: e.target.value })} />
                </td>
                <td>
                  <input value={q.choiceB} onChange={(e) => update(i, { choiceB: e.target.value })} />
                </td>
                <td>
                  <select value={q.correct} onChange={(e) => update(i, { correct: e.target.value as Choice })}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                  </select>
                </td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    <button className="btn small ghost" onClick={() => move(i, -1)} aria-label="上へ">↑</button>
                    <button className="btn small ghost" onClick={() => move(i, 1)} aria-label="下へ">↓</button>
                    <button className="btn small ghost" onClick={() => remove(i)}>削除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button className="btn ghost" onClick={add}>
          ＋ 問題を追加
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 設定・リセット
// ---------------------------------------------------------------------------
function Settings({
  g,
  act,
  setMsg,
  onLogout,
}: {
  g: GameState;
  act: Act;
  setMsg: (m: Msg) => void;
  onLogout: () => void;
}) {
  const [s, setS] = useState<GameSettings>(g.settings);
  const settingsKey = JSON.stringify(g.settings);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setS(g.settings), [settingsKey]);
  const changed = JSON.stringify(s) !== JSON.stringify(g.settings);

  return (
    <section className="card stack">
      <h2>ルール設定</h2>
      <div className="row">
        <label>
          制限時間（秒）{" "}
          <input type="number" min={3} max={120} value={s.timeLimitSec} onChange={(e) => setS({ ...s, timeLimitSec: Number(e.target.value) })} style={{ width: 90 }} />
        </label>
        <label>
          通信遅延の猶予（ms）{" "}
          <input type="number" min={0} max={3000} step={100} value={s.graceMs} onChange={(e) => setS({ ...s, graceMs: Number(e.target.value) })} style={{ width: 100 }} />
        </label>
        <label>
          <input type="checkbox" checked={s.spectatorAnswer} onChange={(e) => setS({ ...s, spectatorAnswer: e.target.checked })} /> 脱落者も参考回答できる（判定には影響なし）
        </label>
        <button
          className="btn primary"
          disabled={!changed}
          onClick={async () => {
            const r = await act("settings", { settings: s });
            if (r.ok) setMsg({ kind: "info", text: "設定を保存しました（次の出題から反映）" });
          }}
        >
          設定を保存
        </button>
      </div>
      <p className="small">
        猶予：締め切り時刻の直前に押された回答が通信に時間がかかって届くケースを救済するため、締め切り＋猶予までにサーバーに届いた回答を有効にします（画面上のカウントダウンは猶予なしで 0 になります）。厳密にしたい場合は 0 にしてください。
      </p>

      <h2 style={{ marginTop: 16 }}>ゲーム全体のリセット</h2>
      <p className="small">参加者・回答をすべて削除して、参加受付の状態に戻します（問題と設定は残ります）。参加者の端末は自動的に参加登録画面に戻ります。</p>
      <div>
        <button
          className="btn danger"
          onClick={async () => {
            const v = window.prompt("リセットするには「リセット」と入力してください");
            if (v !== "リセット") return;
            const r = await act("reset");
            if (r.ok) setMsg({ kind: "info", text: "リセットしました" });
          }}
        >
          ゲームをリセット
        </button>
      </div>

      <h2 style={{ marginTop: 16 }}>ログアウト</h2>
      <div>
        <button
          className="btn ghost"
          onClick={async () => {
            await api("/api/admin/logout", {});
            onLogout();
          }}
        >
          ログアウト
        </button>
      </div>
    </section>
  );
}
