/**
 * 📦 測資取得共用入口(V75.1.5)—— 讀「手機真正吃到的那份」gh-pages 產物
 *
 * 🚨 為什麼要抽出來(這是實跑踩到的,不是預防性重構):
 *   原本各支測試自己寫
 *       if (!fs.existsSync(CACHE)) execSync(`git show origin/gh-pages:… > ${CACHE}`)
 *   而 shell 的 `>` **不管指令成不成功都會先把檔案建出來** → git show 失敗時
 *   留下一個 **0 bytes** 的快取檔;下一次跑 `existsSync` 是 true → 直接讀那個空檔 →
 *   `JSON.parse` 丟 `Unexpected end of JSON input`,而且**它自己永遠不會好**
 *   (同陷阱 #18 / #20:壞掉的快取被永久固化)。
 *
 * ⛔ 三條鐵則:
 *   ① 快取要**驗內容**(非空 + parse 得動),⛔ 不可只看檔案在不在。
 *   ② 壞的快取一律**刪掉**再重抓,⛔ 不可沿用。
 *   ③ 真的抓不到就**說出來**(回 null 讓呼叫端誠實跳過),⛔ 不可靜默給空陣列
 *      —— 那會變成「掃到 0 筆卻全綠」的假綠燈。
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const _readJson = f => {
    try {
        const s = fs.readFileSync(f, 'utf8');
        if (!s.trim()) return null;              // ① 0 bytes / 全空白 = 壞的
        return JSON.parse(s);
    } catch (_) { return null; }
};

/**
 * @param {string} rel   repo 內相對路徑,如 'data/2327.json'
 * @param {string} cache 快取檔位置(選填;預設 /tmp/_ghdata_<safe>.json)
 * @returns {any|null}   拿不到回 null(⛔ 呼叫端要自己決定是跳過還是 exit 1)
 */
export function ghJson(rel, cache) {
    const safe = rel.replace(/[^\w.^-]/g, '_');
    const CACHE = cache || `/tmp/_ghdata_${safe}`;
    let v = fs.existsSync(CACHE) ? _readJson(CACHE) : null;
    if (v != null) return v;
    if (fs.existsSync(CACHE)) { try { fs.unlinkSync(CACHE); } catch (_) {} }   // ② 壞的先刪
    // 先試本地(fetch_testdata.sh 拉下來的那份),再退回 gh-pages
    const local = path.join(ROOT, rel);
    v = fs.existsSync(local) ? _readJson(local) : null;
    if (v != null) { try { fs.writeFileSync(CACHE, fs.readFileSync(local)); } catch (_) {} return v; }
    try {
        const out = execSync(`git -C ${JSON.stringify(ROOT)} show origin/gh-pages:${JSON.stringify(rel)}`,
                             { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        const parsed = out.trim() ? JSON.parse(out) : null;
        if (parsed != null) { fs.writeFileSync(CACHE, out); return parsed; }
    } catch (_) {}
    return null;   // ③ 誠實回報拿不到
}

/** 拿不到就 exit 1(⛔ 不可當成通過)——「這支測試沒有真實測資就沒有意義」時用這個 */
export function ghJsonOrDie(rel, cache) {
    const v = ghJson(rel, cache);
    if (v == null) {
        console.log(`❌ 讀不到測資 ${rel} —— 先跑 \`bash scripts/fetch_testdata.sh\`(或 git fetch origin gh-pages)。⛔ 不可當成通過。`);
        process.exit(1);
    }
    return v;
}
