"use client";
/**
 * スクリーン用の効果音（Web Audio API でその場で合成するオリジナル音源。音声ファイル不要）
 *
 * ブラウザは「ユーザーが一度クリックするまで音を出さない」決まりがあるため、
 * スクリーン画面の「音を出す」ボタンで unlock() を呼んでから使う。
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = 0.8;

export function unlock(): boolean {
  if (typeof window === "undefined") return false;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    // 音割れ防止
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return true;
}

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
  if (master && ctx) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
}

export const isReady = () => ctx != null && ctx.state === "running";

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------
const NOTE: Record<string, number> = {};
["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].forEach((n, i) => {
  for (let o = 1; o <= 7; o++) NOTE[`${n}${o}`] = 440 * Math.pow(2, (i - 9 + (o - 4) * 12) / 12);
});

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  release?: number;
  detune?: number;
  filter?: number;
}

function tone(freq: number, start: number, dur: number, o: ToneOpts = {}) {
  if (!ctx || !master) return;
  const { type = "triangle", gain = 0.3, attack = 0.005, release = 0.08, detune = 0, filter } = o;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.detune.value = detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + attack);
  g.gain.setValueAtTime(gain, start + Math.max(attack, dur - release));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  let node: AudioNode = osc;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = filter;
    osc.connect(f);
    node = f;
  }
  node.connect(g).connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

/** ブラス風（のこぎり波を2本ずらして重ね、ローパスで丸める） */
function brass(freq: number, start: number, dur: number, gain = 0.16) {
  tone(freq, start, dur, { type: "sawtooth", gain, attack: 0.03, release: 0.12, detune: -6, filter: 2600 });
  tone(freq, start, dur, { type: "sawtooth", gain, attack: 0.03, release: 0.12, detune: 6, filter: 2600 });
}

function noise(start: number, dur: number, gain = 0.2, hp = 1000) {
  if (!ctx || !master) return;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(g).connect(master);
  src.start(start);
}

const now = () => (ctx ? ctx.currentTime + 0.01 : 0);

// ---------------------------------------------------------------------------
// 効果音
// ---------------------------------------------------------------------------

/** 出題：駆け上がるジングル */
export function sfxQuestion() {
  if (!isReady()) return;
  const t = now();
  const run = ["G4", "C5", "E5", "G5", "C6"];
  run.forEach((n, i) => tone(NOTE[n], t + i * 0.07, 0.12, { type: "square", gain: 0.09, filter: 3500 }));
  const hit = t + run.length * 0.07 + 0.02;
  ["C5", "E5", "G5", "C6"].forEach((n) => brass(NOTE[n], hit, 0.55, 0.07));
  noise(hit, 0.35, 0.12, 5000);
}

/**
 * 考え中の 1 秒ごとの音（チクタク＋低音の鼓動）。
 * remain：残り秒数。残り 3 秒からは高く・強くなる。
 */
export function sfxThinking(remain: number) {
  if (!isReady()) return;
  const t = now();
  const urgent = remain <= 3;
  // 時計のチク・タク
  tone(urgent ? 2200 : 1500, t, 0.03, { type: "square", gain: urgent ? 0.12 : 0.06 });
  tone(urgent ? 1800 : 1100, t + 0.5, 0.03, { type: "square", gain: urgent ? 0.1 : 0.04 });
  // 低音の鼓動（ドクン・ドクン）
  const bass = remain % 2 === 0 ? NOTE.A2 : NOTE.E2;
  tone(bass, t, 0.22, { type: "sine", gain: urgent ? 0.5 : 0.35, release: 0.15 });
  tone(bass * 2, t, 0.12, { type: "triangle", gain: 0.08 });
  if (urgent) tone(bass, t + 0.5, 0.18, { type: "sine", gain: 0.35, release: 0.12 });
}

/** 時間切れ：ブザー */
export function sfxTimeUp() {
  if (!isReady()) return;
  const t = now();
  tone(NOTE.C3, t, 0.7, { type: "sawtooth", gain: 0.16, filter: 1200, detune: -10 });
  tone(NOTE.C3 * 1.012, t, 0.7, { type: "sawtooth", gain: 0.16, filter: 1200, detune: 10 });
  tone(NOTE.C2, t, 0.7, { type: "square", gain: 0.1, filter: 600 });
}

/** 正解発表：きらっとしたチャイム＋和音 */
export function sfxReveal(allRevived: boolean) {
  if (!isReady()) return;
  const t = now();
  // 小さなドラムロール
  for (let i = 0; i < 10; i++) noise(t + i * 0.035, 0.05, 0.06 + i * 0.012, 1800);
  const hit = t + 0.38;
  tone(NOTE.E6, hit, 0.5, { type: "sine", gain: 0.22 });
  tone(NOTE.C6, hit + 0.16, 0.9, { type: "sine", gain: 0.22 });
  const chord = allRevived ? ["F4", "A4", "C5", "F5"] : ["C4", "E4", "G4", "C5"];
  chord.forEach((n) => brass(NOTE[n], hit, 0.9, 0.06));
  noise(hit, 0.6, 0.1, 6000);
  if (allRevived) {
    // 全員復活：さらに上がっていくアルペジオ
    ["C5", "F5", "A5", "C6", "F6"].forEach((n, i) => tone(NOTE[n], hit + 0.9 + i * 0.08, 0.2, { type: "triangle", gain: 0.12 }));
  }
}

/** 優勝発表：ファンファーレ */
export function sfxWinner() {
  if (!isReady()) return;
  const t = now();
  // ドラムロール（1.4 秒）
  for (let i = 0; i < 40; i++) noise(t + i * 0.035, 0.05, 0.05 + (i / 40) * 0.12, 1500);
  const s = t + 1.45;
  const melody: Array<[string, number, number]> = [
    ["G4", 0, 0.16],
    ["G4", 0.18, 0.16],
    ["G4", 0.36, 0.16],
    ["C5", 0.54, 0.5],
    ["G4", 1.08, 0.2],
    ["C5", 1.3, 0.2],
    ["E5", 1.52, 1.3],
  ];
  melody.forEach(([n, at, d]) => brass(NOTE[n], s + at, d, 0.12));
  ["C3", "G3", "C4", "E4", "G4"].forEach((n) => brass(NOTE[n], s + 1.52, 1.4, 0.05));
  noise(s + 1.52, 1.4, 0.18, 5000);
  ["C6", "E6", "G6", "C7"].forEach((n, i) => tone(NOTE[n], s + 1.6 + i * 0.09, 0.4, { type: "sine", gain: 0.08 }));
}

/** 「音を出す」を押したときの確認音 */
export function sfxTest() {
  if (!isReady()) return;
  const t = now();
  tone(NOTE.C5, t, 0.12, { type: "sine", gain: 0.2 });
  tone(NOTE.G5, t + 0.12, 0.2, { type: "sine", gain: 0.2 });
}
