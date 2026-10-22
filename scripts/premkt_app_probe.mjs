#!/usr/bin/env node
/**
 * 🌅 V79.5.4 盤前體檢分數 ——「App 真的在用的那條」逐日重建(2010 起)
 *
 * 10/22 使用者:「原本的預判準確度跑掉了,有辦法修正還是評分的方式比重要調整嗎?」
 * 以前的回測(premkt_probe.py STRICT 8 項)跟 App 公式不一樣(App 多了道瓊 / 恆指 / 日月光聯電 ADR / 美債 / 台幣 / 亞幣…,
 * VIX 與亞股的分段也不同)→「App 現在這條」從來沒有整體回測過。這支 ⛔ 不抄公式:載入 index.html,
 * 每一天呼叫 App 自己的 `_preOpenScore`,「資料是不是舊了」也用 App 自己的 `_premktFieldAge`。
 *
 * ⏰ 時間對齊(錯了整份作廢):台股 D 日開盤前看得到的 = 每個海外市場「D 之前最近一個交易日」的收盤
 *    (美股 D−1 收盤 = 台北 D 日凌晨;日韓港 D−1 收盤)。⛔ 不可用 D 日的海外資料(前視)。
 * 🎯 結果用 0050 真的開盤 / 收盤(陷阱 #47:⛔ 加權的開盤價是湊出來的);0050 除息日整天剔除。
 * ⛔ 沒有歷史 = 0 分(照實寫出來):台指期夜盤、恐懼貪婪、那指期(App 早上拿到的是美股收盤後「晚上那 2 小時」
 *    的漂移,而且常常因為拿不到結算價不給 % → 實際上幾乎不計分;`NQ=daily` 可改用整天日線當參考上限)。
 *
 * 資料:
 *   US_HIST   us_hist.json(預設 git show origin/data:data/us_hist.json;要有 mac 區塊、2010 以前起)
 *   RAWB_LOG  premkt_probe.yml 那一輪的 job log(RAWB 緊湊格式:日經 / 韓股 / 恆指 / 台幣 / 韓元 / 人民幣)
 *             ⛔ 沒給 → 亞股與亞幣那幾項 = 0 分(會寫出來);台幣改用 us_hist 的 TWD=X
 *   B0050     0050 日 K(逗號分隔多份,先出現的優先;16 年:<d16>/_bench0050.json,再接 gh-pages data/0050.json)
 *   DIV       0050 股利(_div0050.json 格式 {d:{'0050':{h:[[除息日,…]]}}});沒給 → 不剔除除息日(會寫出來)
 *   HTML      index.html(預設 repo 那份)
 * 判準(V75.0.9):候選要「方向猜對」與「名次相關」**兩個都** ≥13/17 年比現行好才算過;
 *   「拿掉某幾項」再加逐年樣本外(每一年只看以前的年份決定拿不拿)。⛔ 這支只量,不改 App。
 * 跑法:node scripts/premkt_app_probe.mjs [--selftest]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAND = 0.3;     // 開高 / 開低的界線(%);同 premkt_probe
const SELF = process.argv.includes('--selftest');

// ── RAWB 解碼(premkt_probe.py 的緊湊格式)──────────────────────────────
export function decodeRawb(text) {
  const rows = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/RAWB\|(\w+)\|(\d+)\|(\d{4}-\d{2}-\d{2})\|([\d.]+)\|(.*)$/);
    if (!m) continue;
    const k = m[1], off = +m[2];
    (rows[k] = rows[k] || { d0: m[3], c0: +m[4], parts: {} }).parts[off] = m[5] ? m[5].trim().split(',') : [];
  }
  const out = {};
  for (const [k, r] of Object.entries(rows)) {
    const items = Object.keys(r.parts).map(Number).sort((a, b) => a - b).flatMap(o => r.parts[o]);
    let d = new Date(r.d0 + 'T00:00:00Z');
    const ser = [];   // [日期, 漲跌%]
    for (const it of items) {
      const [g, bp] = it.includes(':') ? it.split(':').map(Number) : [1, Number(it)];
      d = new Date(d.getTime() + g * 864e5);
      ser.push([d.toISOString().slice(0, 10), bp / 100]);
    }
    out[k] = ser;
  }
  return out;
}

// ── 每個海外序列:「D 之前最近一根」的漲跌 / 收盤 / 5 根累計 ──────────────
function mkSeries(pairs) {   // pairs: [[日期, 值]](已排序)
  const ds = pairs.map(p => p[0]), vs = pairs.map(p => p[1]);
  const idx = D => { let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] < D) lo = m + 1; else hi = m; } return lo - 1; };
  return { ds, vs, idx };
}
const chgFromCloses = pairs => {   // 收盤 → 逐根漲跌%(跟前一根比,同 App 的 chg_pct)
  const out = [];
  for (let i = 1; i < pairs.length; i++) if (pairs[i - 1][1] > 0 && pairs[i][1] > 0) out.push([pairs[i][0], (pairs[i][1] / pairs[i - 1][1] - 1) * 100]);
  return out;
};

export function buildInputs(src, D, prevTW, nqMode) {
  const at = (S, f) => { if (!S) return { d: null, v: null }; const i = S.idx(D); return i < 0 ? { d: null, v: null } : { d: S.ds[i], v: f ? f(S, i) : S.vs[i] }; };
  const c5 = (S, i) => { if (i < 4) return null; let p = 1; for (let j = i - 4; j <= i; j++) p *= 1 + S.vs[j] / 100; return (p - 1) * 100; };
  const r2 = v => v == null ? null : Math.round(v * 100) / 100;   // App 拿到的是兩位小數的 %
  const g = k => at(src[k]);
  const spx = g('spx'), ndx = g('ndx'), dji = g('dji'), sox = g('sox'), tsm = g('tsm'), asx = g('asx'), umc = g('umc');
  const vix = at(src.vixLvl), ust = g('ust'), nq = g('nq'), nk = g('nk'), ks = g('ks'), hs = g('hs');
  const twd = g('twd'), twd5 = at(src.twd, c5), krw5 = at(src.krw, c5), cny5 = at(src.cny, c5);
  const mr = { taiex_date: prevTW, fi_three_date: prevTW, sp500_date: spx.d,
               nikkei_date: nk.d, kospi_date: ks.d, hsi_date: hs.d, tsm_date: tsm.d, asx_date: asx.d, umc_date: umc.d };
  const x = {
    dji: r2(dji.v), ndx: r2(ndx.v), spx: r2(spx.v), sox: r2(sox.v), tsm: r2(tsm.v), asx: r2(asx.v), umc: r2(umc.v),
    vix: vix.v == null ? null : vix.v.toFixed(2), ust: r2(ust.v), nq: nqMode === 'daily' ? r2(nq.v) : null, night: null,
    nk: r2(nk.v), ks: r2(ks.v), hs: r2(hs.v), fg: null, twd: r2(twd.v), twd5: r2(twd5.v), krw5: r2(krw5.v), cny5: r2(cny5.v),
  };
  return { mr, x };
}

// ── 統計 ───────────────────────────────────────────────────────────────
export function spearman(xs, ys) {
  const rk = v => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); let i = 0;
    while (i < o.length) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let q = i; q <= j; q++) r[o[q][1]] = (i + j) / 2; i = j + 1; } return r; };
  const a = rk(xs), b = rk(ys), n = a.length; if (n < 3) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let cv = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { cv += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return va && vb ? cv / Math.sqrt(va * vb) : 0;
}
export function judge(rows, sOf) {   // 使用者看到的:開高偏多(s≥3)/ 開低偏空(s≤−3)
  let up = 0, dn = 0, upHi = 0, upLo = 0, dnLo = 0, dnHi = 0, hit = 0;
  for (const r of rows) { const s = sOf(r);
    if (s >= 3) { up++; if (r.gap > BAND) upHi++; if (r.gap < -BAND) upLo++; if (r.gap > 0) hit++; }
    else if (s <= -3) { dn++; if (r.gap < -BAND) dnLo++; if (r.gap > BAND) dnHi++; if (r.gap < 0) hit++; } }
  const c = up + dn, p = (a, b) => b ? a / b * 100 : NaN;
  return { n: rows.length, call: p(c, rows.length), up, upHi: p(upHi, up), upLo: p(upLo, up), dn, dnLo: p(dnLo, dn), dnHi: p(dnHi, dn),
           hit: p(hit, c), wrong: p(upLo + dnHi, c), rho: spearman(rows.map(sOf), rows.map(r => r.gap)), rhoIo: spearman(rows.map(sOf), rows.map(r => r.io)) };
}
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—';
const line = (lab, j) => `${lab.padEnd(22)} 講話 ${f1(j.call)}% ・開高偏多 ${String(j.up).padStart(4)} 天 真開高 ${f1(j.upHi)}% 開低 ${f1(j.upLo)}% ・開低偏空 ${String(j.dn).padStart(4)} 天 真開低 ${f1(j.dnLo)}% 開高 ${f1(j.dnHi)}% ・方向對 ${f1(j.hit)}% 開反 ${f1(j.wrong)}% ・名次相關 ${j.rho >= 0 ? '+' : ''}${j.rho.toFixed(3)}(開→收 ${j.rhoIo >= 0 ? '+' : ''}${j.rhoIo.toFixed(3)})`;

// ── 瀏覽器:App 自己的兩支函式 ────────────────────────────────────────────
async function scoreAll(days, html) {
  let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'premktapp-')), 'index.html');
  fs.writeFileSync(tmp, html);
  const page = await browser.newPage();
  await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof app !== 'undefined' && !!app._preOpenScore && !!app._premktFieldAge, null, { timeout: 30000 });
  const out = await page.evaluate(ds => ds.map(o => {
    const stale = app._premktFieldAge(o.mr, o.D).stale;
    const r = app._preOpenScore(Object.assign({}, o.x, { stale }));
    return { s: r.s, sPct: r.sPct, p: r.parts.filter(q => q.d !== 0 || /資料舊了/.test(q.note)).map(q => [q.nm, q.d, /資料舊了/.test(q.note) ? 1 : 0]) };
  }), days);
  await browser.close();
  return out;
}

function load0050(files) {
  const B = new Map();
  for (const f of files) {
    if (!f || !fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const d = String(r.date).replace(/\//g, '-').slice(0, 10);
      if (+r.open > 0 && +r.close > 0 && !B.has(d)) B.set(d, [+r.open, +r.close]);
    }
  }
  return B;
}

async function main() {
  const html = fs.readFileSync(process.env.HTML || path.join(ROOT, 'index.html'), 'utf8');
  let U;
  if (process.env.US_HIST) U = JSON.parse(fs.readFileSync(process.env.US_HIST, 'utf8'));
  else { try { U = JSON.parse(execSync(`git -C ${JSON.stringify(ROOT)} show origin/data:data/us_hist.json`, { encoding: 'utf8', maxBuffer: 1 << 30 })); } catch (_) {} }
  if (!U || !U.mac || !U.syms || !(U.days && U.days[0] <= '2010-01-04')) { console.log('❌ us_hist.json 讀不到、或沒有 mac 區塊、或起點晚於 2010(本機那份常是舊格式 → 先 git fetch origin data)'); process.exit(1); }
  const ser = (grp, k) => U[grp][k] ? U.days.map((d, i) => [d, U[grp][k].c[i]]).filter(p => p[1] != null && p[1] > 0) : [];
  const src = {
    dji: mkSeries(chgFromCloses(ser('syms', '^DJI'))), ndx: mkSeries(chgFromCloses(ser('syms', '^IXIC'))), spx: mkSeries(chgFromCloses(ser('syms', '^GSPC'))),
    sox: mkSeries(chgFromCloses(ser('syms', '^SOX'))), tsm: mkSeries(chgFromCloses(ser('syms', 'TSM'))), asx: mkSeries(chgFromCloses(ser('syms', 'ASX'))),
    umc: mkSeries(chgFromCloses(ser('syms', 'UMC'))), vixLvl: mkSeries(ser('syms', '^VIX')), nq: mkSeries(chgFromCloses(ser('syms', 'NQ=F'))),
    ust: mkSeries(chgFromCloses(ser('mac', '^TNX'))), twd: mkSeries(chgFromCloses(ser('mac', 'TWD=X'))),
  };
  const notes = [];
  if (process.env.RAWB_LOG) {
    const R = decodeRawb(fs.readFileSync(process.env.RAWB_LOG, 'utf8'));
    for (const k of ['nk', 'ks', 'hs', 'twd', 'krw', 'cny']) if (R[k] && R[k].length > 1000) src[k] = mkSeries(R[k]);
    notes.push(`亞股 / 亞幣:RAWB ${Object.entries(R).map(([k, v]) => `${k} ${v.length}`).join(' ・')}`);
  } else notes.push('⚠️ 沒給 RAWB_LOG → 日經 / 韓股 / 恆指 / 韓元 / 人民幣 = 0 分;台幣用 us_hist 的 TWD=X(只有美股交易日)');
  const B = load0050(String(process.env.B0050 || '').split(',').filter(Boolean));
  if (B.size < 250) { console.log(`❌ 0050 日 K 只有 ${B.size} 根(B0050=…,16 年:<d16>/_bench0050.json,gh-pages data/0050.json)`); process.exit(1); }
  let ex = new Set();
  if (process.env.DIV) { const j = JSON.parse(fs.readFileSync(process.env.DIV, 'utf8')); ex = new Set(((j.d || {})['0050'] || {}).h?.map(h => String(h[0]).slice(0, 10)) || []); }
  else notes.push('⚠️ 沒給 DIV → 0050 除息日沒剔除(那天的開盤跳空是除息不是行情)');
  const nqMode = process.env.NQ === 'daily' ? 'daily' : 'none';
  if (nqMode === 'daily') notes.push('⚠️ NQ=daily:那指期用整天日線(App 早上拿到的是晚上 2 小時的漂移,這是參考上限)');

  const TD = [...B.keys()].sort();
  const days = [], meta = [];
  for (let i = 1; i < TD.length; i++) {
    const D = TD[i]; if (D < '2010-01-04') continue;
    const [o, c] = B.get(D), pc = B.get(TD[i - 1])[1];
    const { mr, x } = buildInputs(src, D, TD[i - 1], nqMode);
    if (x.spx == null) continue;
    days.push({ D, mr, x });
    // 🔁 V79.5.3 以前亞股算分(日經 / 韓股 ±1、恆指 ±0.5;比台股上一個交易日舊的不算)—— 只給「加回亞股」那個候選,⛔ 不是 App 現在的算法
    const aS = c => c == null ? 0 : (c >= 1 ? 1 : c >= 0.3 ? 0.5 : c <= -1 ? -1 : c <= -0.3 ? -0.5 : 0);
    const fresh = d => !!d && d >= TD[i - 1];
    const asiaOld = (fresh(mr.nikkei_date) ? aS(x.nk) : 0) + (fresh(mr.kospi_date) ? aS(x.ks) : 0) + (fresh(mr.hsi_date) ? aS(x.hs) * 0.5 : 0);
    meta.push({ d: D, gap: (o / pc - 1) * 100, io: (c / o - 1) * 100, cc: (c / pc - 1) * 100, ex: ex.has(D), asiaOld });
  }
  const sc = await scoreAll(days, html);
  const rows = meta.map((m, i) => ({ ...m, s: sc[i].s, sPct: sc[i].sPct, p: sc[i].p })).filter(r => !r.ex);
  console.log(`🌅 App 盤前分數逐日重建:${rows[0].d} ~ ${rows.at(-1).d} ・${rows.length} 天(剔除除息 ${meta.length - rows.length} 天)`);
  for (const n of notes) console.log('   ' + n);
  console.log('   ⛔ 沒有歷史 = 0 分:台指期夜盤 / 恐懼貪婪' + (nqMode === 'none' ? ' / 那指期(App 早上幾乎拿不到)' : ''));
  return { rows };
}

export function report(rows) {
  const S0 = r => r.s;
  const drop = ks => r => Math.round((r.s - r.p.filter(q => ks.includes(q[0])).reduce((a, q) => a + q[1], 0)) * 10) / 10;
  const flip = ks => r => Math.round((r.s - 2 * r.p.filter(q => ks.includes(q[0])).reduce((a, q) => a + q[1], 0)) * 10) / 10;
  const FX = ['💱 台幣(當日)', '💱 台幣(5 日連貶)'], FX3 = [...FX, '💱 亞幣競貶', '💱 人民幣急貶'];
  const addAsia = w => r => Math.round((r.s + w * (r.asiaOld || 0)) * 10) / 10;   // V79.5.3 以前的亞股分數加回去
  const cands = {
    '加回亞股(V79.5.3 以前)': addAsia(1), '加回亞股(減半)': addAsia(0.5),
    '拿掉 VIX 水位': drop(['😱 VIX']), '拿掉 美債': drop(['📜 美債 10 年期']), '美債 反過來': flip(['📜 美債 10 年期']),
    '拿掉 台幣(當日+5日)': drop(FX), '拿掉 匯率四項': drop(FX3), '拿掉 日月光/聯電': drop(['🔌 日月光 ADR', '🔌 聯電 ADR']),
    '拿掉 VIX+美債+台幣': drop(['😱 VIX', '📜 美債 10 年期', ...FX]),
  };
  const out = [];
  out.push('\n== 全期(使用者看到的:開高偏多 = 分數 ≥65、開低偏空 = ≤35;開高 / 開低 = 0050 開盤跳空超過 ±0.3%)');
  out.push(line('現行(App)', judge(rows, S0)));
  for (const [k, f] of Object.entries(cands)) out.push(line(k, judge(rows, f)));
  for (const w of [60, 120, 250]) { out.push(`\n== 最近 ${w} 天`); out.push(line('現行(App)', judge(rows.slice(-w), S0))); }
  out.push('\n== 分數桶(0050 開盤跳空 / 開盤到收盤 / 全天)');
  for (const [nm, f] of [['≥65', v => v >= 65], ['55~64', v => v >= 55 && v < 65], ['45~54', v => v >= 45 && v < 55], ['36~44', v => v > 35 && v < 45], ['≤35', v => v <= 35]]) {
    const sub = rows.filter(r => f(r.sPct)); if (sub.length < 15) { out.push(`   ${nm}: ${sub.length} 天(太少)`); continue; }
    const avg = k => sub.reduce((a, r) => a + r[k], 0) / sub.length, pc = g => sub.filter(g).length / sub.length * 100;
    out.push(`   ${nm.padEnd(6)} ${String(sub.length).padStart(4)} 天 ・開高 ${f1(pc(r => r.gap > BAND))}% 開平 ${f1(pc(r => Math.abs(r.gap) <= BAND))}% 開低 ${f1(pc(r => r.gap < -BAND))}% ・跳空 ${avg('gap').toFixed(2)}% ・開盤到收盤 ${avg('io').toFixed(2)}% ・全天 ${avg('cc').toFixed(2)}%`);
  }
  const years = [...new Set(rows.map(r => r.d.slice(0, 4)))].sort();
  const byY = f => Object.fromEntries(years.map(y => [y, judge(rows.filter(r => r.d.startsWith(y)), f)]));
  const Y0 = byY(S0);
  out.push('\n== 逐年(現行):方向對 / 開反 / 名次相關 / 講話天數');
  for (const y of years) out.push(`   ${y}: 方向對 ${f1(Y0[y].hit)}% ・開反 ${f1(Y0[y].wrong)}% ・相關 ${Y0[y].rho >= 0 ? '+' : ''}${Y0[y].rho.toFixed(3)} ・講話 ${Y0[y].up + Y0[y].dn}/${Y0[y].n}`);
  out.push(`\n== 候選 vs 現行(逐年:方向對較多 / 名次相關較高 / 開反較少;⭐ 換要「方向對」與「相關」都 ≥13/${years.length})`);
  const verdict = {};
  for (const [k, f] of Object.entries(cands)) {
    const Y = byY(f);
    const a = years.filter(y => Y[y].hit > Y0[y].hit).length, b = years.filter(y => Y[y].rho > Y0[y].rho).length, c = years.filter(y => Y[y].wrong < Y0[y].wrong).length;
    const pass = a >= 13 && b >= 13;
    verdict[k] = { a, b, c, pass };
    out.push(`   ${pass ? '✅' : '⛔'} ${k.padEnd(20)} 方向對 ${a}/${years.length} ・相關 ${b}/${years.length} ・開反較少 ${c}/${years.length}`);
  }
  // 逐年樣本外:每一年只看「以前的年份」決定每一項要不要拿掉(以前 ≥75% 的年份拿掉比較好才拿)
  const items = [...new Set(rows.flatMap(r => r.p.map(q => q[0])))];
  let wins = 0, tot = 0; const wf = [];
  for (let i = 3; i < years.length; i++) {
    const ks = items.filter(k => { let better = 0, n = 0;
      for (const py of years.slice(0, i)) { const rs = rows.filter(r => r.d.startsWith(py)); if (!rs.some(r => r.p.some(q => q[0] === k && q[1] !== 0))) continue; n++;
        if (judge(rs, drop([k])).hit > judge(rs, S0).hit) better++; }
      return n >= 3 && better / n >= 0.75; });
    const rs = rows.filter(r => r.d.startsWith(years[i])), a = judge(rs, S0).hit, b = judge(rs, drop(ks)).hit;
    wins += b > a; tot++; wf.push(`   ${years[i]}: 拿掉 ${ks.join('、') || '(無)'} ・方向對 ${f1(a)} → ${f1(b)}`);
  }
  out.push('\n== 逐年樣本外(每一年只用以前的年份決定拿掉哪幾項;判準 = 方向猜對)'); out.push(...wf); out.push(`   → 樣本外贏 ${wins}/${tot} 年`);
  return { text: out.join('\n'), verdict, wf: { wins, tot }, y0: Y0 };
}

async function selftest() {
  let fails = 0; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails++; };
  // ① RAWB 解碼:三根(隔天 +0.12%、隔 3 天 −0.45%)
  const R = decodeRawb('x RAWB|nk|0|2020-01-02|100.0000|12,3:-45\nRAWB|nk|2|2020-01-02|100.0000|7');
  ok('① RAWB 解碼:日期 / bp / 分段順序', JSON.stringify(R.nk) === JSON.stringify([['2020-01-03', 0.12], ['2020-01-06', -0.45], ['2020-01-07', 0.07]]), JSON.stringify(R.nk));
  // ② ⭐ 時間對齊決定性對照:美股 D−1 的方向決定台股 D 的跳空;D 當天的美股故意相反 → 用到 D(前視)命中會掉到 0
  const days = [], tw = [];
  for (let i = 0; i < 60; i++) { const d = new Date(Date.UTC(2020, 0, 6 + i)); if ([0, 6].includes(d.getUTCDay())) continue; days.push(d.toISOString().slice(0, 10)); }
  const usChg = days.map((d, i) => [d, i % 2 ? 1 : -1]);   // 美股:奇數天漲、偶數天跌
  const src = { spx: mkSeries(usChg), ndx: mkSeries(usChg), dji: mkSeries(usChg), sox: mkSeries(usChg), tsm: mkSeries(usChg), asx: mkSeries([]), umc: mkSeries([]),
                vixLvl: mkSeries([]), ust: mkSeries([]), nq: mkSeries([]), twd: mkSeries([]), nk: mkSeries(days.map(d => [d, 0.5])), ks: mkSeries([]), hs: mkSeries([]) };
  for (let i = 1; i < days.length; i++) { const { mr, x } = buildInputs(src, days[i], days[i - 1], 'none'); tw.push({ D: days[i], mr, x, gapSign: usChg[i - 1][1] }); }
  ok('② 用的是「D 之前最近一根」(D−1),⛔ 不是 D 當天', tw.every(t => Math.sign(t.x.spx) === t.gapSign) && tw.every(t => t.mr.sp500_date < t.D), JSON.stringify(tw.slice(0, 2)));
  const html = fs.readFileSync(process.env.HTML || path.join(ROOT, 'index.html'), 'utf8');
  const sc = await scoreAll(tw.map(t => ({ D: t.D, mr: t.mr, x: t.x })), html);
  const rows = tw.map((t, i) => ({ d: t.D, s: sc[i].s, sPct: sc[i].sPct, p: sc[i].p, gap: t.gapSign * 1, io: 0, cc: 0 }));
  ok('②b 美股方向 → 分數方向(同一天)→ 方向對 100%', judge(rows, r => r.s).hit === 100, JSON.stringify(judge(rows, r => r.s)));
  // 決定性對照:同一支 buildInputs,只把「今天」往後挪一天 → 拿到的是 D 當天的美股(前視),而它跟 D−1 相反 → 方向全錯
  const la = tw.map((t, i) => days[i + 2] ? { D: t.D, gapSign: t.gapSign, ...buildInputs(src, days[i + 2], t.D, 'none') } : null).filter(Boolean);
  const sl = await scoreAll(la.map(t => ({ D: t.D, mr: t.mr, x: t.x })), html);
  const look = la.map((t, i) => ({ d: t.D, s: sl[i].s, gap: t.gapSign, io: 0 }));
  ok('②c ⭐ 決定性對照:同一支函式拿到 D 當天的美股(前視)→ 方向對 0%', look.length > 30 && judge(look, r => r.s).hit === 0, JSON.stringify(judge(look, r => r.s)));
  // ③ 資料舊了:亞股最後一根早於台股上一個交易日 → App 判舊、0 分
  const old = buildInputs({ ...src, nk: mkSeries([['2020-01-06', 2]]) }, '2020-02-10', '2020-02-07', 'none');
  const so = await scoreAll([{ D: '2020-02-10', mr: old.mr, x: old.x }], html);
  ok('③ 亞股太舊 → App 自己的 _premktFieldAge 判舊 → 0 分', so[0].p.some(q => q[0] === '🇯🇵 日經' && q[1] === 0 && q[2] === 1), JSON.stringify(so[0].p));
  // ④ 5 根累計(亞幣競貶要用):五根各 +0.2% → 約 +1.004%
  const fx = mkSeries(days.slice(0, 6).map(d => [d, 0.2]));
  const b5 = buildInputs({ ...src, twd: fx, krw: fx, cny: fx }, days[6], days[5], 'none');
  ok('④ 5 根累計 = 連乘(1.002^5 − 1 = 1.00%)', b5.x.twd5 === 1 && b5.x.krw5 === 1 && b5.x.cny5 === 1, JSON.stringify(b5.x));
  console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ PREMKT_APP_SELFTEST_PASS');
  process.exit(fails ? 1 : 0);
}

if (SELF) await selftest();
else if (process.argv[1] && process.argv[1].endsWith('premkt_app_probe.mjs')) {
  const { rows } = await main();
  const R = report(rows);
  console.log(R.text);
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(rows));   // 逐日明細(本機再分析用)
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ verdict: R.verdict, wf: R.wf, y0: R.y0, n: rows.length, from: rows[0].d, to: rows.at(-1).d }));
}
