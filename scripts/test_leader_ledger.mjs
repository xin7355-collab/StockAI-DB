// 👑 V77.9.3 領頭羊加進 📒 成績單(自動模擬買賣)—— 使用者:「領頭羊策略也加進去成績單裡面自動買賣」
//
// ⛔ 釘住(注入都要叫得出來):
//   ① 規則三份一致:pro `_LEAD` == index `_LEADER_EDGE.rule/.anchor` == lib_leader.py(會動真錢的那份)
//   ② 換倉日 = 加權日曆從錨點起第 1、11… 天;成交 = 隔天收盤;⭐ 不是換倉日的名單變動⛔ 不可觸發買賣
//   ③ 掉出前 N×hyst 名才賣(還在前 10 名續抱)、最多 N 檔、⛔ 不設停損
//   ④ 大盤嚴格空頭 → 不買、賣照常;隔天快漲停 → 不買、⛔ 不遞補;沒有那天的名單 → 那次⛔ 不硬猜
//   ⑤ 訊號出了、隔天還沒到 → 畫面列「會買 / 會賣」,⛔ 不算進成績
//   ⑥ ⭐ 決定性對照:把換倉日名單的第 1 名換人 → 買進的那幾檔要跟著變
//   ⑦ 🎑 其他三頁:假日快照(加權沒開盤那天)⛔ 不算
//   ⑧ pick_snapshot.py --leader:實跑寫 lead、回補標 bf:1、⛔ 不覆蓋實跑、main() 重跑⛔ 不洗掉 lead
// 跑法:node scripts/test_leader_ledger.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ① 三份規則一致
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PROSRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const LIB = fs.readFileSync(path.join(ROOT, 'lib_leader.py'), 'utf8');
const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8');
const ix = IDX.match(/rule: \{ U: (\d+), N: (\d+), R: (\d+), L: (\d+), hyst: (\d+) \}/) || [];
const ixAnc = (IDX.match(/anchor: '(\d{4}-\d{2}-\d{2})'/) || [])[1];
// ⚠️ V77.9.4 pro `_LEAD` 多了 U / L(釣魚要自己算名單)→ 逐欄取,⛔ 不依賴欄位順序
const prLine = (PROSRC.match(/_LEAD: \{[^}]*\}/) || [''])[0], pf = k => (prLine.match(new RegExp('\\b' + k + ": '?([\\d-]+)'?")) || [])[1];
const pr = prLine ? ['', pf('N'), pf('R'), pf('hyst'), pf('anchor'), pf('U'), pf('L')] : [];
const lb = LIB.match(/LEADER_RULE = \{'U': (\d+), 'N': (\d+), 'R': (\d+), 'L': (\d+), 'hyst': (\d+)\}/) || [];
const lbAnc = (LIB.match(/LEADER_ANCHOR = '(\d{4}-\d{2}-\d{2})'/) || [])[1];
ok('① 規則三份一致(N / R / hyst / 錨點:pro == index == lib_leader)',
  pr.length && ix.length && lb.length && pr[1] === ix[2] && pr[2] === ix[3] && pr[3] === ix[5] && pr[4] === ixAnc && pr[5] === ix[1] && pr[6] === ix[4]
  && lb.slice(1).join() === ix.slice(1).join() && lbAnc === ixAnc, JSON.stringify([pr.slice(1), ix.slice(1), ixAnc, lb.slice(1), lbAnc]));
ok('①b auto_trade.py 名單 / 時鐘走 lib_leader(⛔ 不另寫一份)',
  /import lib_leader as _LL/.test(AT) && /return _LL\.leader_calc\(/.test(AT) && /return _LL\.leader_clock\(/.test(AT) && !/rows\.sort\(key=lambda r: -r\['amt20'\]\)/.test(AT));

// ── 合成資料:加權日曆(平日)、每檔 K 線 ──
const wk = (a, b) => { const out = []; for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6) out.push(d.toISOString().slice(0, 10)); } return out; };
const CAL = wk('2026-05-01', '2026-10-09');              // 09-24 = 第 1 天、10-08 = 第 11 天、10-09 = 第 12 天
const cal = CAL.filter(d => d >= '2026-09-24');
const [D1, F1, D11, F11] = [cal[0], cal[1], cal[10], cal[11]];
const tw = (dir) => CAL.map((d, i) => ({ date: d.replace(/-/g, '/'), close: dir > 0 ? 10000 + i * 10 : 20000 - i * 30 }));
const kl = (px = {}) => CAL.map(d => ({ date: d.replace(/-/g, '/'), close: px[d] ?? 100, open: 100, high: 101, low: 99, volume: 1000 }));
const lead = (syms) => ({ rows: syms.map((s, i) => ({ s, c: 100, r: i + 1, x: 30 - i, a: 50, chg: 1, lim: 0, att: 0 })), n: 100, passed: 40 });
const A10 = ['1101', '1102', '1103', '1104', '1105', '1106', '1107', '1108', '1109', '1110'];
// 第 11 天:1101 掉出前 10;1102 掉到第 8 名(續抱);新第 1 名 2001
const B10 = ['2001', '1103', '1104', '1105', '1106', '1107', '1108', '1102', '1109', '1110'];
const K = {};
for (const s of [...A10, '2001', '2002', '9999']) K[s] = kl();
K['1101'] = kl({ [F11]: 123 });                            // 賣在 F11 收盤 123
K['2001'] = kl({ [F11]: 110 });                             // 2001 在 F11 從 100 → 110 = +10% → 快漲停買不到

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
await page.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });   // 🎯 V77.9.6 這支測的是 👑 那一套 → 先切成 👑(🧬 預設另由 test_stratswitch 測)
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(pathToFileURL(path.join(ROOT, 'pro.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && typeof PRO._leaderLedgerLoad === 'function', null, { timeout: 60000 });

const run = (days, twRows, cut) => page.evaluate(async ({ days, twRows, K, cut }) => {
  const m = new Map(); for (const r of twRows) { const d = r.date.replace(/\//g, '-'); if (!cut || d <= cut) m.set(d, r.close); }
  PRO._twii = { m, days: [...m.keys()].sort() }; PRO._twiiLoad = async () => PRO._twii;
  PRO._rlK = {};
  PRO.fetchJson = async (u) => {
    if (/pick_history/.test(u)) return { days };
    const s = (u.match(/data\/(\d+)\.json/) || [])[1];
    return s && K[s] ? K[s].filter(r => !cut || r.date.replace(/\//g, '-') <= cut) : null;
  };
  const R = await PRO._leaderLedgerLoad();
  return { err: R.err, skipped: R.skipped, next: R.next,
    trades: R.trades.map(t => ({ s: t.sym, d: t.d, st: t.st ? { e: t.st.entry, x: t.st.exitP, open: t.st.open, d1: t.st.d1, why: t.st.why, net: t.st.net } : null })),
    rebs: R.rebs.map(x => ({ d: x.d, has: x.has, buys: x.buys, sells: x.sells, skips: x.skips, plan: x.plan, bear: x.bear })) };
}, { days, twRows, K, cut });

// ② ③ 基本情境
const D5 = cal[4];
const days = [{ d: D1, lead: lead(A10) }, { d: D5, lead: lead(['9999', ...A10.slice(1)]) }, { d: D11, lead: lead(B10) }];
const r = await run(days, tw(1));
const buy1 = r.rebs[0] && r.rebs[0].buys;
ok('② 錨點那天換倉 → 隔天收盤買前 5 名', JSON.stringify(buy1) === JSON.stringify(A10.slice(0, 5)) && r.trades.filter(t => t.d === F1).length === 5, JSON.stringify(r.rebs[0]));
ok('②b ⭐ 不是換倉日的名單變動(第 5 天 9999 衝上第 1)⛔ 不觸發買賣', !r.trades.some(t => t.s === '9999') && r.rebs.length === 2, JSON.stringify(r.rebs.map(x => x.d)));
const t1101 = r.trades.find(t => t.s === '1101'), t1102 = r.trades.find(t => t.s === '1102');
ok('③ 掉出前 10 名 → 下一次換倉隔天收盤賣(1101 賣在 123)', t1101 && t1101.st && !t1101.st.open && t1101.st.x === 123 && t1101.st.d1 === F11 && /掉出前 10 名/.test(t1101.st.why), JSON.stringify(t1101));
ok('③b 還在前 10 名(第 8 名)→ 續抱', t1102 && t1102.st && t1102.st.open, JSON.stringify(t1102));
ok('③c 最多 5 檔 ・⛔ 不設停損(持有中的沒有 stop 出場)', r.trades.filter(t => t.st && t.st.open).length <= 5 && !r.trades.some(t => t.st && /停損/.test(t.st.why || '')));
ok('④ 隔天快漲停(+10%)→ 不買、⛔ 不遞補第 6 名(只補前 5 名裡還沒有的 1106)', !r.trades.some(t => t.s === '2001') && r.rebs[1].skips.some(x => /2001/.test(x) && /漲停/.test(x)) && JSON.stringify(r.rebs[1].buys) === '["1106"]' && !r.trades.some(t => t.s === '1107'), JSON.stringify(r.rebs[1]));
ok('⑤ 扣成本:1101 100 → 123 = +23% − 0.44%', t1101 && Math.abs(t1101.st.net - 22.56) < 1e-6, t1101 && t1101.st.net);

// ④ 空頭 → 不買、賣照常
const rb = await run(days, tw(-1));
ok('④b 大盤嚴格空頭那天 → 不買(一檔都沒有)', rb.rebs[0].bear === true && !rb.trades.length, JSON.stringify(rb.rebs[0]));
// ④c 沒有那天的名單 → 那次⛔ 不硬猜
const rm = await run([{ d: D5, lead: lead(A10) }, { d: D11, lead: lead(B10) }], tw(1));
ok('④c 錨點那天沒名單 → 那次不動(skipped 1)、下次換倉照常', rm.skipped === 1 && !rm.rebs[0].has && rm.trades.every(t => t.d === F11), JSON.stringify(rm.rebs));

// ⑤ 訊號出了、隔天還沒到 → plan
const rp = await run([{ d: D1, lead: lead(A10) }], tw(1), D1);
ok('⑤b 換倉日當天(隔天還沒到)→ 列出會買的 5 檔、⛔ 不算成績', rp.rebs[0].plan && rp.rebs[0].plan.buy.length === 5 && !rp.trades.length, JSON.stringify(rp.rebs[0]));

// ⑥ 決定性對照
const swap = ['2002', ...A10.slice(1)];
const rs = await run([{ d: D1, lead: lead(swap) }], tw(1));
ok('⑥ ⭐ 決定性對照:第 1 名換成 2002 → 買進名單跟著變', JSON.stringify(rs.rebs[0].buys) !== JSON.stringify(buy1) && rs.rebs[0].buys.includes('2002') && !rs.rebs[0].buys.includes('1101'), JSON.stringify(rs.rebs[0].buys));

// ⑤c 畫面
const html = await page.evaluate(async ({ days, twRows, K, D1 }) => {
  const m = new Map(); for (const r of twRows) { const d = r.date.replace(/\//g, '-'); if (d <= D1) m.set(d, r.close); }
  PRO._twii = { m, days: [...m.keys()].sort() }; PRO._twiiLoad = async () => PRO._twii; PRO._rlK = {};
  PRO.fetchJson = async (u) => /pick_history/.test(u) ? { days } : (K[(u.match(/data\/(\d+)\.json/) || [])[1]] || null);
  let el = document.getElementById('recoLedger');
  PRO._recoSrc = 'lead'; PRO._rlSig = null; PRO._recoLedgerRender();
  for (let i = 0; i < 60 && !(el.innerText || '').includes('換倉訊號'); i++) await new Promise(r => setTimeout(r, 100));
  return { txt: el.innerText, plan: !!el.querySelector('[data-leadplan]'), tab: !!el.querySelector('[data-recosrc="lead"]') };
}, { days: [{ d: D1, lead: lead(A10) }], twRows: tw(1), K, D1 });
ok('⑤c 畫面:👑 分頁 + 「會買」那塊(還沒成交)', html.tab && html.plan && /會買/.test(html.txt), html.txt.slice(0, 300));
ok('⑤d ⛔ 無 🔴🟢、無 pageerror', !/[🔴🟢]/u.test(html.txt) && !errs.length, errs.join(' | '));

// ⑦ 其他三頁:假日快照⛔ 不算
const g = await page.evaluate(async ({ twRows }) => {
  const m = new Map(); for (const r of twRows) m.set(r.date.replace(/\//g, '-'), r.close);
  m.delete('2026-09-25');                                  // 加權那天沒開盤
  PRO._twii = { m, days: [...m.keys()].sort() }; PRO._twiiLoad = async () => PRO._twii; PRO._rlK = {};
  PRO.fetchJson = async (u) => /pick_history/.test(u) ? { days: [{ d: '2026-09-25', pb: [{ s: '1101', c: 100, k: 'x', lb: 1, hq: 1, bear: 0 }] }, { d: '2026-09-24', pb: [{ s: '1102', c: 100, k: 'x', lb: 1, hq: 1, bear: 0 }] }] } : null;
  const R = await PRO._recoLedgerLoad('atr2', 'pb');
  return { ghost: R.ghost, days: R.days, syms: R.trades.map(t => t.sym) };
}, { twRows: tw(1) });
ok('⑦ 🎑 加權沒開盤那天的快照⛔ 不算(假日幽靈)', g.ghost === 1 && g.days === 1 && !g.syms.includes('1101'), JSON.stringify(g));
await browser.close();

// ⑧ pick_snapshot.py --leader
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'leadsnap-'));
const PY = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
os.environ['DATA_DIR'] = ${JSON.stringify(T)}
import importlib, pick_snapshot as P, screener_miner as scr
P.DATA = __import__('pathlib').Path(${JSON.stringify(T)}); P.OUT = P.DATA / 'pick_history.json'
mode = sys.argv[1]
if mode == 'setup':
    import datetime as dt
    days = []; d = dt.date(2025, 11, 3)
    while d <= dt.date(2026, 9, 25):
        if d.weekday() < 5: days.append(d.isoformat())
        d += dt.timedelta(days=1)
    json.dump([{'date': x.replace('-', '/'), 'close': 100 + i} for i, x in enumerate(days)], open(P.DATA / '^TWII.json', 'w'))
    for k in range(12):
        sym = str(3000 + k)
        rows = []
        for i, x in enumerate(days):
            c = round(50 + i * (0.05 + k * 0.01), 2)
            rows.append({'date': x.replace('-', '/'), 'open': c, 'high': c, 'low': c, 'close': c, 'volume': 1000000 * (12 - k)})
        json.dump(rows, open(P.DATA / f'{sym}.json', 'w'))
    D = {'cols': scr.COLS, 'rows': {}, 'data_date': '2026-09-25'}
    for k in range(12):
        v = scr.build_one(json.load(open(P.DATA / f'{3000 + k}.json')))
        v[scr.CI['etf']] = 0; v[scr.CI['att']] = 0
        D['rows'][str(3000 + k)] = v
    json.dump(D, open(P.DATA / 'screener.json', 'w'))
    json.dump({'days': [{'d': '2026-09-25', 'pb': [{'s': '3001', 'c': 1, 'k': 'x'}]}]}, open(P.OUT, 'w'))
elif mode == 'leader':
    print('RC', P.leader_main())
elif mode == 'main':
    json.dump({'data_date': '2026-09-25', 'picks': [{'s': '3002', 'c': 1, 'k': 'y', 'lb': 1, 'hq': 1}]}, open(P.DATA / 'playbook_edge.json', 'w'))
    print('RC', P.main())
H = json.load(open(P.OUT))
print('OUT', json.dumps({x['d']: {'lead': [r['s'] for r in (x.get('lead') or {}).get('rows', [])], 'bf': (x.get('lead') or {}).get('bf'), 'pb': len(x.get('pb') or [])} for x in H['days']}))
`;
const py = (mode) => execFileSync('python3', ['-c', PY, mode], { encoding: 'utf8', cwd: ROOT });
py('setup');
const o1 = py('leader'); const s1 = JSON.parse((o1.match(/OUT (.*)/) || [])[1] || '{}');
ok('⑧ --leader:當天(screener)寫 lead、錨點那天(09-24)回補並標 bf:1', s1['2026-09-25'] && s1['2026-09-25'].lead.length > 0 && !s1['2026-09-25'].bf
  && s1['2026-09-24'] && s1['2026-09-24'].lead.length > 0 && s1['2026-09-24'].bf === 1 && s1['2026-09-25'].pb === 1, o1.slice(-400));
// 再跑一次:09-24 已有 → ⛔ 不重算覆蓋(把它改成假名單,重跑後要還在)
const H1 = JSON.parse(fs.readFileSync(path.join(T, 'pick_history.json'), 'utf8'));
H1.days.find(x => x.d === '2026-09-24').lead.rows = [{ s: 'KEEP', c: 1, r: 1 }];
fs.writeFileSync(path.join(T, 'pick_history.json'), JSON.stringify(H1));
const s2 = JSON.parse((py('leader').match(/OUT (.*)/) || [])[1] || '{}');
ok('⑧b 已經有 lead 的日子⛔ 不覆蓋', JSON.stringify(s2['2026-09-24'].lead) === '["KEEP"]', JSON.stringify(s2['2026-09-24']));
const s3 = JSON.parse((py('main').match(/OUT (.*)/) || [])[1] || '{}');
ok('⑧c main() 同一天重跑 pb/sig ⛔ 不洗掉 lead', s3['2026-09-25'] && s3['2026-09-25'].lead.length > 0 && s3['2026-09-25'].pb === 1, JSON.stringify(s3['2026-09-25']));
fs.rmSync(T, { recursive: true, force: true });

console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條失敗' : '✅ LEADER_LEDGER_PASS'}`);
process.exit(fails.length ? 1 : 0);
