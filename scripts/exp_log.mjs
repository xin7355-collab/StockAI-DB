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
 *   node scripts/exp_log.mjs pre --q "問題" --crit "事先寫死的判定條件" --tries 20 --bias '<JSON>'|@檔案 [--data <資料包雜湊>] [--lab <k>] [--retro]  → 印 id
 *   node scripts/exp_log.mjs bias   → 印偏誤檢查清單 + 可以直接改的 JSON 範本
 *   node scripts/exp_log.mjs done <id> --verdict ok|trap|method|blocked --tries 20 --result "數字一句話" [--cmd "指令"]
 *   node scripts/exp_log.mjs list
 *
 * 🧪 V82.2.5 偏誤檢查(使用者 11/13「可以做的都做」;來源:tradermonty edge-strategy-reviewer 的 13 項偏誤清單〔MIT,skl 已收〕
 *   + 貼文引用的 A 股 factor-calc「時間點正確」自檢,改成台股版):`pre` 一定要逐項回答 `BIAS` 每一條「這次怎麼處理」,
 *   不適用寫 `na:理由`(⛔ 只寫 na)。為什麼要在登記時寫:事後才想到「財報那天其實還沒公布」= 結果已經看過了,
 *   那時候改等於事後挑;寫在前面,`test_exp_registry` 才擋得住「跑完才補」。
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const REG = path.join(ROOT, 'research', 'experiments.ndjson');
export const VERDICTS = ['ok', 'trap', 'method', 'blocked'];
// 🧪 V82.2.5 這個時間以後登記的 pre 一定要有完整的 bias(之前的舊登記照舊,⛔ 回頭補 —— 補了也不是事先寫的)
export const BIAS_CUTOFF = '2026-11-13T03:00:00Z';
/** 偏誤檢查清單:k = 欄位名、q = 要回答的問題(台股版)。⛔ 改 k 會讓舊登記對不上 —— 只能加新的、不改舊的。 */
export const BIAS = [
    { k: 'pit',    q: '時間點:每個用到的資料,訊號那天真的已經公布了嗎?(財報看公布日,沒有就用法定期限 5/15・8/14・11/14・隔年 3/31;月營收次月 10 日後;法人 / 融資是盤後;K 線收盤後)' },
    { k: 't1',     q: '成交時點:訊號要用到 T 日收盤才知道的資料 → 最早 T 日尾盤(訊號尾盤就判得出來)或 T+1;寫清楚用哪一個價成交' },
    { k: 'xsec',   q: '截面:排名、百分位、標準化只用「當天存在」的股票;門檻 ⛔ 用整段期間(含未來)的統計量' },
    { k: 'univ',   q: '股票池:怎麼選的、含不含 ETF / 權證 / 全額交割;⛔ 用今天的成分股或名單回推過去' },
    { k: 'surv',   q: '存活者:有沒有含已下市 / 停止交易的股票(d16 含下市)' },
    { k: 'adj',    q: '價格斷崖:除權息、減資、分割有沒有還原;報酬含不含息' },
    { k: 'trade',  q: '那天真的買得到 / 賣得掉嗎:漲跌停鎖死、處置 / 全額交割、停牌、成交量門檻;放空要有券' },
    { k: 'cost',   q: '成本:扣多少來回成本(預設 0.44%;當沖 / ETF 另計)' },
    { k: 'bench',  q: '基準:跟什麼比(含息 0050 / 同一天全市場 / 同一天沒觸發的同類)' },
    { k: 'multi',  q: '試幾種:參數格 × 出場 × 子群一共幾種(= tries),怎麼校正(BH、鄰近參數高原、只報最好那組要打折)' },
    { k: 'oos',    q: '樣本外:前後半段同向 / walk-forward / 保留期,用哪一種' },
    { k: 'regime', q: '盤勢:多空分開、拿掉特殊年(2008・2020・2022)或 research/regime_breaks.json 的斷點後還成立嗎' },
    { k: 'sham',   q: '安慰劑:隨機日期或同一天隨機股票的對照怎麼做' },
    { k: 'tail',   q: '極端值與樣本:縮尾或看中位數、拿掉最大幾筆還成立嗎;獨立事件數(同一事件去重)多少' },
];
export const BIAS_KEYS = BIAS.map(b => b.k);
/** 回傳問題清單(空 = 合格)。答案 = 一句話寫這次怎麼處理;不適用 = `na:理由`(理由至少 2 個字)。 */
export function checkBias(bias) {
    if (!bias || typeof bias !== 'object' || Array.isArray(bias)) return ['沒有 bias(偏誤檢查):先跑 `node scripts/exp_log.mjs bias` 拿範本'];
    const bad = [];
    for (const k of BIAS_KEYS) {
        const v = String(bias[k] == null ? '' : bias[k]).trim();
        if (!v) { bad.push(`${k} 沒寫`); continue; }
        if (/^n\/?a\b/i.test(v)) {
            const why = v.replace(/^n\/?a\s*[:：]?\s*/i, '').trim();
            if (why.length < 2) bad.push(`${k} 寫 na 卻沒寫理由(要寫 na:理由)`);
        }
    }
    return bad;
}
/** --bias 可以給 JSON 字串或 @檔案路徑 */
export function parseBias(v) {
    if (v == null || v === true) return null;
    if (typeof v === 'object') return v;
    let t = String(v).trim();
    if (t.startsWith('@')) t = fs.readFileSync(path.resolve(t.slice(1)), 'utf8');
    try { return JSON.parse(t); } catch (e) { throw new Error(`--bias 不是 JSON(${e.message.slice(0, 60)})`); }
}

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
    const bias = parseBias(o.bias), bb = checkBias(bias);
    if (bb.length) throw new Error(`偏誤檢查沒填完(${bb.join(';')})—— 每一條都要寫這次怎麼處理,不適用寫 na:理由`);
    const rows = readReg(file), id = o.id || nextId(rows, o.day || tpeDay());
    const r = { id, t: 'pre', at: o.at || new Date().toISOString(), q: o.q, crit: o.crit, tries: o.tries != null ? +o.tries : null, data: o.data || null, code: o.code || sha(), lab: o.lab || null, retro: !!o.retro,
                bias: Object.fromEntries(BIAS_KEYS.map(k => [k, String(bias[k]).trim()])) };
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
        else if (cmd === 'bias') {
            for (const b of BIAS) console.log(`・${b.k}:${b.q}`);
            console.log('\n範本(每一條改成「這次怎麼處理」;不適用寫 na:理由):');
            console.log(JSON.stringify(Object.fromEntries(BIAS_KEYS.map(k => [k, ''])), null, 1));
        }
        else if (cmd === 'list') { for (const [id, e] of byId(readReg())) console.log(`${id} ${e.done ? e.done.verdict : '⏳'}${e.pre && e.pre.retro ? '(補登)' : ''} ${(e.pre && e.pre.q || '').slice(0, 60)}`); }
        else { console.error('用法:pre --q --crit --bias <JSON|@檔案> [--tries --data --lab --retro] | done <id> --verdict --tries --result [--cmd] | bias | list'); process.exit(1); }
    } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
}
