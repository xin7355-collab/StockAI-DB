#!/usr/bin/env node
/**
 * 🧙 分點「誰厲害」全面回測(只讀,⛔ 不打 API、⛔ 不寫 App)
 *
 * ❓ 使用者(2026-08-31):「分點券商還是有分厲害的分點、神秘分點、地緣分點等等,
 *    所以說還是有所區分,請將這些相關資訊或者是我沒想到的去做一個分析回測」。
 *    承 chips_deep_probe 的結論:**整體集中度**沒有方向性 —— 但那不否定
 *    「**特定券商**有沒有差別」。這支就是測那件事。
 *
 * 📥 資料:`chips_deep` 分支 467 天(2024-08-30 ~ 2026-08-28,前 200 家券商 × 全市場)
 *    + `data/*.json` K 線 + `data/company_geo.json`(公司所在縣市)。
 *
 * 🔬 五組問題:
 *    A. 厲害的分點 —— 個別券商的「買了會漲」有沒有**延續性**?
 *       ⛔⛔ 這題最大的陷阱是**循環論證**:用全期成績挑出「厲害的」再報它全期成績,
 *       200 家裡**必然**有幾家看起來很神(V72.9.2 排點估計值的教訓)。
 *       → 唯一誠實的做法:**前半段排名、後半段驗收**(再反向做一次)。
 *    B. 神秘分點 —— 60 個交易日沒碰過這檔的券商突然大買 → 之後會怎樣?
 *    C. 地緣分點 —— 券商所在縣市 == 公司所在縣市的大買,有沒有比較準?
 *       (V71.9.8 上線時標「未回測過預測力」—— 現在資料夠了,補上)
 *    D. 連買 3 天 —— 同一家連續吃貨 vs 只買一天,有沒有差?
 *    E. 隔日沖分點 —— 高翻臉率券商的大買,隔天是不是真的比較弱?
 *       (驗 broker_perf.flip 那條在 2 年窗口還成不成立)
 *
 * ⛔ 方法鐵則(全部沿用本專案標準):
 *    ・進場價 = **隔天開盤**(分點收盤後才公布);排除隔天開盤漲停鎖死(買不到)
 *    ・報酬扣同期加權;來回成本 0.44% 不先扣,但結論必須對照它
 *    ・(券商,股票)10 日去重;門檻用「淨買佔當日成交量 %」(比例,不是憑空價位)
 *    ・對照組 = 同門檻的全部買超事件(⛔ 不是「隨便挑一天」—— 這裡要分離的是
 *      「**哪家**買」的資訊,不是「有人買」的資訊)
 *
 * ⚠️ 誠實限制(寫在前面):
 *    ・券商母體是「以**近期** 20 日活躍度選出的前 200 家」→ 對**券商**有輕微選樣偏誤
 *      (兩年前活躍、現在消失的分點不在裡面),對股票沒有。
 *    ・地緣:前 200 家多是總部/大分點(台北居多)→ 非台北的配對樣本可能很薄,照實報。
 *
 * 用法:
 *    CHIPS_DEEP_DIR=/tmp/deepfull/chips_deep node scripts/broker_skill_probe.mjs
 *    node scripts/broker_skill_probe.mjs --selftest     # 注入已知的神券商+翻臉券商驗 harness
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DEEP_DIR = process.env.CHIPS_DEEP_DIR || path.join(ROOT, 'chips_deep');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');

const BUY_TH = 0.5;      // A/C/D/E:淨買 ≥ 當日量 0.5% 才算「有意義的買」
const MYST_TH = 1.0;     // B:神秘分點門檻更高(它的故事就是「突然大買」)
const MYST_GAP = 60;     // B:至少 60 個交易日沒出現在這檔的前15名單裡
const DEDUP = 10;        // (券商,股票)10 日去重
const MIN_BROKER_EV = 80;  // 每家券商至少要這麼多事件才進排名
const COST = 0.44;

const nf = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

// ── 載入(同 chips_deep_probe 的做法)─────────────────────────────
function loadDeep() {
  const files = fs.readdirSync(DEEP_DIR).filter((f) => f.endsWith('.json.gz')).sort();
  const days = [];
  const nm = {};
  for (const f of files) {
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DEEP_DIR, f))).toString('utf8'));
      if (j && j.d && j.s) { days.push(j); Object.assign(nm, j.nm || {}); }
    } catch { /* 讀不起來的檔跳過,尾端有數量守門 */ }
  }
  return { days, nm };
}

function loadPrices(need) {
  const px = new Map();
  for (const sym of need) {
    const p = path.join(DATA_DIR, `${sym}.json`);
    if (!fs.existsSync(p)) continue;
    let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || rows.length < 260) continue;
    const o = { dates: [], close: [], high: [], low: [], open: [], vol: [] };
    for (const r of rows) {
      if (!r || r.close == null) continue;
      o.dates.push(String(r.date).replace(/\//g, '-'));
      o.close.push(+r.close); o.high.push(+r.high); o.low.push(+r.low);
      o.open.push(+r.open); o.vol.push(+(r.volume || 0));
    }
    if (o.dates.length < 260) continue;
    o.at = new Map(); o.dates.forEach((d, i) => o.at.set(d, i));
    px.set(sym, o);
  }
  return px;
}

function loadIndex() {
  const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '^TWII.json'), 'utf8'))
    .filter((r) => r && r.close != null);
  const m = new Map();
  rows.forEach((r) => m.set(String(r.date).replace(/\//g, '-'), +r.close));
  return m;
}

function exRet(px, idxMap, sym, i, fwd) {
  const o = px.get(sym);
  const entry = o.open[i + 1], exit = o.close[i + fwd];   // i+1 開盤進、i+fwd 收盤出
  if (!(entry > 0) || !(exit > 0)) return null;
  const bi = idxMap.get(o.dates[i + 1]), bj = idxMap.get(o.dates[i + fwd]);
  if (!bi || !bj) return null;
  return (exit / entry - 1) * 100 - (bj / bi - 1) * 100;
}

function tradable(px, sym, i) {
  const o = px.get(sym);
  const pc = o.close[i], op = o.open[i + 1];
  if (!(pc > 0) || !(op > 0)) return false;
  return !(op >= pc * 1.0995 && o.high[i + 1] === o.low[i + 1]);
}

// ── 地緣:券商名 → 縣市(⛔ 只認無歧義的地名,同 V71.9.8 的原則)──
//    區名→縣市只收「全台唯一」的;中山/中正/信義/民權/和平/建國…一律不對照。
const GEO_TOKENS = {
  台北: '台北市', 臺北: '台北市', 松山: '台北市', 城中: '台北市', 大安: '台北市',
  士林: '台北市', 北投: '台北市', 內湖: '台北市', 南港: '台北市', 萬華: '台北市',
  新北: '新北市', 板橋: '新北市', 三重: '新北市', 新莊: '新北市', 永和: '新北市',
  中和: '新北市', 土城: '新北市', 樹林: '新北市', 淡水: '新北市', 汐止: '新北市',
  新店: '新北市', 蘆洲: '新北市', 桃園: '桃園市', 中壢: '桃園市', 平鎮: '桃園市',
  楊梅: '桃園市', 八德: '桃園市', 台中: '台中市', 臺中: '台中市', 豐原: '台中市',
  大甲: '台中市', 沙鹿: '台中市', 清水: '台中市', 台南: '台南市', 臺南: '台南市',
  永康: '台南市', 新營: '台南市', 高雄: '高雄市', 鳳山: '高雄市', 岡山: '高雄市',
  苓雅: '高雄市', 三民: '高雄市', 左營: '高雄市', 基隆: '基隆市', 新竹: '新竹市',
  竹北: '新竹縣', 竹科: '新竹市', 苗栗: '苗栗縣', 頭份: '苗栗縣', 彰化: '彰化縣',
  員林: '彰化縣', 鹿港: '彰化縣', 南投: '南投縣', 草屯: '南投縣', 雲林: '雲林縣',
  斗六: '雲林縣', 虎尾: '雲林縣', 嘉義: '嘉義市', 屏東: '屏東縣', 宜蘭: '宜蘭縣',
  羅東: '宜蘭縣', 花蓮: '花蓮縣', 台東: '台東縣', 臺東: '台東縣',
};
function brokerCity(name) {
  if (!name) return null;
  // ⛔ 外資/純總部名(元大/群益/兆豐…)沒有地名 → null(不參加地緣配對)
  for (const [tok, city] of Object.entries(GEO_TOKENS)) {
    if (name.includes(tok)) return city;
  }
  return null;
}

// ── 主程式 ─────────────────────────────────────────────────────
function main() {
  console.log('🧙 分點「誰厲害」全面回測\n');
  const { days, nm } = loadDeep();
  console.log(`📥 深歷史 ${days.length} 天(${days[0]?.d} ~ ${days[days.length - 1]?.d})・券商 ${Object.keys(nm).length} 家`);
  if (days.length < 240 && !SELFTEST) {
    console.log('⏳ 不足 240 天 → 不跑(理由同 chips_deep_probe)'); process.exit(2);
  }
  const need = new Set();
  for (const d of days) for (const s of Object.keys(d.s)) need.add(s);
  const px = loadPrices(need);
  const idxMap = loadIndex();
  let geo = {};
  try { geo = (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'company_geo.json'), 'utf8')).data) || {}; } catch { }
  console.log(`📈 K 線 ${px.size} 檔・公司地緣 ${Object.keys(geo).length} 檔`);

  // ── 一次掃描,收所有事件 ───────────────────────────────────────
  // ev: {b, sym, i, dnum, ratio, ex1, ex10, ex20, streak, gap}
  const lastSeen = new Map();     // `b|s` -> 全域交易日序號(B 用)
  const runLen = new Map();       // `b|s` -> 連買天數(D 用)
  const lastEv = new Map();       // `b|s` -> 去重
  const nextNet = new Map();      // `b|s|dnum` -> 隔天有沒有淨賣(E 用;先掃一遍建索引)
  const FWD = 20;
  const events = [];
  // ⚠️ D(連買 ≥3)要**獨立**收集:主去重 10 日會把「連買第 2、3 天」全部擋掉,
  //    「run≥3 的事件」在主陣列裡**結構上不可能存在**(selftest 抓到:n=0 且零錯誤訊息)。
  const evD = [];
  const lastEvD = new Map();

  // E 的「隔天有沒有翻臉」⛔ 不可預建全量索引 —— 467 天 × 8 萬鍵 ≈ 3,700 萬個
  //    Map 條目,實測直接 OOM(6GB)。改成**滾動一天**:昨天的買超事件掛在
  //    pendingFlip,今天掃到同 (券商,股票) 就地解決;掃完沒出現的 = 沒翻臉。
  let pendingFlip = new Map();
  let curPending = new Map();

  for (let dn = 0; dn < days.length; dn++) {
    const day = days[dn];
    // ⚠️ 換手必須在解決**之前** —— 第一版先解決再換手,day-0 的事件被 day-2 的資料
    //    解決(差了一天,全部 NaN,selftest 抓到)。昨天收集的現在輪到被今天解決;
    //    「沒出現」不用另外處理(建立時預設 flipNext=false)。
    pendingFlip = curPending; curPending = new Map();
    for (const [sym, arr] of Object.entries(day.s)) {
      for (const x of arr) {
        if ((+x[1] || 0) >= 0) continue;
        const ev = pendingFlip.get(`${x[0]}|${sym}`);
        if (ev) ev.flipNext = true;
      }
    }
    for (const [sym, arr] of Object.entries(day.s)) {
      const o = px.get(sym); if (!o) continue;
      const i = o.at.get(day.d);
      if (i == null || i < 250 || i + FWD + 1 >= o.dates.length) continue;
      const vol = o.vol[i]; if (!(vol > 0)) continue;
      for (const x of arr) {
        const b = String(x[0]); const net = +x[1] || 0;
        const key = `${b}|${sym}`;
        const seenBefore = lastSeen.get(key);
        lastSeen.set(key, dn);                       // 買賣都算「出現過」
        if (net <= 0) { runLen.delete(key); continue; }
        const ratio = net / vol * 100;
        if (ratio < BUY_TH) { runLen.delete(key); continue; }
        // ⚠️ 「連買」必須是**連續交易日** —— 缺席(沒進前 15)就斷。
        //    第一版沒查日期,隔好幾週的三次買被當成「連買 3 天」(selftest 抓到:45k 筆假連買)。
        const prevRun = runLen.get(key);
        const run = (prevRun && prevRun.dn === dn - 1) ? prevRun.run + 1 : 1;
        runLen.set(key, { dn, run });
        const isRun3 = run === 3;
        const prevEv = lastEv.get(key);
        const dedupOk = !(prevEv != null && dn - prevEv < DEDUP);
        if (!dedupOk && !isRun3) continue;
        if (dedupOk) lastEv.set(key, dn);
        if (!tradable(px, sym, i)) continue;
        const ex1 = exRet(px, idxMap, sym, i, 1);
        const ex10 = exRet(px, idxMap, sym, i, 10);
        const ex20 = exRet(px, idxMap, sym, i, 20);
        if (ex10 == null) continue;
        // E:隔天這家在同一檔是不是淨賣 —— 掛到 curPending,明天現場解決。
        //    ⚠️ 隔天沒出現在前 15 名 = 沒翻臉(⛔ 不是 null 排除,selftest 抓過);
        //    代價:小量偷賣(沒進前 15)看不到 → 翻臉率是**下限**。
        const evObj = {
          b, sym, dnum: dn, date: day.d, ratio, run,
          gap: seenBefore == null ? Infinity : dn - seenBefore,
          warm: dn >= MYST_GAP,                       // B 的暖身守門
          flipNext: dn + 1 < days.length ? false : null,   // 預設沒翻臉,明天出現淨賣再改 true
          ex1, ex10, ex20,
        };
        if (dn + 1 < days.length) curPending.set(key, evObj);
        if (dedupOk) events.push(evObj);             // A/B/C/E 用(正常去重)
        if (isRun3) {                                 // D 用(連買完成那一刻,自己 20 日去重)
          const pd = lastEvD.get(key);
          if (pd == null || dn - pd >= 20) { lastEvD.set(key, dn); evD.push(evObj); }
        }
      }
    }
  }
  console.log(`🧾 買超事件(≥${BUY_TH}% 量,10 日去重,可成交):${events.length.toLocaleString()} 筆\n`);
  if (events.length < 3000) { console.error('❌ 事件太少 → 不下結論'); process.exit(1); }

  const MID = Math.floor(days.length / 2);
  const ctlAll = mean(events.map((e) => e.ex10));
  const ctl20 = mean(events.filter((e) => e.ex20 != null).map((e) => e.ex20));
  console.log(`(對照組)全部買超事件:10 日超額 ${nf(ctlAll)}% ・20 日 ${nf(ctl20)}%`);
  console.log(`⚠️ 下面各組報的是**相對這個對照組**的 pp 差 —— 要分離的是「哪家買」的資訊,不是「有人買」。\n`);

  // ═══ A. 厲害的分點:前半段排名 → 後半段驗收 ═══════════════════
  console.log('═══ A. 厲害的分點 —— 個別券商的成績有沒有延續性 ═══');
  const half = (lo, hi) => {
    const m = new Map();
    for (const e of events) {
      if (e.dnum < lo || e.dnum >= hi) continue;
      let a = m.get(e.b); if (!a) m.set(e.b, a = []);
      a.push(e.ex10);
    }
    const out = new Map();
    for (const [b, a] of m) if (a.length >= MIN_BROKER_EV) out.set(b, { m: mean(a), n: a.length });
    return out;
  };
  const persist = (train, test, tag) => {
    const both = [...train.keys()].filter((b) => test.has(b));
    if (both.length < 20) { console.log(`   ${tag}:兩邊都夠樣本的券商只有 ${both.length} 家 ⏳`); return null; }
    const ranked = both.sort((x, y) => train.get(y).m - train.get(x).m);
    const q = Math.max(5, Math.floor(ranked.length / 5));
    const top = ranked.slice(0, q), bot = ranked.slice(-q);
    const tTop = mean(top.map((b) => test.get(b).m)), tBot = mean(bot.map((b) => test.get(b).m));
    const trTop = mean(top.map((b) => train.get(b).m)), trBot = mean(bot.map((b) => train.get(b).m));
    // Spearman 等級相關
    const rt = new Map(ranked.map((b, i) => [b, i]));
    const testRank = [...both].sort((x, y) => test.get(y).m - test.get(x).m);
    const rs = new Map(testRank.map((b, i) => [b, i]));
    const n = both.length;
    let d2 = 0; for (const b of both) d2 += (rt.get(b) - rs.get(b)) ** 2;
    const rho = 1 - 6 * d2 / (n * (n * n - 1));
    console.log(`   ${tag}(${n} 家):訓練段 前1/5 ${nf(trTop)}% vs 後1/5 ${nf(trBot)}%(差 ${nf(trTop - trBot)}pp ← 這是**循環的**,必然漂亮)`);
    console.log(`   ${' '.repeat(tag.length)}  驗收段 前1/5 ${nf(tTop)}% vs 後1/5 ${nf(tBot)}%(差 ${nf(tTop - tBot)}pp ← **這才算數**)・等級相關 ρ=${nf(rho, 3)}`);
    return { edge: tTop - tBot, rho, topBrokers: top.slice(0, 10) };
  };
  const trA = half(0, MID), teA = half(MID, days.length);
  const fwdRes = persist(trA, teA, '前半學→後半考');
  const revRes = persist(teA, trA, '後半學→前半考(反向)');
  if (fwdRes && fwdRes.edge > 0.3) {
    console.log('   🏆 訓練段前 10 名(名稱|訓練 10 日|驗收 10 日|驗收樣本):');
    for (const b of fwdRes.topBrokers) {
      console.log(`      ${(nm[b] || b).padEnd(10)} ${nf(trA.get(b).m).padStart(6)}% → ${nf(teA.get(b).m).padStart(6)}%(n=${teA.get(b).n})`);
    }
    console.log('   💀 訓練段墊底 10 名(「避開爛的」往往比「追好的」持久):');
    const both = [...trA.keys()].filter((b) => teA.has(b)).sort((x, y) => trA.get(x).m - trA.get(y).m);
    for (const b of both.slice(0, 10)) {
      console.log(`      ${(nm[b] || b).padEnd(10)} ${nf(trA.get(b).m).padStart(6)}% → ${nf(teA.get(b).m).padStart(6)}%(n=${teA.get(b).n})`);
    }
  }

  // ═══ B. 神秘分點 ═══════════════════════════════════════════════
  console.log('\n═══ B. 神秘分點 —— 60 個交易日沒碰過這檔,突然大買 ≥1% 量 ═══');
  const myst = events.filter((e) => e.warm && e.ratio >= MYST_TH && e.gap >= MYST_GAP);
  const mystCtl = events.filter((e) => e.warm && e.ratio >= MYST_TH && e.gap < MYST_GAP);
  const rep = (name, evs, ctl) => {
    if (evs.length < 300) { console.log(`   ${name}:n=${evs.length} ⏳ 樣本不足`); return; }
    const m10 = mean(evs.map((e) => e.ex10)) - mean(ctl.map((e) => e.ex10));
    const e20 = evs.filter((e) => e.ex20 != null), c20 = ctl.filter((e) => e.ex20 != null);
    const m20 = mean(e20.map((e) => e.ex20)) - mean(c20.map((e) => e.ex20));
    const w = evs.filter((e) => e.ex10 > 0).length / evs.length * 100;
    const cw = ctl.filter((e) => e.ex10 > 0).length / ctl.length * 100;
    // 前後半同向
    const h1 = evs.filter((e) => e.dnum < MID), h2 = evs.filter((e) => e.dnum >= MID);
    const c1 = ctl.filter((e) => e.dnum < MID), c2 = ctl.filter((e) => e.dnum >= MID);
    const d1 = h1.length > 100 && c1.length > 100 ? mean(h1.map((e) => e.ex10)) - mean(c1.map((e) => e.ex10)) : NaN;
    const d2b = h2.length > 100 && c2.length > 100 ? mean(h2.map((e) => e.ex10)) - mean(c2.map((e) => e.ex10)) : NaN;
    console.log(`   ${name}:n=${evs.length.toLocaleString()} ・10日 ${m10 >= 0 ? '+' : ''}${nf(m10)}pp ・20日 ${m20 >= 0 ? '+' : ''}${nf(m20)}pp ・勝率 ${nf(w, 1)}%(對照 ${nf(cw, 1)}%)`
      + ` ・前半 ${nf(d1)} / 後半 ${nf(d2b)}${(d1 > 0) === (d2b > 0) ? '' : ' 🚨不同向'}`);
  };
  rep('神秘(久違/首次現身)', myst, mystCtl);

  // ═══ C. 地緣分點 ═══════════════════════════════════════════════
  console.log('\n═══ C. 地緣分點 —— 券商縣市 == 公司縣市的大買 ═══');
  const bCity = {}; for (const [b, name] of Object.entries(nm)) bCity[b] = brokerCity(name);
  const nGeoBrokers = Object.values(bCity).filter(Boolean).length;
  console.log(`   券商可判縣市:${nGeoBrokers}/${Object.keys(nm).length} 家(其餘是總部/外資,無地名)`);
  const geoEv = [], geoCtl = [], geoEvX = [], geoCtlX = [];   // X = 排除台北/新北
  for (const e of events) {
    const bc = bCity[e.b], sc = geo[e.sym];
    if (!bc || !sc) continue;
    const isMatch = bc === sc;
    (isMatch ? geoEv : geoCtl).push(e);
    if (sc !== '台北市' && sc !== '新北市') (isMatch ? geoEvX : geoCtlX).push(e);
  }
  rep('全部縣市配對', geoEv, geoCtl);
  rep('⭐ 排除雙北(在地資訊才有意義)', geoEvX, geoCtlX);

  // ═══ D. 連買 3 天 ══════════════════════════════════════════════
  console.log('\n═══ D. 連續吃貨 —— 同一家連買 ≥3 天 vs 只買 1 天 ═══');
  rep('連買 ≥3 天', evD, events.filter((e) => e.run === 1));

  // ═══ E. 隔日沖分點 ═════════════════════════════════════════════
  console.log('\n═══ E. 隔日沖分點 —— 高翻臉率券商的大買,隔天真的比較弱嗎 ═══');
  //   翻臉率在**前半段**算,事件在**後半段**驗(⛔ 同段算同段驗 = 循環)
  const flipRate = new Map();
  {
    const agg = new Map();
    for (const e of events) {
      if (e.dnum >= MID || e.flipNext == null) continue;
      let a = agg.get(e.b); if (!a) agg.set(e.b, a = { f: 0, n: 0 });
      a.n++; if (e.flipNext) a.f++;
    }
    for (const [b, a] of agg) if (a.n >= MIN_BROKER_EV) flipRate.set(b, a.f / a.n);
  }
  const frs = [...flipRate.values()].sort((a, b) => a - b);
  if (frs.length >= 20) {
    // 「高翻臉」要語意上真的高(⛔ 不是「低分布裡的前 20%」):分位與絕對值取較嚴。
    //    ⚠️ 第一版的退化守門把門檻硬抬到 0.5,真實資料最高才 0.44 → 高翻臉組 0 筆
    //    (實跑抓到)。0.35 = 「每三次大買就有一次隔天翻賣」,語意站得住。
    const hiTh = Math.max(frs[Math.floor(frs.length * 0.8)], 0.35);
    const loTh = Math.min(frs[Math.floor(frs.length * 0.2)], 0.15);
    const hiEv = events.filter((e) => e.dnum >= MID && flipRate.get(e.b) >= hiTh);
    const loEv = events.filter((e) => e.dnum >= MID && flipRate.get(e.b) <= loTh);
    const d1 = mean(hiEv.map((e) => e.ex1)) - mean(loEv.map((e) => e.ex1));
    const d10 = mean(hiEv.map((e) => e.ex10)) - mean(loEv.map((e) => e.ex10));
    console.log(`   前半段翻臉率:P80=${nf(hiTh * 100, 1)}% ・P20=${nf(loTh * 100, 1)}%(${frs.length} 家可排名)`);
    console.log(`   後半段驗收:高翻臉率券商的買 vs 低翻臉率券商的買`
      + `(n=${hiEv.length.toLocaleString()}/${loEv.length.toLocaleString()})`);
    main._flipDiff = { d1, d10 };
    console.log(`   隔 1 日差 ${nf(d1)}pp ・10 日差 ${nf(d10)}pp`
      + (d1 < -0.1 ? ' ✅ 高翻臉的隔天確實較弱(方向與 broker_perf.flip 一致)' : ' ➖ 差異在雜訊內'));
    const hiNames = [...flipRate.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
      .map(([b, r]) => `${nm[b] || b} ${nf(r * 100, 0)}%`);
    console.log(`   翻臉率最高:${hiNames.join(' ・ ')}`);
  } else {
    console.log(`   ⏳ 可排名券商只有 ${frs.length} 家,不足`);
  }

  console.log('\n📌 判讀原則:任何一組要成立,至少要 ①驗收段(不是訓練段)有 ≥0.44pp(成本)的差');
  console.log('   ②前後半同向 ③樣本 ≥300。⛔ 訓練段的數字再漂亮都不算數(那是挑出來的)。');
  return { fwdRes, revRes, teA, ctlAll, flipDiff: main._flipDiff, events: events.length, nEvD: evD.length };
}

// ── 🧪 selftest:合成一家「真的會挑股」的券商 + 一家「必翻臉」的券商 ──
function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bsp-'));
  const dd = path.join(tmp, 'deep'), pd = path.join(tmp, 'data');
  fs.mkdirSync(dd); fs.mkdirSync(pd);
  const NSYM = 40, NBAR = 800, NDAY = 400;
  const dates = [];
  for (let d = new Date(Date.UTC(2023, 0, 2)); dates.length < NBAR;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10));
  }
  fs.writeFileSync(path.join(pd, '^TWII.json'),
    JSON.stringify(dates.map((dt) => ({ date: dt, open: 10000, high: 10000, low: 10000, close: 10000, volume: 1 }))));
  fs.writeFileSync(path.join(pd, 'company_geo.json'), JSON.stringify({ data: {} }));
  // 班表(⭐ 先排班、後產價 —— 價格效果必須跟「誰買了」綁在一起,E 才驗得動)
  const smartBuy = (s2, b) => (b % 23 === s2 % 23);                 // 7777:買了會漲
  const flipBuy = (s2, b) => (b % 2 === 0 && (s2 + b / 2) % 6 === 0); // 9999:買完隔天砍 + 壓價
  const runBuy = (s2, b) => ((b + s2) % 17) < 4;                    // 6666:每 17 天連買 4 天
  const fillerBuy = (f, s2, b) => ((b + f * 7 + s2 * 3) % 29 === 0); // 30 家填充
  const syms = [];
  for (let s2 = 0; s2 < NSYM; s2++) {
    const sym = String(3000 + s2); syms.push(sym);
    const rows = []; let c = 100;
    for (let b = 0; b < NBAR; b++) {
      const boost = [...Array(10).keys()].some((k) => b - 1 - k >= 0 && smartBuy(s2, b - 1 - k));
      const dip = b - 1 >= 0 && flipBuy(s2, b - 1);                 // 翻臉券商買完隔天 −0.5%
      // ⚠️ open 必須用**前一天**的收盤 —— 第一版用當天收盤×0.999,
      //    當天的壓價全被開盤吸收 → 隔日 open→close 報酬永遠看不到跌,E 驗不動(selftest 抓到)。
      const prevC = c;
      c *= (1 + (boost ? 0.003 : -0.0004)) * (dip ? 0.995 : 1);
      rows.push({ date: dates[b], open: +prevC.toFixed(2), high: +(Math.max(prevC, c) * 1.005).toFixed(2),
                  low: +(Math.min(prevC, c) * 0.995).toFixed(2), close: +c.toFixed(2), volume: 10_000_000 });
    }
    fs.writeFileSync(path.join(pd, `${sym}.json`), JSON.stringify(rows));
  }
  for (let b = NBAR - NDAY; b < NBAR - 25; b++) {
    const sMap = {};
    syms.forEach((sym, s2) => {
      const arr = [];
      if (smartBuy(s2, b)) arr.push(['7777', 200_000 + s2 * 100, 100]);
      if (flipBuy(s2, b)) arr.push(['9999', 150_000 + s2 * 50, 100]);
      if (b - 1 >= 0 && flipBuy(s2, b - 1)) arr.push(['9999', -(150_000 + s2 * 50), 100]);
      if (runBuy(s2, b)) arr.push(['6666', 120_000, 100]);
      for (let f = 0; f < 30; f++) if (fillerBuy(f, s2, b)) arr.push([String(5000 + f), 70_000 + f * 500, 100]);
      if (arr.length) sMap[sym] = arr;
    });
    fs.writeFileSync(path.join(dd, `${dates[b]}.json.gz`),
      zlib.gzipSync(Buffer.from(JSON.stringify({ d: dates[b], n: NSYM, k: 15,
        nm: { 7777: '神券商', 9999: '翻臉王', 6666: '連買俠', 1111: '填充' }, s: sMap }))));
  }
  DEEP_DIR = dd; DATA_DIR = pd;
  console.log('🧪 --selftest:7777 買了會漲、9999 買完隔天砍且壓價、6666 連買 4 天。斷言 A/D/E 都要抓得到。\n');
}

if (SELFTEST) {
  selftest();
  const res = main();
  let bad = [];
  // ⚠️ 斷言⛔ 不可用「前 1/5 的平均」—— 前 1/5 有 6 家,單一神券商會被 5 家雜訊稀釋
  //    (第一版就栽在這:edge 只有 0.35 而斷言要 >1)。直接驗 7777 自己。
  if (!res.fwdRes) bad.push('A 沒跑起來(券商數不足?)');
  else {
    if (!(res.fwdRes.edge > 0.2)) bad.push(`A 前/後 1/5 驗收差太小(${nf(res.fwdRes.edge)})`);
    if (res.fwdRes.topBrokers?.[0] !== '7777') bad.push(`A 訓練段第 1 名不是 7777(是 ${res.fwdRes.topBrokers?.[0]})`);
    const t7 = res.teA?.get('7777'), all10 = res.ctlAll;
    if (!t7 || !(t7.m > all10 + 1)) bad.push(`7777 的驗收段成績沒有明顯高於全體(${t7 ? nf(t7.m) : 'null'} vs ${nf(all10)})`);
  }
  if (res.flipDiff == null || !(res.flipDiff.d1 < -0.05)) bad.push(`E 沒抓到翻臉王(隔日差=${res.flipDiff ? nf(res.flipDiff.d1) : 'null'})`);
  if (!(res.nEvD >= 300)) bad.push(`D 的連買事件只有 ${res.nEvD} 筆(6666 的班表應該給出上千筆)`);
  if (bad.length) {
    console.error('\n❌ SELFTEST 失敗 —— 探針本身壞掉:'); bad.forEach((b) => console.error('   - ' + b));
    process.exit(1);
  }
  console.log('\n✅ BROKER_SKILL_PROBE_SELFTEST_PASS');
} else {
  main();
}
