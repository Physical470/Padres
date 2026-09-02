/**
 * 世田谷パドレス 個人成績 — チーム共有バックエンド (Google Apps Script)
 *
 * スプレッドシートをチーム共通の保存先にするためのウェブアプリです。
 *
 * ── セットアップ（チームで1回だけ・管理者のGoogleアカウントで） ──
 * 1. https://sheets.new で空のスプレッドシートを作成
 * 2. メニュー「拡張機能」→「Apps Script」を開き、
 *    このファイルの内容を Code.gs に丸ごと貼り付けて保存
 * 3. すぐ下の TOKEN を好きな合言葉に変更
 * 4. 「デプロイ」→「新しいデプロイ」→ 種類の選択「ウェブアプリ」
 *      - 次のユーザーとして実行: 自分
 *      - アクセスできるユーザー: 全員
 *    → デプロイ（初回はアクセス権限の承認が求められます）
 * 5. 発行された「ウェブアプリのURL」と合言葉を、
 *    アプリの「設定・データ」→「チーム共有」に入力して接続
 *
 * ※コードを修正した場合は「デプロイ」→「デプロイを管理」→ 鉛筆アイコン
 *   → バージョン「新バージョン」で再デプロイしてください。
 */

const TOKEN = "padres";

// 貼り替え・再デプロイが反映されたか確認するための版数(アプリの共有カードに表示されます)
const VERSION = "6";

const SCHEMAS = {
  players:  ["id","name","number","pos","throws","bats","active"],
  games:    ["id","date","opponent","place","scoreFor","scoreAgainst","note"],
  batting:  ["id","gameId","playerId","AB","R","H","D2","T3","HR","RBI","BB","HBP","SO","SH","SF","GDP","SB","CS"],
  pitching: ["id","gameId","playerId","GS","OUTS","BF","HA","HRA","BBA","HBPA","SOA","RA","ER","W","L","SV","HLD"],
  settings: ["key","value"]
};

const DATA_COLLECTIONS = ["players", "games", "batting", "pitching"];

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cb = p.callback || "";
  if ((p.token || "") !== TOKEN) return respond({ error: "合言葉が違います" }, cb);

  const action = p.action || "all";
  if (action === "all") return respond({ ok: true, version: VERSION, db: readAll() }, cb);

  // 書き込み系(JSONPフォールバック用): パラメータのpayloadにJSONを載せて呼ぶ
  let body = {};
  if (p.payload) {
    try { body = JSON.parse(p.payload); }
    catch (err) { return respond({ error: "payloadの形式が不正です" }, cb); }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return respond(dispatch(action, body), cb);
  } catch (err) {
    return respond({ error: String(err && err.message || err) }, cb);
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ error: "リクエストの形式が不正です" });
  }
  if ((body.token || "") !== TOKEN) return json({ error: "合言葉が違います" });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return json(dispatch(body.action, body));
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function dispatch(action, body) {
  switch (action) {
    case "upsert":       upsert(body.collection, body.record); break;
    case "delete":       remove(body.collection, body.id); break;
    case "deleteWhere":  deleteWhere(body.collection, body.field, body.value); break;
    case "saveSettings": saveSettings(body.settings); break;
    case "replaceAll":   replaceAll(body.db || {}); break;
    case "clearAll":     replaceAll({}); break;
    default: return { error: "不明な操作: " + action };
  }
  return { ok: true };
}

/* ---------------- helpers ---------------- */

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// callback付き(JSONP)なら JavaScript として、なければ JSON として返す
function respond(obj, callback) {
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + JSON.stringify(obj) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(obj);
}

function sheet(name) {
  if (!SCHEMAS[name]) throw new Error("不明なシート: " + name);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SCHEMAS[name]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function guardCollection(col) {
  if (DATA_COLLECTIONS.indexOf(col) < 0) throw new Error("不明なコレクション: " + col);
}

function findRow(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

/**
 * 日付セル(Dateオブジェクト)を yyyy-MM-dd に戻す。
 * シートに保存された日付は「どこかのタイムゾーンの深夜0時」を指す瞬間なので、
 * 最も近い日付に丸めることで、スクリプト/シート/端末のTZ設定に一切依存せず
 * 元の日付を復元できる(TZ差は最大±14時間 < 12時間超のズレのみ影響)。
 */
function dateToYmd(v) {
  const d = new Date(Math.round(v.getTime() / 86400000) * 86400000);
  const p = n => (n < 10 ? "0" : "") + n;
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

/**
 * 日付セルの書式が「書式なし/文字列」に変わってしまい、シリアル値(数値)として
 * 読めてしまう場合の復旧。シートのシリアル値は 1899-12-30 起点の日数。
 */
function serialToYmd(n) {
  return dateToYmd(new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000));
}

/**
 * セルの値を yyyy-MM-dd に正規化する。
 * 日付型・シリアル値・"Wed May 13 2026 …" のような文字列いずれにも対応。
 */
function toYmd(v) {
  if (v instanceof Date) return dateToYmd(v);
  if (typeof v === "number" && v > 20000 && v < 80000) return serialToYmd(v);
  const s = String(v === null || v === undefined ? "" : v).trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s.length >= 8) {
    const t = Date.parse(s);
    if (!isNaN(t)) return dateToYmd(new Date(t));
  }
  return s;
}

function readAll() {
  const out = {};
  DATA_COLLECTIONS.forEach(function (col) {
    const sh = sheet(col);
    const data = sh.getDataRange().getValues();
    const recs = [];
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0]) === "") continue;
      const rec = {};
      SCHEMAS[col].forEach(function (f, i) {
        let v = data[r][i];
        // 日付は "yyyy-MM-dd" 文字列に戻す(タイムゾーンずれ・書式崩れの両方に対応)
        if (f === "date" || v instanceof Date) v = toYmd(v);
        rec[f] = v;
      });
      recs.push(rec);
    }
    out[col] = recs;
  });
  const s = sheet("settings").getDataRange().getValues();
  const settings = {};
  for (let r = 1; r < s.length; r++) {
    if (String(s[r][0]) !== "") settings[s[r][0]] = s[r][1];
  }
  out.settings = settings;
  return out;
}

function upsert(col, record) {
  guardCollection(col);
  if (!record || String(record.id || "") === "") throw new Error("idがありません");
  const sh = sheet(col);
  const values = SCHEMAS[col].map(function (f) {
    return record[f] === undefined || record[f] === null ? "" : record[f];
  });
  const row = findRow(sh, record.id);
  if (row > 0) sh.getRange(row, 1, 1, values.length).setValues([values]);
  else sh.appendRow(values);
}

function remove(col, id) {
  guardCollection(col);
  const sh = sheet(col);
  const row = findRow(sh, id);
  if (row > 0) sh.deleteRow(row);
}

function deleteWhere(col, field, value) {
  guardCollection(col);
  const idx = SCHEMAS[col].indexOf(field);
  if (idx < 0) throw new Error("不明なフィールド: " + field);
  const sh = sheet(col);
  const data = sh.getDataRange().getValues();
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][idx]) === String(value)) sh.deleteRow(r + 1);
  }
}

function saveSettings(settings) {
  const sh = sheet("settings");
  sh.clearContents();
  const rows = [["key", "value"]];
  Object.keys(settings || {}).forEach(function (k) {
    rows.push([k, settings[k]]);
  });
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
}

function replaceAll(dbIn) {
  DATA_COLLECTIONS.forEach(function (col) {
    const sh = sheet(col);
    sh.clearContents();
    const rows = [SCHEMAS[col]];
    (dbIn[col] || []).forEach(function (rec) {
      rows.push(SCHEMAS[col].map(function (f) {
        return rec[f] === undefined || rec[f] === null ? "" : rec[f];
      }));
    });
    sh.getRange(1, 1, rows.length, SCHEMAS[col].length).setValues(rows);
  });
  saveSettings(dbIn.settings || {});
}
