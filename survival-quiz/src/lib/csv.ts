import type { Choice, QuestionInput } from "./types";

/** RFC4180 準拠の簡易 CSV パーサー（ダブルクォート・改行入りセル対応） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function normalizeChoice(v: string): Choice | null {
  const t = v.trim().normalize("NFKC").toUpperCase();
  if (t === "A" || t === "1") return "A";
  if (t === "B" || t === "2") return "B";
  return null;
}

export interface CsvImportResult {
  questions: QuestionInput[];
  errors: string[];
}

/** 「問題文,選択肢A,選択肢B,正解」の CSV を問題リストに変換する（1 行目が見出しなら読み飛ばす） */
export function questionsFromCsv(text: string): CsvImportResult {
  const rows = parseCsv(text);
  const questions: QuestionInput[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const line = i + 1;
    if (i === 0 && normalizeChoice(r[3] ?? "") === null && /問題|question/i.test(r[0] ?? "")) return;
    const [text, a, b, c] = r.map((x) => (x ?? "").trim());
    const correct = normalizeChoice(c ?? "");
    if (!text || !a || !b) errors.push(`${line}行目: 問題文・選択肢A・選択肢B のいずれかが空です`);
    else if (!correct) errors.push(`${line}行目: 正解は A か B で指定してください（"${c ?? ""}"）`);
    else questions.push({ text, choiceA: a, choiceB: b, correct });
  });
  return { questions, errors };
}

const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function questionsToCsv(qs: QuestionInput[]): string {
  const lines = [["問題文", "選択肢A", "選択肢B", "正解"].join(",")];
  for (const q of qs) lines.push([q.text, q.choiceA, q.choiceB, q.correct].map(esc).join(","));
  return lines.join("\r\n") + "\r\n";
}
