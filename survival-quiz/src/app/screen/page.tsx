"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Timer } from "@/components/Timer";
import { useAnsweredCount, useGame, useNow, useParticipants, useServerClock } from "@/lib/client/hooks";
import type { GameState } from "@/lib/types";

export default function ScreenPage() {
  useServerClock();
  const game = useGame();
  const g = game.data;

  return (
    <main className="screen">
      <div className="top">
        <span className="logo">2択サバイバルクイズ</span>
        {g && g.status !== "lobby" && g.status !== "finished" && <span className="num">生存者 {g.aliveCount}人</span>}
      </div>
      <div className="body">{!g ? <p className="center muted">接続中…</p> : <Phase g={g} />}</div>
    </main>
  );
}

function Phase({ g }: { g: GameState }) {
  switch (g.status) {
    case "lobby":
      return <Lobby g={g} />;
    case "question":
    case "closed":
      return <QuestionPhase key={g.current?.index} g={g} />;
    case "revealed":
      return <RevealPhase g={g} />;
    case "waiting":
      return (
        <div className="center">
          <p className="qnum">第{(g.current?.number ?? 0) + 1}問</p>
          <h1>まもなく出題</h1>
          <p className="stats" style={{ marginTop: "4vh" }}>
            <span>生存者<b>{g.aliveCount}</b>人</span>
          </p>
        </div>
      );
    case "finished":
      return <Finished g={g} />;
  }
}

function Lobby({ g }: { g: GameState }) {
  const participants = useParticipants(true);
  const [qr, setQr] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    const joinUrl = process.env.NEXT_PUBLIC_JOIN_URL || `${window.location.origin}/`;
    setUrl(joinUrl);
    QRCode.toDataURL(joinUrl, { width: 720, margin: 1, errorCorrectionLevel: "M" }).then(setQr);
  }, []);
  const count = participants.docs.length;
  return (
    <div className="lobby">
      <div style={{ display: "flex", flexDirection: "column", gap: "3vh" }}>
        <h1 style={{ fontSize: "6.4vh" }}>
          スマホで QR コードを
          <br />
          読み取って参加しよう！
        </h1>
        <p className="url">{url.replace(/^https?:\/\//, "")}</p>
        <div>
          <div className="muted" style={{ fontSize: "3.4vh", fontWeight: 800 }}>
            {g.entryOpen ? "参加者" : "参加受付は終了しました ／ 参加者"}
          </div>
          <div className="bigcount">
            {count}
            <small>人</small>
          </div>
        </div>
      </div>
      <div className="qr">{qr && <img src={qr} alt="参加用QRコード" />}</div>
    </div>
  );
}

function QuestionPhase({ g }: { g: GameState }) {
  const cur = g.current!;
  const now = useNow(g.status === "question", 100);
  const answered = useAnsweredCount(cur.index, g.status === "question");
  const before = g.status === "question" && now < cur.startedAt;

  if (before) {
    return (
      <div className="center">
        <p className="qnum">第{cur.number}問</p>
        <div className="bigcount pop" key={Math.ceil((cur.startedAt - now) / 1000)} style={{ fontSize: "30vh" }}>
          {Math.ceil((cur.startedAt - now) / 1000)}
        </div>
      </div>
    );
  }
  return (
    <>
      <p className="qnum">
        第{cur.number}問{g.questionCount ? ` / 全${g.questionCount}問` : ""}
      </p>
      <p className="q">{cur.text}</p>
      <div className="sc-choices">
        <div className="sc-choice a">
          <span className="k">A</span>
          {cur.choiceA}
        </div>
        <div className="sc-choice b">
          <span className="k">B</span>
          {cur.choiceB}
        </div>
      </div>
      {g.status === "question" ? (
        <Timer cur={cur} now={now} className="sc-timer" />
      ) : (
        <p className="banner">回答締め切り！</p>
      )}
      <p className="stats">
        <span>
          回答済み<b>{answered ?? "–"}</b>/ {g.aliveCount}人
        </span>
      </p>
    </>
  );
}

function RevealPhase({ g }: { g: GameState }) {
  const r = g.reveal!;
  const cur = g.current!;
  return (
    <>
      <p className="qnum">第{r.number}問 正解発表</p>
      <p className="q" style={{ fontSize: "4.4vh" }}>{cur.text}</p>
      <div className="sc-choices">
        {(["A", "B"] as const).map((c) => (
          <div key={c} className={`sc-choice ${c.toLowerCase()} ${r.correct === c ? "win" : "dim"}`}>
            {r.correct === c && <span className="tag">正解</span>}
            <span className="k">{c}</span>
            {c === "A" ? cur.choiceA : cur.choiceB}
            <span className="count">{c === "A" ? r.countA : r.countB}人</span>
          </div>
        ))}
      </div>
      {r.allRevived && <p className="banner">全員不正解のため、全員復活！</p>}
      <p className="stats">
        <span>生存者<b>{r.survivors}</b>人</span>
        <span>脱落<b>{r.eliminated}</b>人</span>
        {r.noAnswer > 0 && <span>未回答<b>{r.noAnswer}</b>人</span>}
      </p>
    </>
  );
}

function Finished({ g }: { g: GameState }) {
  const ranking = g.ranking ?? [];
  const winner = ranking[0];
  const others = ranking.slice(1, 10);
  return (
    <div className="winner">
      <div className="crown pop">🏆</div>
      <p className="muted" style={{ fontSize: "4vh", fontWeight: 800, margin: 0 }}>優勝</p>
      <div className="name pop">{winner ? `${winner.nickname} さん` : "該当者なし"}</div>
      {g.finalistCount > 1 && winner && (
        <p className="muted" style={{ fontSize: "3vh" }}>
          生存者 {g.finalistCount}人 ／ 累計回答時間の短い順（{(winner.totalAnswerMs / 1000).toFixed(2)}秒）
        </p>
      )}
      {others.length > 0 && (
        <div className="ranks" style={{ marginTop: "4vh" }}>
          {others.map((e) => (
            <span key={e.id}>
              {e.rank}位 {e.nickname}
              {e.alive ? `（${(e.totalAnswerMs / 1000).toFixed(2)}秒）` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
