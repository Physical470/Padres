/* ============================================================
   app.js — 世田谷パドレス 個人成績管理アプリ
   保存先: localStorage（設定・データタブから JSON で入出力可）
   ============================================================ */

const STORAGE_KEY = "setagaya-padres-stats-v1";

const DEFAULT_DB = {
  version: 1,
  settings: {
    qualPAperG: 2.0,   // 規定打席 = チーム試合数 × この値
    qualIPperG: 1.0,   // 規定投球回 = チーム試合数 × この値
    eraBasis: 9        // 防御率の基準回（9回換算 / 7回換算）
  },
  players: [],
  games: [],
  batting: [],
  pitching: []
};

let db = loadDB();
let currentSeason = "";   // "" = 全期間, その他 "2026" など
let currentTab = "dashboard";
let battingMode = "basic";
let pitchingMode = "basic";
const sortState = {
  batting:  { key: "OPS", dir: -1 },
  pitching: { key: "ERA", dir: 1 }
};

/* ================= 永続化 ================= */

function loadDB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_DB);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(DEFAULT_DB), ...parsed,
             settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) } };
  } catch (e) {
    console.error(e);
    return structuredClone(DEFAULT_DB);
  }
}

function saveDB() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// 今日の日付(端末のローカル日付)。toISOString()はUTC基準なので
// 日本時間の朝9時前だと前日になってしまう
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ================= ユーティリティ ================= */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function playerById(id) { return db.players.find(p => p.id === id); }
function gameById(id)   { return db.games.find(g => g.id === id); }

function seasonOf(game) { return (game.date || "").slice(0, 4); }

function seasonGames() {
  const gs = db.games.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return currentSeason ? gs.filter(g => seasonOf(g) === currentSeason) : gs;
}

function seasonGameIds() { return new Set(seasonGames().map(g => g.id)); }

function seasonBatting()  { const ids = seasonGameIds(); return db.batting.filter(l => ids.has(l.gameId)); }
function seasonPitching() { const ids = seasonGameIds(); return db.pitching.filter(l => ids.has(l.gameId)); }

function playerLabel(p) {
  return p ? `${p.number != null && p.number !== "" ? "#" + p.number + " " : ""}${p.name}` : "(不明)";
}

/* ================= シーズンセレクタ ================= */

function refreshSeasonSelect() {
  const sel = document.getElementById("season-select");
  const years = [...new Set(db.games.map(seasonOf).filter(Boolean))].sort().reverse();
  const thisYear = String(new Date().getFullYear());
  if (!years.includes(thisYear)) years.unshift(thisYear);
  if (currentSeason === "" && years.length) currentSeason = years[0];
  sel.innerHTML =
    years.map(y => `<option value="${y}" ${y === currentSeason ? "selected" : ""}>${y}年</option>`).join("") +
    `<option value="" ${currentSeason === "" ? "selected" : ""}>全期間</option>`;
}

/* ================= 集計 ================= */

function aggregateBatting() {
  const byPlayer = new Map();
  for (const line of seasonBatting()) {
    if (!byPlayer.has(line.playerId)) byPlayer.set(line.playerId, []);
    byPlayer.get(line.playerId).push(line);
  }
  const lgTotals = sumBat(seasonBatting());
  const rows = [];
  for (const [pid, lines] of byPlayer) {
    const p = playerById(pid);
    if (!p) continue;
    rows.push({ player: p, ...batDerived(sumBat(lines), lgTotals) });
  }
  return { rows, team: batDerived(lgTotals, null) };
}

function aggregatePitching() {
  const byPlayer = new Map();
  for (const line of seasonPitching()) {
    if (!byPlayer.has(line.playerId)) byPlayer.set(line.playerId, []);
    byPlayer.get(line.playerId).push(line);
  }
  const lgTotals = sumPit(seasonPitching());
  const basis = db.settings.eraBasis;
  const rows = [];
  for (const [pid, lines] of byPlayer) {
    const p = playerById(pid);
    if (!p) continue;
    rows.push({ player: p, ...pitDerived(sumPit(lines), lgTotals, basis) });
  }
  return { rows, team: pitDerived(lgTotals, lgTotals, basis) };
}

function qualPA() { return seasonGames().length * db.settings.qualPAperG; }
function qualOuts() { return seasonGames().length * db.settings.qualIPperG * 3; }

/* ================= タブ描画 ================= */

function render() {
  refreshSeasonSelect();
  const fn = {
    dashboard: renderDashboard,
    players: renderPlayers,
    games: renderGames,
    batting: renderBattingTab,
    pitching: renderPitchingTab,
    data: renderDataTab
  }[currentTab];
  if (fn) fn();
}

/* ---------- ダッシュボード ---------- */

function renderDashboard() {
  const el = document.getElementById("tab-dashboard");
  const games = seasonGames();
  const wins  = games.filter(g => g.scoreFor > g.scoreAgainst).length;
  const loses = games.filter(g => g.scoreFor < g.scoreAgainst).length;
  const draws = games.length - wins - loses;
  const bat = aggregateBatting();
  const pit = aggregatePitching();
  const label = currentSeason ? `${currentSeason}年` : "全期間";

  const tiles = `
    <div class="tile-row">
      ${tile("試合", games.length, "", true)}
      ${tile("勝敗", `${wins}-${loses}-${draws}`, "勝-敗-分")}
      ${tile("勝率", fmtAvg(div(wins, wins + loses)))}
      ${tile("チーム打率", fmtAvg(bat.team.AVG))}
      ${tile("チームOPS", bat.team.OPS === null ? "-" : bat.team.OPS.toFixed(3))}
      ${tile("チーム防御率", fmtNum2(pit.team.ERA), db.settings.eraBasis + "回換算")}
      ${tile("本塁打", bat.team.HR)}
      ${tile("盗塁", bat.team.SB)}
      ${tile("得点", bat.team.R)}
      ${tile("失点", pit.team.RA)}
    </div>`;

  const qPA = qualPA(), qOuts = qualOuts();
  const qb = bat.rows.filter(r => r.PA >= qPA);
  const qp = pit.rows.filter(r => r.OUTS >= qOuts);

  const leaders = `
    <div class="section-title">打撃リーダー <span class="sub">規定打席: ${qPA.toFixed(0)} 打席以上（率系）</span></div>
    <div class="leader-grid">
      ${leaderCard("打率", qb, r => r.AVG, fmtAvg)}
      ${leaderCard("本塁打", bat.rows, r => r.HR, fmtInt)}
      ${leaderCard("打点", bat.rows, r => r.RBI, fmtInt)}
      ${leaderCard("安打", bat.rows, r => r.H, fmtInt)}
      ${leaderCard("盗塁", bat.rows, r => r.SB, fmtInt)}
      ${leaderCard("OPS", qb, r => r.OPS, v => v === null ? "-" : v.toFixed(3))}
      ${leaderCard("wRC+", qb, r => r.wRCplus, fmtPlus)}
      ${leaderCard("四球", bat.rows, r => r.BB, fmtInt)}
    </div>
    <div class="section-title">投手リーダー <span class="sub">規定投球回: ${(qOuts / 3).toFixed(0)} 回以上（率系）</span></div>
    <div class="leader-grid">
      ${leaderCard("防御率", qp, r => r.ERA, fmtNum2, true)}
      ${leaderCard("奪三振", pit.rows, r => r.SOA, fmtInt)}
      ${leaderCard("勝利", pit.rows, r => r.W, fmtInt)}
      ${leaderCard("WHIP", qp, r => r.WHIP, fmtNum2, true)}
      ${leaderCard("FIP", qp, r => r.FIP, fmtNum2, true)}
      ${leaderCard("セーブ", pit.rows, r => r.SV, fmtInt)}
    </div>`;

  el.innerHTML = games.length === 0 && db.players.length === 0
    ? `<div class="section-title">${label} ダッシュボード</div>
       <div class="empty-note">まだデータがありません。「選手」タブで選手を登録し、「試合・入力」タブで試合と成績を入力してください。<br>
       まず動きを見たい場合は「設定・データ」タブからサンプルデータを読み込めます。</div>`
    : `<div class="section-title">${label} チームサマリー</div>${tiles}${leaders}`;
}

function tile(label, value, note, hero) {
  return `<div class="tile ${hero ? "tile-hero" : ""}">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value">${value === null || value === undefined ? "-" : value}</div>
    ${note ? `<div class="tile-note">${esc(note)}</div>` : ""}
  </div>`;
}

function leaderCard(title, rows, getter, fmt, asc) {
  const ranked = rows
    .map(r => ({ r, v: getter(r) }))
    .filter(x => x.v !== null && x.v !== undefined && !(typeof x.v === "number" && isNaN(x.v)))
    .filter(x => asc || x.v !== 0)
    .sort((a, b) => asc ? a.v - b.v : b.v - a.v)
    .slice(0, 3);
  const items = ranked.length
    ? ranked.map((x, i) => `<li><span class="rank">${i + 1}</span><span class="lname">${esc(playerLabel(x.r.player))}</span><span class="lval">${fmt(x.v)}</span></li>`).join("")
    : `<li><span class="lname" style="color:var(--ink-muted)">該当なし</span></li>`;
  return `<div class="leader-card"><h4>${esc(title)}</h4><ol>${items}</ol></div>`;
}

/* ---------- 選手 ---------- */

function renderPlayers() {
  const el = document.getElementById("tab-players");
  const players = db.players.slice().sort((a, b) => (+a.number || 999) - (+b.number || 999));
  el.innerHTML = `
    <div class="toolbar">
      <div class="section-title" style="margin:0;border:none;">ロースター <span class="sub">${players.length}名</span></div>
      <div class="spacer"></div>
      <button class="btn btn-gold" id="btn-add-player">＋ 選手を追加</button>
    </div>
    ${players.length === 0
      ? `<div class="empty-note">選手が登録されていません。「＋ 選手を追加」から登録してください。</div>`
      : `<div class="player-grid">${players.map(p => `
          <div class="player-card ${p.active === false ? "inactive" : ""}" data-pid="${p.id}">
            <div class="pc-num">${esc(p.number ?? "-")}</div>
            <div>
              <div class="pc-name">${esc(p.name)}</div>
              <div class="pc-meta">${esc(p.pos || "")}${p.bats || p.throws ? ` ／ ${esc(p.throws || "?")}投${esc(p.bats || "?")}打` : ""}${p.active === false ? " ／ 休部中" : ""}</div>
            </div>
          </div>`).join("")}</div>`}
  `;
  el.querySelector("#btn-add-player").onclick = () => openPlayerModal(null);
  el.querySelectorAll(".player-card").forEach(c =>
    c.onclick = () => openPlayerDetail(c.dataset.pid));
}

function openPlayerModal(pid) {
  const p = pid ? playerById(pid) : {};
  openModal(`
    <h3>${pid ? "選手を編集" : "選手を追加"}</h3>
    <div class="form-grid">
      <div class="field half wide"><label>名前 *</label><input id="f-name" value="${esc(p.name || "")}" placeholder="例: 山田 太郎"></div>
      <div class="field"><label>背番号</label><input id="f-number" type="number" min="0" value="${esc(p.number ?? "")}"></div>
      <div class="field"><label>ポジション</label>
        <select id="f-pos">${["", "投手", "捕手", "内野手", "外野手", "ユーティリティ"].map(x =>
          `<option ${p.pos === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label>投</label>
        <select id="f-throws">${["", "右", "左", "両"].map(x => `<option ${p.throws === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label>打</label>
        <select id="f-bats">${["", "右", "左", "両"].map(x => `<option ${p.bats === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label>在籍</label>
        <select id="f-active"><option value="1" ${p.active !== false ? "selected" : ""}>在籍中</option><option value="0" ${p.active === false ? "selected" : ""}>休部中</option></select></div>
    </div>
    <div class="modal-actions">
      ${pid ? `<button class="btn btn-danger" id="m-delete">削除</button>` : ""}
      <button class="btn" id="m-cancel">キャンセル</button>
      <button class="btn btn-gold" id="m-save">保存</button>
    </div>
  `, modal => {
    modal.querySelector("#m-save").onclick = () => {
      const name = modal.querySelector("#f-name").value.trim();
      if (!name) { toast("名前を入力してください"); return; }
      const data = {
        name,
        number: modal.querySelector("#f-number").value,
        pos: modal.querySelector("#f-pos").value,
        throws: modal.querySelector("#f-throws").value,
        bats: modal.querySelector("#f-bats").value,
        active: modal.querySelector("#f-active").value === "1"
      };
      let rec;
      if (pid) { rec = playerById(pid); Object.assign(rec, data); }
      else { rec = { id: uid(), ...data }; db.players.push(rec); }
      pushOps([{ action: "upsert", collection: "players", record: rec }]);
      saveDB(); closeModal(); render(); toast("保存しました");
    };
    const del = modal.querySelector("#m-delete");
    if (del) del.onclick = () => {
      if (!confirm(`${p.name} を削除しますか？ 全ての成績データも削除されます。`)) return;
      db.players = db.players.filter(x => x.id !== pid);
      db.batting = db.batting.filter(x => x.playerId !== pid);
      db.pitching = db.pitching.filter(x => x.playerId !== pid);
      pushOps([
        { action: "delete", collection: "players", id: pid },
        { action: "deleteWhere", collection: "batting", field: "playerId", value: pid },
        { action: "deleteWhere", collection: "pitching", field: "playerId", value: pid }
      ]);
      saveDB(); closeModal(); render(); toast("削除しました");
    };
  });
}

function openPlayerDetail(pid) {
  const p = playerById(pid);
  if (!p) return;
  const batLines = seasonBatting().filter(l => l.playerId === pid);
  const pitLines = seasonPitching().filter(l => l.playerId === pid);
  const lgB = sumBat(seasonBatting());
  const lgP = sumPit(seasonPitching());
  const b = batDerived(sumBat(batLines), lgB);
  const pi = pitDerived(sumPit(pitLines), lgP, db.settings.eraBasis);
  const label = currentSeason ? `${currentSeason}年` : "全期間";

  const batSummary = batLines.length ? `
    <div class="section-title" style="font-size:14px;">打撃 (${label})</div>
    <div class="tile-row">
      ${tile("打率", fmtAvg(b.AVG), "", true)}
      ${tile("試合", b.G)}${tile("打席", b.PA)}${tile("安打", b.H)}
      ${tile("本塁打", b.HR)}${tile("打点", b.RBI)}${tile("盗塁", b.SB)}
      ${tile("OPS", b.OPS === null ? "-" : b.OPS.toFixed(3))}
      ${tile("出塁率", fmtAvg(b.OBP))}${tile("長打率", fmtAvg(b.SLG))}
      ${tile("wOBA", fmtAvg(b.wOBA))}${tile("wRC+", fmtPlus(b.wRCplus))}
      ${tile("ISO", fmtAvg(b.ISO))}${tile("BABIP", fmtAvg(b.BABIP))}
      ${tile("BB%", fmtPct(b.BBpct))}${tile("K%", fmtPct(b.Kpct))}
    </div>
    <div class="table-wrap"><table class="stats">
      <thead><tr><th>試合</th><th>打数</th><th>安</th><th>2B</th><th>3B</th><th>本</th><th>点</th><th>四球</th><th>三振</th><th>盗</th></tr></thead>
      <tbody>${batLines.map(l => {
        const g = gameById(l.gameId);
        return `<tr><td>${esc(g ? `${g.date} ${g.opponent}` : "?")}</td><td class="num">${l.AB}</td><td class="num">${l.H}</td><td class="num">${l.D2}</td><td class="num">${l.T3}</td><td class="num">${l.HR}</td><td class="num">${l.RBI}</td><td class="num">${l.BB}</td><td class="num">${l.SO}</td><td class="num">${l.SB}</td></tr>`;
      }).join("")}</tbody>
    </table></div>` : "";

  const pitSummary = pitLines.length ? `
    <div class="section-title" style="font-size:14px;">投手 (${label})</div>
    <div class="tile-row">
      ${tile("防御率", fmtNum2(pi.ERA), "", true)}
      ${tile("登板", pi.G)}${tile("勝-敗", `${pi.W}-${pi.L}`)}${tile("S / HLD", `${pi.SV} / ${pi.HLD}`)}
      ${tile("投球回", fmtIP(pi.OUTS))}${tile("奪三振", pi.SOA)}
      ${tile("WHIP", fmtNum2(pi.WHIP))}${tile("FIP", fmtNum2(pi.FIP))}
      ${tile("K/9", fmtNum2(pi.K9))}${tile("BB/9", fmtNum2(pi.BB9))}
      ${tile("K-BB%", fmtPct(pi.KBBpct))}${tile("被打率", fmtAvg(pi.AVGA))}
    </div>
    <div class="table-wrap"><table class="stats">
      <thead><tr><th>試合</th><th>回</th><th>被安</th><th>被本</th><th>四球</th><th>三振</th><th>失点</th><th>自責</th></tr></thead>
      <tbody>${pitLines.map(l => {
        const g = gameById(l.gameId);
        return `<tr><td>${esc(g ? `${g.date} ${g.opponent}` : "?")}</td><td class="num">${fmtIP(l.OUTS)}</td><td class="num">${l.HA}</td><td class="num">${l.HRA}</td><td class="num">${l.BBA}</td><td class="num">${l.SOA}</td><td class="num">${l.RA}</td><td class="num">${l.ER}</td></tr>`;
      }).join("")}</tbody>
    </table></div>` : "";

  openModal(`
    <h3>#${esc(p.number ?? "-")} ${esc(p.name)}</h3>
    <div style="color:var(--ink-muted);font-size:13px;margin:-8px 0 10px;">
      ${esc(p.pos || "")}${p.bats || p.throws ? ` ／ ${esc(p.throws || "?")}投${esc(p.bats || "?")}打` : ""}
    </div>
    ${batSummary}${pitSummary}
    ${!batLines.length && !pitLines.length ? `<div class="empty-note">${label}の出場記録はありません。</div>` : ""}
    <div class="modal-actions">
      <button class="btn" id="m-edit">プロフィール編集</button>
      <button class="btn btn-gold" id="m-close">閉じる</button>
    </div>
  `, modal => {
    modal.querySelector("#m-close").onclick = closeModal;
    modal.querySelector("#m-edit").onclick = () => { closeModal(); openPlayerModal(pid); };
  }, true);
}

/* ---------- 試合・入力 ---------- */

function renderGames() {
  const el = document.getElementById("tab-games");
  const games = seasonGames().slice().reverse();
  el.innerHTML = `
    <div class="toolbar">
      <div class="section-title" style="margin:0;border:none;">試合 <span class="sub">${games.length}試合</span></div>
      <div class="spacer"></div>
      <button class="btn btn-gold" id="btn-add-game">＋ 試合を追加</button>
    </div>
    ${games.length === 0
      ? `<div class="empty-note">試合がまだありません。「＋ 試合を追加」から登録し、試合カード内で各選手の成績を入力します。</div>`
      : games.map(gameCardHTML).join("")}
  `;
  el.querySelector("#btn-add-game").onclick = () => openGameModal(null);
  el.querySelectorAll("[data-edit-game]").forEach(b => b.onclick = () => openGameModal(b.dataset.editGame));
  el.querySelectorAll("[data-add-bat]").forEach(b => b.onclick = () => openBatLineModal(b.dataset.addBat, null));
  el.querySelectorAll("[data-add-pit]").forEach(b => b.onclick = () => openPitLineModal(b.dataset.addPit, null));
  el.querySelectorAll("[data-bat-line]").forEach(c => c.onclick = () => {
    const line = db.batting.find(l => l.id === c.dataset.batLine);
    if (line) openBatLineModal(line.gameId, line.id);
  });
  el.querySelectorAll("[data-pit-line]").forEach(c => c.onclick = () => {
    const line = db.pitching.find(l => l.id === c.dataset.pitLine);
    if (line) openPitLineModal(line.gameId, line.id);
  });
}

function gameCardHTML(g) {
  const w = g.scoreFor > g.scoreAgainst, l = g.scoreFor < g.scoreAgainst;
  const badge = w ? `<span class="badge win">勝</span>` : l ? `<span class="badge lose">負</span>` : `<span class="badge draw">分</span>`;
  const bats = db.batting.filter(x => x.gameId === g.id);
  const pits = db.pitching.filter(x => x.gameId === g.id);
  return `
  <div class="game-card">
    <div class="game-head">
      <span class="game-date">${esc(g.date)}</span>
      <span class="game-vs">vs ${esc(g.opponent)}${g.place ? ` <span style="color:var(--ink-muted);font-weight:400;font-size:12px;">@${esc(g.place)}</span>` : ""}</span>
      <span class="game-score">${g.scoreFor} - ${g.scoreAgainst}</span>
      ${badge}
    </div>
    ${g.note ? `<div style="font-size:12px;color:var(--ink-muted);margin-top:4px;">${esc(g.note)}</div>` : ""}
    <div class="game-lines">
      ${bats.length ? `打撃: ` + bats.map(b2 => {
        const p = playerById(b2.playerId);
        return `<span class="line-chip" data-bat-line="${b2.id}" style="cursor:pointer;">${esc(p ? p.name : "?")} ${b2.AB}-${b2.H}${b2.HR > 0 ? ` ${b2.HR}本` : ""}${b2.RBI > 0 ? ` ${b2.RBI}打点` : ""}</span>`;
      }).join("") : `<span style="color:var(--ink-muted)">打撃成績 未入力</span>`}
    </div>
    <div class="game-lines">
      ${pits.length ? `投手: ` + pits.map(pl => {
        const p = playerById(pl.playerId);
        return `<span class="line-chip" data-pit-line="${pl.id}" style="cursor:pointer;">${esc(p ? p.name : "?")} ${fmtIP(pl.OUTS)}回 自責${pl.ER}${pl.W ? " 勝" : ""}${pl.L ? " 負" : ""}${pl.SV ? " S" : ""}</span>`;
      }).join("") : `<span style="color:var(--ink-muted)">投手成績 未入力</span>`}
    </div>
    <div class="game-actions">
      <button class="btn btn-sm btn-gold" data-add-bat="${g.id}">＋ 打撃成績</button>
      <button class="btn btn-sm btn-gold" data-add-pit="${g.id}">＋ 投手成績</button>
      <button class="btn btn-sm" data-edit-game="${g.id}">試合を編集</button>
    </div>
  </div>`;
}

function openGameModal(gid) {
  const g = gid ? gameById(gid) : { date: todayStr(), scoreFor: 0, scoreAgainst: 0 };
  openModal(`
    <h3>${gid ? "試合を編集" : "試合を追加"}</h3>
    <div class="form-grid">
      <div class="field half"><label>日付 *</label><input id="f-date" type="date" value="${esc(g.date || "")}"></div>
      <div class="field half"><label>相手チーム *</label><input id="f-opp" value="${esc(g.opponent || "")}" placeholder="例: 目黒ドジャース"></div>
      <div class="field half"><label>球場・場所</label><input id="f-place" value="${esc(g.place || "")}"></div>
      <div class="field"><label>得点（自チーム）</label><input id="f-for" type="number" min="0" value="${g.scoreFor ?? 0}"></div>
      <div class="field"><label>失点（相手）</label><input id="f-against" type="number" min="0" value="${g.scoreAgainst ?? 0}"></div>
      <div class="field wide"><label>メモ</label><input id="f-note" value="${esc(g.note || "")}"></div>
    </div>
    <div class="modal-actions">
      ${gid ? `<button class="btn btn-danger" id="m-delete">削除</button>` : ""}
      <button class="btn" id="m-cancel">キャンセル</button>
      <button class="btn btn-gold" id="m-save">保存</button>
    </div>
  `, modal => {
    modal.querySelector("#m-save").onclick = () => {
      const date = modal.querySelector("#f-date").value;
      const opponent = modal.querySelector("#f-opp").value.trim();
      if (!date || !opponent) { toast("日付と相手チームは必須です"); return; }
      const data = {
        date, opponent,
        place: modal.querySelector("#f-place").value.trim(),
        scoreFor: +modal.querySelector("#f-for").value || 0,
        scoreAgainst: +modal.querySelector("#f-against").value || 0,
        note: modal.querySelector("#f-note").value.trim()
      };
      let rec;
      if (gid) { rec = gameById(gid); Object.assign(rec, data); }
      else { rec = { id: uid(), ...data }; db.games.push(rec); }
      pushOps([{ action: "upsert", collection: "games", record: rec }]);
      currentSeason = date.slice(0, 4);
      saveDB(); closeModal(); render(); toast("保存しました");
    };
    const del = modal.querySelector("#m-delete");
    if (del) del.onclick = () => {
      if (!confirm("この試合と、紐づく全成績を削除しますか？")) return;
      db.games = db.games.filter(x => x.id !== gid);
      db.batting = db.batting.filter(x => x.gameId !== gid);
      db.pitching = db.pitching.filter(x => x.gameId !== gid);
      pushOps([
        { action: "delete", collection: "games", id: gid },
        { action: "deleteWhere", collection: "batting", field: "gameId", value: gid },
        { action: "deleteWhere", collection: "pitching", field: "gameId", value: gid }
      ]);
      saveDB(); closeModal(); render(); toast("削除しました");
    };
  });
}

function numField(id, label, value) {
  return `<div class="field"><label>${label}</label><input id="${id}" type="number" min="0" inputmode="numeric" value="${value ?? 0}"></div>`;
}

function playerSelectHTML(id, selectedPid, excludeIds) {
  const opts = db.players
    .filter(p => p.active !== false || p.id === selectedPid)
    .filter(p => !excludeIds.has(p.id) || p.id === selectedPid)
    .sort((a, b) => (+a.number || 999) - (+b.number || 999))
    .map(p => `<option value="${p.id}" ${p.id === selectedPid ? "selected" : ""}>${esc(playerLabel(p))}</option>`);
  return `<select id="${id}"><option value="">選手を選択…</option>${opts.join("")}</select>`;
}

function openBatLineModal(gameId, lineId) {
  const g = gameById(gameId);
  const line = lineId ? db.batting.find(l => l.id === lineId) : {};
  const entered = new Set(db.batting.filter(l => l.gameId === gameId).map(l => l.playerId));
  if (db.players.length === 0) { toast("先に選手を登録してください"); return; }
  openModal(`
    <h3>打撃成績 — ${esc(g.date)} vs ${esc(g.opponent)}</h3>
    <div class="form-grid">
      <div class="field wide"><label>選手 *</label>${playerSelectHTML("f-player", line.playerId, entered)}</div>
      <div class="form-section-label">打撃</div>
      ${numField("f-AB", "打数", line.AB)}
      ${numField("f-H", "安打", line.H)}
      ${numField("f-D2", "二塁打", line.D2)}
      ${numField("f-T3", "三塁打", line.T3)}
      ${numField("f-HR", "本塁打", line.HR)}
      ${numField("f-RBI", "打点", line.RBI)}
      ${numField("f-R", "得点", line.R)}
      ${numField("f-BB", "四球", line.BB)}
      ${numField("f-HBP", "死球", line.HBP)}
      ${numField("f-SO", "三振", line.SO)}
      ${numField("f-SH", "犠打", line.SH)}
      ${numField("f-SF", "犠飛", line.SF)}
      ${numField("f-GDP", "併殺打", line.GDP)}
      <div class="form-section-label">走塁</div>
      ${numField("f-SB", "盗塁", line.SB)}
      ${numField("f-CS", "盗塁死", line.CS)}
    </div>
    <div class="table-note">打席数は自動計算されます（打数＋四死球＋犠打・犠飛）。安打には二塁打・三塁打・本塁打も含めた総数を入力してください。</div>
    <div class="modal-actions">
      ${lineId ? `<button class="btn btn-danger" id="m-delete">削除</button>` : ""}
      <button class="btn" id="m-cancel">キャンセル</button>
      <button class="btn btn-gold" id="m-save">保存</button>
    </div>
  `, modal => {
    modal.querySelector("#m-save").onclick = () => {
      const pid = modal.querySelector("#f-player").value;
      if (!pid) { toast("選手を選択してください"); return; }
      const v = k => Math.max(0, +modal.querySelector("#f-" + k).value || 0);
      const data = { playerId: pid, gameId };
      ["AB","H","D2","T3","HR","RBI","R","BB","HBP","SO","SH","SF","GDP","SB","CS"].forEach(k => data[k] = v(k));
      if (data.H > data.AB) { toast("安打が打数を超えています"); return; }
      if (data.D2 + data.T3 + data.HR > data.H) { toast("長打の合計が安打数を超えています"); return; }
      let rec;
      if (lineId) { rec = db.batting.find(l => l.id === lineId); Object.assign(rec, data); }
      else { rec = { id: uid(), ...data }; db.batting.push(rec); }
      pushOps([{ action: "upsert", collection: "batting", record: rec }]);
      saveDB(); closeModal(); render(); toast("保存しました");
    };
    const del = modal.querySelector("#m-delete");
    if (del) del.onclick = () => {
      db.batting = db.batting.filter(l => l.id !== lineId);
      pushOps([{ action: "delete", collection: "batting", id: lineId }]);
      saveDB(); closeModal(); render(); toast("削除しました");
    };
  });
}

function openPitLineModal(gameId, lineId) {
  const g = gameById(gameId);
  const line = lineId ? db.pitching.find(l => l.id === lineId) : {};
  const entered = new Set(db.pitching.filter(l => l.gameId === gameId).map(l => l.playerId));
  if (db.players.length === 0) { toast("先に選手を登録してください"); return; }
  const ipWhole = Math.floor((line.OUTS || 0) / 3);
  const ipFrac = (line.OUTS || 0) % 3;
  const dec = line.W ? "W" : line.L ? "L" : line.SV ? "SV" : line.HLD ? "HLD" : "";
  openModal(`
    <h3>投手成績 — ${esc(g.date)} vs ${esc(g.opponent)}</h3>
    <div class="form-grid">
      <div class="field wide"><label>選手 *</label>${playerSelectHTML("f-player", line.playerId, entered)}</div>
      <div class="field"><label>先発</label>
        <select id="f-GS"><option value="0" ${!line.GS ? "selected" : ""}>リリーフ</option><option value="1" ${line.GS ? "selected" : ""}>先発</option></select></div>
      <div class="field"><label>勝敗</label>
        <select id="f-dec">
          <option value="" ${dec === "" ? "selected" : ""}>なし</option>
          <option value="W" ${dec === "W" ? "selected" : ""}>勝利</option>
          <option value="L" ${dec === "L" ? "selected" : ""}>敗戦</option>
          <option value="SV" ${dec === "SV" ? "selected" : ""}>セーブ</option>
          <option value="HLD" ${dec === "HLD" ? "selected" : ""}>ホールド</option>
        </select></div>
      <div class="form-section-label">投球内容</div>
      ${numField("f-ip-whole", "投球回", ipWhole)}
      <div class="field"><label>端数（アウト）</label>
        <select id="f-ip-frac">${[0, 1, 2].map(x => `<option value="${x}" ${ipFrac === x ? "selected" : ""}>${x}/3</option>`).join("")}</select></div>
      ${numField("f-BF", "対戦打者", line.BF)}
      ${numField("f-HA", "被安打", line.HA)}
      ${numField("f-HRA", "被本塁打", line.HRA)}
      ${numField("f-BBA", "与四球", line.BBA)}
      ${numField("f-HBPA", "与死球", line.HBPA)}
      ${numField("f-SOA", "奪三振", line.SOA)}
      ${numField("f-RA", "失点", line.RA)}
      ${numField("f-ER", "自責点", line.ER)}
    </div>
    <div class="table-note">対戦打者数を入れると K% / BB% / 被打率 が算出できます（不明なら0のままでOK）。</div>
    <div class="modal-actions">
      ${lineId ? `<button class="btn btn-danger" id="m-delete">削除</button>` : ""}
      <button class="btn" id="m-cancel">キャンセル</button>
      <button class="btn btn-gold" id="m-save">保存</button>
    </div>
  `, modal => {
    modal.querySelector("#m-save").onclick = () => {
      const pid = modal.querySelector("#f-player").value;
      if (!pid) { toast("選手を選択してください"); return; }
      const v = k => Math.max(0, +modal.querySelector("#f-" + k).value || 0);
      const decVal = modal.querySelector("#f-dec").value;
      const data = {
        playerId: pid, gameId,
        GS: +modal.querySelector("#f-GS").value,
        OUTS: v("ip-whole") * 3 + (+modal.querySelector("#f-ip-frac").value),
        BF: v("BF"), HA: v("HA"), HRA: v("HRA"), BBA: v("BBA"), HBPA: v("HBPA"),
        SOA: v("SOA"), RA: v("RA"), ER: v("ER"),
        W: decVal === "W" ? 1 : 0, L: decVal === "L" ? 1 : 0,
        SV: decVal === "SV" ? 1 : 0, HLD: decVal === "HLD" ? 1 : 0
      };
      if (data.ER > data.RA) { toast("自責点が失点を超えています"); return; }
      let rec;
      if (lineId) { rec = db.pitching.find(l => l.id === lineId); Object.assign(rec, data); }
      else { rec = { id: uid(), ...data }; db.pitching.push(rec); }
      pushOps([{ action: "upsert", collection: "pitching", record: rec }]);
      saveDB(); closeModal(); render(); toast("保存しました");
    };
    const del = modal.querySelector("#m-delete");
    if (del) del.onclick = () => {
      db.pitching = db.pitching.filter(l => l.id !== lineId);
      pushOps([{ action: "delete", collection: "pitching", id: lineId }]);
      saveDB(); closeModal(); render(); toast("削除しました");
    };
  });
}

/* ---------- 打撃成績テーブル ---------- */

const BAT_COLS_BASIC = [
  ["G", "試合", fmtInt], ["PA", "打席", fmtInt], ["AB", "打数", fmtInt], ["R", "得点", fmtInt],
  ["H", "安打", fmtInt], ["D2", "二塁打", fmtInt], ["T3", "三塁打", fmtInt], ["HR", "本塁打", fmtInt],
  ["TB", "塁打", fmtInt], ["RBI", "打点", fmtInt], ["SB", "盗塁", fmtInt],
  ["BB", "四球", fmtInt], ["HBP", "死球", fmtInt], ["SO", "三振", fmtInt],
  ["AVG", "打率", fmtAvg], ["OBP", "出塁率", fmtAvg], ["SLG", "長打率", fmtAvg], ["OPS", "OPS", v => v === null ? "-" : v.toFixed(3)]
];

const BAT_COLS_ADV = [
  ["PA", "打席", fmtInt],
  ["OPS", "OPS", v => v === null ? "-" : v.toFixed(3)],
  ["ISO", "ISO", fmtAvg], ["BABIP", "BABIP", fmtAvg],
  ["BBpct", "BB%", fmtPct], ["Kpct", "K%", fmtPct], ["BBK", "BB/K", fmtNum2],
  ["wOBA", "wOBA", fmtAvg], ["wRAA", "wRAA", v => v === null ? "-" : v.toFixed(1)],
  ["wRC", "wRC", v => v === null ? "-" : v.toFixed(1)],
  ["wRCplus", "wRC+", fmtPlus], ["OPSplus", "OPS+", fmtPlus],
  ["XBH", "長打", fmtInt], ["GDP", "併殺", fmtInt],
  ["SBpct", "盗塁成功率", fmtPct], ["SH", "犠打", fmtInt], ["SF", "犠飛", fmtInt]
];

function renderBattingTab() {
  const el = document.getElementById("tab-batting");
  const { rows, team } = aggregateBatting();
  const cols = battingMode === "basic" ? BAT_COLS_BASIC : BAT_COLS_ADV;
  const st = sortState.batting;
  const qPA = qualPA();

  rows.sort((a, b) => {
    const av = a[st.key], bv = b[st.key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av - bv) * st.dir;
  });

  el.innerHTML = `
    <div class="toolbar">
      <div class="section-title" style="margin:0;border:none;">打撃成績</div>
      <div class="spacer"></div>
      <div class="seg">
        <button class="${battingMode === "basic" ? "active" : ""}" data-mode="basic">基本</button>
        <button class="${battingMode === "adv" ? "active" : ""}" data-mode="adv">アドバンスト</button>
      </div>
      <button class="btn btn-sm" id="btn-csv-bat">CSV出力</button>
    </div>
    ${rows.length === 0 ? `<div class="empty-note">打撃成績がまだありません。「試合・入力」タブから入力してください。</div>` : `
    <div class="table-wrap">
      <table class="stats" id="bat-table">
        <thead><tr>
          <th data-key="">選手</th>
          ${cols.map(([k, label]) => `<th data-key="${k}" class="${st.key === k ? "sorted" + (st.dir === 1 ? " asc" : "") : ""}">${label}</th>`).join("")}
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr class="${r.PA < qPA ? "unqualified" : ""}">
              <td><span class="pname" data-pid="${r.player.id}"><span class="pnum">${esc(r.player.number ?? "")}</span>${esc(r.player.name)}</span></td>
              ${cols.map(([k, , fmt]) => `<td class="num">${fmt(r[k])}</td>`).join("")}
            </tr>`).join("")}
          <tr class="total-row">
            <td>チーム合計</td>
            ${cols.map(([k, , fmt]) => `<td class="num">${["wRAA","wRC","wRCplus","OPSplus"].includes(k) ? "-" : fmt(team[k])}</td>`).join("")}
          </tr>
        </tbody>
      </table>
    </div>
    <div class="table-note">グレー表示は規定打席（${qPA.toFixed(0)}打席）未満。wRC+ / OPS+ / wRAA はチーム全体を基準(=100)とした相対値。列ヘッダのクリックでソートできます。</div>`}
  `;

  el.querySelectorAll(".seg button").forEach(b => b.onclick = () => { battingMode = b.dataset.mode; renderBattingTab(); });
  el.querySelectorAll("th[data-key]").forEach(th => th.onclick = () => {
    const k = th.dataset.key;
    if (!k) return;
    if (st.key === k) st.dir *= -1; else { st.key = k; st.dir = -1; }
    renderBattingTab();
  });
  el.querySelectorAll(".pname").forEach(n => n.onclick = () => openPlayerDetail(n.dataset.pid));
  const csv = el.querySelector("#btn-csv-bat");
  if (csv) csv.onclick = () => exportTableCSV(cols, rows, "batting");
}

/* ---------- 投手成績テーブル ---------- */

const PIT_COLS_BASIC = [
  ["G", "登板", fmtInt], ["GS", "先発", fmtInt], ["W", "勝", fmtInt], ["L", "敗", fmtInt],
  ["SV", "S", fmtInt], ["HLD", "HLD", fmtInt],
  ["OUTS", "投球回", v => fmtIP(v)], ["BF", "打者", fmtInt],
  ["HA", "被安打", fmtInt], ["HRA", "被本塁打", fmtInt], ["BBA", "与四球", fmtInt],
  ["HBPA", "与死球", fmtInt], ["SOA", "奪三振", fmtInt], ["RA", "失点", fmtInt], ["ER", "自責点", fmtInt],
  ["ERA", "防御率", fmtNum2], ["WHIP", "WHIP", fmtNum2]
];

const PIT_COLS_ADV = [
  ["OUTS", "投球回", v => fmtIP(v)],
  ["ERA", "防御率", fmtNum2], ["FIP", "FIP", fmtNum2], ["RA9", "RA", fmtNum2],
  ["K9", "K/9", fmtNum2], ["BB9", "BB/9", fmtNum2], ["HR9", "HR/9", fmtNum2],
  ["Kpct", "K%", fmtPct], ["BBpct", "BB%", fmtPct], ["KBBpct", "K-BB%", fmtPct],
  ["KBB", "K/BB", fmtNum2], ["AVGA", "被打率", fmtAvg],
  ["LOBpct", "LOB%", fmtPct], ["WPCT", "勝率", fmtAvg]
];

function renderPitchingTab() {
  const el = document.getElementById("tab-pitching");
  const { rows, team } = aggregatePitching();
  const cols = pitchingMode === "basic" ? PIT_COLS_BASIC : PIT_COLS_ADV;
  const st = sortState.pitching;
  const qOuts = qualOuts();

  rows.sort((a, b) => {
    const av = a[st.key], bv = b[st.key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av - bv) * st.dir;
  });

  el.innerHTML = `
    <div class="toolbar">
      <div class="section-title" style="margin:0;border:none;">投手成績 <span class="sub">防御率は${db.settings.eraBasis}回換算</span></div>
      <div class="spacer"></div>
      <div class="seg">
        <button class="${pitchingMode === "basic" ? "active" : ""}" data-mode="basic">基本</button>
        <button class="${pitchingMode === "adv" ? "active" : ""}" data-mode="adv">アドバンスト</button>
      </div>
      <button class="btn btn-sm" id="btn-csv-pit">CSV出力</button>
    </div>
    ${rows.length === 0 ? `<div class="empty-note">投手成績がまだありません。「試合・入力」タブから入力してください。</div>` : `
    <div class="table-wrap">
      <table class="stats">
        <thead><tr>
          <th data-key="">選手</th>
          ${cols.map(([k, label]) => `<th data-key="${k}" class="${st.key === k ? "sorted" + (st.dir === 1 ? " asc" : "") : ""}">${label}</th>`).join("")}
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr class="${r.OUTS < qOuts ? "unqualified" : ""}">
              <td><span class="pname" data-pid="${r.player.id}"><span class="pnum">${esc(r.player.number ?? "")}</span>${esc(r.player.name)}</span></td>
              ${cols.map(([k, , fmt]) => `<td class="num">${fmt(r[k])}</td>`).join("")}
            </tr>`).join("")}
          <tr class="total-row">
            <td>チーム合計</td>
            ${cols.map(([k, , fmt]) => `<td class="num">${fmt(team[k])}</td>`).join("")}
          </tr>
        </tbody>
      </table>
    </div>
    <div class="table-note">グレー表示は規定投球回（${(qOuts / 3).toFixed(0)}回）未満。FIP の定数はチーム全体の防御率に合わせて補正しています。K% / BB% / 被打率 は対戦打者数の入力が必要です。</div>`}
  `;

  el.querySelectorAll(".seg button").forEach(b => b.onclick = () => { pitchingMode = b.dataset.mode; renderPitchingTab(); });
  el.querySelectorAll("th[data-key]").forEach(th => th.onclick = () => {
    const k = th.dataset.key;
    if (!k) return;
    if (st.key === k) st.dir *= -1;
    else { st.key = k; st.dir = ["ERA", "FIP", "WHIP", "BB9", "HR9", "BBpct", "RA9", "AVGA"].includes(k) ? 1 : -1; }
    renderPitchingTab();
  });
  el.querySelectorAll(".pname").forEach(n => n.onclick = () => openPlayerDetail(n.dataset.pid));
  const csv = el.querySelector("#btn-csv-pit");
  if (csv) csv.onclick = () => exportTableCSV(cols, rows, "pitching");
}

function exportTableCSV(cols, rows, name) {
  const head = ["選手", ...cols.map(c => c[1])].join(",");
  const body = rows.map(r =>
    [`"${r.player.name}"`, ...cols.map(([k, , fmt]) => `"${fmt(r[k])}"`)].join(",")).join("\n");
  const blob = new Blob(["﻿" + head + "\n" + body], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `padres-${name}-${currentSeason || "all"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 設定・データ ---------- */

function syncCardHTML() {
  if (!syncEnabled()) {
    return `
    <div class="data-card">
      <h4>チーム共有（スプレッドシート連携）</h4>
      <p>Google スプレッドシートをチーム共通の保存先にすると、<b>誰が入力しても全員に反映</b>されます。
      未接続の間、データはこの端末のブラウザ内にのみ保存されます。</p>
      <details style="margin-bottom:12px;">
        <summary style="cursor:pointer;color:var(--gold);font-size:13px;">セットアップ手順（チームで1回だけ・約10分）</summary>
        <ol class="setup-steps">
          <li><a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a> で空のスプレッドシートを作成</li>
          <li>メニュー「拡張機能」→「Apps Script」を開く</li>
          <li>リポジトリの <code>apps-script/Code.gs</code> の内容を貼り付けて保存し、冒頭の <code>TOKEN</code> を好きな合言葉に変更</li>
          <li>「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」/ 実行ユーザー「自分」/ アクセス「全員」でデプロイ（初回は権限を承認）</li>
          <li>発行された「ウェブアプリのURL」と合言葉を下に入力して接続</li>
        </ol>
      </details>
      <div class="form-grid">
        <div class="field wide"><label>ウェブアプリのURL</label><input id="sync-url" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="field wide"><label>合言葉（Code.gs の TOKEN）</label><input id="sync-token"></div>
      </div>
      <div class="modal-actions" style="margin-top:12px;"><button class="btn btn-gold" id="btn-sync-connect">接続</button></div>
    </div>`;
  }
  const st = syncStatus.state === "error"
    ? `<span style="color:var(--danger);">⚠ 同期エラー: ${esc(syncStatus.message)}（未送信の変更は自動で再送されます）</span>`
    : `<span style="color:var(--ok);">✓ 接続中</span>`;
  const ver = syncServerVersion === null
    ? ""
    : syncServerVersion === SYNC_EXPECTED_VERSION
      ? `<br><span style="color:var(--ok);">Code.gs 版数: ${esc(syncServerVersion)}（最新）</span>`
      : `<br><span style="color:var(--danger);">⚠ Code.gs 版数: ${esc(syncServerVersion)}（最新は ${SYNC_EXPECTED_VERSION}）。
         Apps Scriptに最新のCode.gsを貼り付けて保存し、「デプロイを管理」→鉛筆→バージョン「新バージョン」で再デプロイしてください</span>`;
  return `
    <div class="data-card">
      <h4>チーム共有（スプレッドシート連携）</h4>
      <p>${st}${ver}<br>保存先: <code style="word-break:break-all;">${esc(syncConf.url)}</code></p>
      <p>チームメイトには下の「共有用リンク」を送ってください。開くだけで同じ共有データに接続されます（合言葉入力も不要）。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-gold" id="btn-sync-share">共有用リンクをコピー</button>
        <button class="btn" id="btn-sync-now">今すぐ同期</button>
        <button class="btn btn-danger" id="btn-sync-disconnect">接続を解除</button>
      </div>
    </div>`;
}

function renderDataTab() {
  const el = document.getElementById("tab-data");
  const s = db.settings;
  el.innerHTML = `
    <div class="section-title">チーム共有</div>
    ${syncCardHTML()}
    <div class="section-title">設定</div>
    <div class="data-card">
      <div class="form-grid">
        <div class="field"><label>規定打席（1試合あたり）</label><input id="s-qpa" type="number" step="0.1" min="0" value="${s.qualPAperG}"></div>
        <div class="field"><label>規定投球回（1試合あたり）</label><input id="s-qip" type="number" step="0.1" min="0" value="${s.qualIPperG}"></div>
        <div class="field"><label>防御率の基準回</label>
          <select id="s-era"><option value="9" ${s.eraBasis === 9 ? "selected" : ""}>9回換算（MLB/NPB標準）</option><option value="7" ${s.eraBasis === 7 ? "selected" : ""}>7回換算（草野球向け）</option></select></div>
      </div>
      <div class="modal-actions" style="margin-top:12px;"><button class="btn btn-gold" id="s-save">設定を保存</button></div>
    </div>

    <div class="section-title">データ管理</div>
    <div class="data-card">
      <h4>バックアップ</h4>
      <p>${syncEnabled()
        ? "データは共有スプレッドシートに保存されています(この端末にもキャッシュされます)。JSON書き出しは手元にバックアップを残したいときに使ってください。"
        : "データはこのブラウザの localStorage に保存されています。機種変更やバックアップには JSON の書き出し・読み込みを使ってください。"}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-gold" id="btn-export">JSON書き出し</button>
        <button class="btn" id="btn-import">JSON読み込み</button>
        <input type="file" id="file-import" accept=".json" style="display:none;">
      </div>
    </div>
    <div class="data-card">
      <h4>サンプルデータ</h4>
      <p>アプリの動作を確認するためのデモ用データ（選手8名・試合3つ）を読み込みます。</p>
      <button class="btn" id="btn-sample">サンプルデータを読み込む</button>
    </div>
    <div class="data-card">
      <h4>全データ削除</h4>
      <p>選手・試合・成績・設定をすべて初期化します。この操作は元に戻せません。</p>
      <button class="btn btn-danger" id="btn-reset">全データを削除</button>
    </div>

    <div class="section-title">指標の説明</div>
    <div class="data-card glossary">
      <dl>
        <dt>OPS</dt><dd>出塁率＋長打率。打者の総合力の定番指標。</dd>
        <dt>ISO</dt><dd>長打率−打率。純粋な長打力。</dd>
        <dt>BABIP</dt><dd>本塁打を除くインプレー打球が安打になった割合。運や打球の質の目安。</dd>
        <dt>wOBA</dt><dd>四球〜本塁打まで各イベントの得点価値で重み付けした出塁指標。MLBで打者評価の主流。</dd>
        <dt>wRC+</dt><dd>wOBAベースの得点創出力。チーム平均=100で、130なら平均より30%多く得点を生んだ計算。</dd>
        <dt>OPS+</dt><dd>OPSをチーム平均=100に補正した相対値。</dd>
        <dt>K% / BB%</dt><dd>打席あたりの三振率・四球率。</dd>
        <dt>WHIP</dt><dd>1イニングあたりに許した走者数（被安打＋与四球）。</dd>
        <dt>FIP</dt><dd>守備の影響を除いた「投手が直接責任を持つ結果」（HR・四死球・三振）だけで算出する防御率相当値。</dd>
        <dt>K-BB%</dt><dd>奪三振率−与四球率。投手の支配力を示す近年重視の指標。</dd>
        <dt>LOB%</dt><dd>出した走者を残塁させた割合。</dd>
      </dl>
    </div>
  `;

  // ---- チーム共有 ----
  const connectBtn = el.querySelector("#btn-sync-connect");
  if (connectBtn) connectBtn.onclick = async () => {
    const url = el.querySelector("#sync-url").value;
    const token = el.querySelector("#sync-token").value;
    if (!url.trim()) { toast("ウェブアプリのURLを入力してください"); return; }
    connectBtn.disabled = true;
    connectBtn.textContent = "接続中…";
    try {
      await connectSync(url, token);
      toast("チーム共有に接続しました");
      renderDataTab();
    } catch (e) {
      toast("接続に失敗しました: " + e.message);
      connectBtn.disabled = false;
      connectBtn.textContent = "接続";
    }
  };
  const shareBtn = el.querySelector("#btn-sync-share");
  if (shareBtn) shareBtn.onclick = async () => {
    const link = syncShareLink();
    try {
      await navigator.clipboard.writeText(link);
      toast("共有用リンクをコピーしました。LINEなどで送ってください");
    } catch (e) {
      prompt("このリンクをコピーして共有してください", link);
    }
  };
  const nowBtn = el.querySelector("#btn-sync-now");
  if (nowBtn) nowBtn.onclick = () => syncPull(false);
  const discBtn = el.querySelector("#btn-sync-disconnect");
  if (discBtn) discBtn.onclick = () => {
    if (!confirm("共有への接続を解除しますか？\n(共有データは残ります。この端末は現在の内容のままローカル保存に戻ります)")) return;
    disconnectSync();
    renderDataTab();
    toast("接続を解除しました");
  };

  el.querySelector("#s-save").onclick = () => {
    db.settings.qualPAperG = Math.max(0, +el.querySelector("#s-qpa").value || 0);
    db.settings.qualIPperG = Math.max(0, +el.querySelector("#s-qip").value || 0);
    db.settings.eraBasis = +el.querySelector("#s-era").value;
    pushOps([{ action: "saveSettings", settings: db.settings }]);
    saveDB(); toast("設定を保存しました");
  };

  el.querySelector("#btn-export").onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `setagaya-padres-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  el.querySelector("#btn-import").onclick = () => el.querySelector("#file-import").click();
  el.querySelector("#file-import").onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.players) || !Array.isArray(parsed.games)) throw new Error("形式が不正です");
        if (!confirm("現在のデータを読み込んだ内容で置き換えます。よろしいですか？")) return;
        db = { ...structuredClone(DEFAULT_DB), ...parsed,
               settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) } };
        if (syncEnabled() && confirm("読み込んだ内容で共有データ(スプレッドシート)も置き換えますか？\n(キャンセルすると次の同期で共有データ側の内容に戻ります)")) {
          pushOps([{ action: "replaceAll", db: exportableDb() }]);
        }
        saveDB(); currentSeason = ""; refreshSeasonSelect(); render(); toast("読み込みました");
      } catch (err) {
        toast("読み込みに失敗しました: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  el.querySelector("#btn-sample").onclick = () => {
    if (syncEnabled()) { toast("共有モード中はサンプルデータを読み込めません(共有データを上書きしてしまうため)"); return; }
    if ((db.players.length || db.games.length) &&
        !confirm("現在のデータをサンプルデータで置き換えます。よろしいですか？")) return;
    db = buildSampleData();
    saveDB(); currentSeason = ""; refreshSeasonSelect(); render(); toast("サンプルデータを読み込みました");
  };

  el.querySelector("#btn-reset").onclick = () => {
    const sharedNote = syncEnabled() ? "\n※共有データ(スプレッドシート)も空になります。" : "";
    if (!confirm("全データを削除します。よろしいですか？" + sharedNote)) return;
    if (!confirm("本当によろしいですか？ この操作は元に戻せません。")) return;
    db = structuredClone(DEFAULT_DB);
    if (syncEnabled()) pushOps([{ action: "replaceAll", db: exportableDb() }]);
    saveDB(); currentSeason = ""; refreshSeasonSelect(); render(); toast("初期化しました");
  };
}

/* ---------- サンプルデータ ---------- */

function buildSampleData() {
  const y = new Date().getFullYear();
  const P = (name, number, pos, throws, bats) => ({ id: uid(), name, number, pos, throws, bats, active: true });
  const players = [
    P("田中 圭介", 1, "投手", "右", "右"),
    P("佐藤 大樹", 18, "投手", "左", "左"),
    P("鈴木 亮", 2, "捕手", "右", "右"),
    P("高橋 翔", 3, "内野手", "右", "左"),
    P("伊藤 健", 6, "内野手", "右", "右"),
    P("渡辺 悠人", 7, "外野手", "右", "左"),
    P("山本 拓也", 9, "外野手", "左", "左"),
    P("中村 慎一", 25, "ユーティリティ", "右", "右")
  ];
  const [p1, p2, c, if1, if2, of1, of2, ut] = players.map(p => p.id);
  const G = (date, opponent, place, sf, sa) => ({ id: uid(), date, opponent, place, scoreFor: sf, scoreAgainst: sa, note: "" });
  const games = [
    G(`${y}-04-06`, "目黒ドジャース", "多摩川緑地", 7, 3),
    G(`${y}-04-20`, "杉並ジャイアンツ", "駒沢公園", 2, 5),
    G(`${y}-05-11`, "渋谷メッツ", "世田谷公園", 10, 4)
  ];
  const [g1, g2, g3] = games.map(g => g.id);
  const B = (gameId, playerId, o) => ({
    id: uid(), gameId, playerId,
    AB: 0, R: 0, H: 0, D2: 0, T3: 0, HR: 0, RBI: 0, BB: 0, HBP: 0,
    SO: 0, SH: 0, SF: 0, GDP: 0, SB: 0, CS: 0, ...o
  });
  const batting = [
    B(g1, if1, { AB: 4, H: 3, D2: 1, R: 2, RBI: 2, SB: 1 }),
    B(g1, of1, { AB: 3, H: 1, HR: 1, R: 1, RBI: 3, BB: 1 }),
    B(g1, c,   { AB: 4, H: 1, SO: 1, RBI: 1 }),
    B(g1, if2, { AB: 3, H: 2, D2: 1, R: 1, BB: 1 }),
    B(g1, of2, { AB: 4, H: 2, T3: 1, R: 2, RBI: 1, SB: 2 }),
    B(g1, ut,  { AB: 3, H: 0, SO: 2, SH: 1 }),
    B(g2, if1, { AB: 4, H: 1, SO: 1 }),
    B(g2, of1, { AB: 3, H: 0, SO: 2, BB: 1 }),
    B(g2, c,   { AB: 3, H: 1, D2: 1, RBI: 1, GDP: 1 }),
    B(g2, if2, { AB: 3, H: 1, BB: 1, R: 1 }),
    B(g2, of2, { AB: 4, H: 2, R: 1, CS: 1 }),
    B(g2, ut,  { AB: 3, H: 1, RBI: 1 }),
    B(g3, if1, { AB: 5, H: 3, D2: 2, R: 2, RBI: 3 }),
    B(g3, of1, { AB: 4, H: 2, HR: 1, R: 2, RBI: 4, BB: 1 }),
    B(g3, c,   { AB: 4, H: 2, R: 1, RBI: 1 }),
    B(g3, if2, { AB: 4, H: 1, SF: 1, RBI: 1, R: 1 }),
    B(g3, of2, { AB: 5, H: 3, R: 2, SB: 1, RBI: 1 }),
    B(g3, ut,  { AB: 4, H: 1, HBP: 1, R: 2, SO: 1 })
  ];
  const Pt = (gameId, playerId, o) => ({
    id: uid(), gameId, playerId,
    GS: 0, OUTS: 0, BF: 0, HA: 0, HRA: 0, BBA: 0, HBPA: 0, SOA: 0,
    RA: 0, ER: 0, W: 0, L: 0, SV: 0, HLD: 0, ...o
  });
  const pitching = [
    Pt(g1, p1, { GS: 1, OUTS: 15, BF: 22, HA: 4, BBA: 2, SOA: 7, RA: 2, ER: 2, W: 1 }),
    Pt(g1, p2, { OUTS: 6, BF: 8, HA: 1, BBA: 0, SOA: 3, RA: 1, ER: 1, SV: 1 }),
    Pt(g2, p2, { GS: 1, OUTS: 12, BF: 21, HA: 6, HRA: 1, BBA: 3, SOA: 4, RA: 4, ER: 3, L: 1 }),
    Pt(g2, ut,  { OUTS: 6, BF: 9, HA: 2, BBA: 1, SOA: 1, RA: 1, ER: 1 }),
    Pt(g3, p1, { GS: 1, OUTS: 18, BF: 26, HA: 5, HRA: 1, BBA: 1, HBPA: 1, SOA: 9, RA: 3, ER: 3, W: 1 }),
    Pt(g3, p2, { OUTS: 3, BF: 4, HA: 1, SOA: 2, RA: 1, ER: 1 })
  ];
  return { ...structuredClone(DEFAULT_DB), players, games, batting, pitching };
}

/* ---------- モーダル ---------- */

function openModal(html, setup, wideOK) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="overlay"><div class="modal" ${wideOK ? 'style="max-width:760px;"' : ""}>${html}</div></div>`;
  const overlay = root.querySelector(".overlay");
  const modal = root.querySelector(".modal");
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) closeModal(); });
  const cancel = modal.querySelector("#m-cancel");
  if (cancel) cancel.onclick = closeModal;
  if (setup) setup(modal);
  const first = modal.querySelector("input, select");
  if (first) first.focus();
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

/* ---------- 初期化 ---------- */

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.onclick = () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach(p =>
      p.classList.toggle("active", p.id === "tab-" + currentTab));
    render();
  };
});

document.getElementById("season-select").onchange = e => {
  currentSeason = e.target.value;
  render();
};

document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

refreshSeasonSelect();
render();
initSync();
