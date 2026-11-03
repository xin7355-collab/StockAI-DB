#!/usr/bin/env node
/**
 * 🧯 V80.2.2 回測引擎 `PARK=idle`(閒錢停 0050):現金 + 0050 湊不到一筆 → ⛔ 賣 0050(LAB method park-churn)
 *
 * 為什麼:以前要買的那一刻現金不夠就先把 0050 賣掉湊錢 —— 但「現金 + 0050」加起來還是不到一筆(LOT)時,
 *   賣完照樣買不了(skipped),收盤又把錢停回 0050 → 隔天再來一次 → 每天來回 PARK_COST(0.27%)。
 *   賠到剩不到一筆的路徑一路磨到 0(量化實驗室「接近一年高點帶量 + 拉回 20 日均線」16 年起點 251:原樣 0.1 萬 vs 加守門 128.6 萬)。
 *
 * 釘住:
 *   ⓢ 靜態:賣 0050 湊錢那段要先問「現金 + 0050 夠不夠一筆」(ROTATE 照舊先賣)
 *   ⓐ ⭐ 決定性對照:CAPITAL 3 萬 < LOT 15 萬(錢永遠湊不到一筆 —— ⚠️ 10 萬不行:停在 0050 那幾年漲一倍多,後面真的湊得到)→ 一筆都沒買、0050 只買 1 次、只在最後結算賣 1 次、「湊不到一筆沒賣」> 0
 *      `INJECT=old`:把守門拿掉的副本跑同一組 → 賣出次數 > 10(= 以前每天來回)→ ⓐ 必紅
 *   ⓑ 正常本金:照樣有買、照樣有賣 0050 湊錢(⛔ 修過頭 = 永遠不賣)
 * ⚠️ 真跑引擎(repo data/ 前 99 檔),約 2~3 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const GUARD = 'if (ROTATE || parkSh * _pps >= _need - 1e-6) {';
let FILE = SRC, injFile = null;
// 🧯 V81.0.0 逐年模式 + 停 0050:那一年最後一天就結清(INJECT=year 拿掉 → ⓒ 必紅)
const YGUARD = 'if (YEAR && i > YR_TO && PARK && parkOf && parkSh > 0) {';
if (process.env.INJECT === 'year') {
    const s = fs.readFileSync(SRC, 'utf8');
    if (!s.includes(YGUARD)) { console.error('❌ 注入點找不到'); process.exit(1); }
    injFile = path.join(ROOT, 'scripts', `_pb_parkchurn_inject_${process.pid}.mjs`);
    fs.writeFileSync(injFile, s.replace(YGUARD, 'if (false) {'));
    FILE = injFile;
    console.log('🧪 INJECT=year:拿掉「逐年模式那一年最後一天就結清 0050」');
}
if (process.env.INJECT === 'old') {
    const s = fs.readFileSync(SRC, 'utf8');
    if (!s.includes(GUARD)) { console.error('❌ 注入點找不到'); process.exit(1); }
    injFile = path.join(ROOT, 'scripts', `_pb_parkchurn_inject_${process.pid}.mjs`);   // ⚠️ 要放在 scripts/ 裡(引擎用相對路徑 import lib)
    fs.writeFileSync(injFile, s.replace(GUARD, 'if (true) {'));
    FILE = injFile;
    console.log('🧪 INJECT=old:拿掉「湊不到一筆就不賣 0050」的守門');
}
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

try {
    // ── ⓢ 靜態 ──
    const CODE = fs.readFileSync(SRC, 'utf8');
    const blk = (CODE.match(/if \(PARK === 'idle' && cash < amt && parkSh > 0[\s\S]{0,900}?parkShort\+\+;\s*\}/) || [''])[0];
    ok('ⓢ 賣 0050 湊錢前先問「現金 + 0050 夠不夠一筆」(ROTATE 照舊先賣);不夠記 parkShort', blk.includes(GUARD) && /else parkShort\+\+;/.test(blk), blk.slice(0, 300));

    // ── 執行期 ──
    const DATA = path.join(ROOT, 'data');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parkchurn-'));
    const base = { ...process.env, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: '', STOPFILL: 'close', WARMUP: '240', GATE: 'lb', MIN_N: '4', PARK: 'idle', BENCH0050: path.join(DATA, '0050.json') };
    for (const k of ['STATS_WIN', 'STATS_FROM', 'LB_Z', 'LB_TOP', 'CLIFF', 'RANKBY', 'WARMUPS', 'YEARRUNS', 'YEAR_OFFSET', 'VOLCAP', 'EQGATE', 'ROTATE', 'COST_X', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'YEAR', 'CAPITAL', 'BEAR_MODE', 'DAYGATE', 'LISTK', 'ALLFIRE', 'PSRC']) delete base[k];
    const run = (tag, extra) => {
        const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '99', '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), EQUITY_OUT: path.join(tmp, `e_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
        let s = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {}
        const m = (r.stdout || '').match(/停泊進出\s+買 (\d+) 次 \/ 賣 (\d+) 次[^\n]*?湊不到一筆沒賣 (\d+) 次/);
        return { r, s, buy: m ? +m[1] : null, sell: m ? +m[2] : null, short: m ? +m[3] : null, tail: ((r.stdout || '') + (r.stderr || '')).slice(-500) };
    };

    // ⓐ 錢永遠湊不到一筆(⚠️ 一筆都沒進場時引擎 exit 1、⛔ 寫 summary —— 那正是預期;停泊進出那一行在 exit 前照印,逐日淨值也照寫)
    const A = run('a', { CAPITAL: '30000' });
    const out = A.r.stdout || '';
    ok('ⓐ0 CAPITAL < LOT 跑得完、印出停泊進出那一行', A.buy != null, A.tail);
    ok(`ⓐ1 ⭐ 一筆都沒買(3 萬就算停在 0050 一路漲也到不了 15 萬)`, A.r.status === 1 && /一筆都沒進場/.test(out) && !A.s, A.tail);
    ok(`ⓐ2 ⭐ 0050 只買 1 次、只在最後結算賣 1 次(買 ${A.buy} / 賣 ${A.sell};以前每天來回)`, A.buy === 1 && A.sell === 1, `buy=${A.buy} sell=${A.sell}`);
    ok(`ⓐ3 有碰到「想買但湊不到一筆」的日子(${A.short} 次)—— 證明那段判斷真的被走到(⛔ 空過)`, A.short > 0, `short=${A.short}`);
    // ⓐ4 獨立對帳:逐日淨值的 0050 市值 ÷ 那天 0050 收盤 = 手上 0050 股數 → ⛔ 可以往下掉(往下掉一天 = 那天來回一次 0.27%)
    let drops = null, days = 0;
    try {
        const E = JSON.parse(fs.readFileSync(path.join(tmp, 'e_a.json'), 'utf8')).rows;
        const C = new Map(JSON.parse(fs.readFileSync(path.join(DATA, '0050.json'), 'utf8')).map(r => [String(r.date || '').replace(/\//g, '-').slice(0, 10), +r.close]));
        let last = null, prev = null; drops = 0;
        for (const r of E) { const c = C.get(r.d); if (c > 0) last = c; if (!(last > 0) || !(r.park > 0)) continue; days++; const sh = r.park / last; if (prev != null && sh < prev * (1 - 0.001)) drops++; prev = sh; }
    } catch (e) { drops = null; }
    ok(`ⓐ4 ⭐ 逐日淨值對帳:手上 0050 股數 ${days} 天裡往下掉 ${drops} 天(⛔ 掉 = 那天賣了又買回)`, drops === 0 && days > 100, `drops=${drops} days=${days}`);

    // ⓑ 正常本金:照樣有買、照樣賣 0050 湊錢
    const B = run('b', {});
    ok(`ⓑ 正常本金照樣有買(${B.s && B.s.n} 筆)、照樣有賣 0050 湊錢(賣 ${B.sell} 次)`, B.r.status === 0 && B.s && B.s.n > 0 && B.sell > 1, B.tail);

    // ⓒ 🧯 V81.0.0 逐年模式(YEAR)+ 停 0050:那一年最後一天收盤就把 0050 結清
    //   以前留到整份資料最後一天才結 → 那一年的停泊損益把之後的 0050 漲跌也算進去(逐年表 🅿️ 那一列 2018 停泊 +138 萬 / 本金 100 萬)、
    //   年底之後淨值少算 0050 → 中途最多賠錯成 −58~−88%
    const Cy = run('c', { YEAR: '2024' });
    let after = null, before = null, yTo = Cy.s && Cy.s.yTo;
    try { const E = JSON.parse(fs.readFileSync(path.join(tmp, 'e_c.json'), 'utf8')).rows;
          after = E.filter(r => yTo && r.d > yTo); before = E.filter(r => yTo && r.d <= yTo); } catch (_) {}
    ok(`ⓒ0 逐年模式跑得完(${yTo || '?'} 收)、那一年裡真的有停在 0050`, Cy.r.status === 0 && before && before.some(r => r.park > 0), Cy.tail);
    ok(`ⓒ1 ⭐ 那一年最後一天之後 0050 一股都不留(${after ? after.length : '?'} 天裡停泊市值 > 0 的有 ${after ? after.filter(r => r.park > 0).length : '?'} 天)`, after && after.every(r => r.park === 0), after && after.slice(0, 3).map(r => r.d + ':' + r.park).join(','));
    ok(`ⓒ2 停泊損益(${Cy.s && Cy.s.park})沒有大到不可能(< 本金 100 萬的 60%)、中途最多賠(${Cy.s && Cy.s.dd}%)> −50%`, Cy.s && Math.abs(Cy.s.park) < 6e5 && Cy.s.dd > -50, JSON.stringify(Cy.s && { park: Cy.s.park, dd: Cy.s.dd }));
    fs.rmSync(tmp, { recursive: true, force: true });
} finally {
    if (injFile) fs.rmSync(injFile, { force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
