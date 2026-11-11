#!/usr/bin/env node
/**
 * 🗂️ V82.1.2 實驗登錄(SELF_EVOLVING_AUDIT G2)—— `research/experiments.ndjson`,一行一筆、只增不刪
 *
 * 每一個研究兩行:
 *   pre  —— 跑之前:問題、事先寫死的判定條件、預計試幾種、資料(研究資料包雜湊)、程式 commit
 *   done —— 跑完:指令、結果、判定(ok / trap / method / blocked)、實際試了幾種
 * 實測總表(pro.html PRO.LAB)的條目用 `x: 'EXP-…'` 指回這裡;`scripts/test_exp_registry.mjs` 釘住對應關係與時間順序。
 * ⭐ 事後補登的標 `retro: true`(⛔ 假裝事先登記 —— 那正是「事後挑」的另一種形式)。
 *
 * 用法:
 *   node scripts/exp_log.mjs pre --q "問題" --crit "事先寫死的判定條件" --tries 20 [--data <資料包雜湊>] [--lab <k>] [--retro]  → 印 id
 *   node scripts/exp_log.mjs done <id> --verdict ok|trap|method|blocked --tries 20 --result "數字一句話" [--cmd "指令"]
 *   node scripts/exp_log.mjs list
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const REG = path.join(ROOT, 'research', 'experiments.ndjson');
export const VERDICTS = ['ok', 'trap', 'method', 'blocked'];

export function readReg(file = REG) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch (e) { throw new Error(`${path.basename(file)} 第 ${i + 1} 行不是 JSON`); } });
}
/** id → {pre, done} */
export function byId(rows) {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.id)) m.set(r.id, {}); const e = m.get(r.id); if (e[r.t]) throw new Error(`${r.id} 有兩筆 ${r.t}`); e[r.t] = r; }
    return m;
}
export function nextId(rows, day) {
    const pre = `EXP-${day.replace(/-/g, '')}-`, n = rows.filter(r => r.t === 'pre' && r.id.startsWith(pre)).length;
    return pre + String(n + 1).padStart(2, '0');
}
const append = (file, o) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(o) + '\n'); };
const sha = () => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().slice(0, 12); } catch (_) { return null; } };
const tpeDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

export function pre(o, file = REG) {
    if (!o.q || !o.crit) throw new Error('pre 要有 --q 問題 與 --crit 事先寫死的判定條件');
    const rows = readReg(file), id = o.id || nextId(rows, o.day || tpeDay());
    const r = { id, t: 'pre', at: o.at || new Date().toISOString(), q: o.q, crit: o.crit, tries: o.tries != null ? +o.tries : null, data: o.data || null, code: o.code || sha(), lab: o.lab || null, retro: !!o.retro };
    append(file, r); return r;
}
export function done(id, o, file = REG) {
    const m = byId(readReg(file));
    if (!m.has(id) || !m.get(id).pre) throw new Error(`${id} 沒有 pre(先登記才可以收結果)`);
    if (m.get(id).done) throw new Error(`${id} 已經有結果了(只增不刪:要重跑就開新的 id)`);
    if (!VERDICTS.includes(o.verdict)) throw new Error(`verdict 只認 ${VERDICTS.join(' / ')}`);
    const r = { id, t: 'done', at: o.at || new Date().toISOString(), verdict: o.verdict, tries: o.tries != null ? +o.tries : null, result: o.result || '', cmd: o.cmd || null, code: o.code || sha() };
    append(file, r); return r;
}

function args(a) { const o = {}; for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; o[k] = v; } else (o._ = o._ || []).push(a[i]); } return o; }

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain) {
    const [cmd, ...rest] = process.argv.slice(2), o = args(rest);
    try {
        if (cmd === 'pre') console.log(pre(o).id);
        else if (cmd === 'done') console.log(done(o._ && o._[0], o).id);
        else if (cmd === 'list') { for (const [id, e] of byId(readReg())) console.log(`${id} ${e.done ? e.done.verdict : '⏳'}${e.pre && e.pre.retro ? '(補登)' : ''} ${(e.pre && e.pre.q || '').slice(0, 60)}`); }
        else { console.error('用法:pre --q --crit [--tries --data --lab --retro] | done <id> --verdict --tries --result [--cmd] | list'); process.exit(1); }
    } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
}
