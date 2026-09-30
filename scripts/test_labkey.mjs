// 🔁 V77.7.0 實測總表「更新,⛔ 不是新增」守門
//
// 使用者:「每次回測完都要依照我的習慣排序方法紀錄,⛔ 不要每次都開新的卡片」。
// 釘住:
//  ① 帶主題鍵 k 的條目,k 全表唯一(⛔ 同一個題目兩張卡)
//  ② 帶 k 的一定也帶 u(最後更新日 YYYY-MM-DD)
//  ③ 渲染:✅有用 照 r 排名;其他欄照 u 新→舊(原始碼釘住)
//  ④ 同一欄裡 ⛔ 不可有兩條標題幾乎一樣的(去掉 emoji/標點後前 16 字相同)
//  ⑤ 決定性對照:把一條 k 複製一份 → ① 必紅
// 跑法:node scripts/test_labkey.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ck = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) FAIL.push(m); };
const src = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');

function parseLab(s) {
    const a = s.indexOf('\n  LAB: {'); const b = s.indexOf('\n  },', a);
    const block = s.slice(a, b);
    const cols = {}; let cur = null;
    for (const line of block.split('\n')) {
        const m = line.match(/^    (ok|trap|method|blocked|next): \[/); if (m) { cur = m[1]; cols[cur] = []; continue; }
        if (cur && /^      \{ /.test(line)) {
            const k = (line.match(/\bk: '([^']+)'/) || [])[1] || null;
            const u = (line.match(/\bu: '([^']+)'/) || [])[1] || null;
            const t = (line.match(/\bt: '([^']+)'/) || [])[1] || '';
            cols[cur].push({ k, u, t });
        }
    }
    return cols;
}
function check(s, tag = '') {
    const cols = parseLab(s);
    const all = Object.values(cols).flat();
    const ks = all.filter(x => x.k).map(x => x.k);
    const dup = ks.filter((k, i) => ks.indexOf(k) !== i);
    return { cols, all, ks, dup, noU: all.filter(x => x.k && !/^\d{4}-\d{2}-\d{2}$/.test(x.u || '')) };
}
const R = check(src);
ck(Object.keys(R.cols).length === 5 && R.all.length > 250, `⓪ 讀得到五欄 ${R.all.length} 條(空過守門)`);
ck(R.dup.length === 0, `① 主題鍵 k 全表唯一(${R.ks.length} 條有 k${R.dup.length ? ',重複:' + R.dup.join(',') : ''})`);
ck(R.noU.length === 0, `② 帶 k 的都帶 u(缺:${R.noU.map(x => x.k).join(',') || '無'})`);
ck(/col === 'ok' \|\| col === 'trap'/.test(src) && /sort\(\(a, b\) => \(b\.u \|\| ''\)\.localeCompare\(a\.u \|\| ''\)\)/.test(src),
   '③ 渲染:✅有用 / ⛔ 沒用 照 r(V78.0.9);其他欄照 u 新→舊');
const norm = t => t.replace(/<[^>]+>/g, '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').slice(0, 16);
let near = [];
for (const [c, arr] of Object.entries(R.cols)) {
    const seen = new Map();
    for (const x of arr) { const n = norm(x.t); if (n.length >= 8 && seen.has(n)) near.push(`${c}:${n}`); seen.set(n, 1); }
}
ck(near.length === 0, `④ 同一欄沒有兩條標題幾乎一樣的(${near.join(' / ') || '無'})`);
// ⑤ 決定性對照
const inj = src.replace(/(\n      \{ k: 'news-hist'[^\n]*)/, '$1$1');
ck(check(inj).dup.length > 0, '⑤ ⭐ 決定性對照:同一條 k 複製一份 → ① 叫得出來');
ck(R.ks.includes('news-hist'), '⑥ 消息面那兩條已經併成一條(k: news-hist)');
console.log(`\n${FAIL.length ? '❌ ' + FAIL.length + ' 條沒過' : '✅ 全部通過'}`);
process.exit(FAIL.length ? 1 : 0);
