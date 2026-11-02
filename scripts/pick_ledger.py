#!/usr/bin/env python3
"""🔏 推薦紀錄存證(V80.1.9,評估紀錄 52:srikar0805/wallstreet-council 的 publish.py 想法,程式自己寫)。

為什麼要有這支:`data/pick_history.json`(V73.4.1)記「當天實際推了哪幾檔」,但它住在 data / gh-pages ——
  那兩個分支每次都整個 force-push 覆蓋 → 舊的長怎樣沒有任何痕跡,事後「被改過」也看不出來。
  這支把每一天、每一段紀錄的指紋(sha256)**只增不改**地記在獨立分支 pick_ledger 的 pick_ledger.tsv:
  之後任何人重算一次指紋,對得上 = 那天的紀錄從記下來到現在沒被改過。

規則:
  ① 一列 = 日期、哪一段(pick_history 那天紀錄的第一層鍵,例:pb / sig / lead)、指紋前 16 碼、筆數、記錄時間
  ② 那一段第一次出現 → 記一列(之後補回來的段落,例:👑 回補 bf:1,也算第一次出現 → 照記)
  ③ 今天(台北)的紀錄還會被同一天重跑覆蓋 → 指紋變了就再記一列(以最後一列為準)
  ④ 過去的日子指紋變了 → ⛔ 不記新的(證據要留著),印出來、算進「對不上」
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


def plan(hist, ledger_text, today):
    """→ (要追加的列, 對不上的 [(日期, 段落)])。純函式。today = 'YYYY-MM-DD'(台北)。"""
    last = read_ledger(ledger_text)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    add, bad = [], []
    for (d, k), (h, n) in sorted(parts_of(hist).items()):
        old = last.get((d, k))
        if old == h:
            continue
        if old is None or d >= today:
            add.append(f'{d}\t{k}\t{h}\t{n}\t{now}\n')
        else:
            bad.append((d, k))
    return add, bad


def verify(hist, ledger_text):
    """→ (對得上幾段, 對不上的 [(日期, 段落)], 存證有、現在紀錄沒有的幾段(超過保留天數被裁掉的))。"""
    last, cur = read_ledger(ledger_text), parts_of(hist)
    good = sum(1 for key, h in last.items() if key in cur and cur[key][0] == h)
    bad = sorted(key for key, h in last.items() if key in cur and cur[key][0] != h)
    gone = sum(1 for key in last if key not in cur)
    return good, bad, gone


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
        good, bad, gone = verify(hist, text)
        print(f'🔏 存證比對:{good} 段對得上、{len(bad)} 段對不上、{gone} 段已超過保留天數')
        for d, k in bad[:20]:
            print(f'  ⚠️ {d} {k}:現在的紀錄跟當時記下的指紋不一樣')
        return 1 if bad else 0
    today = datetime.now(TPE).strftime('%Y-%m-%d')
    add, bad = plan(hist, text, today)
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
    add, bad = plan(h1, '', '2026-11-02')
    ok('② 第一次:每一天每一段各記一列(3 列)、沒有對不上', len(add) == 3 and not bad, add)
    led = HEAD + ''.join(add)
    add2, bad2 = plan(h1, led, '2026-11-02')
    ok('③ 沒變 → 什麼都不記(⛔ 重複記)', add2 == [] and bad2 == [], add2)
    h2 = json.loads(json.dumps(h1))
    h2['days'][1]['pb'].append({'s': '3008'})
    add3, bad3 = plan(h2, led, '2026-11-02')
    ok('④ 今天的紀錄被同一天重跑改了 → 再記一列(以最後一列為準)', len(add3) == 1 and add3[0].startswith('2026-11-02\tpb') and not bad3, add3)
    h3 = json.loads(json.dumps(h1))
    h3['days'][0]['pb'][0]['s'] = '9999'
    add4, bad4 = plan(h3, led, '2026-11-02')
    ok('⑤ 過去的紀錄被改 → ⛔ 不記新的、列進對不上', add4 == [] and bad4 == [('2026-10-30', 'pb')], (add4, bad4))
    h4 = json.loads(json.dumps(h1))
    h4['days'][0]['lead'] = [{'s': '2330', 'bf': 1}]
    add5, bad5 = plan(h4, led, '2026-11-02')
    ok('⑥ 過去的日子補上新的一段(👑 回補 bf:1)→ 第一次出現,照記', len(add5) == 1 and '\tlead\t' in add5[0] and not bad5, add5)
    good, badv, gone = verify(h3, led)
    ok('⑦ verify:改過的那段抓得到,其他對得上', badv == [('2026-10-30', 'pb')] and good == 2 and gone == 0, (good, badv))
    good2, bad2v, gone2 = verify({'days': [h1['days'][1]]}, led)
    ok('⑧ 超過保留天數被裁掉的 → 算「已裁掉」,⛔ 當成被改', bad2v == [] and gone2 == 2 and good2 == 1, (good2, bad2v, gone2))
    ok('⑨ 壞列 / 表頭跳過', read_ledger(HEAD + 'x\n2026-01-01\tpb\n2026-01-02\tpb\tabc\t1\tt\n') == {('2026-01-02', 'pb'): 'abc'})
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 10 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main(sys.argv))
