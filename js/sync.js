/* ============================================================
   sync.js — チーム共有(Google Apps Script + スプレッドシート)
   接続すると:
     - 起動時/画面復帰時/90秒ごとに共有データを取得して表示を更新
     - 入力・削除のたびに項目単位でスプレッドシートへ書き込み
     - 通信失敗時は端末内のキューに退避し、次の機会に自動再送
   ============================================================ */

const SYNC_CONF_KEY = "padres-sync-config";
const SYNC_QUEUE_KEY = "padres-sync-queue";

// このアプリが想定する Code.gs の版数。接続先がこれより古い場合は
// 貼り替え・再デプロイが未反映なので、共有カードで警告する
const SYNC_EXPECTED_VERSION = "6";

let syncConf = null;
try { syncConf = JSON.parse(localStorage.getItem(SYNC_CONF_KEY) || "null"); } catch (e) { /* ignore */ }

let syncBusy = false;
let syncPulling = false;
let syncStatus = { state: syncConf ? "idle" : "off", at: null, message: "" };
let syncServerVersion = null;   // 接続先Code.gsの版数(再デプロイの反映確認用)

function syncEnabled() { return !!(syncConf && syncConf.url); }

function saveSyncConf(conf) {
  syncConf = conf;
  if (conf) localStorage.setItem(SYNC_CONF_KEY, JSON.stringify(conf));
  else {
    localStorage.removeItem(SYNC_CONF_KEY);
    localStorage.removeItem(SYNC_QUEUE_KEY);
  }
  updateSyncChip();
}

/* ---------------- 送信キュー ---------------- */

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || "[]"); }
  catch (e) { return []; }
}

function saveQueue(q) { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(q)); }

function pushOps(ops) {
  if (!syncEnabled()) return;
  const q = loadQueue();
  q.push(...ops);
  saveQueue(q);
  flushQueue();
}

async function flushQueue() {
  if (!syncEnabled() || syncBusy) return;
  syncBusy = true;
  setSyncStatus("syncing");
  try {
    let q = loadQueue();
    while (q.length) {
      await sendOp(q[0]);
      q = loadQueue();
      q.shift();
      saveQueue(q);
    }
    setSyncStatus("ok");
  } catch (e) {
    setSyncStatus("error", e.message);
  } finally {
    syncBusy = false;
  }
}

/* ---------------- API ---------------- */

async function parseApiResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // Apps Scriptが正しく公開されていないと、JSONではなく
    // Googleのログイン/エラーページ(HTML)が返ってくる
    const err = new Error(
      "サーバーの応答を読み取れません。Apps Scriptのデプロイ設定を確認してください:" +
      " ①種類が「ウェブアプリ」 ②アクセスできるユーザーが「全員」" +
      " ③URLが「ウェブアプリのURL」(https://script.google.com/macros/s/…/exec)"
    );
    err.network = true;
    throw err;
  }
}

async function safeFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    // ログインが必要な設定のままだと accounts.google.com へのリダイレクトが
    // CORSで遮断され、通信エラーと同じ見え方になる
    const err = new Error(
      "サーバーに接続できません。Apps Scriptのデプロイ設定が" +
      "「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」になっているか確認してください" +
      "(設定変更後は「デプロイを管理」から新バージョンとして再デプロイ)。" +
      "設定が正しい場合はURLと通信環境を確認してください"
    );
    err.network = true;
    throw err;
  }
}

/* ---- JSONPトランスポート ----
   fetchがCORS等で遮断される環境向けの代替経路。<script>タグ経由なので
   CORSの影響を受けない。Code.gs側の callback / payload 対応が必要。 */

function transportOf(c) { return (c && c.transport) || "fetch"; }

function jsonpRequest(c, params) {
  return new Promise((resolve, reject) => {
    const cb = "__padresCb" + Date.now().toString(36) + Math.floor(Math.random() * 1e6);
    const script = document.createElement("script");
    let timer;
    const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
    window[cb] = data => { cleanup(); resolve(data); };
    script.onerror = () => {
      cleanup();
      reject(new Error("サーバーに接続できません。URLと通信環境を確認してください"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        "サーバーから応答がありません。Code.gsが最新版か(貼り付け後に保存したか)、" +
        "デプロイを「新バージョン」で更新したか確認してください"
      ));
    }, 15000);
    const sep = c.url.includes("?") ? "&" : "?";
    script.src = `${c.url}${sep}token=${encodeURIComponent(c.token || "")}&${params}&callback=${cb}&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

async function jsonpGet(c) {
  const data = await jsonpRequest(c, "action=all");
  if (data.error) throw new Error(data.error);
  if (!data.db) throw new Error("応答の形式が不正です(Code.gsが最新か確認してください)");
  syncServerVersion = data.version || "旧";
  return data.db;
}

async function jsonpOp(op) {
  const payload = { ...op };
  delete payload.action;
  const data = await jsonpRequest(
    syncConf,
    `action=${encodeURIComponent(op.action)}&payload=${encodeURIComponent(JSON.stringify(payload))}`
  );
  if (data.error) throw new Error(data.error);
}

function persistTransport(c, t) {
  c.transport = t;
  if (c === syncConf) saveSyncConf(syncConf);
}

/* ---- 送受信(fetch優先・失敗時はJSONPへ自動切替) ---- */

async function apiGet(conf) {
  const c = conf || syncConf;
  if (transportOf(c) !== "jsonp") {
    try {
      const sep = c.url.includes("?") ? "&" : "?";
      const res = await safeFetch(`${c.url}${sep}token=${encodeURIComponent(c.token || "")}&action=all`);
      const data = await parseApiResponse(res);
      if (data.error) throw new Error(data.error);
      if (!data.db) throw new Error("応答の形式が不正です(Code.gsが最新か確認してください)");
      syncServerVersion = data.version || "旧";
      return data.db;
    } catch (e) {
      if (!e.network) throw e;
      // fetchが遮断される環境ではJSONPに切り替えて再試行
      const db = await jsonpGet(c).catch(() => { throw e; });
      persistTransport(c, "jsonp");
      return db;
    }
  }
  return jsonpGet(c);
}

async function apiPost(op) {
  const res = await safeFetch(syncConf.url, {
    method: "POST",
    // text/plain にするとプリフライト無しで Apps Script に届く
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: syncConf.token || "", ...op })
  });
  const data = await parseApiResponse(res);
  if (data.error) throw new Error(data.error);
}

async function sendOp(op) {
  if (transportOf(syncConf) !== "jsonp") {
    try {
      await apiPost(op);
      return;
    } catch (e) {
      if (!e.network) throw e;
      await sendOpJsonp(op).catch(() => { throw e; });
      persistTransport(syncConf, "jsonp");
      return;
    }
  }
  await sendOpJsonp(op);
}

async function sendOpJsonp(op) {
  if (op.action === "replaceAll") {
    // URL長の制限があるため、全置換は1レコードずつに分解して送る
    const d = op.db || {};
    await jsonpOp({ action: "clearAll" });
    for (const col of ["players", "games", "batting", "pitching"]) {
      for (const rec of d[col] || []) {
        await jsonpOp({ action: "upsert", collection: col, record: rec });
      }
    }
    await jsonpOp({ action: "saveSettings", settings: d.settings || {} });
    return;
  }
  await jsonpOp(op);
}

/* ---------------- 取得と正規化 ---------------- */

const SYNC_BAT_NUMS = ["AB","R","H","D2","T3","HR","RBI","BB","HBP","SO","SH","SF","GDP","SB","CS"];
const SYNC_PIT_NUMS = ["GS","OUTS","BF","HA","HRA","BBA","HBPA","SOA","RA","ER","W","L","SV","HLD"];

// 瞬間(ミリ秒)を最も近い日付に丸めて yyyy-MM-dd にする(TZ差の1日ズレ防止)
function msToYmd(t) {
  return new Date(Math.round(t / 86400000) * 86400000).toISOString().slice(0, 10);
}

/**
 * どんな形で返ってきた日付も yyyy-MM-dd に正規化する。
 *  - "2026-05-13"                        … そのまま
 *  - "2026-05-13T00:00:00.000Z"          … 日付型のまま返ったISO
 *  - "Wed May 13 2026 00:00:00 GMT+0900" … 日付が文字列化されたもの
 *  - 46208                               … 書式崩れによるシリアル値
 */
function normDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // シリアル値(1899-12-30起点の日数)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.round(parseFloat(s));
    if (n > 20000 && n < 80000) return msToYmd(Date.UTC(1899, 11, 30) + n * 86400000);
  }
  // ISO / 英語表記など、日付として解釈できる文字列
  if (s.length >= 8) {
    const t = Date.parse(s);
    if (!isNaN(t)) return msToYmd(t);
  }
  return s.length > 10 ? s.slice(0, 10) : s;
}

function normalizeRemote(r) {
  const base = structuredClone(DEFAULT_DB);
  const s = r.settings || {};
  ["qualPAperG", "qualIPperG"].forEach(k => {
    if (s[k] !== undefined && s[k] !== "") base.settings[k] = +s[k] || base.settings[k];
  });
  if (s.eraBasis) base.settings.eraBasis = +s.eraBasis || 9;

  base.players = (r.players || []).map(p => ({
    id: String(p.id),
    name: String(p.name || ""),
    number: p.number === null || p.number === undefined ? "" : String(p.number),
    pos: String(p.pos || ""),
    throws: String(p.throws || ""),
    bats: String(p.bats || ""),
    active: !(p.active === false || String(p.active).toUpperCase() === "FALSE")
  }));
  base.games = (r.games || []).map(g => ({
    id: String(g.id),
    date: normDate(g.date),
    opponent: String(g.opponent || ""),
    place: String(g.place || ""),
    scoreFor: +g.scoreFor || 0,
    scoreAgainst: +g.scoreAgainst || 0,
    note: String(g.note || "")
  }));
  base.batting = (r.batting || []).map(l => {
    const o = { id: String(l.id), gameId: String(l.gameId), playerId: String(l.playerId) };
    SYNC_BAT_NUMS.forEach(f => o[f] = +l[f] || 0);
    return o;
  });
  base.pitching = (r.pitching || []).map(l => {
    const o = { id: String(l.id), gameId: String(l.gameId), playerId: String(l.playerId) };
    SYNC_PIT_NUMS.forEach(f => o[f] = +l[f] || 0);
    return o;
  });
  return base;
}

function exportableDb() {
  return {
    players: db.players,
    games: db.games,
    batting: db.batting,
    pitching: db.pitching,
    settings: db.settings
  };
}

let dateRepairDone = false;

/**
 * シート側の日付が yyyy-MM-dd で無い行(英語表記・シリアル値など)を、
 * 正規化した値で1件ずつ静かに直す。ISO形式(日付セル)は対象外なので
 * 直し続けるループにはならない。1回の読み込みにつき一度だけ実行。
 */
function repairRemoteDates(remote) {
  if (!syncEnabled() || dateRepairDone) return;
  const rawById = new Map((remote.games || []).map(g => [String(g.id), String(g.date ?? "").trim()]));
  const ops = [];
  for (const g of db.games) {
    const raw = rawById.get(g.id);
    if (raw === undefined) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) continue;      // 既に正しい形/ISO日付セルは触らない
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.date || "")) continue; // 正しく直せた行のみ
    ops.push({ action: "upsert", collection: "games", record: g });
  }
  if (ops.length) {
    dateRepairDone = true;
    pushOps(ops);
  }
}

async function syncPull(silent) {
  if (!syncEnabled() || syncPulling) return;
  // 入力モーダルを開いている間は表示を差し替えない
  if (document.querySelector("#modal-root .overlay")) return;
  syncPulling = true;
  setSyncStatus("syncing");
  try {
    await flushQueue();
    const remote = await apiGet();
    db = normalizeRemote(remote);
    saveDB();
    repairRemoteDates(remote);
    refreshSeasonSelect();
    render();
    setSyncStatus("ok");
    if (!silent) toast("共有データを取得しました");
  } catch (e) {
    setSyncStatus("error", e.message);
    if (!silent) toast("同期に失敗しました: " + e.message);
  } finally {
    syncPulling = false;
  }
}

/* ---------------- 接続・切断 ---------------- */

async function connectSync(url, token, opts) {
  const conf = { url: url.trim(), token: (token || "").trim() };
  if (!/^https?:\/\//.test(conf.url)) throw new Error("URLの形式が正しくありません");
  if (conf.url.includes("docs.google.com")) {
    throw new Error("それはスプレッドシート自体のURLです。Apps Scriptの「デプロイ」で発行される「ウェブアプリのURL」(https://script.google.com/macros/s/…/exec)を入力してください");
  }
  if (/\/dev(\?|$)/.test(conf.url)) {
    throw new Error("「…/dev」は所有者専用のテストURLです。「…/exec」で終わるウェブアプリのURLを入力してください");
  }
  if (conf.url.includes("script.google.com") && !conf.url.includes("/macros/")) {
    throw new Error("Apps Scriptエディタ画面のURLではなく、デプロイ時に発行される「ウェブアプリのURL」(https://script.google.com/macros/s/…/exec)を入力してください");
  }
  const remote = await apiGet(conf); // 接続テストを兼ねる
  const remoteHas = (remote.players || []).length || (remote.games || []).length;
  const localHas = db.players.length || db.games.length;

  if (remoteHas && localHas && !(opts && opts.fromLink)) {
    if (!confirm("共有データが見つかりました。この端末の表示は共有データに置き換わります。\n(この端末だけにあるデータは消えます。必要ならキャンセルして先にJSON書き出しでバックアップしてください)\n続けますか？")) {
      throw new Error("キャンセルしました");
    }
  }

  saveSyncConf(conf);

  if (!remoteHas && localHas && !(opts && opts.fromLink)) {
    if (confirm("共有データはまだ空です。この端末のデータをアップロードして共有データにしますか？")) {
      pushOps([{ action: "replaceAll", db: exportableDb() }]);
      await flushQueue();
    }
  }

  await syncPull(true);
}

function disconnectSync() {
  saveSyncConf(null);
  syncStatus = { state: "off", at: null, message: "" };
  updateSyncChip();
}

function syncShareLink() {
  const payload = btoa(encodeURIComponent(JSON.stringify({ u: syncConf.url, t: syncConf.token || "" })));
  return location.origin + location.pathname + "#s=" + payload;
}

/* ---------------- ステータス表示 ---------------- */

function setSyncStatus(state, message) {
  syncStatus = { state, at: new Date(), message: message || "" };
  updateSyncChip();
}

function updateSyncChip() {
  const chip = document.getElementById("sync-chip");
  if (!chip) return;
  if (!syncEnabled()) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.remove("ok", "error", "syncing");
  const t = syncStatus.at
    ? `${String(syncStatus.at.getHours()).padStart(2, "0")}:${String(syncStatus.at.getMinutes()).padStart(2, "0")}`
    : "";
  if (syncStatus.state === "syncing") { chip.classList.add("syncing"); chip.textContent = "同期中…"; }
  else if (syncStatus.state === "error") { chip.classList.add("error"); chip.textContent = "共有 ⚠ 未同期あり"; chip.title = syncStatus.message; }
  else if (syncStatus.state === "ok") { chip.classList.add("ok"); chip.textContent = `共有 ✓ ${t}`; }
  else { chip.textContent = "共有"; }
}

/* ---------------- 初期化 ---------------- */

function initSync() {
  // 共有リンク(#s=...)からの自動接続
  if (location.hash.startsWith("#s=")) {
    try {
      const payload = JSON.parse(decodeURIComponent(atob(location.hash.slice(3))));
      history.replaceState(null, "", location.pathname + location.search);
      if (payload.u) {
        connectSync(payload.u, payload.t, { fromLink: true })
          .then(() => toast("チーム共有に接続しました"))
          .catch(e => toast("共有への接続に失敗しました: " + e.message));
      }
    } catch (e) {
      toast("共有リンクを読み取れませんでした");
    }
  }

  const chip = document.getElementById("sync-chip");
  if (chip) chip.onclick = () => syncPull(false);
  updateSyncChip();

  if (syncEnabled()) syncPull(true);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncPull(true);
  });
  setInterval(() => {
    if (!document.hidden) syncPull(true);
  }, 90000);
}
