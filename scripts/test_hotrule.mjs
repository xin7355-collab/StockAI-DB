#!/usr/bin/env node
/**
 * 🔥 V79.4.9 「高檔飆股」選股規則換成「照這一招的平均排・每一招都算」(使用者 10/21 選「換,次數維持 8 次」)
 *
 * 釘住:
 *   ① 規則常數只有一份:scripts/lib_hotrule.mjs == index.html `_HOT_RULE` == lib_hotrule.py(auto_trade / alert_system 讀它)
 *   ② App 排序跟著設定走:同一份名單,`hotRule` 預設(mean)只留 r>0 照 exp 排;換回舊的(lb)只留 o>0 照 lb 排;
 *      ⭐ 決定性對照:翻開關 → 前 2 名真的變(兩種排法給的名單不同);舊格式名單(沒有 r / o)→ 不篩
 *   ③ auto_trade.py `fetch_picks` 在 HOT_RULE=mean / lb 下的前 2 名 == App 決策台 `_deckBuyOf`(同一份名單、同一個規則)
 *   ④ playbook_scan 真的跑一次(repo data/ 30 檔):預設那份「只留 o>0、照 (hq, lb, v) 排」== HOT_RULE=lb 跑出來那份
 *      (欄位逐一相同 → 「換回舊的」= 舊排法一模一樣);r>0 的列每檔最多 2 列、r=1 是那檔排序值最高的
 * ⚠️ ④ 要真的跑兩次 playbook_scan(各約 40 秒)。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { HOT_RULES, HOT_DEFAULT } from './lib_hotrule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ck = (c, m, e = '') => { console.log((c ? '✅ ' : '❌ ') + m + (c || !e ? '' : `  ${String(e).slice(0, 300)}`)); if (!c) FAIL.push(m); };
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ① 常數三份一致
{
    const m = HTML.match(/_HOT_RULE: (\{ mean: \{[^}]*\}, lb: \{[^}]*\} \})/);
    let app = null; try { app = m ? new Function(`return ${m[1]};`)() : null; } catch (_) { app = null; }
    ck(!!app && JSON.stringify(app) === JSON.stringify(HOT_RULES), `① index.html _HOT_RULE == lib_hotrule.mjs`, `${JSON.stringify(app)} vs ${JSON.stringify(HOT_RULES)}`);
    const py = spawnSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)}); import lib_hotrule as h; print(json.dumps({'r': h.HOT_RULES, 'd': h.HOT_DEFAULT}))`], { encoding: 'utf8' });
    let P = null; try { P = JSON.parse(py.stdout.trim()); } catch (_) {}
    ck(!!P && JSON.stringify(P.r) === JSON.stringify(HOT_RULES) && P.d === HOT_DEFAULT, '① lib_hotrule.py == lib_hotrule.mjs(規則與預設)', py.stdout + py.stderr);
    ck(HOT_DEFAULT === 'mean' && HOT_RULES.mean.z === 0 && HOT_RULES.mean.minN === 8 && HOT_RULES.lb.z === 1.28 && HOT_RULES.lb.top === 2, '① 現行 = 照平均・≥8 次;舊的 = 保守下界 1.28・一檔 2 招');
    const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8'), AL = fs.readFileSync(path.join(ROOT, 'alert_system.py'), 'utf8');
    ck(/from lib_hotrule import hot_rule, rule_rows, rule_key/.test(AT) && /HOT_RULE = hot_rule\(os\.getenv\('HOT_RULE'\)\)/.test(AT) && /rule_rows\(j\.get\('picks'\) or \[\], HOT_RULE\)/.test(AT), '① auto_trade.py 讀 lib_hotrule(⛔ 不另寫一份)');
    // 🧬 V80.0.9 alert_system 改走 lib_hotrule.deck_pick(= 決策台那條篩選;deck_pick 自己呼叫 rule_rows)
    const LH = fs.readFileSync(path.join(ROOT, 'lib_hotrule.py'), 'utf8');
    ck(/from lib_hotrule import [^\n]*deck_pick/.test(AL) && /deck_pick\(picks, hot_rule\(os\.getenv\('HOT_RULE'\)\)/.test(AL) && /def deck_pick[\s\S]*?rule_rows\(picks, rule\)/.test(LH), '① alert_system.py 讀 lib_hotrule(deck_pick → rule_rows)');
}

// 合成名單:同一檔兩招、新 / 舊排法名次不同
const row = (s, k, exp, lb, r, o, rank = 90, vol = 70, bear = 0) => ({ s, k, exp, lb, r, o, rank, vol, hq: (rank >= 85 && vol >= 60) ? 1 : 0, bear, trig: 100, stop: 95, c: 98, v: 1000 });
const NEW = [
    row('1111', '💪 發動棒破昨高', 6.0, 0.5, 1, 0),     // 平均最高、下界很低 → 只在新排法
    row('2222', '📦 箱型突破', 5.0, 0.4, 1, 0),
    row('3333', '🎯 回後買上漲', 3.0, 2.5, 1, 1),        // 兩套都有
    row('4444', '🕯️ 站上長黑K壓力', 2.0, 1.9, 0, 1),   // 只在舊排法
    row('5555', '📈 葛蘭碧買點', 1.5, 1.8, 0, 1),
];
const OLDFMT = NEW.map(({ r, o, ...x }) => x);
const wrap = (picks, rule) => ({ data_date: '2026-10-21', picks, mkt: { bear60: false }, ...(rule ? { rule } : {}) });

const pyPick = (list, rule) => {
    const code = `
import sys, json, io, os
os.environ['HOT_RULE'] = ${JSON.stringify(rule)}
sys.path.insert(0, ${JSON.stringify(ROOT)})
import auto_trade as A
data = ${JSON.stringify(JSON.stringify(wrap(list, 'mean')))}.encode()
class R(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False
A.urllib.request.urlopen = lambda *a, **k: R(data)
A.log = lambda *a, **k: None
j, picks = A.fetch_picks()
print(json.dumps([p['s'] for p in picks[:A.MAX_PICKS]]))
`;
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 60000 });
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) { return { err: (r.stderr || r.stdout || '').slice(-400) }; }
};

let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._deckBuyOf === 'function', null, { timeout: 60000 });
const appPick = (list, rule) => page.evaluate(([j, rule]) => {
    app._mySyms = () => new Set(); app.settings.hotRule = rule;
    return { buy: app._deckBuyOf(j).buy.map(x => String(x.s)), sorted: app._pbSort(j.picks, new Set()).map(x => `${x.s}|${x.k}`), edge: (app._pbEdge = j, app._pbEdgeOf('3333')?.k) };
}, [wrap(list, 'mean'), rule]);

// ② App 跟著設定走
const Am = await appPick(NEW, 'mean'), Al = await appPick(NEW, 'lb'), Ao = await appPick(OLDFMT, 'mean');
ck(JSON.stringify(Am.buy) === JSON.stringify(['1111', '2222']), `② 預設(照平均)決策台前 2 名 = 1111, 2222 — 實得 ${JSON.stringify(Am.buy)}`);
ck(JSON.stringify(Al.buy) === JSON.stringify(['3333', '4444']), `② 換回舊的(保守下界)前 2 名 = 3333, 4444 — 實得 ${JSON.stringify(Al.buy)}`);
ck(JSON.stringify(Am.buy) !== JSON.stringify(Al.buy), '② ⭐ 決定性對照:翻開關前 2 名真的變');
ck(Am.sorted.every(x => !/^4444|^5555/.test(x)) && Al.sorted.every(x => !/^1111|^2222/.test(x)), '② 只留這套規則的列(mean 不含 o-only、lb 不含 r-only)', JSON.stringify([Am.sorted, Al.sorted]));
ck(Ao.sorted.length === OLDFMT.length, `② 舊格式名單(沒有 r / o)不篩(${Ao.sorted.length}/${OLDFMT.length})`);
// ②b 🔬 舊格式名單在預設(照平均)下也一定照 lb 排 —— 照平均會是 1111 → 2222 → …(兩套都不是的順序;檢查代理 10/22 抓到)
const lbOrder = [...OLDFMT].sort((a, b) => b.lb - a.lb).map(x => `${x.s}|${x.k}`);
ck(JSON.stringify(Ao.sorted) === JSON.stringify(lbOrder) && Ao.sorted[0].startsWith('3333'), `②b 🔬 舊格式名單照 lb 排(${Ao.sorted.map(x => x.split('|')[0]).join(' ')})`, JSON.stringify(Ao.sorted));
{
    const pyOld = pyPick(OLDFMT, 'mean');
    ck(JSON.stringify(pyOld) === JSON.stringify(Ao.buy) && JSON.stringify(pyOld) === JSON.stringify(['3333', '4444']), `②c 舊格式名單:auto_trade 前 2 名 == 決策台 == 3333, 4444(照 lb)— 實得 ${JSON.stringify(pyOld)} vs ${JSON.stringify(Ao.buy)}`);
    // 產業作戰室 `_pbKeyOf` 同一條(⛔ 第三份實作;抽原始碼用假的 this 跑)
    const PH = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
    const m = PH.match(/\n  _pbKeyOf\(x, rule\) \{([^\n]*)\},\n/);
    let kf = null; try { kf = m ? new Function('x', 'rule', m[1]) : null; } catch (_) { kf = null; }
    const T = { _hotRule: () => 'mean' };
    const proOld = kf ? [...OLDFMT].sort((a, b) => kf.call(T, b) - kf.call(T, a)).map(x => `${x.s}|${x.k}`) : null;
    const proNew = kf ? [...NEW].sort((a, b) => kf.call(T, b) - kf.call(T, a)).map(x => x.s) : null;
    ck(!!kf && JSON.stringify(proOld) === JSON.stringify(lbOrder) && proNew[0] === '1111', `②d 產業作戰室 _pbKeyOf:舊格式照 lb、新格式照平均(${proOld && proOld[0]} / ${proNew && proNew[0]})`, m ? m[1].slice(0, 200) : '找不到 _pbKeyOf');
}
// ③ auto_trade 同一條
for (const [rule, A] of [['mean', Am], ['lb', Al]]) {
    const p = pyPick(NEW, rule);
    ck(JSON.stringify(p) === JSON.stringify(A.buy), `③ HOT_RULE=${rule}:auto_trade 前 2 名 == 決策台 — 實得 ${JSON.stringify(p)} vs ${JSON.stringify(A.buy)}`, JSON.stringify(p));
}
await browser.close();

// ④ playbook_scan 真的跑:預設的 o>0 那幾列 == HOT_RULE=lb 跑出來的(換回舊的 = 舊排法一模一樣)
{
    const WANT = ['5314', '3026', '4537', '4573', '7856', '2426', '3443', '4939', '4958', '8996', '4931', '3189', '2330', '2317', '2454',
                  '3231', '6415', '2603', '1101', '2881', '3008', '2382', '6669', '3711', '2308', '1216', '2412', '2891', '5871', '3034'];
    const have = WANT.filter(s => fs.existsSync(path.join(ROOT, 'data', `${s}.json`)));
    if (have.length < 25) { ck(false, `④ repo 的 data/ 只找到 ${have.length}/30 檔 → 先跑 bash scripts/fetch_testdata.sh`); }
    else {
        const R = fs.mkdtempSync(path.join(os.tmpdir(), 'hotrule_'));
        fs.mkdirSync(path.join(R, 'scripts')); fs.mkdirSync(path.join(R, 'data'));
        for (const f of ['playbook_scan.mjs', 'lib_hotrule.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(R, 'scripts', f));
        fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(R, 'index.html'));
        for (const s of have) fs.copyFileSync(path.join(ROOT, 'data', `${s}.json`), path.join(R, 'data', `${s}.json`));
        const tw = path.join(ROOT, 'data', '^TWII.json'); if (fs.existsSync(tw)) fs.copyFileSync(tw, path.join(R, 'data', '^TWII.json'));
        const scan = env => { const r = spawnSync(process.execPath, ['scripts/playbook_scan.mjs', String(have.length)], { cwd: R, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 300000 }); let j = null; try { j = JSON.parse(fs.readFileSync(path.join(R, 'data', 'playbook_edge.json'), 'utf8')); } catch (_) {} return { rc: r.status, j, log: (r.stdout || '') + (r.stderr || '') }; };
        const D = scan({ HOT_RULE: '' }), L = scan({ HOT_RULE: 'lb' });
        ck(D.rc === 0 && L.rc === 0 && D.j && L.j, '④ 兩次都跑得完', (D.log + L.log).slice(-400));
        if (D.j && L.j) {
            ck(D.j.rule === 'mean' && L.j.rule === 'lb', `④ 檔頭記下規則(${D.j.rule} / ${L.j.rule})`);
            const F = ['s', 'k', 'w', 'po', 'exp', 'lb', 'n', 'trig', 'loose', 'rank', 'vol', 'hq', 'bear', 'up', 'stop'];
            const pick = x => JSON.stringify(F.map(f => x[f]));
            const oldFromNew = D.j.picks.filter(x => x.o > 0).sort((a, b) => (b.hq - a.hq) || (b.lb - a.lb) || (b.v - a.v)).map(pick);
            const lbRun = L.j.picks.map(pick);
            ck(oldFromNew.length > 0 && JSON.stringify(oldFromNew) === JSON.stringify(lbRun), `④ 預設那份「只留 o>0、照下界排」== HOT_RULE=lb 那份(${oldFromNew.length} / ${lbRun.length} 列逐欄相同)`);
            const perSym = new Map(); for (const x of D.j.picks.filter(x => x.r > 0)) (perSym.get(x.s) || perSym.set(x.s, []).get(x.s)).push(x);
            ck([...perSym.values()].every(a => a.length <= 2 && a.find(x => x.r === 1) && a.every(x => x.exp <= a.find(y => y.r === 1).exp)), `④ 新排法每檔最多 2 列、r=1 是那檔平均最高的(${perSym.size} 檔)`);
            ck(D.j.picks.filter(x => x.r > 0).length >= L.j.picks.length, `④ 新排法的列數 ≥ 舊排法(${D.j.picks.filter(x => x.r > 0).length} vs ${L.j.picks.length};門檻比較寬)`);
        }
        fs.rmSync(R, { recursive: true, force: true });
    }
}
console.log(FAIL.length ? `\n❌ ${FAIL.length} 條失敗` : '\n✅ test_hotrule 全過');
process.exit(FAIL.length ? 1 : 0);
