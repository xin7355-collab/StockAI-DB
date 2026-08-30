#!/usr/bin/env node
/**
 * 🔬 分點逐日深歷史 —— 預測力回測(只讀,⛔ 不打 API、⛔ 不寫 App)
 *
 * ❓ 這支要回答的問題(CLAUDE.md 裡**因為沒有逐日分點歷史而長期卡住**的那幾條):
 *    ① 「某家分點今天大買這一檔」→ 這一檔未來 5/10/20 日的**超額**報酬是多少?
 *    ② 分點的邊際是不是只是「活躍度」的代理?(⛔ 兩端都正 = 不是方向訊號)
 *    ③ 「主力集中度」(前 5 大買超佔當日成交量的比例)有沒有預測力?
 *    ④ 疊在現行配置(🧬 高位階 + 高波動)之上還有沒有**增量**?
 *
 * 📥 資料源:`chips_deep` 分支的 `chips_deep/YYYY-MM-DD.json.gz`
 *    格式 `{"d":日期,"n":股票數,"k":15,"nm":{代號:名稱},"s":{股號:[[代號,淨股數,均價],…]}}`
 *    取法:`git archive origin/chips_deep | tar -x -C <某個資料夾>`
 *    ⛔ 前端不讀這個分支,它只給探針/回測。
 *
 * ⛔ 六道關卡(本專案的標準,少一道都不算數):
 *    ① 全期為正 ② 前後半段同向 ③ 逐年同向 ④ 拿掉最好的那一年還在
 *    ⑤ 扣掉來回成本 0.44% ⑥ **增量檢定** —— 疊在現行配置之上還有沒有多的
 *    ⭐ 再加兩關(V73.2.x 之後才補上的):
 *    ⑦ **買得到嗎** —— 訊號當天漲停鎖死的,收盤價根本買不到
 *    ⑧ **反方向那一桶是不是也正** —— 是的話那是「活躍度」不是「方向」
 *
 * 🚧 空過守門(⛔ 都不可拿掉,這支最大的風險是「跑完很乾淨,其實什麼都沒掃到」):
 *    ・深歷史天數不足 → 直接 exit 1 並說出「現在有幾天、至少要幾天」
 *    ・對照組事件數為 0 → exit 1(沒有對照組的數字一律不可解讀)
 *    ・任何一組事件數 < MIN_N 一律標「樣本不足」,⛔ 不給結論
 *
 * 用法:
 *    node scripts/chips_deep_probe.mjs                    # 用預設資料夾 chips_deep/
 *    CHIPS_DEEP_DIR=/tmp/deep node scripts/chips_deep_probe.mjs
 *    node scripts/chips_deep_probe.mjs --min-days 60      # 放寬最少天數(只給管線自驗用)
 *    node scripts/chips_deep_probe.mjs --selftest         # 注入必然學得到的訊號,驗 harness 本身
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DEEP_DIR = process.env.CHIPS_DEEP_DIR || path.join(ROOT, 'chips_deep');
let DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SELFTEST = argv.includes('--selftest');
// ⚠️ 240 個交易日 ≈ 1 年。少於這個,「逐年同向」與「拿掉最好那一年」兩關⛔ 根本做不了,
//    而那兩關正是本專案最會擋掉假訊號的兩關(V73.2.0 / V73.2.9 各救場一次)。
const MIN_DAYS = parseInt(argOf('--min-days', '240'), 10);
const FWD = [5, 10, 20];                 // 前瞻天期
const COST = 0.44;                       // 來回成本 %(手續費 6 折 + 證交稅)
const DEDUP = 20;                        // 同檔同訊號 N 個交易日內只算一次
const MIN_N = 300;                       // 低於這個一律標「樣本不足」,⛔ 不給結論

const nf = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const med = (a) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

// ── 1. 讀深歷史 ────────────────────────────────────────────────
function loadDeep() {
  if (!fs.existsSync(DEEP_DIR)) {
    console.error(`❌ 找不到深歷史資料夾 ${DEEP_DIR}`);
    console.error('   取法:git archive origin/chips_deep | tar -x -C .');
    process.exit(1);
  }
  const files = fs.readdirSync(DEEP_DIR).filter((f) => f.endsWith('.json.gz')).sort();
  const days = [];
  for (const f of files) {
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DEEP_DIR, f))).toString('utf8'));
      if (j && j.d && j.s) days.push(j);
    } catch (e) {
      console.error(`   ⚠️ ${f} 讀不起來:${String(e.message).slice(0, 60)}`);
    }
  }
  return days;
}

// ── 2. 讀 K 線 + 加權指數(超額報酬要扣同期大盤)────────────────
function loadPrices(symsNeeded) {
  const px = new Map();          // sym -> {dates:[], close:[], high:[], low:[], open:[], vol:[]}
  let miss = 0;
  for (const sym of symsNeeded) {
    const p = path.join(DATA_DIR, `${sym}.json`);
    if (!fs.existsSync(p)) { miss++; continue; }
    let rows;
    try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { miss++; continue; }
    if (!Array.isArray(rows) || rows.length < 260) { miss++; continue; }
    const o = { dates: [], close: [], high: [], low: [], open: [], vol: [] };
    for (const r of rows) {
      // ⛔ 沒有收盤價的列一律丟掉(V74.2.3:盤中快照留下的空殼,float(None) 會讓整檔算不出東西)
      if (!r || r.close == null) continue;
      o.dates.push(String(r.date).replace(/\//g, '-'));
      o.close.push(+r.close); o.high.push(+r.high); o.low.push(+r.low);
      o.open.push(+r.open); o.vol.push(+(r.volume || 0));
    }
    if (o.dates.length < 260) { miss++; continue; }
    // ⚠️ 日期 → 索引一定要先建 Map:indexOf 是 O(n),
    //    2,653 檔 × 490 天 × 700 根 ≈ 9 億次比較,跑不完(而且它不會報錯,只會看起來卡住)
    o.at = new Map(); o.dates.forEach((d, i) => o.at.set(d, i));
    px.set(sym, o);
  }
  return { px, miss };
}

function loadIndex() {
  const p = path.join(DATA_DIR, '^TWII.json');
  if (!fs.existsSync(p)) return null;
  const rows = JSON.parse(fs.readFileSync(p, 'utf8')).filter((r) => r && r.close != null);
  const m = new Map();
  rows.forEach((r, i) => m.set(String(r.date).replace(/\//g, '-'), { i, c: +r.close }));
  return { map: m, arr: rows.map((r) => +r.close) };
}

// ── 3. 事件收集 ────────────────────────────────────────────────
/**
 * 把每一天的分點資料轉成事件。
 * ⛔ 只用「當天收盤時已知」的資訊 —— 分點是收盤後公布的,所以進場價用**隔天開盤**,
 *    ⚠️ 這跟 K 棒訊號那批(訊號日尾盤買,V72.9.0)**不一樣**,別把兩邊的數字互相比較。
 */
function buildEvents(days, px) {
  const ev = [];
  for (const day of days) {
    const d = day.d;
    for (const [sym, arr] of Object.entries(day.s)) {
      const o = px.get(sym); if (!o) continue;
      const i = o.at.get(d);
      // 需要 250 根暖身(位階/波動要算)+ 前瞻天數 + 1(隔天開盤才進場)
      if (i == null || i < 250 || i + Math.max(...FWD) + 1 >= o.dates.length) continue;
      const vol = o.vol[i]; if (!(vol > 0)) continue;
      // arr = [[券商代號, 淨股數, 均價], ...]。⚠️ 淨額單位是**股**,K 線 volume 也是股 → 同單位。
      const nets = arr.map((x) => +x[1] || 0);
      const buys = nets.filter((x) => x > 0).sort((a, b) => b - a);
      const sells = nets.filter((x) => x < 0).sort((a, b) => a - b);
      const concBuy = buys.slice(0, 5).reduce((s, x) => s + x, 0) / vol * 100;
      const concSell = -sells.slice(0, 5).reduce((s, x) => s + x, 0) / vol * 100;
      const netAll = nets.reduce((s, x) => s + x, 0) / vol * 100;
      ev.push({ sym, date: d, i, raw: { concBuy, concSell, netAll } });
    }
  }
  return ev;
}

// ── 4. 報酬(扣同期加權)────────────────────────────────────────
function excessReturn(px, idx, sym, i, fwd) {
  const o = px.get(sym);
  // ⭐ 分點是**收盤後**才公布 → 只能隔天開盤進場(⛔ 用訊號日收盤價 = 前視偏誤)
  const entry = o.open[i + 1];
  const exit = o.close[i + 1 + fwd - 1];
  if (!(entry > 0) || !(exit > 0)) return null;
  const r = (exit / entry - 1) * 100;
  const di = idx.map.get(o.dates[i + 1]);
  const dj = idx.map.get(o.dates[i + 1 + fwd - 1]);
  if (!di || !dj) return null;
  const rb = (dj.c / di.c - 1) * 100;
  return r - rb;
}

// 🚧 買得到嗎:訊號隔天開盤就漲停鎖死 → ⛔ 買不到,不可算進去
function tradableNextOpen(px, sym, i) {
  const o = px.get(sym);
  const prevC = o.close[i], op = o.open[i + 1], hi = o.high[i + 1], lo = o.low[i + 1];
  if (!(prevC > 0) || !(op > 0)) return false;
  const lim = prevC * 1.0995;
  return !(op >= lim && hi === lo);      // 開盤就漲停且全日不動 = 鎖死
}

// ── 5. 主程式 ──────────────────────────────────────────────────
function main(opt = {}) {
  console.log('🔬 分點逐日深歷史 —— 預測力回測\n');
  const days = loadDeep();
  console.log(`📥 深歷史 ${days.length} 天` +
    (days.length ? `(${days[0].d} ~ ${days[days.length - 1].d})` : ''));
  // 🚧 空過守門①
  if (days.length < MIN_DAYS) {
    console.log(`\n⏳ 目前只有 ${days.length} 天,至少要 ${MIN_DAYS} 天(≈1 年)才做得了`);
    console.log('   ⛔ 少於一年就沒有「逐年同向」與「拿掉最好那一年」那兩關,');
    console.log('      而那兩關正是本專案最會擋掉假訊號的兩關 → 現在下任何結論都不算數。');
    console.log('   ▶️ 回算跑完之後再跑一次:');
    console.log('      git archive origin/chips_deep | tar -x -C . && node scripts/chips_deep_probe.mjs');
    process.exit(2);        // 2 = 資料還不夠(⛔ 不是 0,別讓它看起來像跑完了)
  }
  const symsNeeded = new Set();
  for (const d of days) for (const s of Object.keys(d.s)) symsNeeded.add(s);
  const { px, miss } = loadPrices(symsNeeded);
  const idx = loadIndex();
  console.log(`📈 K 線 ${px.size} 檔可用(${miss} 檔沒有或太短)・加權指數 ${idx ? idx.map.size : 0} 天`);
  if (!idx || !px.size) { console.error('❌ 缺 K 線或加權指數 → 無法算超額報酬'); process.exit(1); }

  const ev = buildEvents(days, px);
  console.log(`🧾 (股·日)樣本 ${ev.length.toLocaleString()} 筆\n`);
  // 🚧 空過守門②
  if (ev.length < MIN_N * 10) {
    console.error(`❌ 樣本只有 ${ev.length} 筆(<${MIN_N * 10})→ 不足以分桶,⛔ 不下結論`);
    process.exit(1);
  }

  // 門檻一律用**當天的橫斷面分位**(⛔ 不寫死「>5%」那種憑空門檻)
  const byDate = new Map();
  for (const e of ev) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }
  for (const [, list] of byDate) {
    for (const key of ['concBuy', 'concSell', 'netAll']) {
      const vals = list.map((x) => x.raw[key]).sort((a, b) => a - b);
      const rank = (v) => {
        let lo = 0, hi = vals.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < v) lo = m + 1; else hi = m; }
        return lo / Math.max(1, vals.length - 1) * 100;
      };
      for (const x of list) x.raw[`${key}_pct`] = rank(x.raw[key]);
    }
  }

  const SCENARIOS = [
    ['(對照組)全部(股·日)', () => true],
    ['🟥 前5大買超佔量 最高 10%', (r) => r.concBuy_pct >= 90],
    ['🟥 前5大買超佔量 最高 25%', (r) => r.concBuy_pct >= 75],
    ['⬜ 前5大買超佔量 中間 40~60%', (r) => r.concBuy_pct >= 40 && r.concBuy_pct <= 60],
    ['🟩 前5大買超佔量 最低 25%', (r) => r.concBuy_pct <= 25],
    ['🟥 前15家淨額佔量 最高 10%(買方壓倒)', (r) => r.netAll_pct >= 90],
    ['🟩 前15家淨額佔量 最低 10%(賣方壓倒)', (r) => r.netAll_pct <= 10],
    ['🟩 前5大賣超佔量 最高 10%', (r) => r.concSell_pct >= 90],
  ];

  const rows = [];
  for (const [name, test] of SCENARIOS) {
    const hits = ev.filter((e) => test(e.raw));
    const seen = new Map();
    const kept = [];
    for (const e of hits) {                      // 20 日去重
      const prev = seen.get(e.sym);
      if (prev != null && e.i - prev < DEDUP) continue;
      seen.set(e.sym, e.i); kept.push(e);
    }
    const tradable = kept.filter((e) => tradableNextOpen(px, e.sym, e.i));
    const out = { name, n: kept.length, nTradable: tradable.length };
    for (const f of FWD) {
      const rs = tradable.map((e) => excessReturn(px, idx, e.sym, e.i, f)).filter((x) => x != null);
      out[`m${f}`] = mean(rs); out[`d${f}`] = med(rs);
      out[`w${f}`] = rs.length ? rs.filter((x) => x > 0).length / rs.length * 100 : NaN;
      out[`c${f}`] = rs.length;
    }
    rows.push(out);
  }

  const base = rows[0];
  console.log('┌─ 事件 ────────────────────────────────┬──── n ───┬─ 5日 ─┬─ 10日 ─┬─ 20日 ─┬ 20日勝率 ┐');
  for (const r of rows) {
    const d = (f) => (r === base ? nf(r[`m${f}`]) : nf(r[`m${f}`] - base[`m${f}`]));
    const tag = r.n < MIN_N ? ' ⏳樣本不足' : '';
    console.log(`│ ${r.name.padEnd(36)} │ ${String(r.nTradable).padStart(8)} │ `
      + `${d(5).padStart(5)} │ ${d(10).padStart(6)} │ ${d(20).padStart(6)} │ `
      + `${nf(r.w20, 1).padStart(7)}% │${tag}`);
  }
  console.log('└───────────────────────────────────────┴──────────┴───────┴────────┴────────┴──────────┘');
  console.log(`\n⚠️ 「5日/10日/20日」那三欄對「非對照組」是**相對對照組的 pp 差**,對照組本身是絕對值。`);
  console.log(`⚠️ 進場價是**隔天開盤**(分點收盤後才公布)→ ⛔ 不可拿來跟 K 棒訊號那批(訊號日尾盤買)直接比。`);
  console.log(`⚠️ 已排除「隔天開盤就漲停鎖死」的事件(買不到);來回成本 ${COST}% 尚未扣,`);
  console.log(`   任何一格的 pp 差沒有大於 ${COST} 就等於白做。`);

  // ⑧ 反方向那一桶是不是也正 —— 是的話那是「活躍度」不是「方向」
  const hi = rows.find((r) => r.name.includes('最高 10%') && r.name.includes('前5大買超'));
  const lo = rows.find((r) => r.name.includes('前5大賣超'));
  if (hi && lo && hi.n >= MIN_N && lo.n >= MIN_N) {
    const a = hi.m20 - base.m20, b = lo.m20 - base.m20;
    console.log('\n🔎 方向性檢定(⭐ 這一關最容易被忽略):');
    console.log(`   買方極端 ${nf(a)}pp ・賣方極端 ${nf(b)}pp`);
    // ⚠️ 第一版只抓「兩端都正」→ 350 天實跑時買賣兩端**都是負的**(-0.60/-0.68),
    //    它卻印「方向相反」—— 同號就是同號,正負都算活躍度(只是方向反過來)。
    //    加 0.3pp 的雜訊門檻:一端幾乎是 0 時不算「同向」。
    if ((a > 0.3 && b > 0.3) || (a < -0.3 && b < -0.3)) {
      console.log('   🚨 **兩端同號 → 那是「活躍度」不是「方向」**,⛔ 不可做成多空');
      console.log('      (同 V72.5.2 集保「隱藏大戶」的教訓;兩端都負 = 分點大進大出的日子整體較差)');
    } else if (Math.abs(a) <= 0.3 && Math.abs(b) <= 0.3) {
      console.log('   ➖ 兩端都在 ±0.3pp 雜訊範圍內 → 沒有可解讀的方向性');
    } else {
      console.log('   ✅ 兩端方向相反(或一端無訊號)→ 至少不是純活躍度代理(但還要過其餘七關)');
    }
  }

  console.log('\n⏭️ 下一步(⛔ 上面任何一格看起來不錯都還不算數):');
  console.log('   ① 逐年拆開看方向一不一致 ② 拿掉最好的那一年還在不在');
  console.log('   ③ 疊在 🧬 高位階+高波動 之上有沒有**增量**(V73.2.5:78% 的訊號只是把它再數一次)');
  return opt.returnRows ? rows : undefined;
}

// ── 6. 🧪 harness 自驗 ─────────────────────────────────────────
/**
 * ⛔ 沒有這一段的話,「每一格都是雜訊」分不出是**真的沒訊號**還是**程式壞掉**
 *    (同 `ml_probe.py --selftest` 的教訓)。
 * 做法:合成一批資料,讓「前 5 大買超佔量高」**必然**對應到大漲,
 *      然後斷言這支真的把那個邊際算出來。算不出來就 exit 1。
 */
function selftest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'deepprobe-'));
  const dd = path.join(tmp, 'deep'), pd = path.join(tmp, 'data');
  fs.mkdirSync(dd); fs.mkdirSync(pd);
  const NSYM = 60, NBAR = 700, NDAY = 300;
  const dates = [];
  for (let i = 0, d = new Date(Date.UTC(2023, 0, 2)); dates.length < NBAR; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10));
  }
  // 加權指數:一路平盤(超額報酬 = 個股報酬,斷言才乾淨)
  fs.writeFileSync(path.join(pd, '^TWII.json'),
    JSON.stringify(dates.map((d) => ({ date: d, open: 10000, high: 10000, low: 10000, close: 10000, volume: 1 }))));
  // 決定哪些 (股, 日) 是「訊號日」——用固定的規則,讓斷言可重現(⛔ 不用亂數)
  const isSig = (si, bi) => (bi % 37 === si % 37);
  const syms = [];
  for (let s2 = 0; s2 < NSYM; s2++) {
    const sym = String(2000 + s2);
    syms.push(sym);
    const rows = []; let c = 100;
    for (let b = 0; b < NBAR; b++) {
      // 訊號日的**隔天起** 20 根各漲 0.2% → 20 日超額約 +4%
      const boost = [...Array(20).keys()].some((k) => b - 1 - k >= 0 && isSig(s2, b - 1 - k));
      c = c * (1 + (boost ? 0.004 : -0.0005));   // 注入的效果要**明顯大於**斷言門檻,才有判別餘裕
      rows.push({ date: dates[b], open: +(c * 0.999).toFixed(2), high: +(c * 1.01).toFixed(2),
                  low: +(c * 0.99).toFixed(2), close: +c.toFixed(2), volume: 10_000_000 });
    }
    fs.writeFileSync(path.join(pd, `${sym}.json`), JSON.stringify(rows));
  }
  // 深歷史:訊號日 → 前 5 大買超佔量很高;其餘日子很低
  for (let b = NBAR - NDAY; b < NBAR - 25; b++) {
    const sMap = {};
    syms.forEach((sym, s2) => {
      const big = isSig(s2, b);
      // ⭐ 買賣兩側刻意**反相關**:訊號日買方大、賣方小。
      //   這樣自驗才同時驗得到「⑧ 方向性檢定」——買賣兩側如果一起大,
      //   那條檢定會永遠印「兩端都正 = 活躍度」,等於它本身沒被驗過。
      // ⚠️ 一定要加「每檔不同」的微幅差異 —— 全部同值時橫斷面分位會整片壓成同一個名次,
      //    top 10% 那個桶會變成 0 筆(合成資料才會遇到,但它會讓自驗看起來像程式壞掉)。
      const jit = 1 + s2 / 200;
      const bper = Math.round((big ? 1_500_000 : 20_000) * jit);
      const sper = Math.round((big ? 20_000 : 1_500_000) * (2 - jit));
      sMap[sym] = [
        ...[...Array(5).keys()].map((k) => [`90${k}0`, bper, 100]),
        ...[...Array(5).keys()].map((k) => [`91${k}0`, -sper / 5, 100]),
      ];
    });
    fs.writeFileSync(path.join(dd, `${dates[b]}.json.gz`),
      zlib.gzipSync(Buffer.from(JSON.stringify({ d: dates[b], n: NSYM, k: 15, nm: {}, s: sMap }))));
  }
  DEEP_DIR = dd; DATA_DIR = pd;
  console.log(`🧪 --selftest:合成 ${NSYM} 檔 × ${NDAY - 25} 天,`
    + '「前5大買超佔量高」→ 之後 20 根必漲。斷言這支要抓得到。\n');
  return { tmp };
}

if (SELFTEST) {
  selftest();
  const res = main({ returnRows: true });
  const base = res.find((r) => r.name.includes('對照組'));
  const hit = res.find((r) => r.name.includes('前5大買超佔量 最高 10%'));
  const sellB = res.find((r) => r.name.includes('前5大賣超佔量 最高 10%'));
  const edge = hit && base ? hit.m20 - base.m20 : NaN;
  const sEdge = sellB && base ? sellB.m20 - base.m20 : NaN;
  console.log(`\n🧪 自驗結果:買方極端邊際 ${nf(edge)}pp ・賣方極端邊際 ${nf(sEdge)}pp(20 日)`);
  let bad = [];
  // ① harness 真的算得出注入的邊際
  if (!(edge > 2)) bad.push('注入了「必然學得到」的訊號卻算不出邊際');
  // ② ⑧ 方向性檢定本身也要被驗到:反相關的合成資料下,賣方那一桶必須明顯比買方差
  if (!(sEdge < edge - 1)) bad.push('方向性檢定沒作用(賣方那桶沒有明顯比買方差)');
  // ③ 樣本數守門真的有在數
  if (!(hit && hit.n >= MIN_N)) bad.push(`事件數只有 ${hit ? hit.n : 0},合成資料應該遠超過 ${MIN_N}`);
  if (bad.length) {
    console.error('❌ SELFTEST 失敗 —— 這支探針本身壞掉了:');
    bad.forEach((b) => console.error('   - ' + b));
    process.exit(1);
  }
  console.log('✅ CHIPS_DEEP_PROBE_SELFTEST_PASS(harness 真的算得出邊際,方向性檢定也有作用)');
} else {
  main();
}
