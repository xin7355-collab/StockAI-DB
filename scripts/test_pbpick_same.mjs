// 🧬 V79.4.7 「今天可以買的」三處同一條規則:決策台 `_deckBuyOf` / 尾盤提醒 `_eodTriggerSweep` / auto_trade.py `fetch_picks`
//
// 🚨 為什麼要這支:V73.2.9 起 🧬 是**必要條件**(不挑它整套輸給 0050),決策台改了,
//    但尾盤提醒與 auto_trade.py 還是「🧬 排前面、不擋」→ 🧬 不夠 2 檔時會推 / 買**非 🧬** 的(陷阱 #37);
//    決策台還多擋「這一檔自己空頭」,另外兩處也沒有。
//
// 釘住:
//  ① 同一份合成清單(有非 🧬 但下界最高的、🧬 但自己空頭的、同一檔兩招)→ 決策台前 2 名 == auto_trade 前 2 名
//  ② ⭐ 決定性對照:把清單裡 🧬 只留 1 檔 → 兩邊都只給 1 檔(⛔ 不可補非 🧬 的)
//  ③ 尾盤提醒的掃描名單也走同一個濾網(原始碼:`_eodTriggerSweep` 裡 `_pbSort(...)` 後面接 🧬 + 不是空頭)
//
// 跑法:node scripts/test_pbpick_same.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ck = (c, m, e = '') => { console.log((c ? '✅ ' : '❌ ') + m + (c || !e ? '' : `  ${String(e).slice(0, 300)}`)); if (!c) FAIL.push(m); };

// 採礦端的排法:🧬 優先 → 下界由高到低(playbook_scan:`(b.hq - a.hq) || (b.lb - a.lb) || (b.v - a.v)`)
const mk = (s, k, lb, rank, vol, bear = 0) => ({ s, k, lb, rank, vol, hq: (rank >= 85 && vol >= 60) ? 1 : 0, bear, trig: 100, stop: 95, c: 98, v: 1000 });
const sortMiner = a => a.slice().sort((x, y) => (y.hq - x.hq) || (y.lb - x.lb) || (y.v - x.v));
const LIST_A = sortMiner([
    mk('3333', '💪 發動棒破昨高', 9.0, 50, 70),            // 下界最高,但 ⛔ 不是 🧬
    mk('1111', '💪 發動棒破昨高', 5.0, 92, 75),            // 🧬
    mk('1111', '🎯 回後買上漲', 4.0, 92, 75),              // 同一檔第二招 → 去重
    mk('2222', '📦 箱型突破', 4.5, 90, 80, 1),             // 🧬 但這一檔自己空頭
    mk('4444', '🕯️ 站上長黑K壓力', 3.0, 88, 65),          // 🧬
    mk('5555', '📈 葛蘭碧買點', 2.0, 95, 90),              // 🧬
]);
const LIST_B = sortMiner([mk('3333', '💪 發動棒破昨高', 9.0, 50, 70), mk('1111', '💪 發動棒破昨高', 5.0, 92, 75), mk('2222', '📦 箱型突破', 4.5, 90, 80, 1), mk('6666', '📦 箱型突破', 4.0, 60, 90)]);
const wrap = picks => ({ data_date: '2026-10-20', picks, mkt: { bear60: false } });

// auto_trade.py:用假的網路回傳同一份清單,走真的 fetch_picks
const pyPick = list => {
    const code = `
import sys, json, io, os
sys.path.insert(0, ${JSON.stringify(ROOT)})
import auto_trade as A
data = json.dumps(${JSON.stringify(JSON.stringify(wrap(list)))}).encode()
class R(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False
A.urllib.request.urlopen = lambda *a, **k: R(json.loads(data).encode() if isinstance(json.loads(data), str) else data)
A.log = lambda *a, **k: None
j, picks = A.fetch_picks()
print(json.dumps([p['s'] for p in picks[:A.MAX_PICKS]]))
`;
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 60000 });
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) { return { err: (r.stderr || r.stdout || '').slice(-400) }; }
};

const _exec = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._deckBuyOf === 'function', null, { timeout: 60000 });
const deckPick = async list => page.evaluate(j => { app._mySyms = () => new Set(); return app._deckBuyOf(j).buy.map(x => String(x.s)); }, wrap(list));

// ① 同一份清單 → 兩邊前 2 名一樣
{
    const d = await deckPick(LIST_A), p = pyPick(LIST_A);
    ck(JSON.stringify(d) === JSON.stringify(['1111', '4444']), `① 決策台前 2 名 = 1111, 4444(非 🧬 的 3333、自己空頭的 2222 都不給)— 實得 ${JSON.stringify(d)}`);
    ck(JSON.stringify(p) === JSON.stringify(d), `① auto_trade 前 2 名 == 決策台 — 實得 ${JSON.stringify(p)}`, JSON.stringify(p));
}
// ② 決定性對照:🧬 只剩 1 檔(1111;2222 空頭、3333 / 6666 不是 🧬)→ 兩邊都只給 1 檔
{
    const d = await deckPick(LIST_B), p = pyPick(LIST_B);
    ck(JSON.stringify(d) === JSON.stringify(['1111']), `② 決策台只給 1111(⛔ 不補非 🧬)— 實得 ${JSON.stringify(d)}`);
    ck(JSON.stringify(p) === JSON.stringify(['1111']), `② auto_trade 只給 1111(舊版會補 3333 / 2222)— 實得 ${JSON.stringify(p)}`, JSON.stringify(p));
}
// ③ 尾盤提醒的掃描名單走同一個濾網
{
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const i = src.indexOf('async _eodTriggerSweep('), body = i > 0 ? src.slice(i, src.indexOf('\n    },', i)) : '';
    ck(body.length > 500, '③ 找得到 _eodTriggerSweep');
    ck(/_pbSort\(list, mine\)\.filter\(x => this\._hqOf\(x\) === 1 && !x\.bear\)/.test(body), '③ 尾盤提醒:_pbSort 之後接「🧬 + 這一檔自己不是空頭」(跟 _deckBuyOf 同一條)');
    const dk = src.indexOf('_deckBuyOf(j) {'), dbody = dk > 0 ? src.slice(dk, src.indexOf('\n    },', dk)) : '';
    ck(/this\._hqOf\(x\) === 1 && !x\.bear/.test(dbody), '③ 決策台 _deckBuyOf 還是同一條(⛔ 一邊改了另一邊沒改)');
}
await browser.close();
console.log(FAIL.length ? `\n❌ ${FAIL.length} 條失敗` : '\n✅ 全過');
process.exit(FAIL.length ? 1 : 0);
