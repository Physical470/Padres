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

const SCHEMAS = {
  players:  ["id","name","number","pos","throws","bats","active"],
  games:    ["id","date","opponent","place","scoreFor","scoreAgainst","note"],
  batting:  ["id","gameId","playerId","AB","R","H","D2","T3","HR","RBI","BB","HBP","SO","SH","SF","GDP","SB","CS"],
  pitching: ["id","gameId","playerId","GS","OUTS","BF","HA","HRA","BBA","HBPA","SOA","RA","ER","W","L","SV","HLD"],
  settings: ["key","value"]
};

const DATA_COLLECTIONS = ["players", "games", "batting", "pitching"];

function doGet(e) {
  const token = (e && e.parameter && e.parameter.token) || "";
  if (token !== TOKEN) return json({ error: "合言葉が違います" });
  return json({ ok: true, db: readAll() });
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
    switch (body.action) {
      case "upsert":       upsert(body.collection, body.record); break;
      case "delete":       remove(body.collection, body.id); break;
      case "deleteWhere":  deleteWhere(body.collection, body.field, body.value); break;
      case "saveSettings": saveSettings(body.settings); break;
      case "replaceAll":   replaceAll(body.db || {}); break;
      default: return json({ error: "不明な操作: " + body.action });
    }
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- helpers ---------------- */

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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

function readAll() {
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
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
        // 日付セルは "yyyy-MM-dd" 文字列に戻す(タイムゾーンずれ防止)
        if (v instanceof Date) v = Utilities.formatDate(v, tz, "yyyy-MM-dd");
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
