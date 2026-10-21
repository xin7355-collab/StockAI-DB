// 🎯 V79.4.7 明日作戰清單「真的跑一次」守門(陷阱 #57)
//
// 🚨 為什麼要這支:V76.2.9(2026-09-14)把 playbook_scan.mjs 的 `tickOf` 搬到檔案最上面(Node 端),
//    但算觸發價那段是在**瀏覽器裡**(page.evaluate)跑的 → ReferenceError → 被每檔的 catch 吞掉
//    → 凡是「有真的觸發價」的股票整檔消失。2026-09-14 ~ 10-20 每天名單 0 筆有觸發價(全是「無價格閘門」),
//    auto_trade.py 遇到沒有觸發價一律跳過 → 🔥 五週沒有買過任何一檔,workflow 全綠、檔案照寫。
//    ⛔ test_ticksize 只比對原始碼字串 → 全程綠燈(陷阱 #40:靜態檢查看不到「這段在哪個環境跑」)。
//
// 釘住:
//  ① 走正式入口:複製 playbook_scan.mjs + index.html + 30 檔 K 線到暫存資料夾,真的跑一次
//  ② 名單裡至少一筆有觸發價;觸發價對齊跳動單位、停損 = 觸發價 × 0.95 往下對齊跳動單位
//  ③ log 寫「分析丟出例外:0 檔」
//  ④ 決定性對照:把瀏覽器裡那行 tickOf 拿掉 → 必須 exit 1、⛔ 不可寫出名單
//
// 跑法:node scripts/test_pbscan_run.mjs   (約 40 秒;要 repo 的 data/,沒有就先跑 scripts/fetch_testdata.sh)
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ck = (c, m, e = '') => { console.log((c ? '✅ ' : '❌ ') + m + (c || !e ? '' : `  ${String(e).slice(0, 300)}`)); if (!c) FAIL.push(m); };
const tickOf = v => v < 10 ? 0.01 : v < 50 ? 0.05 : v < 100 ? 0.1 : v < 500 ? 0.5 : v < 1000 ? 1 : 5;
const onGrid = p => { const t = tickOf(p); return Math.abs(p / t - Math.round(p / t)) < 1e-6; };

// 9/11(壞掉前最後一天)名單上有觸發價的幾檔 + 權值股 —— 只要 repo 的 data/ 有就用
const WANT = ['5314', '3026', '4537', '4573', '7856', '2426', '3443', '4939', '4958', '8996', '4931', '3189', '2330', '2317', '2454',
              '3231', '6415', '2603', '1101', '2881', '3008', '2382', '6669', '3711', '2308', '1216', '2412', '2891', '5871', '3034'];
const have = WANT.filter(s => fs.existsSync(path.join(ROOT, 'data', `${s}.json`)));
if (have.length < 25) { console.error(`❌ repo 的 data/ 只找到 ${have.length}/30 檔 → 先跑 bash scripts/fetch_testdata.sh`); process.exit(1); }

const setup = (tag, mutate) => {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), `pbscan_${tag}_`));
    fs.mkdirSync(path.join(R, 'scripts')); fs.mkdirSync(path.join(R, 'data'));
    let src = fs.readFileSync(path.join(ROOT, 'scripts/playbook_scan.mjs'), 'utf8');
    if (mutate) src = mutate(src);
    fs.writeFileSync(path.join(R, 'scripts/playbook_scan.mjs'), src);
    fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(R, 'index.html'));
    for (const s of have) fs.copyFileSync(path.join(ROOT, 'data', `${s}.json`), path.join(R, 'data', `${s}.json`));
    const tw = path.join(ROOT, 'data', '^TWII.json'); if (fs.existsSync(tw)) fs.copyFileSync(tw, path.join(R, 'data', '^TWII.json'));
    return R;
};
const run = R => {
    const r = spawnSync(process.execPath, ['scripts/playbook_scan.mjs', String(have.length)], { cwd: R, encoding: 'utf8', timeout: 300000 });
    const out = path.join(R, 'data', 'playbook_edge.json');
    return { rc: r.status, log: (r.stdout || '') + (r.stderr || ''), j: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
};

// ── ①②③ 正式程式真的跑一次 ──────────────────────────────────────
console.log(`── ①②③ 正式入口真的跑一次(${have.length} 檔)──`);
{
    const R = setup('ok');
    const { rc, log, j } = run(R);
    ck(rc === 0, '① playbook_scan 跑完 rc=0', log.slice(-600));
    ck(!!j, '① 有寫出 playbook_edge.json');
    const picks = (j && j.picks) || [];
    const trig = picks.filter(x => x.trig != null);
    ck(trig.length >= 1, `② 名單裡至少一筆有觸發價(實得 ${trig.length}/${picks.length})—— 陷阱 #57 壞掉時是 0`);
    ck(trig.every(x => onGrid(+x.trig)), '② 觸發價全部對齊跳動單位', trig.filter(x => !onGrid(+x.trig)).map(x => `${x.s}:${x.trig}`).join(' '));
    ck(trig.every(x => +x.trig > +x.c - 1e-9), '② 觸發價都 ≥ 現價(⛔ 不可叫人「漲過」一個已經過去的價)', trig.filter(x => !(+x.trig > +x.c - 1e-9)).map(x => `${x.s}:${x.c}→${x.trig}`).join(' '));
    const stopOk = x => { const want = +(Math.floor(+x.trig * 0.95 / tickOf(+x.trig * 0.95) + 1e-9) * tickOf(+x.trig * 0.95)).toFixed(2); return Math.abs(+x.stop - want) < 1e-6; };
    ck(trig.every(stopOk), '② 停損 = 觸發價 × 0.95 往下對齊跳動單位', trig.filter(x => !stopOk(x)).map(x => `${x.s}:${x.trig}/${x.stop}`).join(' '));
    ck(/分析丟出例外:0 檔/.test(log), '③ log 寫「分析丟出例外:0 檔」', (log.match(/分析丟出例外[^\n]*/) || [''])[0]);
    fs.rmSync(R, { recursive: true, force: true });
}

// ── ④ 決定性對照:瀏覽器裡那行 tickOf 拿掉 = 重現 V76.2.9 的壞法 ─────────
console.log('── ④ 決定性對照:拿掉瀏覽器裡的 tickOf → 必須擋下來 ──');
{
    const LINE = 'const tickOf = p => app._tickOf(p);';
    const src = fs.readFileSync(path.join(ROOT, 'scripts/playbook_scan.mjs'), 'utf8');
    ck(src.split(LINE).length === 2, '④ 正式程式裡剛好有一行瀏覽器端的 tickOf(借 App 的 _tickOf)');
    const R = setup('bug', s => s.replace(LINE, '/* 注入:拿掉 */'));
    const { rc, log, j } = run(R);
    ck(rc === 1, `④ 注入後 exit 1(實得 rc=${rc})`, log.slice(-400));
    ck(/程式出錯/.test(log), '④ log 寫出「程式出錯」(⛔ 不可靜默)');
    ck(!j, '④ 注入後⛔ 沒有寫出 playbook_edge.json(壞名單不可蓋掉昨天的)');
    fs.rmSync(R, { recursive: true, force: true });
}

console.log(FAIL.length ? `\n❌ ${FAIL.length} 條失敗` : '\n✅ 全過');
process.exit(FAIL.length ? 1 : 0);
