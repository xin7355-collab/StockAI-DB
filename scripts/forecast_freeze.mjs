#!/usr/bin/env node
/**
 * 🧊 V82.7.0 每天早上凍結「App 盤前頁當下說了什麼」:開盤預判 + 反攻條件雷達 → 之後在產業作戰室對答案
 *   使用者 11/26:「把每日開盤預判及反攻條件雷達(空方主控 4/11、成形門檻 9/11)紀錄下來看有沒有效果」。
 *   為什麼要凍結:以前早上只存原始資料(macro_risk.premkt_recent[].x),產業作戰室事後拿「現在的公式」重算 ——
 *     公式 5 週改了 3 次(夜盤算分、盤中價不算、0.4% 不算),對答案對的不是當天畫面。
 *   做法:用 index.html 真的函式(lib_appextract,⛔ 另抄一份)算好結論,存成 { out, radar },
 *     由 `python scripts/premkt_attach.py`(呼叫 macro_miner._premkt_attach)塞進 premkt_recent 裡「這一輪剛寫的那一筆」(晚上 daily_miner 照舊併進 data/premkt_log.json)。
 *
 * 跑法(macro_cron 那一步,macro_miner.py 寫完 data/macro_risk.json 之後;只用 Node 內建,⛔ npm):
 *   node scripts/forecast_freeze.mjs data/macro_risk.json /tmp/freeze.json
 *   ① 只在 macro_risk.premkt_w(這一輪真的寫了今天早上那筆)對得上 premkt_recent 某一筆時才算;否則印一行、不寫檔
 *   ② 其他輸入跟 App 一樣從網站抓(macro_cache / risk_history / bubble_warning / ^TWII / breadth),抓不到退 raw
 *      (data/* 走 data 分支、macro_cache.json 走 gh-pages 分支 —— 它只在網站根目錄);
 *      再抓不到 → 那一段照 App 的處置(雷達那條 ⏳、該格 null),⛔ 整支失敗
 *   ③ 任何例外都 exit 0(凍結失敗 ⛔ 擋總經推送);只有參數錯 exit 2
 *
 * 存什麼(精簡;⛔ 存畫面文字 —— 文字改了不影響對答案):
 *   out:  { ver 公式指紋, app 版本, s 分數, sPct, raw, call 開高偏多 / 開低偏空 / 中性震盪, k hi|mid|lo, occ [開高,平,開低](當天畫面印的發生率),
 *           n 有計分的項目數, intra [盤中抓的美股格], stale [太舊只列出來的格], nt 夜盤漲跌(算分的才有), ntWhy, tsm, usD 美股資料日, p [[項目, 分]] }
 *   radar:{ ver, lvl formed|base|bear|swan, passN, judged, need, lit 每一條 1/0/x(照條件表順序), nm 條件名字(| 隔開、同 lit 順序), swan 黑天鵝條件數,
 *           rx { 約 20 個原始數字,事後查「哪一條壞了」用 }, twD 加權最後一根, rhD risk_history 最後一筆 }
 *   卡片整張藏起來(VIX 與外資期貨都沒有)→ radar = { na: '…' }
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildApp, srcHash } from './lib_appextract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = 'https://xin7355-collab.github.io/StockAI-DB/';
const RAWD = 'https://raw.githubusercontent.com/xin7355-collab/StockAI-DB/data/';
const RAWG = 'https://raw.githubusercontent.com/xin7355-collab/StockAI-DB/gh-pages/';   // macro_cache.json 只在網站根目錄(data 分支沒有)

// 算分用到的成員(指紋只拿「會改變結論」的那幾支 → 改說明文字不換版)
export const VER_PRE = ['_premktX', '_preOpenScore', '_premktCall', '_premktFieldAge', '_premktNight', '_PREMKT_DEAD', '_vixState', '_macroPick', '_intraAt'];
export const VER_RADAR = ['_reboundInputs', '_reboundCalc', '_reboundNeed', '_calcDistributionDays', '_amtState', '_twRealizedVol', '_deleverProgress', '_twiiLag', '_fiFutState', '_vixState', '_macroPick'];
export const NEED = [...new Set([...VER_PRE, ...VER_RADAR, '_premktOccOf', '_PREMKT_OCC', '_dW', '_WD'])];

const r2 = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : Math.round(+v * 100) / 100;
const lastDate = (rows, ...keys) => {
    if (!Array.isArray(rows) || !rows.length) return null;
    const r = rows[rows.length - 1] || {};
    for (const k of keys) if (r[k]) return String(r[k]).replace(/\//g, '-').slice(0, 10);
    return null;
};

/** 純計算(測試直接呼叫):src = index.html 原始碼;其他都是已經抓好的 JSON(抓不到給 null) */
export function freeze({ src, mr, usm, rh, bub, twii, breadth, app }) {
    mr = mr || {}; usm = usm || {};
    const state = {
        _macroRiskCache: mr, usMacroCache: usm, _marketSnapshot: usm,
        _riskHistCache: Array.isArray(rh) ? rh : null, _bubbleCache: bub || null,
        _twiiKlineCache: Array.isArray(twii) && twii.length ? { rows: twii, at: Date.now() } : null,
        _breadthHist: Array.isArray(breadth && breadth.history) ? breadth.history : null,
        _distDayCount: null, _futuresCache: null,
    };
    const A = buildApp(src, NEED, state);
    // ── 開盤預判(同 renderMarketBriefing:_premktX → _preOpenScore;tech 那一行只列出來、不計分 → 這裡不補,分數一樣)──
    const PX = A._premktX(mr, usm);
    const po = A._preOpenScore({ ...PX.x });
    const oc = A._premktOccOf(po.sPct);
    const out = {
        ver: srcHash(src, VER_PRE), app: app || null,
        s: r2(po.s), sPct: po.sPct, raw: r2(po.raw), call: A._premktCall(po.s),
        k: oc ? oc.k : null, occ: oc ? [oc.b.up, oc.b.flat, oc.b.dn] : null,
        n: po.parts.filter(p => p.d).length,
        intra: Object.keys(PX.usIntra || {}).sort(), stale: Object.keys((PX.age && PX.age.stale) || {}).sort(),
        nt: PX.nt && PX.nt.chg != null ? r2(PX.nt.chg) : null, ntWhy: (PX.nt && PX.nt.why) || '',
        tsm: r2(PX.x.tsm), usD: String(mr.sp500_date || mr.nasdaq_date || '').slice(0, 10) || null,
        p: po.parts.filter(p => p.d).map(p => [p.nm, p.d]),
    };
    // ── 反攻條件雷達(同 _renderReboundRadar:那張卡藏起來的條件照抄)──
    let radar;
    if (mr.vix == null && mr.fi_futures_net == null) radar = { na: 'App 那張卡藏起來(VIX 與外資期貨都沒有資料)' };
    else {
        const inp = A._reboundInputs();
        const R = A._reboundCalc(inp);
        radar = {
            ver: srcHash(src, VER_RADAR), lvl: R.lvl, passN: R.passN, judged: R.judged.length, need: R.needN, lit: R.lit,
            nm: R.C.map(c => c.name).join('|'),   // 條件名字(照 lit 的順序;健康檢查照名字對 —— 條件換版順序會變)
            swan: R.isSwan ? R.swanHits.length : 0,
            rx: {
                vix: r2(inp.vix), sp: r2(mr.sp500_chg_pct), twd5: r2(mr.usdtwd_chg_5d), ks: r2(mr.kospi_chg_pct), nk: r2(mr.nikkei_chg_pct),
                wti: r2(mr.wti_chg_pct), fi5: r2(inp.fiChg5), fifu: r2(mr.fi_futures_net), bwd: r2(mr.taifex_backwardation),
                amt: r2(inp.amt && inp.amt.tn), twvix: r2(mr.tw_vix), rv: r2(inp.rv && inp.rv.pct), dist: r2(inp.dist),
                mg5: r2(inp.mgChg5), dl: r2(inp.dl && inp.dl.ratio), jpy3: r2(mr.jpy_chg_3d), fg: r2(mr.fear_greed),
            },
            twD: lastDate(usm.twii_history, 'date', 'd'), rhD: lastDate(rh, 'date'),
        };
    }
    return { out, radar };
}

/** 抓一個已發佈的檔:網站 → raw(data/* 走 data 分支;macro_cache.json 走 gh-pages 分支);抓不到回 { j: null, why } */
export async function fetchPub(rel, getter = fetch, ms = 12000) {
    const bases = rel.startsWith('data/') ? [PAGES, RAWD] : [PAGES, RAWG];
    const why = [];
    for (const b of bases) {
        try {
            const r = await getter(`${b}${rel}?t=${Date.now()}`, { signal: AbortSignal.timeout(ms) });
            if (!r.ok) { why.push(`HTTP ${r.status}`); continue; }
            return { j: await r.json(), why: '', src: b === PAGES ? '網站' : b === RAWD ? 'data 分支' : 'gh-pages 分支' };
        } catch (e) { why.push(e && e.name === 'TimeoutError' ? '逾時' : String((e && e.message) || e).slice(0, 40)); }
    }
    return { j: null, why: why.join(' / '), src: null };
}

/** 這一輪有沒有真的寫了今天早上那一筆(macro_miner 的 premkt_w 標記 + premkt_recent 裡同一個 d / at) */
export function markOf(mr) {
    const w = mr && mr.premkt_w;
    if (!w || !w.d || !w.at) return null;
    const e = (mr.premkt_recent || []).find(x => x && x.d === w.d && x.at === w.at);
    return e ? { d: w.d, at: w.at } : null;
}

async function main(argv) {
    const [mrPath, outPath] = argv;
    if (!mrPath || !outPath) { console.log('用法:node scripts/forecast_freeze.mjs data/macro_risk.json /tmp/freeze.json'); return 2; }
    let mr;
    try { mr = JSON.parse(fs.readFileSync(mrPath, 'utf8')); } catch (e) { console.log(`ℹ️ 🧊 讀不到 ${mrPath}(${String(e.message).slice(0, 60)})→ 不凍結`); return 0; }
    const mk = markOf(mr);
    if (!mk) { console.log('ℹ️ 🧊 這一輪沒有寫今天早上那一筆(不在台北平日 05:00~08:59,或不是 macro_cron)→ 不凍結'); return 0; }
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const app = (src.match(/_APP_VERSION: ?['"](V[0-9.]+)/) || [])[1] || null;
    const files = { usm: 'macro_cache.json', rh: 'data/risk_history.json', bub: 'data/bubble_warning.json', twii: 'data/%5ETWII.json', breadth: 'data/breadth.json' };
    const got = {}, miss = [];
    await Promise.all(Object.entries(files).map(async ([k, rel]) => {
        const r = await fetchPub(rel);
        got[k] = r.j;
        if (r.j == null) miss.push(`${rel.replace('%5E', '^')}:${r.why}`);
    }));
    const res = freeze({ src, mr, usm: got.usm, rh: got.rh, bub: got.bub, twii: got.twii, breadth: got.breadth, app });
    fs.writeFileSync(outPath, JSON.stringify({ d: mk.d, at: mk.at, ...res }));
    const o = res.out, r = res.radar;
    console.log(`🧊 凍結 ${mk.d} ${mk.at}:開盤 ${o.call}(${o.s} 分 / ${o.sPct})・雷達 ${r.na ? r.na : `${r.lvl} ${r.passN}/${r.judged}(門檻 ${r.need})${r.swan ? ` ・黑天鵝 ${r.swan}` : ''}`}・公式 ${o.ver}/${r.ver || '-'}`
        + (miss.length ? `\n   ⚠️ 抓不到(照 App 的處置算):${miss.join(';')}` : ''));
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(c => process.exit(c), e => { console.log(`⚠️ 🧊 凍結失敗(不影響總經推送):${String((e && e.stack) || e).slice(0, 300)}`); process.exit(0); });
}
