#!/usr/bin/env node
/**
 * 🔁💸 V77.7.4 `portfolio_backtest.mjs` 換股(ROTATE)與成本壓力(COST_X)守門
 *
 * 起因:外部建議「資金不要留在不夠強的股票」「交易成本 ×1.5 / ×2 還成立嗎」—— 本站以前沒有這兩個鉤子。
 * 釘住:
 *   ⓐ 不設時一個字都不變:兩個都⛔ 不進 CACHE_KEY;不設 ROTATE/COST_X 的成績跟舊版逐位相同(決定性對照:同一份快取跑兩次)
 *   ⓑ ⛔ 換股不可改 `vic.ret`(那是「這檔過去有沒有賺」選股門檻的歷史成績 —— 改了會汙染 stat,量到的是洗牌不是換股)
 *   ⓒ 換掉那筆的成績用實際賣出價(`net` 讀 `_rot`),而且股利只算賣出前的(`_dvEv` 過濾 D <= d)
 *   ⓓ 空過守門:ROTATE 設了卻一筆都沒換 → exit 1
 *   ⓔ COST_X 只壓策略,0050 對照仍用 COST0;COST_X=2 時總報酬一定比不設低
 *   ⓕ ROTATE=lose 真的只換「帳面虧損」的(靜態:`u(vic) < 0` 那道門);shamlose 從虧損那幾檔裡隨機挑
 * ⚠️ 真跑引擎(repo `data/` 25 檔、本金壓到 30 萬讓錢不夠用),約 2~3 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const CODE = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓐs CACHE_KEY ⛔ 沒有 ROTATE / COST_X(只動資金層,既有快取照樣重用)', ck && !/ROTATE|COST_X|COST\b/.test(ck), ck);
ok('ⓑs 換股⛔ 不改 vic.ret(寫在 _rot)', /vic\._rot = \{ ret: r, dv: dvr, d/.test(CODE) && !/vic\.ret\s*=[^=]/.test(CODE), '');
ok('ⓒs net 讀 _rot(換掉的那筆用實際賣出價)', /const net = t => \(t\._rot \? t\._rot\.ret \+ t\._rot\.dv : t\.ret \+ \(t\.dv \|\| 0\)\) - COST;/.test(CODE), '');
ok('ⓒs2 股利只算賣出前的(_dvEv 過濾 D <= d)', /\(vic\._dvEv \|\| \[\]\)\.filter\(\(\[D\]\) => D <= d\)/.test(CODE), '');
ok('ⓓs 空過守門:ROTATE 設了卻 0 筆 → exit 1', /ROTATE 設了卻一筆都沒換[^\n]*process\.exit\(1\)/.test(CODE), '');
ok('ⓔs 0050 對照用 COST0(⛔ 不跟著 COST_X 放大)', (CODE.match(/- COST0/g) || []).length >= 4 && /const COST = COST0 \* COST_X;/.test(CODE), '');
ok('ⓕs lose 只換帳面虧損的 / shamlose 從虧損裡隨機', /if \(ROTATE === 'lose' && !\(u\(vic\) < 0\)\) vic = null;/.test(CODE) && /ROTATE === 'shamlose'\) \{ const ls = el\.filter\(x => u\(x\) < 0\)/.test(CODE), '');

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbrot-'));
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', CAPITAL: '300000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'don40', MAXD: '40', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240', TRADES_CACHE: path.join(tmp, 'c.json') };
    for (const k of ['ROTATE', 'COST_X', 'BEAR_EXIT', 'FORCE_EXIT', 'PARK', 'DIV', 'DIV_TRADES', 'FIN_DEEP', 'TURN', 'FIN', 'VAL']) delete base[k];
    const run = (tag, extra) => { const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 }); let s = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {} return { r, s }; };
    const A = run('a', {}), B = run('b', {});
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    ok('ⓐ 決定性對照:不設時兩次結果逐位相同、summary 沒有 rot / costX', A.s && B.s && A.s.cum === B.s.cum && A.s.n === B.s.n && !('rot' in A.s) && !('costX' in A.s), `${A.s?.cum} vs ${B.s?.cum}`);
    const L = run('lose', { ROTATE: 'lose' });
    if (L.r.status === 0) {
        ok('ⓓ ROTATE=lose 真的有換(本金 30 萬 → 錢不夠)', L.s && L.s.rot && L.s.rot.n > 0 && L.s.rot.mode === 'lose', JSON.stringify(L.s?.rot));
        ok('ⓓ2 有換股時成績跟不設不一樣(= 真的生效)', L.s && A.s && L.s.cum !== A.s.cum, `${L.s?.cum} vs ${A.s?.cum}`);
    } else ok('ⓓ ROTATE=lose 若 0 筆要 exit 1 並說原因', /一筆都沒換/.test(L.r.stderr || ''), (L.r.stderr || '').slice(-200));
    const X = run('x2', { COST_X: '2' });
    ok('ⓔ COST_X=2:成本壓力生效(總報酬比不設低)且 summary 記下倍數', X.r.status === 0 && X.s && X.s.costX === 2 && X.s.cum < A.s.cum, `${X.s?.cum} vs ${A.s?.cum}`);
    const bad = spawnSync(process.execPath, [FILE, '25', '2'], { env: { ...base, ROTATE: 'xyz' }, encoding: 'utf8', timeout: 60000 });
    ok('ⓖ 認不得的 ROTATE → exit 1', bad.status === 1 && /ROTATE=xyz 不認得/.test(bad.stderr || ''), bad.stderr);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ 全部通過'}`);
process.exit(fails.length ? 1 : 0);
