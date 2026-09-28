#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏢 公司事件史(V77.8.3,外部評估 ㊷ FinPilot 那兩個事件:減資後恢復買賣 / 庫藏股買回)

使用者 2026-09-28「依照你說的做」= 補這兩種事件的歷史,拿來做事件回測(`corp_event_probe.mjs`)。

① 減資恢復買賣:FinMind `TaiwanStockCapitalReductionReferencePrice`(Free 層)
   欄位 date(= 恢復買賣日)/ stock_id / PostReductionReferencePrice / ReasonforCapitalReduction …
   ⭐ 一次呼叫不帶 data_id 回全部;按年份切窗口抓(一次抓太大容易被截),再依 (stock_id, date) 去重。
② 庫藏股買回:⚠️ **來源還不確定** —— FinMind 清單裡沒有這個 dataset;
   先把候選全部試一次(FinMind 猜名 / TWSE OpenAPI swagger 裡含「庫藏」的端點 / TPEx OpenAPI 同上),
   **每個候選都印 content-type + 開頭 200 字 + 列數**,拿到 JSON 列表就原樣存進 `ts_raw[來源]`。
   ⛔ 名字猜錯(422 / HTTP 200 但是網頁,陷阱 #23)跟「官方不給」要分得出來 → 結論分四種印出來。

⛔ 安全:只記「第幾把 token」,絕不印金鑰值(test_no_token_leak)。
⛔ 空過守門:減資事件 < 50 筆 → exit 1、不寫檔(寧可紅燈,⛔ 不推一份空的上去)。
⚠️ 沙箱連不到 FinMind / TWSE / TPEx → 只能在 Actions 跑(corp_events.yml,手動)。

用法:
  python3 scripts/corp_events_miner.py --out /tmp/corp_events.json
  python3 scripts/corp_events_miner.py --selftest
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
CR_DATASET = 'TaiwanStockCapitalReductionReferencePrice'
TS_FINMIND_GUESS = ['TaiwanStockTreasuryStock', 'TaiwanStockTreasuryShares', 'TaiwanStockBuyBack', 'TaiwanStockRepurchase']
SWAGGERS = [('twse', 'https://openapi.twse.com.tw/v1/swagger.json', 'https://openapi.twse.com.tw/v1'),
            ('tpex', 'https://www.tpex.org.tw/openapi/swagger.json', 'https://www.tpex.org.tw/openapi/v1')]
TS_KEYWORDS = ('庫藏', '買回')
UA = {'User-Agent': 'Mozilla/5.0 (StockAI-DB corp_events_miner)'}


def http_get(url, timeout=60):
    """回 (status, content_type, text);失敗回 (None, 錯誤類別, '')"""
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get('content-type', ''), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode('utf-8', 'replace')
        except Exception:
            body = ''
        return e.code, e.headers.get('content-type', '') if e.headers else '', body
    except Exception as e:
        return None, type(e).__name__, ''


def fm(dataset, start, end=None):
    """FinMind:輪動 token;回 (rows, 第幾把, 原因)。⛔ 不印金鑰"""
    last = 'no-token'
    for i in range(max(1, len(TOKENS))):
        q = {'dataset': dataset, 'start_date': start}
        if end:
            q['end_date'] = end
        if TOKENS:
            q['token'] = TOKENS[i]
        st, ct, body = http_get(API + '?' + urllib.parse.urlencode(q))
        if st is None:
            last = ct
            continue
        try:
            j = json.loads(body)
        except Exception:
            last = f'http{st}:非JSON'
            continue
        if st != 200:
            last = f'http{st}:{str(j.get("msg") or "")[:70]}'
            continue
        rows = j.get('data') or []
        if rows:
            return rows, i + 1, None
        last = 'empty'
    return [], None, last


def classify(status, ctype, body):
    """四種結論:連不上 / 被擋 / 名字錯(422、或 200 但是網頁)/ 有資料 / 空"""
    if status is None:
        return '連不上'
    if status in (401, 403):
        return '被擋'
    if status in (404, 422):
        return '名字錯'
    t = body.lstrip()[:1]
    if status == 200 and t not in '[{':
        return '名字錯(回網頁)'
    try:
        j = json.loads(body)
    except Exception:
        return '非JSON'
    rows = j if isinstance(j, list) else (j.get('data') if isinstance(j, dict) else None)
    return f'有資料 {len(rows)} 列' if rows else '空'


def dedup_cr(rows):
    """依 (stock_id, date) 去重;date 統一 YYYY-MM-DD"""
    out = {}
    for r in rows:
        sid, d = str(r.get('stock_id') or '').strip(), str(r.get('date') or '').replace('/', '-')[:10]
        if not sid or not re.match(r'\d{4}-\d{2}-\d{2}$', d):
            continue
        out[(sid, d)] = {**r, 'stock_id': sid, 'date': d}
    return sorted(out.values(), key=lambda r: (r['date'], r['stock_id']))


def swagger_paths(doc, keywords=TS_KEYWORDS):
    """從 OpenAPI 文件挑出 summary / description / tags 含關鍵字的 GET 路徑"""
    out = []
    for p, ops in (doc.get('paths') or {}).items():
        g = (ops or {}).get('get') or {}
        txt = ' '.join([str(g.get('summary') or ''), str(g.get('description') or ''), ' '.join(map(str, g.get('tags') or []))])
        if any(k in txt for k in keywords):
            out.append((p, txt.strip()[:60]))
    return out


def main(out_path):
    t0 = time.time()
    print(f'🔑 FinMind token {len(TOKENS)} 把(只記第幾把)')
    # ── ① 減資 ──
    raw, used = [], {}
    this_year = date.today().year
    for y in range(2010, this_year + 1):
        rows, k, why = fm(CR_DATASET, f'{y}-01-01', f'{y}-12-31')
        print(f'   減資 {y}:{len(rows)} 列' + (f'(第 {k} 把)' if k else f'({why})'))
        raw += rows
        used[str(y)] = len(rows)
        time.sleep(0.6)
    cr = dedup_cr(raw)
    print(f'✂️ 減資恢復買賣:原始 {len(raw)} 列 → 去重 {len(cr)} 筆・{len({r["stock_id"] for r in cr})} 檔')
    if cr:
        print('   欄位:', sorted(cr[0].keys()))
        print('   第一筆:', json.dumps(cr[0], ensure_ascii=False)[:300])
        reasons = {}
        for r in cr:
            k = str(r.get('ReasonforCapitalReduction') or '?')
            reasons[k] = reasons.get(k, 0) + 1
        print('   原因分布:', json.dumps(dict(sorted(reasons.items(), key=lambda x: -x[1])[:12]), ensure_ascii=False))

    # ── ② 庫藏股候選 ──
    ts_raw, ts_log = {}, []
    for ds in TS_FINMIND_GUESS:
        rows, k, why = fm(ds, '2020-01-01')
        verdict = f'有資料 {len(rows)} 列' if rows else why
        ts_log.append({'src': f'finmind:{ds}', 'verdict': verdict})
        print(f'   🏦 FinMind {ds}:{verdict}')
        if rows:
            ts_raw[f'finmind:{ds}'] = rows[:50000]
    for name, sw, base in SWAGGERS:
        st, ct, body = http_get(sw)
        v = classify(st, ct, body)
        print(f'   🏦 {name} swagger:{st} {ct[:40]} → {v}・開頭 {body[:80]!r}')
        if not v.startswith('有資料') and not (st == 200 and body.lstrip()[:1] == '{'):
            ts_log.append({'src': f'{name}:swagger', 'verdict': v})
            continue
        try:
            doc = json.loads(body)
        except Exception:
            ts_log.append({'src': f'{name}:swagger', 'verdict': '非JSON'})
            continue
        paths = swagger_paths(doc)
        print(f'      含「庫藏/買回」的端點 {len(paths)} 個:', paths[:12])
        if not paths:
            ts_log.append({'src': f'{name}:swagger', 'verdict': f'清單裡沒有含「庫藏/買回」的端點(共 {len(doc.get("paths") or {})} 個端點)'})
        for p, desc in paths[:12]:
            st2, ct2, b2 = http_get(base + p)
            v2 = classify(st2, ct2, b2)
            print(f'      → {p}({desc}):{st2} {v2}・開頭 {b2[:200]!r}')
            ts_log.append({'src': f'{name}:{p}', 'desc': desc, 'verdict': v2})
            if v2.startswith('有資料'):
                j = json.loads(b2)
                ts_raw[f'{name}:{p}'] = j if isinstance(j, list) else j.get('data')
            time.sleep(0.5)

    print(f'⏱️ {time.time() - t0:.0f}s')
    if len(cr) < 50:
        print(f'🚧 減資事件只有 {len(cr)} 筆(< 50)→ ⛔ 不寫檔(寧可紅燈,不推一份空的)')
        return 1
    out = {
        'updated': date.today().isoformat(),
        'src': {'cr': f'FinMind {CR_DATASET}', 'ts': list(ts_raw.keys())},
        'caveat': '減資 date = 恢復買賣日;庫藏股來源見 ts_log(可能是當期快照,⛔ 不一定有歷史)',
        'cr_by_year': used,
        'cr': cr,
        'ts_log': ts_log,
        'ts_raw': ts_raw,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'💾 {out_path}:減資 {len(cr)} 筆・庫藏股來源 {len(ts_raw)} 個')
    return 0


def selftest():
    ok = bad = 0

    def t(c, m):
        nonlocal ok, bad
        print(('  ✅ ' if c else '  ❌ ') + m)
        ok, bad = ok + bool(c), bad + (not c)
    d = dedup_cr([{'stock_id': '2330', 'date': '2020/05/01'}, {'stock_id': '2330', 'date': '2020-05-01', 'x': 1},
                  {'stock_id': '', 'date': '2020-05-01'}, {'stock_id': '1101', 'date': 'bad'}])
    t(len(d) == 1 and d[0].get('x') == 1 and d[0]['date'] == '2020-05-01', '① 去重:同檔同日只留一筆(後到的覆蓋)・壞日期 / 沒代號丟掉')
    t(classify(200, 'text/html', '<!DOCTYPE html>') == '名字錯(回網頁)', '② HTTP 200 但回網頁 = 名字錯(陷阱 #23),⛔ 不是「官方不給」')
    t(classify(422, 'application/json', '{"msg":"x"}') == '名字錯' and classify(403, '', '') == '被擋' and classify(None, 'URLError', '') == '連不上',
      '③ 422 = 名字錯 / 403 = 被擋 / 例外 = 連不上 —— 三種分得出來')
    t(classify(200, 'application/json', '[{"a":1},{"a":2}]') == '有資料 2 列' and classify(200, 'application/json', '[]') == '空', '④ 有列 vs 空列')
    doc = {'paths': {'/opendata/x1': {'get': {'summary': '上市公司庫藏股買回'}}, '/opendata/x2': {'get': {'summary': '本益比'}},
                     '/opendata/x3': {'post': {'summary': '庫藏'}}}}
    t([p for p, _ in swagger_paths(doc)] == ['/opendata/x1'], '⑤ swagger 只挑含「庫藏/買回」的 GET 端點')
    print(f'\n{"❌" if bad else "✅"} selftest {ok}/{ok + bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else '/tmp/corp_events.json'
    sys.exit(main(out))
