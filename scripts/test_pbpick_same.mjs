// 🧬 V79.4.7 「今天可以買的」三處同一條規則:決策台 `_deckBuyOf` / 尾盤提醒 `_eodTriggerSweep` / auto_trade.py `fetch_picks`
// 🧬 V80.0.9 第四處:Telegram alert_system.py(晚上作戰清單 + 13:20 尾盤買點)—— 以前只排序不擋,會推決策台不會列的(使用者:「一直跌也叫我買」)
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

// alert_system.py:同一份清單走真的 `_rank_picks`(= lib_hotrule.deck_pick)取前 MAX_PICKS 檔
const alPick = list => {
    const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ROOT)})
import alert_system as A
print(json.dumps([str(p['s']) for p in A._rank_picks(json.loads(${JSON.stringify(JSON.stringify(list))}))[:A.MAX_PICKS]]))
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
    const a = alPick(LIST_A);
    ck(JSON.stringify(a) === JSON.stringify(d), `① Telegram alert_system 前 2 名 == 決策台(V80.0.9)— 實得 ${JSON.stringify(a)}`, JSON.stringify(a));
}
// ② 決定性對照:🧬 只剩 1 檔(1111;2222 空頭、3333 / 6666 不是 🧬)→ 兩邊都只給 1 檔
{
    const d = await deckPick(LIST_B), p = pyPick(LIST_B);
    ck(JSON.stringify(d) === JSON.stringify(['1111']), `② 決策台只給 1111(⛔ 不補非 🧬)— 實得 ${JSON.stringify(d)}`);
    ck(JSON.stringify(p) === JSON.stringify(['1111']), `② auto_trade 只給 1111(舊版會補 3333 / 2222)— 實得 ${JSON.stringify(p)}`, JSON.stringify(p));
    const a = alPick(LIST_B);
    ck(JSON.stringify(a) === JSON.stringify(['1111']), `② Telegram alert_system 只給 1111(V80.0.9 以前會補 3333 / 2222)— 實得 ${JSON.stringify(a)}`, JSON.stringify(a));
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
// ④ 🐻 V80.0.9 尾盤提醒實跑(假資料、假時鐘、假報價):① 空頭守門開 + 嚴格空頭 → ⛔ 不推;關著 → 照推(決定性對照)
//    ② 只看決策台那 2 檔:前 2 名沒成立、第 3 名成立 → ⛔ 不推第 3 名;同一檔分數拉高排進前 2 → 會推(決定性對照)
{
    const run = async (opt) => page.evaluate(async (o) => {
        const pushed = [];
        app._mySyms = () => new Set();
        app._isLead = () => false;
        app.settings.watchlistAlert = true;
        app.settings.bearGate = o.gate;
        try { Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true }); } catch (_) {}
        app._tpeMinutes = () => ({ wd: 'Wed', min: app._EOD_FROM + 2 });
        app._eodBusy = false;
        app._kbarFiredToday = () => false;
        app._pbRecordFire = () => {};
        app._pbGrade = () => ({ top: false });
        app._lotsForPlaybook = () => ({ acc: 0 });
        app._loadPlaybookEdge = async () => ({ data_date: '2026-10-30', picks: o.picks, mkt: { bear60: o.bear, d: '2026-10-30', c: 100, ma20: 99, ma60: 101 } });
        app.fetchFugleData = async () => ({ price: 100 });
        app._pbExactCheck = async (sym) => ({ fired: o.fire.includes(sym), stop: 95, price: 100 });
        app._fireAlert = (title, body, sym) => { pushed.push(String(sym)); };
        await app._eodTriggerSweep();
        return pushed;
    }, opt);
    const P = (s, lb) => ({ s, k: '💪 發動棒破昨高', lb, exp: lb, rank: 92, vol: 75, hq: 1, bear: 0, trig: 100, stop: 95, c: 98, v: 1000 });
    const two = [P('1111', 5), P('4444', 3)];
    const g1 = await run({ gate: true, bear: true, picks: two, fire: ['1111', '4444'] });
    const g0 = await run({ gate: false, bear: true, picks: two, fire: ['1111', '4444'] });
    ck(g1.length === 0, `④ 空頭守門開 + 大盤嚴格空頭 → 尾盤提醒 ⛔ 不推(決策台寫「今天不開新倉」)— 實推 ${JSON.stringify(g1)}`);
    ck(JSON.stringify(g0) === JSON.stringify(['1111', '4444']), `④ 決定性對照:守門關(預設)→ 照推決策台那 2 檔 — 實推 ${JSON.stringify(g0)}`);
    const three = [P('1111', 5), P('4444', 4), P('5555', 3)];
    const t1 = await run({ gate: false, bear: false, picks: three, fire: ['5555'] });
    const t2 = await run({ gate: false, bear: false, picks: [P('1111', 5), P('4444', 4), P('5555', 9)], fire: ['5555'] });
    ck(t1.length === 0, `④ 只看決策台那 2 檔:第 3 名成立 → ⛔ 不推(以前掃前 8 筆會往下補)— 實推 ${JSON.stringify(t1)}`);
    ck(JSON.stringify(t2) === JSON.stringify(['5555']), `④ 決定性對照:同一檔分數拉高排進前 2 → 會推 — 實推 ${JSON.stringify(t2)}`);
}
await browser.close();
console.log(FAIL.length ? `\n❌ ${FAIL.length} 條失敗` : '\n✅ 全過');
process.exit(FAIL.length ? 1 : 0);
