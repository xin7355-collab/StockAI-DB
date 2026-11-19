#!/usr/bin/env python3
"""🔏 推薦紀錄存證(V80.1.9,評估紀錄 52:srikar0805/wallstreet-council 的 publish.py 想法,程式自己寫)。

為什麼要有這支:`data/pick_history.json`(V73.4.1)記「當天實際推了哪幾檔」,但它住在 data / gh-pages ——
  那兩個分支每次都整個 force-push 覆蓋 → 舊的長怎樣沒有任何痕跡,事後「被改過」也看不出來。
  這支把每一天、每一段紀錄的指紋(sha256)**只增不改**地記在獨立分支 pick_ledger 的 pick_ledger.tsv:
  之後任何人重算一次指紋,對得上 = 那天的紀錄從記下來到現在沒被改過。

規則:
  ① 一列 = 日期、哪一段(pick_history 那天紀錄的第一層鍵,例:pb / sig / lead)、指紋前 16 碼、筆數、記錄時間
  ② 那一段第一次出現 → 記一列(之後補回來的段落,例:👑 回補 bf:1,也算第一次出現 → 照記)
  ③ 還沒「定案」的紀錄會被重跑覆蓋 → 指紋變了就再記一列(以最後一列為準)。
     🕘 V82.5.9 定案 = 那個資料日之後第一個平日台北 09:00(下一個交易時段開始,有人能照它做事的第一刻)。
     以前用「台北的今天」→ 半夜第二輪採礦重算同一個資料日(例:11/02 的名單在 11/03 03:37 重跑)就被當成竄改;
     11/02~11/12 的 10 段警告都是這樣來的(9 段在隔天開盤前、1 段在開盤後手動重跑,見 EXPLAINED)。
  ④ 已經定案的日子指紋變了 → ⛔ 不記新的(證據要留著),印出來、算進「對不上」
  ⑥ 查過、寫得出原因的 → 列在 EXPLAINED(釘住查過之後的那個指紋;之後又被改 → 照樣算對不上)
  ⑤ ⛔ 不刪、不改任何既有的列;workflow ⛔ force push
跑法:python3 scripts/pick_ledger.py append <pick_history.json> <pick_ledger.tsv>
      python3 scripts/pick_ledger.py verify <pick_history.json> <pick_ledger.tsv>
      python3 scripts/pick_ledger.py --selftest
"""
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))
HEAD = 'date\tpart\tsha16\tn\trecorded_utc\n'

# ⑥ 查過的對不上(V82.5.9,查 playbook_scan 每一輪的存證那一行:第一次列出來的是哪一輪、台北幾點)
#    值 = (查過之後現在的指紋, 原因)。⛔ 只收查得到 log 的;指紋對不上(之後又被改)照樣算對不上。
EXPLAINED = {
    ('2026-11-02', 'lead'): ('944fcd04ff816481', '11/03 03:37 隔天開盤前同一個資料日重跑(run 41509976048)'),
    ('2026-11-02', 'sig'):  ('e41cfd38f1232b9f', '11/03 03:37 隔天開盤前同一個資料日重跑(run 41509976048)'),
    ('2026-11-03', 'lead'): ('f63b40e4f74c3572', '11/04 01:16 隔天開盤前同一個資料日重跑(run 41682559529)'),
    ('2026-11-04', 'lead'): ('552d7132cce0bae6', '11/05 01:42 隔天開盤前同一個資料日重跑(run 41879735229)'),
    ('2026-11-05', 'lead'): ('be8631e393aad3e6', '11/06 02:45 以前、隔天開盤前同一個資料日重跑(run 42087323419 已列出)'),
    ('2026-11-05', 'pb'):   ('7428a27e832c4f47', '⚠️ 11/06 10:09 開盤後手動重跑(run 42148504136)—— 那天 13:25 尾盤買用的是這一份,開盤前看到的是舊的'),
    ('2026-11-06', 'lead'): ('9f2bb04452cce9db', '11/07(六)01:00 下一個交易時段前同一個資料日重跑(run 42257534965)'),
    ('2026-11-06', 'pb'):   ('d4cf545f020d2df4', '11/07(六)01:00 下一個交易時段前同一個資料日重跑(run 42257534965)'),
    ('2026-11-11', 'lead'): ('0c08e4aa521cd222', '11/12 00:54 隔天開盤前同一個資料日重跑(run 43062983472)'),
    ('2026-11-12', 'lead'): ('1b2212c1b6425948', '11/13 01:23 隔天開盤前同一個資料日重跑(run 43268949557)'),
}


def final_at(d_iso):
    """資料日 d 的紀錄什麼時候定案:之後第一個平日台北 09:00(⛔ 認得國定假日 —— 假日那天也算平日,只會讓窗口變短、不會變長)。"""
    d = datetime.strptime(d_iso, '%Y-%m-%d')
    nx = d + timedelta(days=1)
    while nx.weekday() >= 5:
        nx += timedelta(days=1)
    return datetime(nx.year, nx.month, nx.day, 9, 0, tzinfo=TPE)


def part_hash(v):
    """一段紀錄的指紋:排序鍵、緊湊格式的 JSON → sha256 前 16 碼(同一份內容在任何電腦都算出同一串)。"""
    s = json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]


def _n(v):
    return len(v) if isinstance(v, (list, dict)) else 1


def parts_of(hist):
    """pick_history.json → {(日期, 段落): (指紋, 筆數)}。日期那一鍵(d)本身不算一段。"""
    out = {}
    for rec in (hist or {}).get('days') or []:
        if not isinstance(rec, dict) or not rec.get('d'):
            continue
        for k, v in rec.items():
            if k == 'd':
                continue
            out[(str(rec['d']), str(k))] = (part_hash(v), _n(v))
    return out


def read_ledger(text):
    """→ {(日期, 段落): 最後一列的指紋}。表頭 / 壞列跳過。"""
    last = {}
    for line in (text or '').splitlines():
        f = line.split('\t')
        if len(f) < 3 or f[0] == 'date':
            continue
        last[(f[0], f[1])] = f[2]
    return last


def plan(hist, ledger_text, now):
    """→ (要追加的列, 對不上的 [(日期, 段落)])。純函式。now = 現在(帶時區的 datetime)。"""
    last = read_ledger(ledger_text)
    stamp = now.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    add, bad = [], []
    for (d, k), (h, n) in sorted(parts_of(hist).items()):
        old = last.get((d, k))
        if old == h:
            continue
        if old is None or now < final_at(d):
            add.append(f'{d}\t{k}\t{h}\t{n}\t{stamp}\n')
        elif EXPLAINED.get((d, k), ('',))[0] != h:
            bad.append((d, k))
    return add, bad


def verify(hist, ledger_text, explained=None):
    """→ (對得上幾段, 對不上的 [(日期, 段落)], 存證有、現在紀錄沒有的幾段(超過保留天數被裁掉的), 查過的 [(日期, 段落, 原因)])。"""
    ex = EXPLAINED if explained is None else explained
    last, cur = read_ledger(ledger_text), parts_of(hist)
    good = sum(1 for key, h in last.items() if key in cur and cur[key][0] == h)
    diff = sorted(key for key, h in last.items() if key in cur and cur[key][0] != h)
    known = [(d, k, ex[(d, k)][1]) for d, k in diff if (d, k) in ex and ex[(d, k)][0] == cur[(d, k)][0]]
    bad = [key for key in diff if not ((key in ex) and ex[key][0] == cur[key][0])]
    gone = sum(1 for key in last if key not in cur)
    return good, bad, gone, known


def _load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def main(argv):
    if len(argv) != 4 or argv[1] not in ('append', 'verify'):
        print(__doc__)
        return 2
    hist = _load(argv[2])
    try:
        with open(argv[3], encoding='utf-8') as f:
            text = f.read()
    except FileNotFoundError:
        text = ''
    if argv[1] == 'verify':
        good, bad, gone, known = verify(hist, text)
        print(f'🔏 存證比對:{good} 段對得上、{len(bad)} 段對不上、{len(known)} 段查過(原因寫在 pick_ledger.py)、{gone} 段已超過保留天數')
        for d, k in bad[:20]:
            print(f'  ⚠️ {d} {k}:現在的紀錄跟當時記下的指紋不一樣')
        for d, k, why in known:
            print(f'  ℹ️ {d} {k}:{why}')
        return 1 if bad else 0
    add, bad = plan(hist, text, datetime.now(TPE))
    with open(argv[3], 'a', encoding='utf-8') as f:
        if not text:
            f.write(HEAD)
        f.writelines(add)
    print(f'🔏 存證:新記 {len(add)} 段' + (f'、⚠️ {len(bad)} 段過去的紀錄跟當時的指紋不一樣(⛔ 不覆蓋):'
                                          + ', '.join(f'{d} {k}' for d, k in bad[:10]) if bad else ''))
    if bad:
        print(f'::warning::推薦紀錄有 {len(bad)} 段跟當時存證的指紋不一樣')
    return 0


def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    h1 = {'days': [{'d': '2026-10-30', 'pb': [{'s': '2330'}, {'s': '2317'}], 'sig': [{'s': '1101'}]},
                   {'d': '2026-11-02', 'pb': [{'s': '2454'}]}]}
    ok('① 指紋跟鍵的順序無關(同一份內容在哪台電腦都一樣)', part_hash({'a': 1, 'b': [2]}) == part_hash({'b': [2], 'a': 1}))
    ok('①b 內容差一個字 → 指紋不同', part_hash([{'s': '2330'}]) != part_hash([{'s': '2331'}]))
    T = lambda s: datetime.strptime(s, '%Y-%m-%d %H:%M').replace(tzinfo=TPE)
    NOW = T('2026-11-02 20:00')
    add, bad = plan(h1, '', NOW)
    ok('② 第一次:每一天每一段各記一列(3 列)、沒有對不上', len(add) == 3 and not bad, add)
    led = HEAD + ''.join(add)
    add2, bad2 = plan(h1, led, NOW)
    ok('③ 沒變 → 什麼都不記(⛔ 重複記)', add2 == [] and bad2 == [], add2)
    h2 = json.loads(json.dumps(h1))
    h2['days'][1]['pb'].append({'s': '3008'})
    add3, bad3 = plan(h2, led, NOW)
    ok('④ 今天的紀錄被同一天重跑改了 → 再記一列(以最後一列為準)', len(add3) == 1 and add3[0].startswith('2026-11-02\tpb') and not bad3, add3)
    h3 = json.loads(json.dumps(h1))
    h3['days'][0]['pb'][0]['s'] = '9999'
    add4, bad4 = plan(h3, led, NOW)
    ok('⑤ 過去的紀錄被改 → ⛔ 不記新的、列進對不上', add4 == [] and bad4 == [('2026-10-30', 'pb')], (add4, bad4))
    h4 = json.loads(json.dumps(h1))
    h4['days'][0]['lead'] = [{'s': '2330', 'bf': 1}]
    add5, bad5 = plan(h4, led, NOW)
    ok('⑥ 過去的日子補上新的一段(👑 回補 bf:1)→ 第一次出現,照記', len(add5) == 1 and '\tlead\t' in add5[0] and not bad5, add5)
    good, badv, gone, _ = verify(h3, led, {})
    ok('⑦ verify:改過的那段抓得到,其他對得上', badv == [('2026-10-30', 'pb')] and good == 2 and gone == 0, (good, badv))
    good2, bad2v, gone2, _ = verify({'days': [h1['days'][1]]}, led, {})
    ok('⑧ 超過保留天數被裁掉的 → 算「已裁掉」,⛔ 當成被改', bad2v == [] and gone2 == 2 and good2 == 1, (good2, bad2v, gone2))
    ok('⑨ 壞列 / 表頭跳過', read_ledger(HEAD + 'x\n2026-01-01\tpb\n2026-01-02\tpb\tabc\t1\tt\n') == {('2026-01-02', 'pb'): 'abc'})
    # ⑩ 🕘 定案 = 資料日之後第一個平日 09:00(台北):半夜第二輪重算同一個資料日 ⛔ 算竄改
    h5 = json.loads(json.dumps(h1))
    h5['days'][1]['pb'][0]['s'] = '2603'                       # 2026-11-02(一)那段被重算
    a6, b6 = plan(h5, led, T('2026-11-03 03:37'))
    ok('⑩ 隔天 03:37 同一個資料日重跑改了 → 照記一列、⛔ 列進對不上', len(a6) == 1 and a6[0].startswith('2026-11-02\tpb') and not b6, (a6, b6))
    a7, b7 = plan(h5, led, T('2026-11-03 09:01'))
    ok('⑩ 決定性對照:同一個改動在隔天 09:01(開盤後)→ ⛔ 記、算對不上', a7 == [] and b7 == [('2026-11-02', 'pb')], (a7, b7))
    ok('⑩ 舊規則(台北的今天)會把 03:37 那次當成竄改 → 新規則才分得出來', '2026-11-02' < T('2026-11-03 03:37').strftime('%Y-%m-%d'))
    hf = {'days': [{'d': '2026-11-06', 'pb': [{'s': '2330'}]}]}
    ledf = HEAD + ''.join(plan(hf, '', T('2026-11-06 18:00'))[0])
    hf2 = {'days': [{'d': '2026-11-06', 'pb': [{'s': '2317'}]}]}
    ok('⑪ 週五的名單:週六 01:00、週一 08:59 重跑 → 照記;週一 09:00 → 對不上',
       len(plan(hf2, ledf, T('2026-11-07 01:00'))[0]) == 1 and len(plan(hf2, ledf, T('2026-11-09 08:59'))[0]) == 1
       and plan(hf2, ledf, T('2026-11-09 09:00')) == ([], [('2026-11-06', 'pb')]))
    ok('⑪ final_at:週一 → 週二 09:00、週五 → 週一 09:00', final_at('2026-11-02') == T('2026-11-03 09:00') and final_at('2026-11-06') == T('2026-11-09 09:00'))
    # ⑫ 查過的(EXPLAINED)釘住查過之後的指紋:一樣 → 列成「查過」、不算對不上;之後又被改 → 照樣對不上
    hx = part_hash(h3['days'][0]['pb'])
    g3, b3v, _, k3 = verify(h3, led, {('2026-10-30', 'pb'): (hx, '測試原因')})
    ok('⑫ 查過、指紋一樣 → 不算對不上、列進查過', b3v == [] and k3 == [('2026-10-30', 'pb', '測試原因')], (b3v, k3))
    g4, b4v, _, k4 = verify(h3, led, {('2026-10-30', 'pb'): ('0' * 16, '測試原因')})
    ok('⑫ 決定性對照:查過之後又被改(指紋不一樣)→ 照樣對不上', b4v == [('2026-10-30', 'pb')] and k4 == [], (b4v, k4))
    a8, b8 = plan(h3, led, T('2026-11-05 12:00'))
    ok('⑫ plan:已定案的日子被改 → 照樣不記;沒查過的列進對不上', a8 == [] and b8 == [('2026-10-30', 'pb')], (a8, b8))
    ok('⑫ EXPLAINED 每一筆都是 16 碼指紋 + 有原因', all(len(v[0]) == 16 and v[1] for v in EXPLAINED.values()) and len(EXPLAINED) == 10)
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 19 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main(sys.argv))
