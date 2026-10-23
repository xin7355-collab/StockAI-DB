#!/usr/bin/env node
/**
 * 🗓️ V22.7(2026-10-23)Cloudflare Worker 排程的星期欄守門
 *   Cloudflare 的星期 1 = 週日 … 7 = 週六(⛔ 跟 GitHub / Linux 的 0 = 週日不一樣)。
 *   以前 wrangler.toml 寫 "* * 1-5" = 週日~週四 → 每個星期五整天沒跑(盤前簡報 / 盤中提醒 / 叫醒採礦 / 週五週報全停)、
 *   週日反而白跑(GitHub 紀錄:Worker 叫醒盤中快照那筆 10/18 週日有、10/16・10/23 週五沒有)。
 *   ① wrangler.toml 的 crons == worker.js 的 CRON(一字不差 —— Cloudflare 傳進來的 event.cron 就是那串原文)
 *   ② 每一條的星期欄 ⛔ 不可有數字(只准 SUN~SAT 英文縮寫)
 *   ③ 照 Cloudflare 的規則算 → 每一條都是週一~週五(⭐ 決定性對照:舊的 "1-5" 用同一個算法 = 週日~週四 → 必須被判錯)
 *   ④ 每一條的分 / 時 = 用途(08:00 盤前・09:00 開盤・17:00 盤後・盤中每 15 分・13 點末班)
 *   ⑤ 真的呼叫 scheduled():台北週五每一條都有做事;週六 / 週日一律不做
 *   ⑥ 分支內容:17:00 叫醒採礦 + 週報、08:00 盤前簡報 + 換倉 + 總經 + 盤中快照、09:00 ETF + 逐筆、其他 = 盤中掃描 + 看門狗
 * 注入:INJECT=numeric(wrangler 改回 1-5)/ noguard(拿掉週末保險)/ mismatch(只改 wrangler 的大小寫)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
let W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
let T = fs.readFileSync(path.join(ROOT, 'cloud-worker/wrangler.toml'), 'utf8');
const inject = (src, a, b) => { const out = src.split(a).join(b); if (out === src) { console.log(`❌ 注入沒有注進去:${a}`); process.exit(1); } return out; };
if (INJ === 'numeric') T = inject(T, 'MON-FRI"', '1-5"');
if (INJ === 'noguard') W = inject(W, 'if (wd === 0 || wd === 6) return;\n        if (event.cron', 'if (event.cron');
if (INJ === 'mismatch') T = inject(T, '"0 9 * * MON-FRI"', '"0 9 * * mon-fri"');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ── wrangler.toml 的 crons(只有一個 crons = [...];⛔ 重複的 key 會讓 wrangler 整個讀不進去)
const nKey = (T.match(/^crons\s*=/gm) || []).length;
ok('⓪ wrangler.toml 只有一個 crons =', nKey === 1, `出現 ${nKey} 次`);
const arr = (T.match(/\[triggers\][\s\S]*?crons\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
const TOML_CRONS = [...arr.matchAll(/"([^"]+)"/g)].map(m => m[1]);
ok('⓪b 讀得到 crons(空過守門)', TOML_CRONS.length >= 5, JSON.stringify(TOML_CRONS));

// ── 載入 worker(複製成 .mjs 才是 ES module;陷阱 #40 第四例)
const tmp = path.join(ROOT, 'scripts', '.tmp_worker_cron.mjs');
fs.writeFileSync(tmp, W);
let M;
try { M = await import(tmp + '?t=' + Date.now()); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
const CRON = M.CRON || {};
const WORKER_CRONS = Object.values(CRON);

// ① 兩邊一字不差
const same = TOML_CRONS.length === WORKER_CRONS.length && TOML_CRONS.every(c => WORKER_CRONS.includes(c));
ok('① wrangler.toml 的 crons == worker.js 的 CRON(一字不差)', same, `toml=${JSON.stringify(TOML_CRONS)} worker=${JSON.stringify(WORKER_CRONS)}`);

// ③ 用 Cloudflare 的規則把星期欄算成 JS 的 getUTCDay(0 = 週日)
const CF_NAMES = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };
function cfWeekdays(field) {
  const out = new Set();
  if (field === '*') { for (let d = 0; d < 7; d++) out.add(d); return out; }
  const num = t => (/^\d+$/.test(t) ? +t : CF_NAMES[t.toUpperCase()]);
  for (const item of field.split(',')) {
    const m = item.match(/^([A-Za-z]{3}|\d+)(?:-([A-Za-z]{3}|\d+))?$/);
    if (!m) return null;                        // L / # / 步長 —— 這裡沒用到,算不出來就當錯
    const a = num(m[1]), b = m[2] ? num(m[2]) : a;
    if (!(a >= 1 && a <= 7 && b >= 1 && b <= 7 && a <= b)) return null;
    for (let d = a; d <= b; d++) out.add(d - 1);
  }
  return out;
}
const setStr = s => (s ? [...s].sort().join(',') : 'null');
const WEEKDAYS = '1,2,3,4,5';
ok('③ 決定性對照:舊的 "1-5" 照 Cloudflare 規則 = 週日~週四(含週日、沒有週五)', setStr(cfWeekdays('1-5')) === '0,1,2,3,4');
ok('③b 對照:"MON-FRI" = 週一~週五', setStr(cfWeekdays('MON-FRI')) === WEEKDAYS);
for (const c of TOML_CRONS) {
  const f = c.trim().split(/\s+/);
  ok(`② 星期欄 ⛔ 不可寫數字:${c}`, f.length === 5 && !/\d/.test(f[4]), f[4]);
  ok(`③c 照 Cloudflare 規則是週一~週五:${c}`, setStr(cfWeekdays(f[4] || '')) === WEEKDAYS, setStr(cfWeekdays(f[4] || '')));
}

// ④ 分 / 時 = 用途
const mh = c => String(c || '').trim().split(/\s+/).slice(0, 2).join(' ');
ok('④ CRON.pre = 台北 08:00(UTC 0:00)', mh(CRON.pre) === '0 0', CRON.pre);
ok('④b CRON.open = 台北 09:00(UTC 1:00)', mh(CRON.open) === '0 1', CRON.open);
ok('④c CRON.eve = 台北 17:00(UTC 9:00)', mh(CRON.eve) === '0 9', CRON.eve);
ok('④d CRON.scan = 台北 09:00~12:45 每 15 分', mh(CRON.scan) === '0,15,30,45 1-4', CRON.scan);
ok('④e CRON.last = 台北 13:00 / 13:15 / 13:30', mh(CRON.last) === '0,15,30 5', CRON.last);
ok('④f 台北星期幾用排程時間算(週五早上 08:00 = UTC 週五 00:00)', M._twWeekday && M._twWeekday(Date.parse('2026-10-23T00:00:00Z')) === 5);

// ⑤ 真的呼叫 scheduled()(⛔ 不連網:fetch 一律失敗、env 沒有任何金鑰 → 各支自己會提早結束)
globalThis.fetch = async () => { throw new Error('test: no network'); };
const origLog = console.log, origErr = console.error, origWarn = console.warn;
async function fire(cron, iso) {
  const ps = [];
  const ctx = { waitUntil: p => { ps.push(Promise.resolve(p).catch(() => {})); } };
  console.log = console.error = console.warn = () => {};   // 各支「抓不到」的 log 不印(⛔ 不影響判定)
  try {
    await M.default.scheduled({ cron, scheduledTime: Date.parse(iso), type: 'scheduled' }, {}, ctx);
    await Promise.race([Promise.allSettled(ps), new Promise(r => setTimeout(r, 5000))]);
  } finally { console.log = origLog; console.error = origErr; console.warn = origWarn; }
  return ps.length;
}
const EXPECT = { eve: 2, open: 2, pre: 4, scan: 2, last: 2 };
const FRI = { pre: '2026-10-23T00:00:00Z', open: '2026-10-23T01:00:00Z', scan: '2026-10-23T02:15:00Z', last: '2026-10-23T05:15:00Z', eve: '2026-10-23T09:00:00Z' };
for (const k of Object.keys(EXPECT)) {
  const n = await fire(CRON[k], FRI[k]);
  ok(`⑤ 台北週五 ${k} 那一輪有做事(${EXPECT[k]} 件)`, n === EXPECT[k], `做了 ${n} 件`);
}
for (const [lab, iso] of [['週六 08:00', '2026-10-24T00:00:00Z'], ['週日 08:00', '2026-10-25T00:00:00Z'], ['週日 10:15', '2026-10-25T02:15:00Z'], ['週六 17:00', '2026-10-24T09:00:00Z']]) {
  let n = 0;
  for (const k of Object.keys(EXPECT)) n += await fire(CRON[k], iso);
  ok(`⑤b 台北${lab}:五條排程一件事都不做(雙保險)`, n === 0, `做了 ${n} 件`);
}

// ⑥ 分支內容(靜態:各分支要呼叫的那幾支)
const S = W.slice(W.indexOf('async scheduled(event, env, ctx)'));
const br = (head, tail) => { const i = S.indexOf(head); if (i < 0) return ''; const j = S.indexOf(tail, i + head.length); return S.slice(i, j < 0 ? undefined : j); };
const bEve = br('if (event.cron === CRON.eve)', '} else if');
const bOpen = br('} else if (event.cron === CRON.open)', '} else if');
const bPre = br('} else if (event.cron === CRON.pre)', '} else {');
const bElse = br('} else {', '\n    },');
ok('⑥ 17:00:盤後總結 + 叫醒每日採礦', /runDailySummary\(env\)/.test(bEve) && /minerKick\(env\)/.test(bEve), bEve.slice(0, 200));
ok('⑥b 09:00:ETF 跟單 + 叫醒逐筆', /runEtfFollowMorningPush\(env\)/.test(bOpen) && /ghDispatch\(env, 'intraday-ticks'\)/.test(bOpen), bOpen.slice(0, 200));
ok('⑥c 08:00:盤前簡報 + 換倉 + 總經 + 盤中快照', ['runPreMarket(env)', 'runLeaderRebalPush(env)', 'macroKick(env)', "ghDispatch(env, 'intraday-quotes')"].every(x => bPre.includes(x)), bPre.slice(0, 200));
ok('⑥d 其他(盤中):個人警報 + 看門狗', /runScan\(env\)/.test(bElse) && /intradayWatchdog\(env\)/.test(bElse), bElse.slice(0, 200));
ok('⑥e ⛔ 分流不可再寫死字串(一律 CRON.xxx,改排程只改一處)', !/event\.cron === '/.test(S.slice(0, S.indexOf('\n    },'))));
ok('⑥f 週五盤後總結那則會附週報(以前星期五沒跑 = 從來沒送過)', /isTaipeiFriday\(\) \? buildWeekBlock/.test(W));
// ⑦ 週報第一次真的會送出去 → 內容先驗(以前從來沒跑過):標起訖日、⛔ 講成「本週」(週五 17:00 當天收盤還沒進 breadth)
const H = [['2026/10/15', -3.41, 367, 1767], ['2026/10/16', 0.3, 1367, 684], ['2026/10/19', -0.61, 414, 1705],
  ['2026/10/20', -1.13, 708, 1327], ['2026/10/21', 1.28, 1287, 757], ['2026/10/22', -1.81, 460, 1650]]
  .map(([d, idx, up, dn]) => ({ d, idx, up, dn }));
const wk = M.buildWeekBlock ? M.buildWeekBlock({ history: H }) : '';
const cum = H.slice(-5).reduce((c, b) => c * (1 + b.idx / 100), 1) * 100 - 100;
ok('⑦ 週報標起訖日(最後 5 個交易日 10/16~10/22)', wk.includes('10/16~10/22 共 5 個交易日'), wk);
ok('⑦b 週報漲跌 = 5 天複利(獨立重算)', wk.includes(`${cum > 0 ? '+' : ''}${cum.toFixed(2)}%`), `${wk} vs ${cum.toFixed(2)}`);
ok('⑦c 漲多於跌 / 跌多於漲天數', wk.includes('漲多於跌 2 天 / 跌多於漲 3 天'), wk);
ok('⑦d ⛔ 不可講成「本週」(那 5 天是上週五~昨天)', !/本週/.test(wk), wk);
ok('⑦e 不到 3 天 → 不附', M.buildWeekBlock && M.buildWeekBlock({ history: H.slice(0, 2) }) === '');

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_worker_cron 全過');
process.exit(fails.length ? 1 : 0);
