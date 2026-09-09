#!/usr/bin/env node
/**
 * 🧩 Skill / 代理定義守門
 *
 * 背景:`.claude/skills/*` 與 `.claude/agents/*` 是「Claude 做這件事的標準步驟」。
 *      它們**不會被任何程式引用**,所以壞掉的時候零錯誤訊息 —— 這正是本專案最常犯的
 *      「規則只活在文件裡」(陷阱 #37)最極端的形式。
 *
 * ⛔ 這支釘住四件事:
 *   ① frontmatter 合法(name 要跟資料夾同名 ・ description 要有且夠具體)
 *   ② ⭐⭐ **Skill 裡提到的每個腳本檔名都要真的存在** ——
 *      腳本改名之後 Skill 會開始教錯的指令,而**沒有人會發現**
 *   ③ 兩支 description 不可過度相似(太像 = 每次都選錯那支)
 *   ④ 每支都要有「⛔ 這支不做什麼」的邊界,而且不可長到變成複製 CLAUDE.md
 *
 * 🚨 空過守門:若一個 Skill 都沒掃到、或一個腳本引用都沒抽到 → exit 1
 *    (這支工具最大的風險是「輸出看起來乾淨,其實根本沒掃到」)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

// ── 收集所有定義檔 ────────────────────────────────────────────
const docs = [];
const skillsDir = path.join(ROOT, '.claude/skills');
if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir)) {
        const f = path.join(skillsDir, d, 'SKILL.md');
        if (fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(f))
            docs.push({ kind: 'skill', dir: d, file: f, rel: path.relative(ROOT, f) });
    }
}
const agentsDir = path.join(ROOT, '.claude/agents');
if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir).filter(x => x.endsWith('.md')))
        docs.push({ kind: 'agent', dir: f.replace(/\.md$/, ''), file: path.join(agentsDir, f), rel: `.claude/agents/${f}` });
}

// 🚨 空過守門①:沒掃到東西 = 這支測試等於沒跑
ok('⓪ 至少要掃到 5 支 Skill + 1 支代理', docs.length >= 6, `只掃到 ${docs.length} 支`);
if (docs.length === 0) { console.error('❌ 一個定義檔都沒掃到,拒絕給綠燈'); process.exit(1); }

// ── ① frontmatter ────────────────────────────────────────────
const metas = [];
for (const d of docs) {
    const raw = fs.readFileSync(d.file, 'utf-8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    ok(`① ${d.rel} 有 YAML frontmatter`, !!m);
    if (!m) continue;
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim();
    }
    ok(`① ${d.rel} name === 資料夾名「${d.dir}」`, fm.name === d.dir, `name=${fm.name}`);
    ok(`① ${d.rel} description 夠具體(30~600 字)`,
        !!fm.description && fm.description.length >= 30 && fm.description.length <= 600,
        `長度 ${(fm.description || '').length}`);
    metas.push({ ...d, ...fm, body: raw.slice(m[0].length), lines: raw.split('\n').length });
}

// ── ② ⭐⭐ 引用到的腳本檔名必須真的存在 ────────────────────────
// 抽「看起來是本 repo 檔案路徑」的字串:scripts/x.py ・ index.html ・ root 的 *_probe.py …
// ⚠️ 副檔名要「長的排前面」—— 交替是有序的,`js` 排在 `json` 前面會把 x.json 切成 x.js(實跑踩到)
const FILE_RE = /(?:^|[\s`('"「（])((?:scripts\/|docs\/|\.claude\/|\.github\/)?[A-Za-z0-9_\-./]+\.(?:json|jsonl|yaml|yml|mjs|js|py|sh|html|md))/g;
// 這些是「範例/佔位」不是真檔名,⛔ 不可當成漏檔
const PLACEHOLDER = /(?:\/x\.json|\bdata\/|^<|名字|SKILL\.md$|package\.json)/;
let refTotal = 0;
const missing = [];
for (const m of metas) {
    const seen = new Set();
    let g;
    while ((g = FILE_RE.exec(m.body)) !== null) {
        const p = g[1];
        if (seen.has(p) || PLACEHOLDER.test(p)) continue;
        seen.add(p);
        refTotal++;
        // workflow 與探針常用「裸檔名」稱呼 → 也試這幾個常見位置
        const cands = [p, `.github/workflows/${p}`, `scripts/${p}`];
        if (!cands.some(c => fs.existsSync(path.join(ROOT, c)))) missing.push(`${m.rel} → ${p}`);
    }
}
// 🚨 空過守門②:一個引用都沒抽到 = 正規表示式壞了,不是「沒有問題」
ok('⓪b 抽得到腳本引用(≥ 20 個,否則是抽取器壞了)', refTotal >= 20, `只抽到 ${refTotal} 個`);
ok('② ⭐ Skill 裡提到的檔案全部存在', missing.length === 0, missing.join(' ・ '));

// ── ③ description 兩兩不可過度相似 ───────────────────────────
const toks = s => new Set(String(s).toLowerCase()
    .replace(/[，。、,.()（）「」/·:：]/g, ' ')
    .split(/\s+/).filter(w => w.length >= 2));
// 中文沒有空白 → 再補一層 2-gram,否則整句會被當成一個 token
const grams = s => { const t = String(s).replace(/\s+/g, ''); const o = new Set(); for (let i = 0; i + 2 <= t.length; i++) o.add(t.slice(i, i + 2)); return o; };
const jac = (a, b) => { let inter = 0; for (const x of a) if (b.has(x)) inter++; const uni = a.size + b.size - inter; return uni ? inter / uni : 0; };
let worst = { v: 0, pair: '' };
for (let i = 0; i < metas.length; i++) for (let j = i + 1; j < metas.length; j++) {
    const a = metas[i], b = metas[j];
    const v = Math.max(jac(toks(a.description), toks(b.description)), jac(grams(a.description), grams(b.description)));
    if (v > worst.v) worst = { v, pair: `${a.dir} vs ${b.dir}` };
}
ok('③ 兩支 description 不可過度相似(重疊率 < 0.45)', worst.v < 0.45,
    `最像的是 ${worst.pair} = ${worst.v.toFixed(2)}`);
console.log(`   ℹ️ 最高重疊率 ${worst.v.toFixed(2)}(${worst.pair})`);

// ── ④ 邊界與長度 ─────────────────────────────────────────────
for (const m of metas) {
    if (m.kind === 'skill')
        ok(`④ ${m.dir} 有寫「⛔ 這支不做什麼」的邊界`, /這支不做|不可以|⛔/.test(m.body.slice(0, 1200)));
    ok(`④ ${m.dir} 長度 30~140 行(超過通常是在複製 CLAUDE.md)`,
        m.lines >= 30 && m.lines <= 140, `${m.lines} 行`);
}

// ── ⑤ ⛔ 不可跟既有的 slash command 撞名 ─────────────────────
const cmdDir = path.join(ROOT, '.claude/commands');
const cmds = fs.existsSync(cmdDir) ? fs.readdirSync(cmdDir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')) : [];
const clash = metas.filter(m => cmds.includes(m.dir)).map(m => m.dir);
ok('⑤ 不可跟 .claude/commands 的既有指令撞名', clash.length === 0, clash.join(','));

console.log(`\n${fails.length ? `❌ ${fails.length} 項未過:\n  - ${fails.join('\n  - ')}` : `✅ 全部通過(${docs.length} 支定義檔 ・ ${refTotal} 個檔案引用)`}`);
process.exit(fails.length ? 1 : 0);
