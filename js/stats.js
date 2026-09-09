/* ============================================================
   stats.js — 成績集計・指標計算エンジン
   打撃: AVG / OBP / SLG / OPS / ISO / BABIP / BB% / K% / BB/K /
         wOBA / wRAA / wRC / wRC+ / OPS+ / SB% など
   投手: ERA / WHIP / K/9 / BB/9 / HR/9 / K% / BB% / K-BB% /
         K/BB / FIP / 被打率 / LOB% など
   wOBA係数は FanGraphs 公表の近年係数を使用。
   リーグ環境が存在しないため、wRC+ / OPS+ / FIP定数は
   「チーム全体をリーグとみなした」チーム基準の相対値。
   ============================================================ */

const W = { BB: 0.69, HBP: 0.72, S1: 0.89, D2: 1.27, T3: 1.62, HR: 2.10, SCALE: 1.24 };

const BAT_FIELDS = ["AB","R","H","D2","T3","HR","RBI","BB","HBP","SO","SH","SF","SB","CS","GDP"];
const PIT_FIELDS = ["OUTS","BF","HA","HRA","BBA","HBPA","SOA","RA","ER","W","L","SV","HLD","GS"];

function emptyBat() {
  const o = { G: 0 };
  BAT_FIELDS.forEach(f => o[f] = 0);
  return o;
}

function emptyPit() {
  const o = { G: 0 };
  PIT_FIELDS.forEach(f => o[f] = 0);
  return o;
}

function sumBat(lines) {
  const t = emptyBat();
  for (const l of lines) {
    t.G++;
    BAT_FIELDS.forEach(f => t[f] += (+l[f] || 0));
  }
  return t;
}

function sumPit(lines) {
  const t = emptyPit();
  for (const l of lines) {
    t.G++;
    PIT_FIELDS.forEach(f => t[f] += (+l[f] || 0));
  }
  return t;
}

function div(a, b) { return b > 0 ? a / b : null; }

/* ---------- 打撃派生指標 ----------
   t: 集計済みカウント, lg: チーム(リーグ代替)集計 or null */
function batDerived(t, lg) {
  const d = { ...t };
  d.PA  = t.AB + t.BB + t.HBP + t.SH + t.SF;
  d.S1  = t.H - t.D2 - t.T3 - t.HR;
  d.TB  = d.S1 + 2 * t.D2 + 3 * t.T3 + 4 * t.HR;
  d.XBH = t.D2 + t.T3 + t.HR;

  d.AVG   = div(t.H, t.AB);
  d.OBP   = div(t.H + t.BB + t.HBP, t.AB + t.BB + t.HBP + t.SF);
  d.SLG   = div(d.TB, t.AB);
  d.OPS   = (d.OBP !== null && d.SLG !== null) ? d.OBP + d.SLG : null;
  d.ISO   = (d.SLG !== null && d.AVG !== null) ? d.SLG - d.AVG : null;
  d.BABIP = div(t.H - t.HR, t.AB - t.SO - t.HR + t.SF);
  d.BBpct = div(t.BB, d.PA);
  d.Kpct  = div(t.SO, d.PA);
  d.BBK   = div(t.BB, t.SO);
  d.SBpct = div(t.SB, t.SB + t.CS);

  const wobaDen = t.AB + t.BB + t.HBP + t.SF;
  d.wOBA = div(
    W.BB * t.BB + W.HBP * t.HBP + W.S1 * d.S1 + W.D2 * t.D2 + W.T3 * t.T3 + W.HR * t.HR,
    wobaDen
  );

  // チーム基準の相対指標(リーグ代替)
  d.wRAA = null; d.wRC = null; d.wRCplus = null; d.OPSplus = null;
  if (lg && lg !== t) {
    const L = batDerived(lg, null);
    if (d.wOBA !== null && L.wOBA !== null && d.PA > 0 && L.PA > 0 && L.R > 0) {
      const lgRPA = L.R / L.PA;
      d.wRAA = (d.wOBA - L.wOBA) / W.SCALE * d.PA;
      d.wRC  = d.wRAA + lgRPA * d.PA;
      d.wRCplus = ((d.wRAA / d.PA + lgRPA) / lgRPA) * 100;
    }
    if (d.OBP !== null && d.SLG !== null && L.OBP > 0 && L.SLG > 0) {
      d.OPSplus = (d.OBP / L.OBP + d.SLG / L.SLG - 1) * 100;
    }
  }
  return d;
}

/* ---------- 投手派生指標 ----------
   t: 集計済み, lg: チーム集計 or null, eraBasis: 防御率の基準回(9 or 7) */
function pitDerived(t, lg, eraBasis) {
  const d = { ...t };
  const B = eraBasis || 9;
  const ip = t.OUTS / 3;
  d.IP = ip;

  d.ERA   = div(t.ER * B, ip);
  d.RA9   = div(t.RA * B, ip);
  d.WHIP  = div(t.HA + t.BBA, ip);
  d.K9    = div(t.SOA * B, ip);
  d.BB9   = div(t.BBA * B, ip);
  d.HR9   = div(t.HRA * B, ip);
  d.KBB   = div(t.SOA, t.BBA);
  d.Kpct  = div(t.SOA, t.BF);
  d.BBpct = div(t.BBA, t.BF);
  d.KBBpct = (d.Kpct !== null && d.BBpct !== null) ? d.Kpct - d.BBpct : null;
  d.AVGA  = div(t.HA, Math.max(0, t.BF - t.BBA - t.HBPA));
  d.WPCT  = div(t.W, t.W + t.L);

  // LOB% = (H+BB+HBP-R) / (H+BB+HBP-1.4*HR)
  const lobDen = t.HA + t.BBA + t.HBPA - 1.4 * t.HRA;
  d.LOBpct = lobDen > 0 ? (t.HA + t.BBA + t.HBPA - t.RA) / lobDen : null;

  // FIP: 定数はチーム全体の ERA-FIPcore 差から算出(リーグ代替)。データ不足時は3.10
  let fipC = 3.10;
  if (lg && lg.OUTS >= 27) {
    const lgIP = lg.OUTS / 3;
    const lgERA = lg.ER * B / lgIP;
    const lgCore = (13 * lg.HRA + 3 * (lg.BBA + lg.HBPA) - 2 * lg.SOA) / lgIP;
    fipC = lgERA - lgCore;
  }
  d.FIP = ip > 0 ? (13 * t.HRA + 3 * (t.BBA + t.HBPA) - 2 * t.SOA) / ip + fipC : null;

  return d;
}

/* ---------- 表示フォーマット ---------- */
function fmtAvg(v)  { return v === null ? "-" : (v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, "")); }
function fmtNum2(v) { return v === null ? "-" : v.toFixed(2); }
function fmtPct(v)  { return v === null ? "-" : (v * 100).toFixed(1) + "%"; }
function fmtInt(v)  { return v === null || v === undefined ? "-" : String(Math.round(v)); }
function fmtPlus(v) { return v === null ? "-" : String(Math.round(v)); }
function fmtIP(outs) {
  const w = Math.floor(outs / 3), r = outs % 3;
  return r === 0 ? `${w}.0` : `${w}.${r}`;
}
