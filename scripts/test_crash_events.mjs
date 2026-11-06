#!/usr/bin/env node
/**
 * 🌪️ V82.0.0 大跌事件(scripts/crash_events.mjs → data/crash_events.json)跟 App 同一把尺
 *  ① 每一天切一次真的加權日 K(gh-pages data/^TWII.json):crash_events 的「這一段第一次 25 天跌 15%」
 *     == index.html `_crashFastState`(亮不亮 + 第一次是哪天)—— 兩份程式碼、同一份定義
 *  ② leg10 / bear20 / end 的定義跟 lib_crash.corrLegs 一字不差(leg10 = 段首、end = 段尾隔天、bear20 = 段內第一次 ≤ −20%)
 *  ③ OCC.fast15 == index.html `_CRASH_OCC.tw`(同一份發生率抄兩處 → 跨檔比對,⛔ 只改一邊)
 *  ④ crash_events --selftest 全過
 *  注入:INJECT=th(crash_events 跌 14% 就算)→ ① 必紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { ghJsonOrDie } from './lib_ghdata.mjs';
import { corrLegs } from './lib_crash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INJ = process.env.INJECT || '';
let CE = fs.readFileSync(path.join(ROOT, 'scripts/crash_events.mjs'), 'utf8');
const CE0 = CE;
if (INJ === 'th') CE = CE.replace('export const W = 250, FW = 25, FX = 0.85;', 'export const W = 250, FW = 25, FX = 0.86;');
if (INJ && CE === CE0) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, 'scripts', `_t_ce_${process.pid}.mjs`);
fs.writeFileSync(TMP, CE);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
try {
    const { legsWithEvents, OCC } = await import(TMP);
    const grab = (k, isObj) => {
        const m = new RegExp(`\\n    ${k}${isObj ? ': ' : '\\('}`).exec(SRC);
        if (!m) throw new Error('找不到 ' + k);
        const s = SRC.indexOf('{', m.index + 5); let d = 0, i = s;
        for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && --d === 0) break; }
        return (0, eval)('({' + SRC.slice(m.index + 5, i + 1) + '})')[k];
    };
    const A = { _crashFastState: grab('_crashFastState'), _CRASH_OCC: grab('_CRASH_OCC', true), _lastBarIsToday: () => false, _tpeMinutes: () => ({ min: 15 * 60 }) };
    const rows = ghJsonOrDie('data/^TWII.json');
    const c = rows.map(r => +r.close), d = rows.map(r => String(r.date).replace(/\//g, '-').slice(0, 10));
    ok('⓪ 測資:加權日 K 夠長(≥ 600 根)', rows.length >= 600, rows.length);
    // ① 逐日比
    let nDay = 0, nOn = 0, nBad = 0; const bad = [];
    for (let k = 275; k < c.length; k++) {
        const app = A._crashFastState(rows.slice(0, k + 1));
        const L = legsWithEvents(c.slice(0, k + 1), d.slice(0, k + 1));
        const cur = L.length && L[L.length - 1].open ? L[L.length - 1] : null;
        const f = cur ? cur.ev.find(e => e.k === 'fast15') : null;
        const mine = f ? { on: true, d: f.d } : { on: false };
        nDay++; if (app && app.on) nOn++;
        const same = app && app.on === mine.on && (!mine.on || app.d === mine.d);
        if (!same) { nBad++; if (bad.length < 4) bad.push(`${d[k]} app=${JSON.stringify(app && { on: app.on, d: app.d })} ce=${JSON.stringify(mine)}`); }
    }
    ok(`① 每一天 crash_events 的 25 天跌 15% == App _crashFastState(${nDay} 天、亮 ${nOn} 天)`, nBad === 0 && nOn > 0, bad.join(' | '));
    // ② 其他三種跟 corrLegs 同一個切法
    const CL = corrLegs(c), L = legsWithEvents(c, d);
    ok('② 段數 == corrLegs', L.length === CL.legs.length, `${L.length} vs ${CL.legs.length}`);
    let e2 = 0;
    for (let k = 0; k < L.length; k++) {
        const g = CL.legs[k], ev = Object.fromEntries(L[k].ev.map(e => [e.k, e]));
        if (ev.leg10.d !== d[g.s]) e2++;
        if (!g.open && (!ev.end || ev.end.d !== d[g.e + 1])) e2++;
        let b20 = null; for (let i = g.s; i <= g.e; i++) if (c[i] / CL.hi[i] - 1 <= -0.20) { b20 = d[i]; break; }
        if ((ev.bear20 ? ev.bear20.d : null) !== b20) e2++;
    }
    ok('② leg10 = 段首、end = 段尾隔天、bear20 = 段內第一次 ≤ −20%', e2 === 0, e2);
    // ③ 跨檔:發生率
    const T = A._CRASH_OCC.tw, F = OCC.fast15;
    ok('③ OCC.fast15 == index.html _CRASH_OCC(台股那一組 + 修正中隨便一天)', F.from === A._CRASH_OCC.from && F.n === T.n && F.leg === T.leg && F.wk === T.wk && F.mo === T.mo && F.half === T.half && F.re === T.re && F.reN === T.reN && F.base === A._CRASH_OCC.base, JSON.stringify({ F, T }));
    ok('③ leg10 / bear20 / end 的發生率有填(⛔ 0)', OCC.leg10.n > 0 && OCC.bear20.n > 0 && OCC.end.n > 0, JSON.stringify(OCC));
    // ④ selftest
    let st = ''; try { st = execFileSync('node', [path.join(ROOT, 'scripts/crash_events.mjs'), '--selftest'], { encoding: 'utf8' }); } catch (e) { st = String(e.stdout || e); }
    ok('④ crash_events --selftest 全過', /0 失敗/.test(st), st.slice(-200));
} finally { try { fs.unlinkSync(TMP); } catch (_) {} }
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_crash_events 全過');
process.exit(fails.length ? 1 : 0);
