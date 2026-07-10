/* ============================================================
   sync.js — チーム共有(Google Apps Script + スプレッドシート)
   接続すると:
     - 起動時/画面復帰時/90秒ごとに共有データを取得して表示を更新
     - 入力・削除のたびに項目単位でスプレッドシートへ書き込み
     - 通信失敗時は端末内のキューに退避し、次の機会に自動再送
   ============================================================ */

const SYNC_CONF_KEY = "padres-sync-config";
const SYNC_QUEUE_KEY = "padres-sync-queue";

let syncConf = null;
try { syncConf = JSON.parse(localStorage.getItem(SYNC_CONF_KEY) || "null"); } catch (e) { /* ignore */ }

let syncBusy = false;
let syncPulling = false;
let syncStatus = { state: syncConf ? "idle" : "off", at: null, message: "" };

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
      await apiPost(q[0]);
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
    throw new Error(
      "サーバーの応答を読み取れません。Apps Scriptのデプロイ設定を確認してください:" +
      " ①種類が「ウェブアプリ」 ②アクセスできるユーザーが「全員」" +
      " ③URLが「ウェブアプリのURL」(https://script.google.com/macros/s/…/exec)"
    );
  }
}

async function safeFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    // ログインが必要な設定のままだと accounts.google.com へのリダイレクトが
    // CORSで遮断され、通信エラーと同じ見え方になる
    throw new Error(
      "サーバーに接続できません。Apps Scriptのデプロイ設定が" +
      "「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」になっているか確認してください" +
      "(設定変更後は「デプロイを管理」から新バージョンとして再デプロイ)。" +
      "設定が正しい場合はURLと通信環境を確認してください"
    );
  }
}

async function apiGet(conf) {
  const c = conf || syncConf;
  const sep = c.url.includes("?") ? "&" : "?";
  const res = await safeFetch(`${c.url}${sep}token=${encodeURIComponent(c.token || "")}&action=all`);
  const data = await parseApiResponse(res);
  if (data.error) throw new Error(data.error);
  if (!data.db) throw new Error("応答の形式が不正です(Code.gsが最新か確認してください)");
  return data.db;
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

/* ---------------- 取得と正規化 ---------------- */

const SYNC_BAT_NUMS = ["AB","R","H","D2","T3","HR","RBI","BB","HBP","SO","SH","SF","GDP","SB","CS"];
const SYNC_PIT_NUMS = ["GS","OUTS","BF","HA","HRA","BBA","HBPA","SOA","RA","ER","W","L","SV","HLD"];

function normDate(v) {
  const s = String(v || "");
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
