import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task";
const FPS = 30, MAX_FRAMES = 300, COARSE_FPS = 15, MAX_FINE_FPS = 120;
const IDX = { L: { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27 }, R: { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28 } };
const BONES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,31],[28,32]];
const JOINTS = [11,12,13,14,15,16,23,24,25,26,27,28,31,32];
const $ = id => document.getElementById(id);
const other = s => (s === "R" ? "L" : "R");

let landmarker = null, tsBase = 0;
const slots = {};

// ---- 数学 ----
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = a => Math.hypot(a.x, a.y, a.z);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
const deg = r => r * 180 / Math.PI;
function angle3(a, b, c) {
  const u = sub(a, b), v = sub(c, b), d = norm(u) * norm(v);
  return d ? deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d)))) : NaN;
}
// 2D: 線分が水平から何度傾いているか(-90..90)
function tilt2(a, b) {
  let t = deg(Math.atan2(b.y - a.y, b.x - a.x));
  if (t > 90) t -= 180; if (t < -90) t += 180;
  return t;
}
function leanFromVertical(top, bottom) { // 2D, 垂直からの傾き
  return Math.abs(deg(Math.atan2(top.x - bottom.x, bottom.y - top.y)));
}

async function getLandmarker(setStatus) {
  if (landmarker) return landmarker;
  setStatus("解析エンジンを読み込み中…（初回は少し時間がかかります）");
  const fs = await FilesetResolver.forVisionTasks(WASM);
  landmarker = await PoseLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: MODEL }, runningMode: "VIDEO", numPoses: 1
  });
  return landmarker;
}

// ---- スロット（真横 / 後ろ） ----
function createSlot(key, title, hint, num) {
  const s = { key, frames: [], cur: 0, playing: false, impact: -1, phases: [], step: 1 / FPS, ready: false };
  const sec = document.createElement("section");
  sec.className = "card";
  sec.innerHTML = `
    <h2>${num} ${title}</h2><p class="note">${hint}</p>
    <label class="btn">📹 動画を選ぶ<input class="file" type="file" accept="video/*" hidden></label>
    <button class="btn primary analyze" disabled>🔍 解析スタート</button>
    <progress class="prog" value="0" max="1" hidden></progress>
    <p class="note status"></p>
    <div class="viewer" hidden>
      <div class="stage"><video playsinline muted></video><canvas class="overlay"></canvas></div>
      <div class="ctrl phases"></div>
      <button class="btn setimp">📍 このコマをインパクトにする</button>
      <div class="ctrl">
        <button class="btn prev">◀ 1コマ</button>
        <button class="btn play">▶ 再生</button>
        <button class="btn next">1コマ ▶</button>
      </div>
      <input class="slider" type="range" min="0" max="0" value="0">
      <p class="note time"></p>
      <div class="angles"></div>
      <h3>蹴り足の速さ（縦線＝今のコマ、赤＝インパクト）</h3>
      <canvas class="graph" width="800" height="200"></canvas>
      <h3>チェック結果</h3>
      <ul class="check"></ul>
      <button class="btn csv">💾 データ(CSV)を保存</button>
    </div>`;
  $("slots").appendChild(sec);
  const q = c => sec.querySelector(c);
  Object.assign(s, {
    sec, video: q("video"), overlay: q(".overlay"), graph: q(".graph"), status: q(".status"),
    prog: q(".prog"), analyzeBtn: q(".analyze"), viewer: q(".viewer"), slider: q(".slider")
  });

  q(".file").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    s.playing = false; s.ready = false; s.frames = []; s.viewer.hidden = true; updateSync();
    s.video.src = URL.createObjectURL(f);
    e.target.value = "";
    s.video.onloadedmetadata = () => {
      s.analyzeBtn.disabled = false;
      s.status.textContent = `動画を読み込みました（${s.video.duration.toFixed(1)}秒）。「解析スタート」を押してください。`;
    };
  };
  s.analyzeBtn.onclick = () => analyze(s);
  s.slider.oninput = e => show(s, +e.target.value);
  q(".prev").onclick = () => show(s, s.cur - 1);
  q(".next").onclick = () => show(s, s.cur + 1);
  q(".play").onclick = async () => {
    const btn = q(".play");
    s.playing = !s.playing; btn.textContent = s.playing ? "⏸ 停止" : "▶ 再生";
    while (s.playing) {
      await show(s, s.cur + 1);
      if (s.cur >= s.frames.length - 1) s.playing = false;
      await new Promise(r => setTimeout(r, 60));
    }
    btn.textContent = "▶ 再生";
  };
  q(".csv").onclick = () => exportCsv(s);
  q(".setimp").onclick = () => { setImpact(s, s.cur); show(s, s.cur); updateSync(); };
  slots[key] = s;
  return s;
}

function seek(video, t) {
  return new Promise(res => {
    if (Math.abs(video.currentTime - t) < 1e-3) return res();
    video.onseeked = () => res();
    video.currentTime = t;
  });
}

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };

// ---- 解析 ----
const TOE = { L: 31, R: 32 };
let tsCounter = 0;

// 動画のコマ間隔を実測して実際のフレームレートを推定
async function detectFps(v) {
  if (!v.requestVideoFrameCallback) return 60;
  const times = [];
  try {
    v.currentTime = 0; v.muted = true;
    await new Promise(r => { v.onseeked = r; });
    const done = new Promise(res => {
      const cb = (_, m) => { times.push(m.mediaTime); if (times.length < 12) v.requestVideoFrameCallback(cb); else res(); };
      v.requestVideoFrameCallback(cb);
      setTimeout(res, 1500);
    });
    await v.play(); await done; v.pause();
  } catch { return 60; }
  const d = times.slice(1).map((t, i) => t - times[i]).filter(x => x > 1e-4);
  return d.length ? Math.min(240, Math.max(24, Math.round(1 / median(d)))) : 60;
}

async function runPass(s, lm, times, label) {
  const v = s.video, W = v.videoWidth, H = v.videoHeight, out = [];
  s.prog.hidden = false; s.prog.max = times.length; s.prog.value = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    await seek(v, t);
    const r = lm.detectForVideo(v, (tsCounter += 20));
    const lmk = r.landmarks[0], wl = r.worldLandmarks[0];
    out.push({ t, lmk, wl, p: lmk ? lmk.map(q => ({ x: q.x * W, y: q.y * H, z: 0 })) : null });
    s.prog.value = i + 1;
    s.status.textContent = `${label} ${i + 1}/${times.length}`;
  }
  return out;
}

// 欠けたコマを前後から補間した蹴り足つま先〜足首の軌跡
function footTrack(F, foot) {
  const k = IDX[foot];
  const xs = F.map(f => (f.p ? (f.p[k.an].x + f.p[TOE[foot]].x) / 2 : null));
  const ys = F.map(f => (f.p ? (f.p[k.an].y + f.p[TOE[foot]].y) / 2 : null));
  const fill = a => {
    const idx = a.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
    if (!idx.length) return a.map(() => 0);
    return a.map((v, i) => {
      if (v != null) return v;
      const lo = [...idx].reverse().find(j => j < i), hi = idx.find(j => j > i);
      if (lo == null) return a[hi]; if (hi == null) return a[lo];
      return a[lo] + (a[hi] - a[lo]) * (i - lo) / (hi - lo);
    });
  };
  return { x: fill(xs), y: fill(ys) };
}

// 5点の最小二乗(Savitzky-Golay)微分で、ノイズに強い速さ(胴体の長さ/秒)を求める
function speedOf(F, foot, step, torso) {
  const { x, y } = footTrack(F, foot), n = F.length;
  const at = (a, i) => a[Math.max(0, Math.min(n - 1, i))];
  const d = a => a.map((_, i) => (-2 * at(a, i - 2) - at(a, i - 1) + at(a, i + 1) + 2 * at(a, i + 2)) / (10 * step));
  const vx = d(x), vy = d(y);
  return vx.map((_, i) => Math.hypot(vx[i], vy[i]) / torso);
}

const torsoOf = F => median(F.filter(f => f.p).map(f => norm(sub(mid(f.p[11], f.p[12]), mid(f.p[23], f.p[24])))));

async function analyze(s) {
  s.analyzeBtn.disabled = true;
  s.playing = false;
  const foot = $("foot").value;
  try {
    const lm = await getLandmarker(m => (s.status.textContent = m));
    const v = s.video, dur = v.duration;
    // 1回目：全体を粗く解析し、キックの位置を探す
    const nC = Math.min(MAX_FRAMES, Math.max(4, Math.floor(dur * COARSE_FPS)));
    const coarse = await runPass(s, lm, Array.from({ length: nC + 1 }, (_, i) => i * dur / nC), "キックの場面を探しています…");
    if (!coarse.some(f => f.lmk)) {
      s.prog.hidden = true;
      s.status.textContent = "人が見つかりませんでした。全身が写る動画で試してください。";
      s.analyzeBtn.disabled = false; return;
    }
    const cs = speedOf(coarse, foot, dur / nC, torsoOf(coarse) || 1);
    let ci = 0; cs.forEach((q, i) => { if (q > cs[ci]) ci = i; });
    const tc = coarse[ci].t;
    // 2回目：キック前後を実際のフレームレートで細かく解析
    s.status.textContent = "コマ間隔を調べています…";
    const nativeFps = await detectFps(v);
    const fine = Math.min(MAX_FINE_FPS, nativeFps);
    s.step = 1 / fine; s.fps = nativeFps;
    const t0 = Math.max(0, tc - 1.0), t1 = Math.min(dur, tc + 0.5), nF = Math.max(4, Math.floor((t1 - t0) * fine));
    s.frames = await runPass(s, lm, Array.from({ length: nF + 1 }, (_, i) => t0 + i * s.step), "インパクト前後を細かく解析中…");
    s.prog.hidden = true;
    process(s, foot);
    s.status.textContent = `解析が完了しました！（${fine}コマ/秒で解析）インパクトがずれていたら、コマ送りで合わせて「📍 このコマをインパクトにする」を押してください。`;
    s.ready = true;
    s.viewer.hidden = false;
    s.overlay.width = v.videoWidth; s.overlay.height = v.videoHeight;
    s.slider.max = s.frames.length - 1;
    await show(s, s.impact);
    updateSync();
    s.sec.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    s.status.textContent = "エラー：" + err.message;
  }
  s.analyzeBtn.disabled = false;
}

function process(s, foot) {
  const k = IDX[foot], o = IDX[other(foot)], F = s.frames;
  for (const f of F) {
    f.ang = null;
    if (!f.wl || !f.p) continue;
    const w = f.wl, p = f.p;
    f.ang = {
      kickKnee: angle3(w[k.hip], w[k.kn], w[k.an]),
      supKnee: angle3(w[o.hip], w[o.kn], w[o.an]),
      kickHip: angle3(w[k.sh], w[k.hip], w[k.kn]),
      trunk2d: leanFromVertical(mid(p[11], p[12]), mid(p[23], p[24])),
      shTilt: tilt2(p[11], p[12]),
      hipTilt: tilt2(p[23], p[24]),
      headOffset: (p[0].x - p[o.an].x) / Math.max(1, Math.hypot(p[11].x - p[12].x, p[11].y - p[12].y))
    };
  }
  // 角度のブレを3点移動平均でならす
  const raw = F.map(f => f.ang && { ...f.ang });
  F.forEach((f, i) => {
    if (!f.ang) return;
    for (const key of Object.keys(f.ang)) {
      const vals = [raw[i - 1], raw[i], raw[i + 1]].filter(Boolean).map(a => a[key]).filter(x => !isNaN(x));
      if (vals.length) f.ang[key] = avg(vals);
    }
  });
  const torso = torsoOf(F) || 1;
  s.torsoLen = (+$("height").value || 170) / 100 * 0.3;
  s.speed = speedOf(F, foot, s.step, torso);
  s.foot = foot;
  const lo = 2, hi = Math.max(lo, F.length - 3);
  let imp = lo;
  for (let i = lo; i <= hi; i++) if (s.speed[i] > s.speed[imp]) imp = i;
  setImpact(s, imp);
}

// インパクトのコマを決め、各局面を求め直す（自動・手動どちらでも使う）
function setImpact(s, imp) {
  const F = s.frames, o = IDX[other(s.foot)];
  s.impact = imp;
  s.peakMs = Math.max(...s.speed) * s.torsoLen;
  const win = Math.round(0.6 / s.step);
  let back = Math.max(0, imp - win);
  for (let i = back; i <= imp; i++) if (F[i].ang && (!F[back].ang || F[i].ang.kickKnee < F[back].ang.kickKnee)) back = i;
  let plant = imp, best = Infinity;
  for (let i = Math.max(1, imp - Math.round(0.3 / s.step)); i <= Math.min(imp, F.length - 2); i++) {
    const a = F[i - 1], b = F[i + 1];
    if (!a.p || !b.p) continue;
    const d = Math.hypot(b.p[o.an].x - a.p[o.an].x, b.p[o.an].y - a.p[o.an].y);
    if (d < best) { best = d; plant = i; }
  }
  const follow = Math.min(F.length - 1, imp + Math.round(0.25 / s.step));
  s.phases = [{ name: "踏み込み", i: plant }, { name: "振りかぶり", i: back }, { name: "インパクト", i: imp }, { name: "フォロースルー", i: follow }];
  s.back = back;
  renderPhases(s); renderCheck(s);
}

// ---- 表示 ----
function renderPhases(s) {
  const box = s.sec.querySelector(".phases");
  box.innerHTML = "";
  for (const p of s.phases) {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = p.name;
    b.onclick = () => show(s, p.i);
    box.appendChild(b);
  }
}

const NAMES = {
  kickKnee: "蹴り足の膝", supKnee: "軸足の膝", kickHip: "蹴り足の股関節",
  trunk2d: "体幹の傾き(画面上)", shTilt: "肩のライン傾き", hipTilt: "腰のライン傾き"
};

async function show(s, i) {
  if (!s.frames.length) return;
  s.cur = Math.max(0, Math.min(s.frames.length - 1, i));
  s.slider.value = s.cur;
  const f = s.frames[s.cur];
  await seek(s.video, f.t);
  const c = s.overlay.getContext("2d"), W = s.overlay.width, H = s.overlay.height;
  c.clearRect(0, 0, W, H);
  if (f.lmk) {
    c.lineWidth = Math.max(3, W / 250); c.strokeStyle = "#22d3ee"; c.fillStyle = "#fde047";
    const kneeSide = IDX[s.foot];
    for (const [a, b] of BONES) {
      c.strokeStyle = (a === kneeSide.hip || a === kneeSide.kn || a === kneeSide.an) ? "#f87171" : "#22d3ee";
      c.beginPath(); c.moveTo(f.lmk[a].x * W, f.lmk[a].y * H); c.lineTo(f.lmk[b].x * W, f.lmk[b].y * H); c.stroke();
    }
    for (const j of JOINTS) { c.beginPath(); c.arc(f.lmk[j].x * W, f.lmk[j].y * H, c.lineWidth * 1.4, 0, 7); c.fill(); }
  }
  const ph = s.phases.find(p => p.i === s.cur);
  s.sec.querySelector(".time").textContent =
    `${f.t.toFixed(2)}秒（コマ ${s.cur + 1}/${s.frames.length}）${ph ? " ← " + ph.name : ""}`;
  s.sec.querySelector(".angles").innerHTML = f.ang
    ? Object.keys(NAMES).map(k => `<div class="angle">${NAMES[k]}<b>${Math.round(f.ang[k])}°</b></div>`).join("")
    : "<p class='note'>このコマは検出できませんでした</p>";
  drawGraph(s);
}

function drawGraph(s) {
  const c = s.graph.getContext("2d"), W = s.graph.width, H = s.graph.height;
  c.clearRect(0, 0, W, H);
  const mx = Math.max(1e-6, ...s.speed), n = Math.max(1, s.frames.length - 1);
  const X = i => 10 + i / n * (W - 20), Y = v => H - 15 - v / mx * (H - 30);
  c.strokeStyle = "#3b82f6"; c.lineWidth = 2; c.beginPath();
  s.speed.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)))); c.stroke();
  c.lineWidth = 1;
  c.strokeStyle = "#ef4444"; c.beginPath(); c.moveTo(X(s.impact), 0); c.lineTo(X(s.impact), H - 15); c.stroke();
  c.strokeStyle = "#000"; c.beginPath(); c.moveTo(X(s.cur), 0); c.lineTo(X(s.cur), H - 15); c.stroke();
  c.fillStyle = "#667"; c.font = "12px sans-serif";
  c.fillText(`最大 約${s.peakMs.toFixed(1)} m/s（${(s.peakMs * 3.6).toFixed(0)} km/h・目安）`, 12, 14);
}

// ---- チェック項目 ----
function item(t, h, val, ok, fmt) {
  return { t, h, val: val == null || isNaN(val) ? null : fmt(val), ok: val == null || isNaN(val) ? null : ok(val) };
}
function renderCheck(s) {
  const F = s.frames, imp = F[s.impact].ang || {}, bk = (F[s.back] || {}).ang || {};
  const d = v => Math.round(v) + "°";
  let list;
  if (s.key === "side") {
    list = [
      item("軸足の膝が曲がりすぎ・伸びすぎていない？（インパクト）", "目安 130〜170°。安定して踏み込めているか", imp.supKnee, v => v >= 130 && v <= 170, d),
      item("振りかぶりで膝をしっかり曲げた？", "目安 100°以下。大きく引くほど振りが加速", bk.kickKnee, v => v <= 100, d),
      item("インパクトに向けて膝が伸びてきた？", "目安 140°以上。膝下の鞭のような動き", imp.kickKnee, v => v >= 140, d),
      item("上体が傾きすぎていない？（インパクト）", "目安 25°以内。後ろに倒れると力が逃げます", imp.trunk2d, v => v <= 25, d),
      item("蹴り足の最大スピード", "胴体の長さから推定した目安です。比べるときは同じ条件で", s.peakMs, () => null, v => v.toFixed(1) + " m/s"),
      { t: "軸足がボールの真横（少し後ろ）にある？", h: "コマ送りで踏み込みを確認", ok: null },
      { t: "足首を固めてインパクトできている？", h: "コマ送りでインパクト前後を確認", ok: null }
    ];
  } else {
    list = [
      item("体が左右に傾きすぎていない？（インパクト）", "目安 15°以内。軸のぶれは精度の低下に", imp.trunk2d, v => v <= 15, d),
      item("頭が軸足の上にある？（インパクト）", "目安 肩幅1つ分以内。顔が流れないように", imp.headOffset == null ? null : Math.abs(imp.headOffset), v => v <= 1, v => v.toFixed(2) + " 肩幅"),
      item("肩と腰のひねり差（インパクト）", "大きいほど体をひねって蹴れている目安（後ろ撮影は参考値）", imp.shTilt == null ? null : Math.abs(imp.shTilt - imp.hipTilt), () => null, d),
      { t: "助走の向きがボール→ゴール方向にそろっている？", h: "コマ送りで体の向きを確認", ok: null },
      { t: "フォロースルーで蹴り足が目標方向に振り抜けている？", h: "フォロースルーを確認", ok: null }
    ];
  }
  const ul = s.sec.querySelector(".check"); ul.innerHTML = "";
  for (const p of list) {
    const mark = p.ok === true ? "✅ 良好" : p.ok === false ? "⚠️ 要確認" : "";
    const li = document.createElement("li");
    li.innerHTML = `<label><input type="checkbox" ${p.ok === true ? "checked" : ""}><span>${p.t}<small>${p.h}</small>${
      p.val ? `<span class="auto">📊 ${p.val} ${mark}</span>` : ""}</span></label>`;
    ul.appendChild(li);
  }
  if (s.key === "rear") {
    const li = document.createElement("li");
    li.innerHTML = "<small>※ 後ろから撮った動画では膝の角度は正確に測れないため、傾きと位置の確認が中心です。</small>";
    ul.appendChild(li);
  }
}

// ---- 同期ビュー ----
function updateSync() {
  const both = slots.side.ready && slots.rear.ready;
  $("syncbox").hidden = !both;
  if (both) onSync();
}
function onSync() {
  const k = +$("sync").value, sec = k / FPS;
  $("synclabel").textContent = `インパクト ${k >= 0 ? "+" : ""}${sec.toFixed(2)} 秒`;
  for (const s of [slots.side, slots.rear]) {
    const t = s.frames[s.impact].t + sec;
    let bi = 0;
    s.frames.forEach((f, i) => { if (Math.abs(f.t - t) < Math.abs(s.frames[bi].t - t)) bi = i; });
    show(s, bi);
  }
}
$("sync").oninput = onSync;

// ---- CSV ----
function exportCsv(s) {
  const names = ["nose","leye_i","leye","leye_o","reye_i","reye","reye_o","lear","rear","mouth_l","mouth_r","lshoulder","rshoulder","lelbow","relbow","lwrist","rwrist","lpinky","rpinky","lindex","rindex","lthumb","rthumb","lhip","rhip","lknee","rknee","lankle","rankle","lheel","rheel","lfoot","rfoot"];
  const keys = Object.keys(NAMES);
  const head = ["time", "phase", "foot_speed_torso_per_s", ...keys, ...names.flatMap(n => [n + "_x", n + "_y", n + "_z"])];
  const rows = s.frames.map((f, i) => {
    const ph = s.phases.filter(p => p.i === i).map(p => p.name).join("/");
    return [f.t.toFixed(3), ph, s.speed[i].toFixed(3),
      ...keys.map(k => (f.ang ? f.ang[k].toFixed(1) : "")),
      ...names.flatMap((_, j) => (f.wl ? [f.wl[j].x, f.wl[j].y, f.wl[j].z].map(v => v.toFixed(4)) : ["", "", ""]))];
  });
  const blob = new Blob([[head, ...rows].map(r => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `freekick_${s.key}.csv`; a.click();
}

createSlot("side", "真横の動画（メイン）", "キックする側から全身が入るように撮った動画。膝などの角度を見ます。", "②");
createSlot("rear", "後ろの動画（サブ・なくてもOK）", "蹴る方向の真後ろから撮った動画。体の傾き・頭の位置・ひねりを見ます。", "③");
