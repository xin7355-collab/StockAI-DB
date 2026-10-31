#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📚 鉅亨「台股新聞」歷史回補 + 每天續挖(V80.1.3,新聞多因子回測的資料底)

使用者 10/31:「消息面的新聞目前抓法沒有很完整,是否要補齊…補齊後再做多因子回測,這樣比較準」。
news_src_probe(Actions 實測 2026-10-31,mode=hist / fields):
  ・鉅亨分類新聞 category/tw_stock + startAt/endAt:2015 起每週都有(350~900 則;2012 那週 0),一頁最多 30 則
    (limit=100 也只給 30)
  ・2021 / 2024 那頁 30 則有 23 則帶台股代號(market[].code / stock[]);2015 那頁 0/30(只有 keyword + 標題)
    → 研究時要再用股名比對補(⛔ 這支不做,只存原始欄位)
  ・個股頁(symbolNews)只回得到約 2 個月;Google 新聞越舊越少(小型股 2019 / 2021 是 0)→ ⛔ 不拿來回補

存法:獨立 orphan 分支 news_deep(⛔ 不進 data / gh-pages,陷阱 #41;只增不減):
  news_deep/{YYYY-MM}.json.gz = {'m', 'v': 1, 'items': [[id, 時間(epoch 秒), 標題, [代號], [關鍵字], 子分類, 來源, 摘要前 120 字]]}
                                 (照時間排;月份照台北時間)
  news_deep/_status.json      = {'weeks': {週一日期: {'n', 'tot', 'ok', 'fin', 'split', 'at'}}, 'earliest_empty', 'cover', 'last_run'}
⭐ 一週(台北週一 00:00 ~ 下週一 00:00)拿到的則數 ≥ API 說的總數 97% 才算做完;不夠就拆成每天再問一次;
   還不夠記 ok=0(⛔ 不擋,下一輪再試)。結束還不到 3 天的週 ⛔ 不算定案(新聞可能還在補)→ 每一輪都重問。

守門:
  ① 429 / 5xx / 連不上 / 讀不出 JSON → 退避 5、15、45 秒;連 4 次都失敗就收工(保留已抓的,⛔ 不硬打)
  ② 往回補時連 8 週總數 0 → 判定「歷史到這裡為止」,記 earliest_empty、之後不再往前
  ③ 只收在那個窗口裡的(⛔ 不信任頁面多給的)、同一則(id)只收一次
  ④ 已經存在的月份檔讀不出來 → ⛔ 不覆蓋(整輪不推、exit 1)
  ⑤ 覆蓋率:最近 4 週做完後,問 3 檔的個股頁(symbolNews)→ 有幾成在分類新聞裡找得到、找不到的是哪些子分類
     (只量,⛔ 不擋;記進 _status.cover,一天一次)
  ⑥ 空過守門:這一輪一週都沒做完而且不是時間到 → exit 1

跑法:FROM=2013-01 MAX_MIN=330 OUT_DIR=news_deep python3 scripts/news_deep.py
      python3 scripts/news_deep.py --selftest
⛔ 只存,不判斷利多利空、不叫 AI、不用任何金鑰。
"""
import gzip
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

TW = timezone(timedelta(hours=8))
API = 'https://api.cnyes.com/media/api/v1/newslist/category/tw_stock'
SYM_API = 'https://api.cnyes.com/media/api/v1/newslist/TWS:{sym}:STOCK/symbolNews?limit=30&page={pg}'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'zh-TW,zh;q=0.9', 'Referer': 'https://news.cnyes.com/'}
PAGE = 30
COMPLETE = 0.97
FINAL_DAYS = 3
EMPTY_STOP = 8
SHORT_TRIES = 3          # 一週拿不到 97% 最多重試幾輪;之後標 fin(ok 0 留著當記號),⛔ 每天一直重問
FAIL_MAX = 4
BACKOFF = (5, 15, 45)
COVER_SYMS = ('2330', '2317', '1815')
SUM_N = 120
_CODE_RE = re.compile(r'\d{4,6}[A-Z]?')


def codes(item):
    """鉅亨一則新聞標了哪些台股代號(market[].code / market[].symbol 'TWS:2330:STOCK' / stock[])→ 排好的 list;沒有 → []
    ⛔ 海外代號(USS:AAPL)不收。"""
    out = set()
    if not isinstance(item, dict):
        return []
    for m in item.get('market') or []:
        if isinstance(m, dict):
            c = str(m.get('code') or '')
            sym = str(m.get('symbol') or '')
            if sym.startswith('TWS:') or sym.startswith('TWG:'):
                c = sym.split(':')[1]
            elif sym and ':' in sym:
                continue
            if _CODE_RE.fullmatch(c):
                out.add(c)
        elif isinstance(m, str) and _CODE_RE.fullmatch(m):
            out.add(m)
    for c in item.get('stock') or []:
        c = str(c.get('code') if isinstance(c, dict) else c)
        if _CODE_RE.fullmatch(c):
            out.add(c)
    return sorted(out)


def compact(x):
    """一則 → [id, 時間, 標題, [代號], [關鍵字], 子分類, 來源, 摘要前 120 字](⛔ 不存全文 content)"""
    return [int(x.get('newsId') or 0), int(x.get('publishAt') or 0), str(x.get('title') or '')[:200], codes(x),
            [str(k)[:20] for k in (x.get('keyword') or []) if k][:10], str(x.get('categoryName') or ''),
            str(x.get('source') or ''), re.sub(r'\s+', ' ', str(x.get('summary') or ''))[:SUM_N]]


def parse(j):
    """鉅亨 API 回應(已 json.loads)→ (items, meta dict);讀不出 → ([], {})"""
    if not isinstance(j, dict):
        return [], {}
    d = j.get('items') if isinstance(j.get('items'), dict) else (j.get('data') if isinstance(j.get('data'), dict) else j)
    d = d if isinstance(d, dict) else {}
    items = d.get('data') if isinstance(d.get('data'), list) else []
    return [x for x in items if isinstance(x, dict)], d


def week_start(d):
    return d - timedelta(days=d.weekday())


def win_epoch(d0, days):
    a = int(datetime(d0.year, d0.month, d0.day, tzinfo=TW).timestamp())
    return a, a + days * 86400


def tpe_month(ts):
    return datetime.fromtimestamp(ts, TW).strftime('%Y-%m')


class Blocked(Exception):
    pass


class Net:
    """抓 JSON(含退避);連 FAIL_MAX 次都失敗 → Blocked。fetch(url) → (HTTP 狀態, 文字)。"""

    def __init__(self, fetch, sleep):
        self.fetch, self.sleep, self.reqs, self.fails = fetch, sleep, 0, 0

    def get(self, url):
        for att in range(FAIL_MAX):
            self.reqs += 1
            try:
                code, txt = self.fetch(url)
                if code == 200:
                    j = json.loads(txt)
                    self.fails = 0
                    self.sleep(SLEEP)
                    return j
                why = f'HTTP {code}'
            except Exception as e:      # 連不上 / 逾時 / 讀不出 JSON
                why = f'{type(e).__name__}: {str(e)[:60]}'
            self.fails += 1
            if att < FAIL_MAX - 1:
                w = BACKOFF[min(att, len(BACKOFF) - 1)]
                print(f'   ⚠️ {why}(第 {att + 1} 次)→ 等 {w} 秒', flush=True)
                self.sleep(w)
            else:
                print(f'   ⛔ {why}:連 {FAIL_MAX} 次失敗 → 收工', flush=True)
        raise Blocked(url)


def fetch_window(net, a, b):
    """[a, b) 這段的所有頁 → ({id: 精簡一則}, API 說的總數)"""
    got, tot, last, pg = {}, None, 1, 1
    while pg <= last:
        items, d = parse(net.get(f'{API}?startAt={a}&endAt={b - 1}&limit={PAGE}&page={pg}'))
        if tot is None:
            tot = int(d.get('total') or 0)
            last = int(d.get('last_page') or 1)
        if not items:
            break
        for x in items:
            t, nid = int(x.get('publishAt') or 0), x.get('newsId')
            if nid and a <= t < b:                      # ③ 只收窗口裡的
                got[int(nid)] = compact(x)
        pg += 1
    return got, tot or 0


def do_week(net, ws):
    """一週 → (items dict, 總數, ok, 有沒有拆成每天)。拿到的不夠 97% → 拆成每天再問一次。"""
    a, b = win_epoch(ws, 7)
    got, tot = fetch_window(net, a, b)
    split = False
    if tot and len(got) < tot * COMPLETE:
        split = True
        for k in range(7):
            g2, _ = fetch_window(net, *win_epoch(ws + timedelta(days=k), 1))
            got.update(g2)
    ok = tot == 0 or len(got) >= tot * COMPLETE
    return got, tot, ok, split


class Store:
    """月份檔:讀已有的、合併新的、只寫有動到的。讀不出來的已存在月份 → 標 corrupt(⛔ 不覆蓋)。"""

    def __init__(self, out_dir):
        self.dir, self.cache, self.dirty, self.corrupt = Path(out_dir), {}, set(), []

    def month(self, m):
        if m not in self.cache:
            p = self.dir / f'{m}.json.gz'
            rows = {}
            if p.exists():
                try:
                    doc = json.loads(gzip.decompress(p.read_bytes()).decode('utf-8'))
                    rows = {int(r[0]): r for r in doc.get('items') or []}
                except Exception as e:
                    self.corrupt.append(f'{m}({type(e).__name__})')
                    rows = None
            self.cache[m] = rows
        return self.cache[m]

    def add(self, got):
        new = 0
        for nid, rec in got.items():
            mo = self.month(tpe_month(rec[1]))
            if mo is None:
                continue
            if nid not in mo:
                new += 1
            mo[nid] = rec
            self.dirty.add(tpe_month(rec[1]))
        return new

    def save(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        for m in sorted(self.dirty):
            rows = self.cache.get(m)
            if rows is None:
                continue
            doc = {'m': m, 'v': 1, 'items': sorted(rows.values(), key=lambda r: (r[1], r[0]))}
            (self.dir / f'{m}.json.gz').write_bytes(gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'), 6))
        n = len(self.dirty)
        self.dirty = set()
        return n


def cover_check(net, store, now, status):
    """⑤ 最近 4 週(都做完)的個股頁新聞,有幾成在分類新聞裡找得到;找不到的是哪些子分類。只量。"""
    wk = status.get('weeks') or {}
    ws0 = week_start(now.date())
    recent = [(ws0 - timedelta(days=7 * k)).isoformat() for k in range(1, 5)]
    if not all((wk.get(w) or {}).get('ok') for w in recent):
        return None
    a, _ = win_epoch(date.fromisoformat(recent[-1]), 7)
    _, b = win_epoch(date.fromisoformat(recent[0]), 7)
    have = set()
    for m in {tpe_month(a), tpe_month(b - 1)}:
        have |= set((store.month(m) or {}).keys())
    res = {}
    for sym in COVER_SYMS:
        tot, hit, miss = 0, 0, {}
        for pg in (1, 2, 3):
            items, d = parse(net.get(SYM_API.format(sym=sym, pg=pg)))
            for x in items:
                t = int(x.get('publishAt') or 0)
                if not (a <= t < b) or not x.get('newsId'):
                    continue
                tot += 1
                if int(x['newsId']) in have:
                    hit += 1
                else:
                    c = str(x.get('categoryName') or '?')
                    miss[c] = miss.get(c, 0) + 1
            if not items or pg >= int(d.get('last_page') or 1):
                break
        res[sym] = {'hit': hit, 'tot': tot, 'miss_cat': miss}
    return {'d': now.date().isoformat(), 'from': recent[-1], 'syms': res}


def run(out_dir, frm, max_min, now=None, fetch=None, sleep=None, clock=None):
    """回傳 (exit code, outputs dict)。fetch / sleep / clock 給測試換掉。"""
    clock = clock or time.time
    t0 = clock()
    now = now or datetime.now(TW)
    sleep = sleep or time.sleep
    if fetch is None:
        import requests
        sess = requests.Session()

        def fetch(url):
            r = sess.get(url, headers=UA, timeout=30)
            return r.status_code, r.text
    net = Net(fetch, sleep)
    out_dir = Path(out_dir)
    st_path = out_dir / '_status.json'
    status = {}
    if st_path.exists():
        try:
            status = json.loads(st_path.read_text(encoding='utf-8'))
        except Exception:
            print('❌ _status.json 讀不出來 → ⛔ 不覆蓋', flush=True)
            return 1, {'more': 0, 'reason': 'corrupt', 'push': 0}
    weeks = status.setdefault('weeks', {})
    store = Store(out_dir)
    fy, fm = int(frm[:4]), int(frm[5:7])
    oldest = week_start(date(fy, fm, 1))
    stop_at = status.get('earliest_empty')
    ws = week_start(now.date())
    reason, more, done, new_items, empty_run = 'done', 0, 0, 0, 0
    try:
        while ws >= oldest:
            key = ws.isoformat()
            if stop_at and key <= stop_at:
                print(f'⏹️ {key}:之前已判定歷史到 {stop_at} 為止 → 不再往前', flush=True)
                break
            w = weeks.get(key) or {}
            if w.get('fin'):
                empty_run = 0 if w.get('tot') else empty_run + 1          # ⛔ 已定案的空週也要算進「連幾週 0 則」
                if empty_run >= EMPTY_STOP:
                    status['earliest_empty'] = key
                    print(f'⏹️ 連 {EMPTY_STOP} 週 0 則 → 判定歷史到 {key} 為止', flush=True)
                    break
                ws -= timedelta(days=7)
                continue
            if (clock() - t0) / 60 > max_min:
                reason, more = 'time', 1
                break
            got, tot, ok, split = do_week(net, ws)
            new_items += store.add(got)
            end = datetime(ws.year, ws.month, ws.day, tzinfo=TW) + timedelta(days=7)
            old_enough = end <= now - timedelta(days=FINAL_DAYS)
            tries = (w.get('try') or 0) + (0 if ok else 1)
            fin = old_enough and (bool(ok) or tries >= SHORT_TRIES)
            weeks[key] = {'n': max(len(got), w.get('n') or 0), 'tot': tot, 'ok': 1 if ok else 0, 'fin': 1 if fin else 0,
                          'split': 1 if split else 0, 'at': now.isoformat(timespec='minutes')}
            if tries:
                weeks[key]['try'] = tries
            done += 1
            print(f'📰 {key}:{len(got):,} / {tot:,} 則{" ・拆成每天" if split else ""}{"" if ok else " ・⚠️ 不到 97%"}'
                  f'{" ・未定案" if not fin else ""}', flush=True)
            if store.corrupt:
                break
            empty_run = empty_run + 1 if tot == 0 else 0
            if empty_run >= EMPTY_STOP:
                status['earliest_empty'] = key
                print(f'⏹️ 連 {EMPTY_STOP} 週 0 則 → 判定歷史到 {key} 為止', flush=True)
                break
            if done % 20 == 0:
                store.save()
            ws -= timedelta(days=7)
        else:
            pass
    except Blocked:
        reason, more = 'blocked', 0
    if store.corrupt:
        print(f'❌ 已存在的月份檔讀不出來:{store.corrupt} → ⛔ 不覆蓋、這一輪不推', flush=True)
        return 1, {'more': 0, 'reason': 'corrupt', 'push': 0}
    store.save()
    if reason != 'blocked' and (status.get('cover') or {}).get('d') != now.date().isoformat():
        try:
            cv = cover_check(net, store, now, status)
            if cv:
                status['cover'] = cv
                for s, v in cv['syms'].items():
                    print(f'   🔎 覆蓋率 {s}:個股頁 {v["tot"]} 則裡 {v["hit"]} 則在分類新聞裡 ・找不到的子分類 {v["miss_cat"]}', flush=True)
        except Blocked:
            reason, more = 'blocked', 0
    todo_left = 0
    ws = week_start(now.date())
    while ws >= oldest:
        key = ws.isoformat()
        if status.get('earliest_empty') and key <= status['earliest_empty']:
            break
        if not (weeks.get(key) or {}).get('fin'):
            todo_left += 1
        ws -= timedelta(days=7)
    # 未定案的只有最近那幾週 → 不算「還有事要接力」
    backlog = max(0, todo_left - 2)
    if reason == 'time' and backlog == 0:
        more = 0
    status.update({'updated': now.isoformat(timespec='minutes'),
                   'months': sorted(p.name[:7] for p in out_dir.glob('*.json.gz')) if out_dir.exists() else [],
                   'last_run': {'reason': reason, 'reqs': net.reqs, 'weeks_done': done, 'new_items': new_items,
                                'backlog_weeks': backlog}})
    out_dir.mkdir(parents=True, exist_ok=True)
    st_path.write_text(json.dumps(status, ensure_ascii=False, indent=0), encoding='utf-8')
    rc = 0
    if done == 0 and reason != 'time':
        print('❌ 這一輪一週都沒做完(空過守門)', flush=True)
        rc = 1
    push = 1 if done > 0 else 0
    print(f'🏁 {reason} ・請求 {net.reqs} 次 ・做了 {done} 週 ・新增 {new_items:,} 則 ・還沒定案 {backlog} 週'
          f' ・{round((clock() - t0) / 60, 1)} 分', flush=True)
    return rc, {'more': more if backlog else 0, 'reason': reason, 'push': push}


def main():
    rc, out = run(os.environ.get('OUT_DIR') or 'news_deep', (os.environ.get('FROM') or '2013-01').strip(),
                  float(os.environ.get('MAX_MIN') or '330'))
    gh = os.environ.get('GITHUB_OUTPUT')
    if gh:
        with open(gh, 'a') as f:
            f.write(''.join(f'{k}={v}\n' for k, v in out.items()))
    return rc


SLEEP = float(os.environ.get('ND_SLEEP') or '1.0')


# ─────────────────────────────── selftest ───────────────────────────────
class _FakeApi:
    """假的鉅亨:items = [{newsId, publishAt, title, ...}];可設「大窗口只給一部分」「某些網址先失敗 N 次」「多塞窗口外的」"""

    def __init__(self, items, trunc_week=None, trunc_all=None, fail=None, extra_out=False, sym_items=None):
        self.items, self.trunc_week, self.trunc_all = items, trunc_week, trunc_all
        self.fail, self.extra_out, self.calls, self.sym_items = dict(fail or {}), extra_out, [], sym_items or {}

    def __call__(self, url):
        import urllib.parse as up
        self.calls.append(url)
        for k in list(self.fail):
            if k in url and self.fail[k] > 0:
                self.fail[k] -= 1
                return 429, ''
        q = dict(up.parse_qsl(up.urlparse(url).query))
        pg = int(q.get('page') or 1)
        if 'symbolNews' in url:
            sym = url.split('TWS:')[1].split(':')[0]
            rows = self.sym_items.get(sym, [])
            page = rows[(pg - 1) * 30: pg * 30]
            return 200, json.dumps({'items': {'data': page, 'total': len(rows), 'last_page': max(1, -(-len(rows) // 30))}})
        a, b = int(q['startAt']), int(q['endAt'])
        rows = sorted([x for x in self.items if a <= x['publishAt'] <= b], key=lambda x: -x['publishAt'])
        tot = len(rows)
        if self.trunc_all and tot:                         # 不管怎麼切都只給 80%
            rows = rows[: int(tot * 0.8)]
        elif self.trunc_week and (b - a) > 2 * 86400:      # 大窗口只給一半(切成每天就完整)
            rows = rows[: tot // 2]
        page = rows[(pg - 1) * 30: pg * 30]
        if self.extra_out and pg == 1:
            page = page + [{'newsId': 999999, 'publishAt': b + 3600, 'title': '窗口外'}]
        return 200, json.dumps({'items': {'data': page, 'total': tot, 'last_page': max(1, -(-tot // 30))}})


def _mk_items(start, weeks, per_day=13, start_hist=None):
    """從 start(週一)開始往後 weeks 週,每天 per_day 則;start_hist 之前沒有新聞"""
    out, nid = [], 1000
    for k in range(weeks * 7):
        d = start + timedelta(days=k)
        if start_hist and d < start_hist:
            continue
        a, _ = win_epoch(d, 1)
        for j in range(per_day):
            nid += 1
            out.append({'newsId': nid, 'publishAt': a + 3600 + j * 600, 'title': f'測試{nid}', 'categoryName': '台股新聞',
                        'market': [{'code': '2330', 'symbol': 'TWS:2330:STOCK'}] if j % 3 == 0 else [],
                        'stock': ['3231'] if j % 5 == 0 else [], 'keyword': ['台積電'], 'summary': '摘要 ' * 50,
                        'content': '全文' * 500, 'source': '鉅亨網'})
    return out


def selftest():
    import tempfile
    bad = []

    def ok(name, cond):
        print(('✅ ' if cond else '❌ ') + name)
        if not cond:
            bad.append(name)

    global SLEEP
    SLEEP = 0
    nosleep = lambda s: None
    # ① codes:market[].code / symbol / stock[];海外代號 / 空的不收
    ok('① codes 收 market / symbol / stock,⛔ 海外代號',
       codes({'market': [{'code': '2330', 'symbol': 'TWS:2330:STOCK'}, {'code': 'AAPL', 'symbol': 'USS:AAPL:STOCK'},
                         {'code': '1234', 'symbol': 'USS:1234:STOCK'}], 'stock': ['3231', {'code': '6213'}, '']})
       == ['2330', '3231', '6213'] and codes({'market': [{'symbol': 'TWG:8299:STOCK'}]}) == ['8299'] and codes('x') == [])
    r = compact({'newsId': 5, 'publishAt': 9, 'title': 't', 'summary': 'a  b\nc' + 'x' * 300, 'content': '全文',
                 'keyword': ['k'] * 20, 'categoryName': '台股新聞', 'source': '鉅亨網'})
    ok('① compact 摘要壓空白 + 截 120 字、關鍵字最多 10 個、⛔ 不存全文', r[0] == 5 and r[7].startswith('a b c') and len(r[7]) == 120
       and len(r[4]) == 10 and '全文' not in json.dumps(r, ensure_ascii=False))

    now = datetime(2026, 10, 31, 12, 0, tzinfo=TW)          # 週六
    ws_now = week_start(now.date())                          # 2026-10-26
    start = ws_now - timedelta(days=7 * 19)                  # 20 週
    hist = ws_now - timedelta(days=7 * 9)                    # 10 週前開始才有新聞
    items = _mk_items(start, 20, start_hist=hist)
    with tempfile.TemporaryDirectory() as td:
        api = _FakeApi(items)
        rc, out = run(td, f'{start:%Y-%m}', 999, now=now, fetch=api, sleep=nosleep)
        st = json.loads((Path(td) / '_status.json').read_text())
        allm = {}
        for p in Path(td).glob('*.json.gz'):
            doc = json.loads(gzip.decompress(p.read_bytes()))
            for row in doc['items']:
                allm[row[0]] = (p.name[:7], row)
        ok('② 往回補:每一則都存到了(沒有重複)', set(allm) == {x['newsId'] for x in items})
        ok('② 月份照台北時間分', all(m == tpe_month(row[1]) for m, row in allm.values()))
        ok('② 每個月份檔照時間排', all(
            [r[1] for r in json.loads(gzip.decompress(p.read_bytes()))['items']] ==
            sorted(r[1] for r in json.loads(gzip.decompress(p.read_bytes()))['items']) for p in Path(td).glob('*.json.gz')))
        ok('② 連 8 週 0 則 → 判定歷史到那裡為止(⛔ 再往前)',
           st.get('earliest_empty') == (hist - timedelta(days=7 * 8)).isoformat())
        ok('② 這一週(還沒過完)⛔ 定案、上一週(已結束 5 天多)定案',
           st['weeks'][ws_now.isoformat()]['fin'] == 0 and st['weeks'][(ws_now - timedelta(days=7)).isoformat()]['fin'] == 1)
        ok('② rc 0 / push 1 / 沒有積壓 → more 0', rc == 0 and out['push'] == 1 and out['more'] == 0)
        # ③ 第二輪:只重問沒定案的(這一週、上一週)、⛔ 重複
        n1 = len(api.calls)
        rc2, out2 = run(td, f'{start:%Y-%m}', 999, now=now, fetch=api, sleep=nosleep)
        win_calls = [u for u in api.calls[n1:] if 'category' in u]
        asked = {datetime.fromtimestamp(int(u.split('startAt=')[1].split('&')[0]), TW).date() for u in win_calls}
        ok('③ 第二輪只重問沒定案的那一週(這一週)', asked == {ws_now})
        cnt = sum(len(json.loads(gzip.decompress(p.read_bytes()))['items']) for p in Path(td).glob('*.json.gz'))
        ok('③ 第二輪 ⛔ 重複、則數不變', cnt == len(items) and json.loads((Path(td) / '_status.json').read_text())['last_run']['new_items'] == 0)
        # ④ 已存在的月份檔壞掉 → ⛔ 覆蓋、rc 1、push 0
        p = sorted(Path(td).glob('*.json.gz'))[-1]
        raw = p.read_bytes()
        p.write_bytes(b'\x1f\x8b broken')
        rc4, out4 = run(td, f'{start:%Y-%m}', 999, now=now, fetch=_FakeApi(items), sleep=nosleep)
        ok('④ 月份檔讀不出來 → ⛔ 覆蓋、這一輪不推', rc4 == 1 and out4['push'] == 0 and p.read_bytes() == b'\x1f\x8b broken')
        p.write_bytes(raw)
    # ②b 週二看:上一週才結束 1 天多 → ⛔ 定案
    with tempfile.TemporaryDirectory() as td:
        tue = datetime(2026, 10, 27, 12, 0, tzinfo=TW)
        run(td, f'{hist:%Y-%m}', 999, now=tue, fetch=_FakeApi(items), sleep=nosleep)
        st = json.loads((Path(td) / '_status.json').read_text())
        ok('②b 週二看:上一週(結束 < 3 天)⛔ 定案、兩週前定案',
           st['weeks'][(ws_now - timedelta(days=7)).isoformat()]['fin'] == 0 and st['weeks'][(ws_now - timedelta(days=14)).isoformat()]['fin'] == 1)
    # ⑤ 大窗口只給一半 → 拆成每天補齊;⭐ 決定性對照:拿掉「拆成每天」→ 會少
    with tempfile.TemporaryDirectory() as td:
        rc, out = run(td, f'{hist:%Y-%m}', 999, now=now, fetch=_FakeApi(items, trunc_week=True), sleep=nosleep)
        n = sum(len(json.loads(gzip.decompress(p.read_bytes()))['items']) for p in Path(td).glob('*.json.gz'))
        st = json.loads((Path(td) / '_status.json').read_text())
        ok('⑤ 一週只給一半 → 拆成每天補齊、標 split、ok', n == len([x for x in items if x['publishAt'] >= win_epoch(hist, 1)[0]])
           and st['weeks'][hist.isoformat()]['split'] == 1 and st['weeks'][hist.isoformat()]['ok'] == 1)
    global COMPLETE
    keep = COMPLETE
    COMPLETE = 0.0                                          # 決定性對照:不檢查完整度 → 不會拆
    with tempfile.TemporaryDirectory() as td:
        run(td, f'{hist:%Y-%m}', 999, now=now, fetch=_FakeApi(items, trunc_week=True), sleep=nosleep)
        n0 = sum(len(json.loads(gzip.decompress(p.read_bytes()))['items']) for p in Path(td).glob('*.json.gz'))
        ok('⑤ 決定性對照:不檢查完整度 → 少一半', n0 < len(items) * 0.6)
    COMPLETE = keep
    # ⑥ 怎麼切都只給 80% → ok=0、⛔ 定案(下一輪再試)
    with tempfile.TemporaryDirectory() as td:
        run(td, f'{hist:%Y-%m}', 999, now=now, fetch=_FakeApi(items, trunc_all=True), sleep=nosleep)
        st = json.loads((Path(td) / '_status.json').read_text())
        w = st['weeks'][(hist + timedelta(days=7)).isoformat()]
        ok('⑥ 拿不到 97% → ok 0、fin 0(⛔ 擋,下一輪再試)', w['ok'] == 0 and w['fin'] == 0 and w['n'] < w['tot'] and w['try'] == 1)
        for _ in range(SHORT_TRIES - 1):
            run(td, f'{hist:%Y-%m}', 999, now=now, fetch=_FakeApi(items, trunc_all=True), sleep=nosleep)
        w = json.loads((Path(td) / '_status.json').read_text())['weeks'][(hist + timedelta(days=7)).isoformat()]
        ok(f'⑥ 試滿 {SHORT_TRIES} 輪還是拿不到 → 標 fin(ok 0 留著當記號,⛔ 每天一直重問)', w['ok'] == 0 and w['fin'] == 1 and w['try'] == SHORT_TRIES)
    # ⑦ 窗口外的 ⛔ 收
    with tempfile.TemporaryDirectory() as td:
        run(td, f'{hist:%Y-%m}', 999, now=now, fetch=_FakeApi(items, extra_out=True), sleep=nosleep)
        ids = set()
        for p in Path(td).glob('*.json.gz'):
            ids |= {r[0] for r in json.loads(gzip.decompress(p.read_bytes()))['items']}
        ok('⑦ 窗口外多塞的那則 ⛔ 收', 999999 not in ids and len(ids) > 0)
    # ⑧ 429 兩次再好 → 照常;連 4 次 → blocked、已做完的照存、more 0
    with tempfile.TemporaryDirectory() as td:
        waits = []
        api = _FakeApi(items, fail={'page=1': 2})
        rc, out = run(td, f'{hist:%Y-%m}', 999, now=now, fetch=api, sleep=waits.append)
        ok('⑧ 被限流兩次 → 退避 5、15 秒後照常', waits[:2] == [5, 15] and out['reason'] == 'done' and rc == 0)
    with tempfile.TemporaryDirectory() as td:
        api = _FakeApi(items, fail={f'startAt={win_epoch(ws_now - timedelta(days=21), 7)[0]}': 99})
        rc, out = run(td, f'{hist:%Y-%m}', 999, now=now, fetch=api, sleep=nosleep)
        st = json.loads((Path(td) / '_status.json').read_text())
        ok('⑧ 連 4 次失敗 → blocked、more 0、前面做完的照存',
           out['reason'] == 'blocked' and out['more'] == 0 and st['weeks'][(ws_now - timedelta(days=14)).isoformat()]['n'] > 0
           and (ws_now - timedelta(days=21)).isoformat() not in st['weeks'])
    # ⑨ 時間到 → reason time、more 1(還有積壓)
    with tempfile.TemporaryDirectory() as td:
        tick = iter(range(0, 10 ** 6, 40))                     # 每叫一次 clock 過 40 秒
        rc, out = run(td, f'{hist:%Y-%m}', 1.5, now=now, fetch=_FakeApi(items), sleep=nosleep, clock=lambda: next(tick))
        ok('⑨ 時間到 → time、more 1、rc 0', out['reason'] == 'time' and out['more'] == 1 and rc == 0)
    # ⑩ 覆蓋率:個股頁 10 則有 7 則在分類新聞裡 → hit 7 / tot 10、找不到的子分類記下來
    with tempfile.TemporaryDirectory() as td:
        recent = [x for x in items if x['publishAt'] >= win_epoch(ws_now - timedelta(days=28), 1)[0]
                  and x['publishAt'] < win_epoch(ws_now, 1)[0]][:7]
        a0 = win_epoch(ws_now - timedelta(days=10), 1)[0]
        extra = [{'newsId': 500000 + k, 'publishAt': a0 + k, 'categoryName': '國際股'} for k in range(3)]
        api = _FakeApi(items, sym_items={'2330': recent + extra})
        run(td, f'{hist:%Y-%m}', 999, now=now, fetch=api, sleep=nosleep)
        cv = json.loads((Path(td) / '_status.json').read_text()).get('cover') or {}
        v = (cv.get('syms') or {}).get('2330') or {}
        ok('⑩ 覆蓋率 hit 7 / tot 10、找不到的子分類「國際股」3', v.get('hit') == 7 and v.get('tot') == 10
           and v.get('miss_cat') == {'國際股': 3})
    # ⑨b 時間到停在空週中間 → 下一輪接著數(⛔ 從 0 重數 → 多問好幾週)
    with tempfile.TemporaryDirectory() as td:
        st0 = {'weeks': {}}
        for k in range(5):                                     # 歷史開始前 5 週已經問過、都是 0 則
            st0['weeks'][(hist - timedelta(days=7 * (k + 1))).isoformat()] = {'n': 0, 'tot': 0, 'ok': 1, 'fin': 1}
        for k in range(10):                                    # 有新聞的 10 週也已經做完
            st0['weeks'][(hist + timedelta(days=7 * k)).isoformat()] = {'n': 1, 'tot': 1, 'ok': 1, 'fin': 1}
        (Path(td) / '_status.json').write_text(json.dumps(st0))
        api = _FakeApi(items)
        run(td, f'{start:%Y-%m}', 999, now=now, fetch=api, sleep=nosleep)
        st = json.loads((Path(td) / '_status.json').read_text())
        asked = [u for u in api.calls if 'category' in u]
        ok('⑨b 上一輪已數到 5 個空週 → 這一輪只再問 3 個空週就停', st.get('earliest_empty') == (hist - timedelta(days=7 * 8)).isoformat()
           and len(asked) == 3)
    # ⑪ 空過守門:一週都沒做而且不是時間到 → rc 1
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / '_status.json').write_text(json.dumps({'earliest_empty': '2099-01-01'}))
        rc, out = run(td, f'{hist:%Y-%m}', 999, now=now, fetch=_FakeApi(items), sleep=nosleep)
        ok('⑪ 一週都沒做完(不是時間到)→ rc 1', rc == 1 and out['push'] == 0)
    print('✅ NEWS_DEEP_SELFTEST_PASS' if not bad else f'❌ {len(bad)} 條沒過')
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
