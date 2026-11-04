import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task";
const STEP = 1 / 15; // 解析間隔（秒）

// 各種目：撮影のコツと見るポイント。auto は解析結果から最大/最小値を表示する指標
const SPORTS = {
  kick: { name: "⚽ サッカーキック", tips: "真横から全身が入るように撮る。蹴り足と軸足がはっきり見える位置で。",
    points: [
      { t: "軸足の膝は曲がりすぎていない？", h: "軸足の膝は少し曲げる程度が安定します", auto: "supKnee", label: "軸足の膝 最小角度" , mode: "min" },
      { t: "振り足の膝をしっかり引いてから振っている？", h: "膝の曲がりが小さい(角度が小さい)ほど大きな振りかぶり", auto: "kneeMain", label: "振り足の膝 最小角度", mode: "min" },
      { t: "上体が後ろに倒れすぎていない？", h: "体幹の傾きが大きいと力が逃げます", auto: "trunk", label: "体幹の傾き 最大", mode: "max" },
      { t: "インパクトで足首が伸びている？", h: "足先まで一直線になるイメージ" }
    ] },
  throwin: { name: "🤾 スローイン", tips: "真横から、ボールを持つ手とからだ全体が入るように撮る。",
    points: [
      { t: "ボールを頭の後ろまで大きく引けている？", h: "肘の角度が小さくなるほど大きな振りかぶり", auto: "elbowMain", label: "肘 最小角度", mode: "min" },
      { t: "体を弓のように反らせている？", h: "体幹の傾きの変化が大きいほどしなりが大きい", auto: "trunk", label: "体幹の傾き 最大", mode: "max" },
      { t: "両足が地面についたまま投げている？", h: "ルール：両足の一部が地面に必要" },
      { t: "リリースで腕が伸びている？", h: "肘が伸びる(180°に近い)と遠くへ", auto: "elbowMain", label: "肘 最大角度", mode: "max" }
    ] },
  shoot: { name: "🏀 バスケシュート", tips: "真横か斜め前から撮る。シュートする手とボールの軌道が入るように。",
    points: [
      { t: "膝を曲げてためを作れている？", h: "膝をしっかり曲げると下半身の力を使える", auto: "kneeMain", label: "膝 最小角度", mode: "min" },
      { t: "肘が体の正面で真上に向いている？", h: "肘が外に開かないように" },
      { t: "リリースで肘と手首が伸びている？", h: "肘が伸びきる(180°に近い)のが目安", auto: "elbowMain", label: "肘 最大角度", mode: "max" },
      { t: "着地までバランスがくずれていない？", h: "体幹の傾きが小さいほど安定", auto: "trunk", label: "体幹の傾き 最大", mode: "max" }
    ] },
  walk: { name: "🚶 競歩", tips: "真横から、足元まで全身が入るように。カメラは固定して。",
    points: [
      { t: "前足の接地から腰の真下を通るまで膝が伸びている？", h: "競歩のルール：膝が伸びていること(180°に近い)", auto: "kneeMain", label: "膝 最大角度", mode: "max" },
      { t: "両足が同時に浮いていない？", h: "コマ送りで常にどちらかの足が地面についているか確認" },
      { t: "上体が前に倒れすぎていない？", h: "体幹の傾きは小さめが目安", auto: "trunk", label: "体幹の傾き 最大", mode: "max" },
      { t: "腕を前後にリズムよく振れている？", h: "肘は約90°が目安", auto: "elbowMain", label: "肘 最小角度", mode: "min" }
    ] },
  hurdle: { name: "🏃 ハードル", tips: "真横から、ハードル1台と全身が入るように撮る。",
    points: [
      { t: "振り上げ足の膝をしっかり引き上げている？", h: "膝が小さく畳まれて(角度が小さい)前に出る", auto: "kneeMain", label: "振り上げ足の膝 最小角度", mode: "min" },
      { t: "踏み切りで体が起きている？", h: "体幹の傾きが大きすぎないように", auto: "trunk", label: "体幹の傾き 最大", mode: "max" },
      { t: "抜き足(後ろ足)を横から引き付けている？", h: "コマ送りで膝が体の横を通るか確認" },
      { t: "着地後すぐ次の一歩に入れている？", h: "着地の姿勢が崩れていないか" }
    ] }
};

const IDX = { L: { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27 }, R: { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28 } };
const $ = id => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), graph = $("graph");
let sport = "kick", frames = [], series = null, landmarker = null, cur = 0, playing = false, tsBase = 0;

function renderSports() {
  $("sports").innerHTML = "";
  for (const [k, s] of Object.entries(SPORTS)) {
    const b = document.createElement("button");
    b.className = "sport" + (k === sport ? " on" : "");
    b.textContent = s.name;
    b.onclick = () => { sport = k; renderSports(); if (frames.length) renderCheck(); };
    $("sports").appendChild(b);
  }
  $("tips").textContent = "📷 撮影のコツ：" + SPORTS[sport].tips;
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = a => Math.hypot(a.x, a.y, a.z);
function angle3(a, b, c) { // bを頂点とした角度
  const u = sub(a, b), v = sub(c, b);
  const d = norm(u) * norm(v);
  return d ? Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))) * 180 / Math.PI : NaN;
}
function trunkLean(w, side) { // 腰→肩ベクトルと鉛直(−y)の角度
  const i = IDX[side];
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const sh = mid(w[11], w[12]), hp = mid(w[23], w[24]);
  const v = sub(sh, hp), up = { x: 0, y: -1, z: 0 };
  return Math.acos(Math.max(-1, Math.min(1, dot(v, up) / norm(v)))) * 180 / Math.PI;
}
function compute(w, side) {
  const m = IDX[side], o = IDX[side === "R" ? "L" : "R"];
  return {
    kneeMain: angle3(w[m.hip], w[m.kn], w[m.an]),
    supKnee: angle3(w[o.hip], w[o.kn], w[o.an]),
    elbowMain: angle3(w[m.sh], w[m.el], w[m.wr]),
    trunk: trunkLean(w, side)
  };
}
const NAMES = { kneeMain: "メイン側の膝", supKnee: "反対側の膝", elbowMain: "メイン側の肘", trunk: "体幹の傾き" };

async function getLandmarker() {
  if (landmarker) return landmarker;
  $("status").textContent = "解析エンジンを読み込み中…（初回は少し時間がかかります）";
  const fs = await FilesetResolver.forVisionTasks(WASM);
  landmarker = await PoseLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: MODEL }, runningMode: "VIDEO", numPoses: 1
  });
  return landmarker;
}
const seek = t => new Promise(r => { video.onseeked = () => r(); video.currentTime = t; });

$("file").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  playing = false; $("step3").hidden = true; frames = [];
  video.src = URL.createObjectURL(f);
  e.target.value = "";
  video.onloadedmetadata = () => { $("analyze").disabled = false; $("status").textContent = "動画を読み込みました。「解析スタート」を押してください。"; };
};

$("analyze").onclick = async () => {
  $("analyze").disabled = true;
  try {
    const lm = await getLandmarker();
    frames = []; const side = $("side").value;
    const n = Math.floor(video.duration / STEP);
    $("prog").hidden = false; $("prog").max = n;
    for (let i = 0; i <= n; i++) {
      const t = Math.min(i * STEP, video.duration);
      await seek(t);
      const r = lm.detectForVideo(video, tsBase + Math.round(t * 1000) + 1 + i);
      const lmk = r.landmarks[0], wl = r.worldLandmarks[0];
      frames.push({ t, lmk, wl, ang: wl ? compute(wl, side) : null });
      $("prog").value = i;
      $("status").textContent = `解析中… ${i}/${n}`;
    }
    tsBase += Math.round(video.duration * 1000) + n + 1000;
    $("prog").hidden = true;
    const ok = frames.filter(f => f.ang).length;
    $("status").textContent = ok ? "解析が完了しました！" : "人が見つかりませんでした。全身が写る動画で試してください。";
    if (ok) startViewer();
  } catch (err) {
    $("status").textContent = "エラー：" + err.message;
  }
  $("analyze").disabled = false;
};

function startViewer() {
  $("step3").hidden = false;
  $("slider").max = frames.length - 1;
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  renderCheck(); show(0);
  $("step3").scrollIntoView({ behavior: "smooth" });
}

const BONES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
async function show(i) {
  cur = Math.max(0, Math.min(frames.length - 1, i));
  $("slider").value = cur;
  const f = frames[cur];
  await seek(f.t);
  const c = overlay.getContext("2d"); c.clearRect(0, 0, overlay.width, overlay.height);
  if (f.lmk) {
    const W = overlay.width, H = overlay.height;
    c.lineWidth = Math.max(3, W / 250); c.strokeStyle = "#22d3ee"; c.fillStyle = "#fde047";
    for (const [a, b] of BONES) { c.beginPath(); c.moveTo(f.lmk[a].x * W, f.lmk[a].y * H); c.lineTo(f.lmk[b].x * W, f.lmk[b].y * H); c.stroke(); }
    for (const k of [11,12,13,14,15,16,23,24,25,26,27,28]) { c.beginPath(); c.arc(f.lmk[k].x * W, f.lmk[k].y * H, c.lineWidth * 1.4, 0, 7); c.fill(); }
  }
  $("time").textContent = `${f.t.toFixed(2)} 秒（コマ ${cur + 1}/${frames.length}）`;
  $("angles").innerHTML = f.ang ? Object.keys(NAMES).map(k => `<div class="angle">${NAMES[k]}<b>${isNaN(f.ang[k]) ? "-" : Math.round(f.ang[k])}°</b></div>`).join("") : "<p class='note'>このコマは検出できませんでした</p>";
  drawGraph();
}

function drawGraph() {
  const c = graph.getContext("2d"), W = graph.width, H = graph.height;
  c.clearRect(0, 0, W, H);
  const cols = { kneeMain: "#ef4444", supKnee: "#f59e0b", elbowMain: "#22c55e", trunk: "#3b82f6" };
  c.strokeStyle = "#ddd"; c.fillStyle = "#667"; c.font = "12px sans-serif";
  for (let a = 0; a <= 180; a += 45) { const y = H - 20 - a / 180 * (H - 30); c.beginPath(); c.moveTo(30, y); c.lineTo(W, y); c.stroke(); c.fillText(a + "°", 2, y + 4); }
  let ly = 14;
  for (const k of Object.keys(cols)) {
    c.strokeStyle = c.fillStyle = cols[k]; c.beginPath(); let s = false;
    frames.forEach((f, i) => {
      if (!f.ang || isNaN(f.ang[k])) return;
      const x = 30 + i / Math.max(1, frames.length - 1) * (W - 35), y = H - 20 - Math.min(180, f.ang[k]) / 180 * (H - 30);
      s ? c.lineTo(x, y) : c.moveTo(x, y); s = true;
    });
    c.lineWidth = 2; c.stroke(); c.fillText(NAMES[k], W - 120, ly); ly += 14;
  }
  const x = 30 + cur / Math.max(1, frames.length - 1) * (W - 35);
  c.strokeStyle = "#000"; c.lineWidth = 1; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H - 20); c.stroke();
}

function renderCheck() {
  $("check").innerHTML = "";
  for (const p of SPORTS[sport].points) {
    let auto = "";
    if (p.auto) {
      const vals = frames.filter(f => f.ang && !isNaN(f.ang[p.auto])).map(f => f.ang[p.auto]);
      if (vals.length) auto = `<span class="auto">📊 ${p.label}：${Math.round(p.mode === "min" ? Math.min(...vals) : Math.max(...vals))}°</span>`;
    }
    const li = document.createElement("li");
    li.innerHTML = `<label><input type="checkbox"><span>${p.t}<small>${p.h}</small>${auto}</span></label>`;
    $("check").appendChild(li);
  }
}

$("slider").oninput = e => show(+e.target.value);
$("prev").onclick = () => show(cur - 1);
$("next").onclick = () => show(cur + 1);
$("play").onclick = async () => {
  playing = !playing; $("play").textContent = playing ? "⏸ 停止" : "▶ 再生";
  while (playing) { await show(cur + 1); if (cur >= frames.length - 1) playing = false; await new Promise(r => setTimeout(r, 120)); }
  $("play").textContent = "▶ 再生";
};

$("csv").onclick = () => {
  const names = ["nose","leye_i","leye","leye_o","reye_i","reye","reye_o","lear","rear","mouth_l","mouth_r","lshoulder","rshoulder","lelbow","relbow","lwrist","rwrist","lpinky","rpinky","lindex","rindex","lthumb","rthumb","lhip","rhip","lknee","rknee","lankle","rankle","lheel","rheel","lfoot","rfoot"];
  const head = ["time", ...Object.keys(NAMES), ...names.flatMap(n => [n + "_x", n + "_y", n + "_z"])];
  const rows = frames.map(f => [f.t.toFixed(3), ...Object.keys(NAMES).map(k => f.ang ? f.ang[k].toFixed(1) : ""), ...names.flatMap((_, i) => f.wl ? [f.wl[i].x, f.wl[i].y, f.wl[i].z].map(v => v.toFixed(4)) : ["", "", ""])]);
  const blob = new Blob([[head, ...rows].map(r => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "motion.csv"; a.click();
};

renderSports();
