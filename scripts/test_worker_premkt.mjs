#!/usr/bin/env node
/**
 * 🧊 V82.7.0 Telegram 盤前簡報的「今天開高 / 開低」改成跟 App 盤前頁同一個結論(使用者 11/26 選);V82.7.1 起 08:10 發(等早上那份凍結好)
 *   worker `runPreMarket` 只讀 macro_risk.premkt_recent[今天].out(macro_cron 早上用 index.html 真的函式凍結的),⛔ 自己算
 *  ① 今天那筆有凍結 → 訊息裡是 App 的字 + 燈號 + 分數(美股三項全漲也照 App 講「開低偏空」)
 *  ② ⭐ 決定性對照:同一組美股(舊的簡化版會講「開高偏多」)、沒有凍結 → 訊息裡 ⛔ 任何開高 / 開低 / 偏多 / 偏空,只指路 App
 *  ③ 昨天那筆 / 不是開盤前寫的那筆(09:10)/ 結論不是那三種 / 分數不是數字 → 一律當沒有
 *  ④ 燈號跟 App renderMarketBriefing 同一組(跨檔:🔴 開高偏多 / 🟢 開低偏空 / 🟡 中性震盪)
 *  ⑤ 舊的 dScore / 「方向分」不在 runPreMarket 裡;外資那行講「不算進盤前分數」
 *  ⑥ 🧊 V82.7.1 標題寫「台北08:10」(⛔ 還寫 08:00 —— 那則已經挪到 08:10 那輪發)
 *  實跑:假的網路(macro_risk / radar / attention / risk_history)+ 假的 KV 一個使用者,抓 Telegram sendMessage 的內容來比
 *  INJECT=1:把結論換回舊的簡化版 / 不看日期 / 不看寫入時間 —— 三種都要紅
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env._WP_INJ || '';
const INJECTS = {
    oldDscore: ['    const callLine = premktCallLine(macro);',
        "    const _sg = v => (Number.isFinite(+v) ? (v > 0 ? 1 : v < 0 ? -1 : 0) : 0); const _ds = macro ? _sg(macro.sp500_chg_pct) + _sg(macro.nasdaq_chg_pct) + (macro.vix < 20 ? 1 : 0) : 0;\n    const callLine = _ds >= 2 ? '🔴 *今天 開高偏多*' : _ds <= -2 ? '🟢 *今天 開低偏空*' : premktCallLine(macro);"],
    noDate: ['.find(x => x && x.d === today);', '.find(x => x && x.d);'],
    noAt: ["    if (!/^0[5-8]:\\d\\d$/.test(String(e.at || ''))) return null;", ''],
};
let W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
if (INJ) { const [a, b] = INJECTS[INJ]; if (!W.includes(a)) { console.log('❌ 注入點找不到:' + INJ); process.exit(1); } W = W.replace(a, b); }
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
const tmp = path.join(ROOT, 'scripts', `.tmp_worker_pm_${process.pid}.mjs`);
fs.writeFileSync(tmp, W);
let M; try { M = await import(pathToFileURL(tmp).href); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
const { runPreMarket, premktFrozen, premktCallLine } = M;
ok('⓪ export runPreMarket / premktFrozen / premktCallLine', [runPreMarket, premktFrozen, premktCallLine].every(f => typeof f === 'function'));

const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const yday = new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const US_UP = { sp500_chg_pct: 1.8, nasdaq_chg_pct: 2.1, vix: 15, fi_spot_net: 120, fi_futures_net: -20000, updated: '2026-11-27 07:42' };
const fz = (call, sPct, at = '07:42', d = today) => ({ ...US_UP, premkt_recent: [{ d, at, x: { sp500_chg_pct: 1.8 }, out: { s: sPct >= 65 ? 4 : sPct <= 35 ? -4 : 0, sPct, call } }] });

/** 實跑 runPreMarket:假網路 + 一個使用者 → 回傳送出去的 Telegram 文字 */
async function runWith(macro) {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        const u = String(url);
        const J = o => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
        if (u.includes('api.telegram.org')) { sent.push(JSON.parse(opts.body).text); return J({ ok: true }); }
        if (u.includes('/data/macro_risk.json')) return J(macro);
        if (u.includes('/data/risk_history.json')) return J([]);
        return J({});
    };
    const env = {
        TELEGRAM_BOT_TOKEN: 't',
        KV: {
            list: async () => ({ keys: [{ name: 'user:1' }], list_complete: true }),
            get: async () => JSON.stringify({ chat_id: 1, watchlist: [], inventory: [], settings: {} }),
            put: async () => {},
        },
    };
    try { await runPreMarket(env); } finally { globalThis.fetch = realFetch; }
    return sent.join('\n');
}
const DIRW = /開高|開低|偏多|偏空/;

// ① 有凍結 → App 的結論(美股全漲,App 那天講開低偏空 → 照 App)
const m1 = await runWith(fz('開低偏空', 28));
ok('① 有凍結 → 訊息是 App 那一句 + 燈號 + 分數(🟢 開低偏空 28/100)', m1.includes('🟢 *今天 開低偏空*(App 盤前分數 28/100,07:42 的資料)'), m1.slice(0, 300));
ok('① 美股三項全漲也照 App 講(⛔ 自己再算一個開高偏多)', !/開高偏多/.test(m1), m1.slice(0, 300));
const m1b = await runWith(fz('開高偏多', 72));
ok('① 另一種結論也一樣(🔴 開高偏多 72/100)', m1b.includes('🔴 *今天 開高偏多*(App 盤前分數 72/100'), m1b.slice(0, 300));

// ② 決定性對照:同一組美股、沒有凍結
const sgn = v => (v > 0 ? 1 : v < 0 ? -1 : 0);
const oldScore = sgn(US_UP.sp500_chg_pct) + sgn(US_UP.nasdaq_chg_pct) + (US_UP.vix < 20 ? 1 : 0);
const m2 = await runWith({ ...US_UP });
const head2 = m2.split('\n').filter(l => !/外資|主力出貨|完整盤前體檢/.test(l)).join('\n');
ok(`② ⭐ 決定性對照:沒有凍結 → ⛔ 任何開高 / 開低(舊簡化版這組 ${oldScore} 分 = 講開高偏多)`, oldScore >= 2 && m2.length > 0 && !DIRW.test(head2), head2.slice(0, 300));
ok('② 沒有凍結 → 指路 App 盤前頁', /看 App 盤前頁/.test(m2), m2.slice(0, 200));
ok('② 美股漲跌那一行照樣列', /SP500 \+1\.80% \/ NASDAQ \+2\.10% \/ VIX 15\.0/.test(m2), m2.slice(0, 300));

// ③ 不算數的幾種
const no = [['昨天那筆', fz('開高偏多', 72, '07:42', yday)], ['09:10 寫的', fz('開高偏多', 72, '09:10')], ['結論不是那三種', fz('大漲', 72)],
            ['分數不是數字', fz('開高偏多', 'x')], ['沒有 out', { ...US_UP, premkt_recent: [{ d: today, at: '07:42', x: {} }] }]];
for (const [nm, m] of no) ok(`③ ${nm} → 當沒有(⛔ 講結論)`, premktFrozen(m) === null && !DIRW.test(premktCallLine(m)), JSON.stringify(premktFrozen(m)));

// ④ 跨檔:燈號跟 App 同一組
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appLight = c => { const m = IDX.match(new RegExp(`verdict === '${c}'\\) \\{ light = '([^']+)'`)); return m && m[1]; };
const wLight = c => { const F = premktFrozen(fz(c, 50)); return F && F.light; };
ok('④ 燈號跟 App renderMarketBriefing 同一組(開高偏多 / 開低偏空)', ['開高偏多', '開低偏空'].every(c => appLight(c) && appLight(c) === wLight(c)), ['開高偏多', '開低偏空'].map(c => `${c} App ${appLight(c)} / worker ${wLight(c)}`).join(' ・'));
ok('④ 中性那一種跟 App 的 else(🟡)一樣', /else \{ light = '🟡'; vColor = 'yellow'; \}/.test(IDX) && wLight('中性震盪') === '🟡');
ok('④ App 的三種結論只從 _premktCall 來(worker 認的就是那三種字)', /_premktCall\(s\) \{ return s >= 3 \? '開高偏多' : s <= -3 \? '開低偏空' : '中性震盪'; \}/.test(IDX));

// ⑤ 靜態:舊的算法不在了
const body = (() => { const i = W.indexOf('async function runPreMarket('), j = W.indexOf('\n}\n', i); return W.slice(i, j).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n'); })();   // 去掉註解(說明裡會提到舊名字)
ok('⑤ runPreMarket 裡 ⛔ dScore / 方向分', !/dScore|方向分/.test(body), (body.match(/.*(dScore|方向分).*/) || [''])[0]);
ok('⑤ 外資那行講「不算進盤前分數」', /只列出來,不算進盤前分數/.test(body));
ok('⑥ 🧊 標題寫台北08:10(⛔ 還寫 08:00)', /盤前簡報\* _[^_]* 台北08:10_/.test(m1) && !/台北08:00/.test(m1), m1.split('\n')[0]);

if (process.env.INJECT && !INJ) {
    let allRed = true;
    for (const k of Object.keys(INJECTS)) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, INJECT: '', _WP_INJ: k }, encoding: 'utf8', timeout: 120000 });
        const reds = (r.stdout || '').split('\n').filter(l => l.startsWith('❌'));
        const hit = r.status !== 0 && reds.length > 0;
        console.log(`${hit ? '✅' : '❌'} 注入 ${k} → ${reds[0] ? reds[0].slice(0, 90) : '沒叫出來'}`);
        allRed = allRed && hit;
    }
    ok('🧪 三種注入全部叫得出來', allRed);
}
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ WORKER_PREMKT_PASS');
process.exit(fails.length ? 1 : 0);
