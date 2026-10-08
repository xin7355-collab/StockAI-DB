#!/usr/bin/env node
/**
 * 🟥 V78.6.7 漲停隔天開低提醒(`_luGapPick` / `_luGapSweep`)守門
 *   使用者:「做成提醒」。研究在 LAB `lu-gapdown`(lu_split_probe):昨天鎖漲停、今天開低 >1% → 當天反彈;
 *   一般開低股票 5 分鐘後就彈完(開盤撮合價假象)→ 自選只在開低 ≥3% 才提醒,而且叫人「等開盤 5 分鐘後」。
 * 釘住:
 *   ⓐ 庫存:昨天鎖漲停 + 開盤 ≤ +1% → held;開高 3% → ⛔ 不提醒
 *   ⓑ 自選:開低 2% / 4% → ⛔;開低 6% → fav;量縮鎖開低 2% → fav
 *   ⓒ 自選:連續第 2 根漲停 → ⛔ 不提醒(研究:連續 ≥2 根後的開低沒那麼好)
 *   ⓓ 昨天沒鎖漲停 / 沒有開盤價 / 昨收對不上(快照是別天的)→ ⛔ 不提醒
 *   ⓔ 只在台北平日 09:00~10:30;一檔一天一次(localStorage 去重)
 *   ⓕ 👑 的持股 ⛔ 不套(漲停隔天四條套到 👑 全輸,V78.2.0)
 *   ⓖ 文案 ⛔ 不放研究數字 / ⛔「開低別接刀」舊說法;標題歸到「🟥 漲停隔天開低」那一類(使用者關得掉)
 *   ⓗ 決定性對照:把門檻 fav 改成 −7,開低 6% 那檔就不提醒;量縮門檻改 0.4 → 量縮那檔不提醒
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

// ── 靜態 ──
{
    const i = src.indexOf('async _dailyOvernightAlertSweep() {');
    const seg = src.slice(i, src.indexOf('\n    },\n', i)).replace(/^\s*\/\/.*$/gm, '');   // ⛔ 剝掉註解(註解裡引用舊說法是合法的)
    ok('ⓖ 隔日沖盤點 ⛔ 不可再叫人「開低別接刀」(跟實測相反)', i > 0 && !/開低別接刀/.test(seg) && !/開高不破開盤價可續抱/.test(seg), seg.slice(0, 200));
    const j = src.indexOf('    async _luGapSweep('), k = src.indexOf('\n    },\n', j);
    const sw = src.slice(j, k);
    ok('ⓖb 提醒文案 ⛔ 不放研究數字(實測 / 回測 / 勝率 / 平均 / 六關)', j > 0 && !/實測|回測|勝率|平均|六關|pp\b/.test(sw.replace(/^\s*\/\/.*$/gm, '')), '');
    ok('ⓔb 盤中快照每次更新都會掃(接在 _startLiveQuotePoll)', /this\._luGapSweep\(\)/.test(src.slice(src.indexOf('    _startLiveQuotePoll() {'), src.indexOf('    _startLiveQuotePoll() {') + 2000)));
}

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._luGapPick && !!app._luLock, null, { timeout: 30000 });

const R = await page.evaluate(() => {
    const mk = (n, lockLast, lockPrev, lastVol) => {
        const rows = []; let p = 100;
        for (let i = 0; i < n; i++) {
            let c = p * (1 + ((i % 5) - 2) * 0.004);
            if (lockPrev && i === n - 2) c = p * 1.1;
            if (lockLast && i === n - 1) c = p * 1.1;
            rows.push({ date: `2026/09/${String(1 + i).padStart(2, '0')}`, open: p, high: c, low: Math.min(p, c) * 0.99, close: c, volume: (lastVol && i === n - 1) ? lastVol : 1000 });
            p = c;
        }
        return rows;
    };
    const R = {}, A = app;
    const rows = mk(40, true, false), y = rows[rows.length - 1].close;
    const q = gap => ({ p: y * 0.97, c: (0.97 - 1) * 100, o: Math.round(y * (1 + gap / 100) * 100) / 100 });
    R.heldLow = A._luGapPick(rows, q(-2), true);
    R.heldFlat = A._luGapPick(rows, q(0.5), true);
    R.heldHigh = A._luGapPick(rows, q(3), true);
    R.fav2 = A._luGapPick(rows, q(-2), false);
    R.fav4 = A._luGapPick(rows, q(-4), false);
    R.fav6 = A._luGapPick(rows, q(-6), false);
    const lv = mk(40, true, false, 590), ly = lv[lv.length - 1].close, ql = gap => ({ p: ly * 0.97, c: (0.97 - 1) * 100, o: Math.round(ly * (1 + gap / 100) * 100) / 100 });
    R.low2 = A._luGapPick(lv, ql(-2), false);
    R.low05 = A._luGapPick(lv, ql(-0.5), false);
    { const k = A._LUGAP.lowVol; A._LUGAP.lowVol = 0.4; R.lowCtl = A._luGapPick(lv, ql(-2), false); A._LUGAP.lowVol = k; }
    const rs = mk(40, true, true), ys = rs[rs.length - 1].close;
    R.favStreak = A._luGapPick(rs, { p: ys, c: 0, o: ys * 0.96 }, false);
    R.favStreakHeld = A._luGapPick(rs, { p: ys, c: 0, o: ys * 0.96 }, true);   // 決定性對照:同一組資料當庫存要過(⛔ 不是被昨收守門擋掉的)
    R.noLock = A._luGapPick(mk(40, false, false), q(-4), false);
    R.noOpen = A._luGapPick(rows, { p: y, c: 0 }, false);
    R.badPc = A._luGapPick(rows, { p: y * 1.5, c: 0, o: y * 1.4 }, false);
    const keep = A._LUGAP.fav; A._LUGAP.fav = -7; R.ctl = A._luGapPick(rows, q(-6), false); A._LUGAP.fav = keep;
    R.cat = (A._alertCatOf('🟥 漲停隔天開低｜光頡') || {}).k;
    return R;
});
ok('ⓐ 庫存:開低 2% → held', R.heldLow && R.heldLow.kind === 'held' && Math.abs(R.heldLow.gap + 2) < 0.15, JSON.stringify(R.heldLow));
ok('ⓐb 庫存:開平 +0.5% → held(開平開低都別在開盤殺)', R.heldFlat && R.heldFlat.kind === 'held', JSON.stringify(R.heldFlat));
ok('ⓐc 庫存:開高 3% → ⛔ 不提醒', R.heldHigh === null, JSON.stringify(R.heldHigh));
ok('ⓑ 自選:開低 2% → ⛔ 不提醒', R.fav2 === null, JSON.stringify(R.fav2));
ok('ⓑb 自選:一般量鎖、開低 4% → ⛔ 不提醒(V78.6.8:開低 3~5% 09:05 買中位數 ≈ 0)', R.fav4 === null, JSON.stringify(R.fav4));
ok('ⓑc 自選:開低 6% → fav', R.fav6 && R.fav6.kind === 'fav', JSON.stringify(R.fav6));
ok('ⓑd 自選:量縮鎖(量 590 ÷ 前 20 天 1000 = 0.59;基準含當天會變 0.602)開低 2% → fav', R.low2 && R.low2.kind === 'fav' && R.low2.lowVol === 1, JSON.stringify(R.low2));
ok('ⓑe 自選:量縮鎖但只開低 0.5% → ⛔', R.low05 === null, JSON.stringify(R.low05));
ok('ⓑf 決定性對照:量縮門檻改 0.4 → 同一檔不提醒', R.lowCtl === null && R.low2 !== null, JSON.stringify(R.lowCtl));
ok('ⓒ 自選:連續第 2 根漲停 → ⛔ 不提醒(同一組資料當庫存仍提醒 = 不是被別的守門擋掉)', R.favStreak === null && R.favStreakHeld && R.favStreakHeld.kind === 'held', JSON.stringify([R.favStreak, R.favStreakHeld]));
ok('ⓓ 昨天沒鎖漲停 → ⛔', R.noLock === null);
ok('ⓓb 沒有開盤價 → ⛔', R.noOpen === null);
ok('ⓓc 昨收對不上(快照是別天的)→ ⛔', R.badPc === null);
ok('ⓗ 決定性對照:門檻改 −7 → 開低 6% 不提醒', R.ctl === null && R.fav6 !== null);
ok('ⓖc 標題歸到「漲停隔天開低」這一類(關得掉,⛔ 不是鎖住的 👜 部位)', R.cat === 'lunext', R.cat);

// ── sweep:時間窗、去重、👑 ──
const S = await page.evaluate(async () => {
    const A = app, out = {};
    const mk = n => { const rows = []; let p = 100; for (let i = 0; i < n; i++) { let c = i === n - 1 ? p * 1.1 : p * (1 + ((i % 5) - 2) * 0.004); rows.push({ date: `2026/09/${String(1 + i).padStart(2, '0')}`, open: p, high: c, low: Math.min(p, c) * 0.99, close: c, volume: 1000 }); p = c; } return rows; };
    const rows = mk(40), y = rows[39].close;
    const bars = new Map([['2330', rows], ['2317', rows]]);
    const quotes = { '2330': { p: y, c: 0, o: y * 0.94 }, '2317': { p: y, c: 0, o: y * 0.94 } };
    const inv = A._getInventory; A._getInventory = () => [{ symbol: '2330', cost: 90, shares: 1000 }];
    try { localStorage.removeItem('luGapAlert_v1'); } catch (_) {}
    const T = (h, m) => new Date(Date.UTC(2026, 9, 8, h - 8, m));   // 2026-10-08(週四)台北時間
    out.before = (await A._luGapSweep({ now: T(8, 50), scan: { bars }, quotes, force: 1, dry: 1 })).length;
    out.in1 = (await A._luGapSweep({ now: T(9, 6), scan: { bars }, quotes, force: 1, dry: 1 })).map(x => x.sym + '|' + (x.body.includes('你手上有') ? 'held' : 'fav'));
    out.in2 = (await A._luGapSweep({ now: T(9, 20), scan: { bars }, quotes, force: 1, dry: 1 })).length;
    try { localStorage.removeItem('luGapAlert_v1'); } catch (_) {}
    out.after = (await A._luGapSweep({ now: T(10, 45), scan: { bars }, quotes, force: 1, dry: 1 })).length;
    out.sat = (await A._luGapSweep({ now: new Date(Date.UTC(2026, 9, 10, 1, 10)), scan: { bars }, quotes, force: 1, dry: 1 })).length;
    const st = A._strat, lo = A._leadOwns; A._strat = () => 'lead'; A._leadOwns = () => true;
    try { localStorage.removeItem('luGapAlert_v1'); } catch (_) {}
    out.lead = (await A._luGapSweep({ now: T(9, 6), scan: { bars }, quotes, force: 1, dry: 1 })).map(x => x.sym);
    A._strat = st; A._leadOwns = lo; A._getInventory = inv;
    out.bodies = (await (async () => { try { localStorage.removeItem('luGapAlert_v1'); } catch (_) {} A._getInventory = () => [{ symbol: '2330', cost: 90, shares: 1000 }]; const r = await A._luGapSweep({ now: T(9, 6), scan: { bars }, quotes, force: 1, dry: 1 }); A._getInventory = inv; return r.map(x => x.title + ' ' + x.body); })());
    return out;
});
ok('ⓔ 09:00 前 ⛔ 不提醒', S.before === 0, S.before);
ok('ⓔb 09:06 庫存一則(held)+ 自選一則(fav)', JSON.stringify(S.in1.sort()) === JSON.stringify(['2317|fav', '2330|held']), JSON.stringify(S.in1));
ok('ⓔc 同一天第二次 ⛔ 不重複', S.in2 === 0, S.in2);
ok('ⓔd 10:30 之後 ⛔ 不提醒', S.after === 0, S.after);
ok('ⓔe 週末 ⛔ 不提醒', S.sat === 0, S.sat);
ok('ⓕ 👑 的持股 ⛔ 不套;自選照舊', JSON.stringify(S.lead) === JSON.stringify(['2317']), JSON.stringify(S.lead));
ok('ⓖd 文案:庫存講「別在開盤殺」、自選講「等開盤 5 分鐘後、收盤前賣完」', S.bodies.some(b => /別在開盤殺/.test(b)) && S.bodies.some(b => /5 分鐘後/.test(b) && /收盤前賣完/.test(b)), S.bodies.join(' / '));
ok('⓪ 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
