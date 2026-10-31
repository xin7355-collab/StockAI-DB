#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📰 新聞變因(V80.1.4,研究用 ⛔ 不改 App / 採礦)—— news_deep 月份檔 → 每檔每個交易日「標題講到它」幾則

使用者 10/31:「消息面的新聞目前抓法沒有很完整…補齊後再做多因子回測,這樣比較準」。
news_deep(V80.1.3)把鉅亨「台股新聞」分類一週一週往回補;這支只負責「數」,判定交給 factor_panel / factor_zoo_probe。

⭐ 不可違反:
 ① 零前視:新聞歸到「看得到它之後的第一個交易日」—— 交易日 13:30 以前發的歸當天;13:30 以後、週末、假日發的
    歸下一個交易日。factor_panel 的報酬是「隔天開盤買」→ 歸到第 t 天的新聞在 t+1 開盤前都看得到。
 ② 只看標題(括號裡的代號、或股名;股名誤配守門用 universal_radar._title_hits 同一份 ⛔ 不抄第二份)——
    2015~2020 的鉅亨新聞幾乎沒標代號(news_src_probe mode=fields),「有標代號」只有 2021 起才有 → 混用會讓
    2021 起的則數憑空變多;標題比對才是 2015~2026 同一把尺。代號只收括號裡的(⛔ 標題裡的「2025 年」不是千興)。
 ③ 不知道 ≠ 0:沒做完的週(_status.weeks ok≠1)、讀不出來的月份、資料範圍外 → 那幾天全部 NaN;
    不在股名表裡的代號(多半已下市,股名對不到)→ ⛔ 不輸出(研究時當 NaN,⛔ 不可當 0 —— 已下市的本來就比較差,
    當成「沒新聞」會讓「沒新聞 = 比較差」憑空成立)。
 ④ 同一則(id)一檔一天只算一次;同一天同一檔標題一模一樣的(轉載)只算一次。

輸出 OUT(預設 news_cnt.json):
  {meta:{cal:[交易日], known:[0/1], from, to, items, matched, by_year:{年:[則數, 對到幾則, 有標代號幾則]}, …},
   cnt:{代號:[[cal_i, 則數, 盤外則數], …]}}     盤外 = 不是在那個交易日 09:00~13:30 之間發的(前一天收盤後、週末、開盤前)
跑法:NEWS_DIR=<news_deep 解出來的目錄> DATA_DIR=<d16 或 data> NAMES=data/stock_names.json OUT=news_cnt.json \\
      python3 scripts/news_factor.py
      python3 scripts/news_factor.py --selftest
"""
import bisect
import gzip
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TW = timezone(timedelta(hours=8))
OPEN_MIN, CLOSE_MIN = 9 * 60, 13 * 60 + 30
_BR_CODE = re.compile(r'[\(（〔【]\s*(\d{4,6}[A-Z]?)(?:\s*[-.]?\s*TWO?)?\s*[\)）〕】]')


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def load_cal(data_dir):
    """交易日 = 加權指數的日期(DATA_DIR/^TWII.json)"""
    p = Path(data_dir) / '^TWII.json'
    rows = json.loads(p.read_text('utf-8'))
    rows = rows if isinstance(rows, list) else rows.get('data') or []
    return sorted({_d(r.get('date')) for r in rows if r.get('date')})


def load_names(path):
    """stock_names.json → {代號: 股名};同一個股名對到兩檔 → 那個名字不用(⛔ 猜)"""
    j = json.loads(Path(path).read_text('utf-8'))
    nm = j.get('names') if isinstance(j, dict) and isinstance(j.get('names'), dict) else j
    out, seen = {}, defaultdict(list)
    for s, v in (nm or {}).items():
        n = (v[0] if isinstance(v, list) else v) if v else ''
        n = str(n or '').strip()
        if re.fullmatch(r'\d{4,6}[A-Z]?', str(s)) and len(n) >= 2:
            out[str(s)] = n
            seen[n].append(str(s))
    dup = {n for n, ss in seen.items() if len(ss) > 1}
    return {s: n for s, n in out.items() if n not in dup}, len(dup)


class Matcher:
    """標題 → 講到哪幾檔。股名先用兩字前綴縮小候選,最後一律交給 universal_radar._title_hits(誤配守門只有那一份)"""

    def __init__(self, names):
        import universal_radar as ur
        self.ur = ur
        self.sym_of = {n: s for s, n in names.items()}
        self.codes = set(names)
        self.pre = defaultdict(list)
        for n in self.sym_of:
            self.pre[n[:2]].append(n)

    def __call__(self, title):
        t = str(title or '')
        hit = set()
        for m in _BR_CODE.finditer(t):
            if m.group(1) in self.codes:
                hit.add(m.group(1))
        cand = set()
        for i in range(len(t) - 1):
            for n in self.pre.get(t[i:i + 2], ()):
                if t.startswith(n, i):
                    cand.add(n)
        if cand:
            for n in self.ur._title_hits(t, sorted(cand, key=len, reverse=True)):
                hit.add(self.sym_of[n])
        return hit


def attribute(ts, cal):
    """發布時間(epoch 秒)→ (交易日索引 or None, 盤外?)。13:30 以後 / 非交易日 → 下一個交易日。"""
    dt = datetime.fromtimestamp(int(ts), TW)
    day, hm = dt.strftime('%Y-%m-%d'), dt.hour * 60 + dt.minute
    i = bisect.bisect_left(cal, day)
    same = i < len(cal) and cal[i] == day
    if same and hm < CLOSE_MIN:
        return i, not (hm >= OPEN_MIN)
    j = i + 1 if same else i
    return (j if j < len(cal) else None), True


def week_monday(ds):
    d = date.fromisoformat(ds)
    return (d - timedelta(days=d.weekday())).isoformat()


def known_days(cal, weeks_ok, months_bad, first_day, last_day):
    """第 t 天「知道」= 歸到它的那段(前一個交易日 13:30 ~ 當天 13:30)每一個日曆天都有做完的週、讀得出來的月份、在範圍內"""
    def covered(ds):
        return (first_day <= ds <= last_day and weeks_ok.get(week_monday(ds)) is True
                and ds[:7] not in months_bad)
    out = [0] * len(cal)
    for t in range(1, len(cal)):
        d0, d1 = date.fromisoformat(cal[t - 1]), date.fromisoformat(cal[t])
        ok, d = True, d0
        while d <= d1:
            if not covered(d.isoformat()):
                ok = False
                break
            d += timedelta(days=1)
        out[t] = 1 if ok else 0
    return out


def build(news_dir, cal, names, verbose=True):
    news_dir = Path(news_dir)
    st = {}
    sp = news_dir / '_status.json'
    if sp.exists():
        try:
            st = json.loads(sp.read_text('utf-8'))
        except Exception:
            st = {}
    weeks = st.get('weeks') or {}
    weeks_ok = {w: bool(v.get('ok')) for w, v in weeks.items() if isinstance(v, dict)}
    months_bad, items_all = set(), []
    for p in sorted(news_dir.glob('*.json.gz')):
        m = p.name[:7]
        try:
            doc = json.loads(gzip.decompress(p.read_bytes()).decode('utf-8'))
            items_all.extend(doc.get('items') or [])
        except Exception:
            months_bad.add(m)
    done = sorted(w for w, ok in weeks_ok.items() if ok)
    if not done:
        return {'meta': {'err': '沒有做完的週', 'cal': cal, 'known': [0] * len(cal), 'months_bad': sorted(months_bad)}, 'cnt': {}}
    first_day = done[0]
    last_day = (date.fromisoformat(done[-1]) + timedelta(days=6)).isoformat()
    known = known_days(cal, weeks_ok, months_bad, first_day, last_day)
    match = Matcher(names)
    per = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    seen_id, seen_title = set(), set()
    by_year = defaultdict(lambda: [0, 0, 0])
    n_items = n_match = n_out = 0
    for r in items_all:
        try:
            nid, ts, title, tagged = int(r[0]), int(r[1]), str(r[2] or ''), r[3] or []
        except (TypeError, ValueError, IndexError):
            continue
        if nid in seen_id:
            continue
        seen_id.add(nid)
        n_items += 1
        y = datetime.fromtimestamp(ts, TW).strftime('%Y')
        by_year[y][0] += 1
        if tagged:
            by_year[y][2] += 1
        t, off = attribute(ts, cal)
        if t is None or not known[t]:
            n_out += 1
            continue
        hit = match(title)
        if not hit:
            continue
        n_match += 1
        by_year[y][1] += 1
        key_t = re.sub(r'\s+', '', title)
        for s in hit:
            k = (s, t, key_t)
            if k in seen_title:
                continue
            seen_title.add(k)
            c = per[s][t]
            c[0] += 1
            c[1] += 1 if off else 0
    cnt = {s: [[t, v[0], v[1]] for t, v in sorted(d.items())] for s, d in sorted(per.items())}
    meta = {'cal': cal, 'known': known, 'from': first_day, 'to': last_day, 'items': n_items, 'matched': n_match,
            'outside': n_out, 'syms': len(cnt), 'names': len(names), 'name_syms': sorted(names), 'months_bad': sorted(months_bad),
            'weeks_done': len(done), 'weeks_not_ok': sum(1 for v in weeks_ok.values() if not v),
            'by_year': {y: v for y, v in sorted(by_year.items())},
            'rule': '標題講到(括號代號或股名,誤配守門 = universal_radar._title_hits);13:30 以後 / 非交易日歸下一個交易日'}
    if verbose:
        print(f'📰 {n_items:,} 則 ・標題對到股票 {n_match:,} 則 ・範圍外 / 不知道的日子 {n_out:,} 則 ・{len(cnt):,} 檔')
        print(f'   範圍 {first_day} ~ {last_day} ・做完 {len(done)} 週 ・沒做完 {meta["weeks_not_ok"]} 週 ・知道的交易日 {sum(known):,}'
              + (f' ・⚠️ 讀不出來的月份 {sorted(months_bad)}' if months_bad else ''))
        for y, v in sorted(by_year.items()):
            print(f'   {y}:{v[0]:,} 則 ・對到 {v[1]:,}({v[1] / max(1, v[0]) * 100:.0f}%)・有標代號 {v[2]:,}({v[2] / max(1, v[0]) * 100:.0f}%)')
    return {'meta': meta, 'cnt': cnt}


def main():
    news = os.getenv('NEWS_DIR') or 'news_deep'
    data = os.getenv('DATA_DIR') or 'data'
    names_p = os.getenv('NAMES') or str(ROOT / 'data' / 'stock_names.json')
    out = os.getenv('OUT') or 'news_cnt.json'
    cal = load_cal(data)
    names, ndup = load_names(names_p)
    print(f'📅 交易日 {len(cal):,}({cal[0]} ~ {cal[-1]})・股名 {len(names):,} 個(同名對到兩檔、不用的 {ndup} 個)')
    res = build(news, cal, names)
    if not res['cnt']:
        print(f'❌ 沒有可用的新聞:{res["meta"].get("err") or "一則都沒對到"}')
        sys.exit(1)
    Path(out).write_text(json.dumps(res, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    print(f'💾 {out}')


def selftest():
    import tempfile
    fails = []

    def ok(name, cond, extra=''):
        print(('  ✅ ' if cond else '  ❌ ') + name + (f'  {extra}' if extra else ''))
        if not cond:
            fails.append(name)

    cal = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03',
           '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09']

    def ep(ds, hm):
        h, m = hm
        return int(datetime(*map(int, ds.split('-')), h, m, tzinfo=TW).timestamp())

    print('① 歸日:13:30 以前歸當天、13:30 以後 / 週末歸下一個交易日')
    ok('週五 10:00 → 週五、盤中', attribute(ep('2026-10-30', (10, 0)), cal) == (4, False))
    ok('週五 08:30 → 週五、盤外(開盤前)', attribute(ep('2026-10-30', (8, 30)), cal) == (4, True))
    ok('週五 13:29 → 週五', attribute(ep('2026-10-30', (13, 29)), cal)[0] == 4)
    ok('週五 13:30 → 下週一(⛔ 收盤那一刻已經買不到)', attribute(ep('2026-10-30', (13, 30)), cal) == (5, True))
    ok('週六 → 週一', attribute(ep('2026-10-31', (11, 0)), cal) == (5, True))
    ok('最後一天 14:00 → 沒有下一個交易日 = None', attribute(ep('2026-11-09', (14, 0)), cal)[0] is None)
    ok('日曆之前 → 第 0 天(之後由 known 擋)', attribute(ep('2026-10-20', (10, 0)), cal)[0] == 0)

    print('② 標題比對:括號代號 / 股名(誤配守門那一份)/ ⛔ 年份不是代號')
    names = {'2330': '台積電', '2408': '南亞科', '1303': '南亞', '2025': '千興', '5007': '三星', '2412': '中華電'}
    try:
        mt = Matcher(names)
    except Exception as e:
        ok('universal_radar 載得進來', False, repr(e))
        mt = None
    if mt:
        ok('股名', mt('台積電法說會釋利多') == {'2330'})
        ok('括號代號', mt('〈熱門股〉(2330)今天上漲') == {'2330'})
        ok('⛔ 2025 年不是千興', mt('2025 年營收創新高') == set())
        ok('南亞科 ⛔ 同時算成南亞(去子字串)', mt('南亞科 DRAM 報價走揚') == {'2408'})
        ok('東南亞 ⛔ 算成南亞(誤配詞先蓋掉)', mt('東南亞市場需求回溫') == set())
        ok('三星沒有證據 ⛔ 算(Samsung)', mt('三星 HBM 進度落後') == set())
        ok('三星科(5007)有證據才算', mt('三星科 5007 接單滿') == {'5007'})
        ok('一則兩檔', mt('台積電與中華電合作 AI') == {'2330', '2412'})

    print('③④ 不知道 ≠ 0、同一則 / 同標題只算一次、範圍外不收')
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        weeks = {'2026-10-26': {'ok': 1}, '2026-11-02': {'ok': 0}, '2026-11-09': {'ok': 1}}
        (td / '_status.json').write_text(json.dumps({'weeks': weeks}), 'utf-8')
        items = [
            [1, ep('2026-10-27', (10, 0)), '台積電法說會', [], [], '', '', ''],
            [1, ep('2026-10-27', (10, 0)), '台積電法說會', [], [], '', '', ''],          # 同一則 id
            [2, ep('2026-10-27', (11, 0)), '台積電法說會', [], [], '', '', ''],          # 同一天同一檔同標題(轉載)
            [3, ep('2026-10-27', (12, 0)), '台積電 3 奈米擴產', ['2330'], [], '', '', ''],
            [4, ep('2026-10-30', (15, 0)), '中華電 週末公告', [], [], '', '', ''],      # 週五盤後 → 週一(那週沒做完)
            [5, ep('2026-11-04', (10, 0)), '台積電 新聞', [], [], '', '', ''],           # 沒做完的週
            [6, ep('2026-10-28', (9, 30)), '沒有股票的標題', [], [], '', '', ''],
            [8, ep('2026-10-28', (10, 0)), '晶圓代工產能滿載', ['2330'], [], '', '', ''],   # 只有標代號、標題沒講 → ⛔ 算
        ]
        with gzip.open(td / '2026-10.json.gz', 'wt', encoding='utf-8') as f:
            json.dump({'m': '2026-10', 'v': 1, 'items': items[:5] + items[6:]}, f)
        with gzip.open(td / '2026-11.json.gz', 'wt', encoding='utf-8') as f:
            json.dump({'m': '2026-11', 'v': 1, 'items': [items[5]]}, f)
        res = build(td, cal, names, verbose=False) if mt else {'meta': {}, 'cnt': {}}
        c = {s: {t: (n, o) for t, n, o in v} for s, v in res['cnt'].items()}
        k = res['meta'].get('known', [])
        ok('10/27 台積電 = 2 則(同 id 一次、轉載一次 + 另一則)', c.get('2330', {}).get(1) == (2, 0), str(c.get('2330')))
        ok('只有「標了代號」、標題沒講到 ⛔ 算(2015~2020 沒標代號 → 同一把尺)', 2 not in c.get('2330', {}), str(c.get('2330')))
        ok('第 0 天沒有前一天可以看 → 不知道', k[:1] == [0])
        ok('10/27~10/30 知道', k[1:5] == [1, 1, 1, 1], str(k))
        ok('週一 11/02 不知道(歸到它的那段跨到沒做完的週)', k[5] == 0, str(k))
        ok('沒做完那週的新聞 ⛔ 收', 7 not in c.get('2330', {}) and 5 not in c.get('2412', {}), str(c))
        ok('11/09 那週做完了 → 知道(但 11/06 → 11/09 那段跨到沒做完的週 → 11/09 也不知道)', k[10] == 0 and k[9] == 0, str(k))
        # 決定性對照:把沒做完那週改成做完 → 中華電那則就會出現在 11/02
        weeks['2026-11-02'] = {'ok': 1}
        (td / '_status.json').write_text(json.dumps({'weeks': weeks}), 'utf-8')
        res2 = build(td, cal, names, verbose=False) if mt else {'meta': {}, 'cnt': {}}
        c2 = {s: {t: (n, o) for t, n, o in v} for s, v in res2['cnt'].items()}
        ok('決定性對照:那週做完 → 週五盤後的中華電歸到週一、盤外 1 則', c2.get('2412', {}).get(5) == (1, 1), str(c2.get('2412')))
        # 讀不出來的月份 → 那個月不知道、⛔ 當成 0
        (td / '2026-10.json.gz').write_bytes(b'not gzip')
        res3 = build(td, cal, names, verbose=False) if mt else {'meta': {}, 'cnt': {}}
        ok('壞掉的月份 → 那幾天不知道', res3['meta'].get('months_bad') == ['2026-10'] and sum(res3['meta']['known'][1:5]) == 0,
           str(res3['meta'].get('months_bad')))
        ok('輸出帶「股名對得到的代號」(factor_panel 用它分 0 跟 NaN)', res2['meta'].get('name_syms') == sorted(names))
    print(f'\n{"❌ " + str(len(fails)) + " 條沒過:" + ", ".join(fails) if fails else "✅ news_factor selftest 全過"}')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
