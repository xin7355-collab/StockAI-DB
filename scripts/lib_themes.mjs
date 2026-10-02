// 🎯 題材名單解析(pro.html 的 THEMES)—— layer_accel_probe / leader_probe 共用一份(⛔ 不複製名單)
// ⚠️ 名單是 2026 年人工整理的 = 事後挑過,用它回測一律標「名單有偏誤,只能當上限」。
export function parseThemes(src) {
    const a = src.indexOf('  THEMES: ['), b = src.indexOf('\n  ],', a);
    const out = [];
    for (const m of src.slice(a, b).matchAll(/\{ k: '([^']+)', n: '([^']+)', syms: \[([^\]]*)\] \}/g))
        out.push({ k: m[1], n: m[2], syms: [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]) });
    return out;
}
