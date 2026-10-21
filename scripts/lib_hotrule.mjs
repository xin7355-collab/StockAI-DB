/**
 * 🔥 V79.4.9 「高檔飆股」(🧬 + 每檔自己最會賺的那一招)選股規則 —— 全 repo 唯一一份常數
 *
 * 使用者 2026-10-21 選:「換,次數維持 8 次」= 從 V72.9.2 起的「照保守下界排・一檔最多 2 招」
 * 換成「照這一招的平均排・每一招都算」(次數 ≥8 不變)。
 *   研究(全市場 d16、照 App 實際怎麼買、17 條路徑):近 4 年 +61 → +164 萬、16 年 +117 → +323 萬;
 *   次數 ≥4 / 6 / 8 / 10 每一格都多賺(一片高原);同一批候選隨機排輸給「照平均排」,而舊排法連隨機都輸。
 *
 * ⭐ 誰讀這份:playbook_scan.mjs(每晚名單)、portfolio_backtest.mjs(GATE=lb 的預設值)。
 *   App(index.html `_HOT_RULE`)、auto_trade.py / alert_system.py(`HOT_RULE`)各有一份抄本 → test_hotrule.mjs 跨檔比對。
 * ⛔ 改這裡 = 換 App 的選股規則 → 照 CLAUDE.md V75.0.9「換掉之後必做四件」走(彈窗 + 換回舊的 + 所有呼叫點 + 重跑引用的數字)。
 *
 *   minN = 這一檔在這一招至少打過幾次才算數
 *   z    = 排序 / 門檻用的值 = 平均 − z × 標準差 ÷ √次數(z = 0 就是平均);門檻:扣來回成本後 > 0
 *   top  = 一檔最多幾招算候選(99 = 每一招都算;2 = 舊的「一檔最多 2 招」,已觸發 / 觸發不了的也佔名額)
 */
export const HOT_RULES = {
    mean: { minN: 8, z: 0, top: 99 },     // V79.4.9 起(預設)
    lb:   { minN: 8, z: 1.28, top: 2 },   // V72.9.2 ~ V79.4.8(「換回舊的」)
};
export const HOT_DEFAULT = 'mean';
// 🧮 「保守下界」這個欄位的 z(playbook_edge 的 `lb` 欄一律存它 —— A 級徽章 `_pbGrade` 與過去的 pick_history 都當它是下界)
export const LB_FIELD_Z = HOT_RULES.lb.z;
export const ruleOf = name => HOT_RULES[name] ? { name, ...HOT_RULES[name] } : { name: HOT_DEFAULT, ...HOT_RULES[HOT_DEFAULT] };
