// 🧩 V82.7.0 從 index.html 把 app 的成員(函式 / 常數)抽出來,在 Node 裡用「同一份」程式算(⛔ 另抄一份邏輯)
//   為什麼不用 col_rate_base.mjs 那支 extractMember:它只認 `name(` / `name: {`,而且找第一個 `{` 當函式開頭 →
//   `_dW(raw, opt = {}) {` 這種預設值帶大括號的會切錯;`_PREMKT_DEAD: 0.4` / `_WD: [...]` 這種常數抽不到。
//   做法:從成員開頭一行一行往下延伸,第一個「整段能被 JS 解析成一個物件成員」的地方就是結尾(讓 JS 自己判斷,⛔ 自己數括號)。
//   用的人:scripts/forecast_freeze.mjs(每天早上凍結盤前判斷 + 反攻雷達)、scripts/test_forecast_freeze.mjs。
import crypto from 'crypto';

/** index.html 裡 `    name(…) {…}` 或 `    name: 值` 的原始碼(含名字;不含結尾逗號) */
export function extractMember(src, name) {
    const esc = name.replace(/[$]/g, '\\$');
    const re = new RegExp(`\\n    (?:async )?${esc}(?=\\(|\\s*:)`);
    const m = re.exec(src);
    if (!m) throw new Error(`index.html 找不到 ${name}`);
    const start = m.index + 1;
    let pos = start;
    for (let n = 0; n < 6000; n++) {
        const nl = src.indexOf('\n', pos);
        const end = nl < 0 ? src.length : nl;
        const seg = src.slice(start, end);
        // 先試「去掉最後一行的註解與逗號」(串成一個物件時才不會被註解吃掉後面的逗號);`//` 在字串裡被誤砍 → 解析失敗 → 退回原樣
        const cands = [seg.replace(/\s*\/\/[^\n]*$/, '').replace(/,\s*$/, ''), seg.replace(/,\s*$/, ''), seg];
        for (const c of cands) {
            try { new Function(`return ({${c}\n});`); return c.trim(); } catch (_) { /* 還沒到結尾 */ }
        }
        if (nl < 0) break;
        pos = nl + 1;
    }
    throw new Error(`抽不出來(大括號對不上?):${name}`);
}

/** 公式版本指紋:這幾個成員的原始碼 sha256 前 8 碼(改了任何一個字就變;換行 / 註解也算 —— 寧可多變一次) */
export function srcHash(src, names) {
    const h = crypto.createHash('sha256');
    for (const n of names) h.update(`${n}\n${extractMember(src, n)}\n`);
    return h.digest('hex').slice(0, 8);
}

/** 只含 names 那幾個成員 + state(快取欄位)的 app。讀到沒抽出來的 `this.xxx` → 直接丟錯(⛔ 靜默變 undefined 算出另一個數字) */
export function buildApp(src, names, state = {}) {
    const body = names.map(n => extractMember(src, n)).join(',\n');
    // eslint-disable-next-line no-eval
    const obj = (0, eval)(`({${body}\n})`);
    Object.assign(obj, state);
    return new Proxy(obj, {
        get(t, k) {
            if (typeof k === 'symbol' || k in t) return t[k];
            throw new Error(`app.${String(k)} 沒有抽出來(呼叫端的成員清單要補,⛔ 自己另寫一份)`);
        },
    });
}
