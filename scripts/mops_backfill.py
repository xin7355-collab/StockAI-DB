#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📰 公開資訊觀測站「重大訊息」歷史回補(V79.3.8,變因因子研究 —— 事件類變因的資料底)

使用者(2026-10-20):「把能測試的都列出來再來執行。要挖礦就挖礦。」
→ 重大訊息(庫藏股 / 澄清媒體報導 / 董事會決議 / 取得處分資產 / 背書保證 …)以前列在「沒有免費來源」;
  `mops_probe` 第二輪在 runner 上實測(run 39352940986):**全市場單日、上市與上櫃、400 天前、台積電 5 年前整年
  全部抓得到,零金鑰、沒被擋** → 這支把它存下來。

⛔ 不進 data / gh-pages:寫獨立 orphan 分支 `mops_deep`(陷阱 #41;只增不減)。⛔ 不吃 FinMind 額度。
端點與參數 = 探針實測通的那一組(⛔ 不改):
  POST {HOST}/mops/web/ajax_t05st01  firstin=1 step=1 off=1 TYPEK=sii|otc co_id=(空) year=民國 month=M b_date=D e_date=D
  (MOPS 自己的規則:「未指定公司代號時,僅能查詢單日」)
存法:mops_deep/{YYYY-MM}.json.gz = {'m', 'days': {日期: {'sii': n, 'otc': n}}, 'rows': [[代號, 名稱, 日期, 時間, 主旨, 市場]]}
  ⭐ 一天兩個市場都有結果(含 0 筆)才算那天做完 → 可續跑;今天與昨天⛔ 不算做完(可能還沒發完)。

守門:
  ① 被擋(「因為安全性考量」)→ 退避 60 / 120 / 240 秒,連 3 次就收工(保留已抓的,⛔ 不硬打)
  ② MOPS 提示「查無需求資料」= 那天 0 筆(⛔ 不是錯);其他提示 / 連不上 = 那天沒做完(下次再試)
  ③ 對表:每一棒挑一個做完的月份,用「指定公司」那條路查 2330(沒有就 2317)整個月 →
     那家公司的主旨 ≥90% 要在全市場那份找得到(兩條不同的查法對同一件事)→ 沒過 ⛔ 這一棒不推
  ④ 一個過去的月份,平日有 >60% 是 0 筆 → 可疑(多半是被擋或參數變了),⛔ 不寫那個月
  ⑤ 連續 3 個月整月 0 筆 → 判定「歷史到這裡為止」,記進 _status.json、不再往前
  ⑥ 空過守門:這一棒一天都沒做完 → exit 1

跑法:FROM=2010-01 MAX_MIN=330 OUT_DIR=mops_deep python3 scripts/mops_backfill.py
      python3 scripts/mops_backfill.py --selftest
"""
import calendar
import gzip
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mops_probe as mp          # noqa: E402  ⭐ 解析 / 被擋偵測 / host / UA 只有一份(⛔ 不抄)

TW = timezone(timedelta(hours=8))
FROM = (os.environ.get('FROM') or '2010-01').strip()               # 🔧 空字串守門(check_env_default)
MAX_MIN = float(os.environ.get('MAX_MIN') or '330')
OUT_DIR = Path(os.environ.get('OUT_DIR') or 'mops_deep')
SLEEP = float(os.environ.get('MOPS_SLEEP') or '1.2')               # 每次請求之間(MOPS 對機器人敏感)
PATH = '/mops/web/ajax_t05st01'
MARKETS = ('sii', 'otc')
CHECK_COS = ('2330', '2317')
CHECK_MIN = 0.90
EMPTY_MAX = 0.60
STOP_EMPTY_MONTHS = 3
BLOCK_MAX = 3


def months_back(frm, today):
    """最新(這個月)→ 最舊(frm)。"""
    y, m = today.year, today.month
    fy, fm = int(frm[:4]), int(frm[5:7])
    out = []
    while (y, m) >= (fy, fm):
        out.append(f'{y}-{m:02d}')
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return out


def weekdays(mo, today):
    y, m = int(mo[:4]), int(mo[5:7])
    n = calendar.monthrange(y, m)[1]
    return [date(y, m, d) for d in range(1, n + 1) if date(y, m, d).weekday() < 5 and date(y, m, d) < today]


def form(typek, d, co_id='', b=None, e=None):
    return {'encodeURIComponent': '1', 'firstin': '1', 'step': '1', 'off': '1', 'funcName': 't05st01',
            'queryName': 'co_id', 'inpuType': 'co_id', 'keyword': '', 'keycon': '',
            'TYPEK': typek, 'co_id': co_id, 'year': str(d.year - 1911), 'month': str(d.month),
            'b_date': str(b if b is not None else d.day), 'e_date': str(e if e is not None else d.day)}


def parse_rows(html, market):
    """→ [[代號, 名稱, 日期(ISO), 時間, 主旨, 市場]];日期是民國 → 西元。⛔ 第一欄不是代號的列不收(mp.table_rows)。"""
    out = []
    for c in mp.table_rows(html):
        if len(c) < 5:
            continue
        d = c[2].strip()
        try:
            yy, mm, dd = d.split('/')
            iso = f'{int(yy) + 1911}-{int(mm):02d}-{int(dd):02d}'
        except Exception:
            continue
        out.append([c[0].strip(), c[1].strip(), iso, c[3].strip(), c[4].strip(), market])
    return out


def classify(status, text):
    """一次查詢的結果:'ok'(有列)/ 'empty'(MOPS 說查無資料)/ 'blocked' / 'fail'。"""
    if status != 200:
        return 'fail'
    if mp.is_blocked(text):
        return 'blocked'
    if mp.table_rows(text):
        return 'ok'
    msg = mp.mops_msg(text) or ''
    if '查無' in msg:
        return 'empty'
    return 'fail'


def load_month(mo):
    f = OUT_DIR / f'{mo}.json.gz'
    if not f.exists():
        return {'m': mo, 'days': {}, 'rows': []}
    try:
        return json.loads(gzip.decompress(f.read_bytes()).decode('utf-8'))
    except Exception:
        return {'m': mo, 'days': {}, 'rows': []}


def save_month(doc):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc['rows'].sort(key=lambda r: (r[2], r[3], r[5], r[0]))
    (OUT_DIR / f"{doc['m']}.json.gz").write_bytes(gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')))


def month_verdict(doc, wdays):
    """過去的月份:平日 0 筆比例 > 60% → 可疑。回 (ok, 說明)。"""
    done = [d.isoformat() for d in wdays if all(m in (doc['days'].get(d.isoformat()) or {}) for m in MARKETS)]
    if not done:
        return False, '一天都沒做完'
    zero = sum(1 for d in done if sum(doc['days'][d].values()) == 0)
    r = zero / len(done)
    return r <= EMPTY_MAX, f'{len(done)} 天做完 ・0 筆 {zero} 天({r:.0%})'


def cross_check(doc, company_rows):
    """全市場那份裡,那家公司的(日期, 時間, 主旨)要 ≥90% 找得到。回 (ok, 說明)。"""
    if not company_rows:
        return None, '那家公司這個月沒有重大訊息'
    have = {(r[2], r[3], r[4]) for r in doc['rows'] if r[0] == company_rows[0][0]}
    hit = sum(1 for r in company_rows if (r[2], r[3], r[4]) in have)
    r = hit / len(company_rows)
    return r >= CHECK_MIN, f'{company_rows[0][0]} {hit}/{len(company_rows)}({r:.0%})'


def main():
    import requests
    t0 = time.time()
    today = (datetime.now(TW) - timedelta(days=1)).date()        # 今天與昨天⛔ 不算做完 → 只做到前天(weekdays 用 < today)
    sess = requests.Session()
    hdr = {**mp.UA, 'Referer': f'{mp.HOST}/mops/web/t05st01'}
    st_path = OUT_DIR / '_status.json'
    status = json.loads(st_path.read_text(encoding='utf-8')) if st_path.exists() else {}
    stop_at = status.get('earliest_empty')                       # 上一棒判定「歷史到這裡為止」
    blocks, done_days, reqs, months_done, checked = 0, 0, 0, [], None
    empty_run = 0
    reason, more = 'done', 0

    def post(f):
        nonlocal blocks, reqs
        for att in range(3):
            try:
                r = sess.post(mp.HOST + PATH, data=f, headers=hdr, timeout=60)
                r.encoding = r.encoding or 'utf-8'
                reqs += 1
                k = classify(r.status_code, r.text or '')
                if k == 'blocked':
                    blocks += 1
                    print(f'   ⛔ 被擋(第 {blocks} 次)→ 退避 {60 * 2 ** (blocks - 1)} 秒', flush=True)
                    if blocks >= BLOCK_MAX:
                        return 'blocked', ''
                    time.sleep(60 * 2 ** (blocks - 1))
                    continue
                return k, r.text or ''
            except Exception as e:
                print(f'   ⚠️ {type(e).__name__}: {str(e)[:80]}(第 {att + 1} 次)', flush=True)
                time.sleep(3 * (att + 1))
        return 'fail', ''

    for mo in months_back(FROM, today):
        if stop_at and mo <= stop_at:
            print(f'⏹️ {mo}:上一棒已判定歷史到 {stop_at} 為止 → 不再往前', flush=True)
            break
        if (time.time() - t0) / 60 > MAX_MIN:
            reason, more = 'time', 1
            break
        doc = load_month(mo)
        wd = weekdays(mo, today)
        todo = [(d, m) for d in wd for m in MARKETS if m not in (doc['days'].get(d.isoformat()) or {})]
        if not todo:
            continue
        print(f'📰 {mo}:要做 {len(todo)} 次(平日 {len(wd)} 天 × 2 市場)', flush=True)
        for d, m in todo:
            if (time.time() - t0) / 60 > MAX_MIN:
                reason, more = 'time', 1
                break
            k, txt = post(form(m, d))
            if k == 'blocked':
                reason, more = 'blocked', 0
                break
            if k in ('ok', 'empty'):
                rows = parse_rows(txt, m) if k == 'ok' else []
                rows = [r for r in rows if r[2] == d.isoformat()]         # 只收那一天的(⛔ 不信任頁面多給的)
                doc['days'].setdefault(d.isoformat(), {})[m] = len(rows)
                doc['rows'] = [r for r in doc['rows'] if not (r[2] == d.isoformat() and r[5] == m)] + rows
            time.sleep(SLEEP)
        if reason == 'blocked':
            save_month(doc) if doc['days'] else None
            break
        okm, why = month_verdict(doc, wd)
        alldone = all(all(m in (doc['days'].get(d.isoformat()) or {}) for m in MARKETS) for d in wd)
        if alldone and not okm and doc['days']:
            print(f'   ⚠️ {mo} 可疑:{why} → ⛔ 不寫(多半是被擋或參數變了)', flush=True)
            zero_all = all(sum(v.values()) == 0 for v in doc['days'].values())
            if zero_all:
                empty_run += 1
                if empty_run >= STOP_EMPTY_MONTHS:
                    status['earliest_empty'] = mo
                    print(f'⏹️ 連 {STOP_EMPTY_MONTHS} 個月整月 0 筆 → 判定歷史到 {mo} 為止', flush=True)
                    break
            continue
        empty_run = 0
        save_month(doc)
        n_rows = len(doc['rows'])
        done_days += sum(1 for d in wd if all(m in (doc['days'].get(d.isoformat()) or {}) for m in MARKETS))
        print(f'   ✅ {mo}:{why} ・{n_rows:,} 則', flush=True)
        if alldone:
            months_done.append(mo)
            # ③ 對表:每一棒做一次(挑第一個做完的月)
            if checked is None:
                y, m_ = int(mo[:4]), int(mo[5:7])
                last = calendar.monthrange(y, m_)[1]
                for co in CHECK_COS:
                    k, txt = post(form('all', date(y, m_, 1), co_id=co, b=1, e=last))
                    time.sleep(SLEEP)
                    if k != 'ok':
                        continue
                    # ⚠️ 只比「全市場那份已經做完的日子」(⛔ 今天 / 昨天那家公司的新公告不算漏)
                    doneset = {k for k, v in doc['days'].items() if all(mk in v for mk in MARKETS)}
                    crows = [r for r in parse_rows(txt, 'co') if r[2][:7] == mo and r[2] in doneset]
                    res, why2 = cross_check(doc, crows)
                    if res is None:
                        continue
                    checked = (res, f'{mo} {why2}')
                    print(f'   🔎 對表(指定公司那條路):{why2} → {"✅" if res else "❌"}', flush=True)
                    break
    status.update({'updated': datetime.now(TW).isoformat(timespec='minutes'),
                   'months': sorted(p.name[:7] for p in OUT_DIR.glob('*.json.gz')) if OUT_DIR.exists() else [],
                   'last_run': {'reason': reason, 'reqs': reqs, 'blocks': blocks, 'months_done': months_done,
                                'check': checked[1] if checked else None}})
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    st_path.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding='utf-8')
    ok_push = True
    if checked is not None and not checked[0]:
        ok_push = False
        print(f'❌ 對表沒過:{checked[1]} → ⛔ 這一棒不推', flush=True)
    if done_days == 0 and reason != 'time':
        print('❌ 這一棒一天都沒做完(空過守門)', flush=True)
        ok_push = False
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f'more={more}\nreason={reason}\npush={1 if ok_push else 0}\n')
    print(f'🏁 {reason} ・請求 {reqs} 次 ・被擋 {blocks} 次 ・做完 {len(months_done)} 個月 ・{round((time.time() - t0) / 60, 1)} 分', flush=True)
    return 0 if ok_push else 1


def selftest():
    bad = []

    def ok(n, c, e=''):
        print(f"  {'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
        if not c:
            bad.append(n)
    t = date(2026, 10, 20)
    mb = months_back('2026-08', t)
    ok('① 月份由新到舊、含起點', mb == ['2026-10', '2026-09', '2026-08'], mb)
    wd = weekdays('2026-10', t)
    ok('① 平日、⛔ 不含今天以後', all(d.weekday() < 5 for d in wd) and max(wd) < t and date(2026, 10, 19) in wd, wd[-2:])
    f = form('sii', date(2025, 9, 15))
    ok('② 參數 = 探針實測通的那組(民國年、單日 b_date = e_date、co_id 空)', f['year'] == '114' and f['b_date'] == f['e_date'] == '15' and f['co_id'] == '' and f['TYPEK'] == 'sii', f)
    html = ('<table><tr><td>3128</td><td>昇銳</td><td>114/09/15</td><td>07:00:04</td><td>公告本公司名稱變更</td><td></td></tr>'
            '<tr><th>公司代號</th><th>名稱</th></tr></table>')
    rows = parse_rows(html, 'otc')
    ok('③ 解析:民國 → 西元、帶市場、表頭不收', rows == [['3128', '昇銳', '2025-09-15', '07:00:04', '公告本公司名稱變更', 'otc']], rows)
    ok('④ 分類:有列 ok / 查無 empty / 被擋 blocked / 一般網頁 fail',
       classify(200, html) == 'ok' and classify(200, '<html>公開資訊觀測站 資料庫中查無需求資料</html>') == 'empty'
       and classify(200, '因為安全性考量') == 'blocked' and classify(200, '<html>別的網頁</html>') == 'fail' and classify(500, html) == 'fail')
    days = {f'2026-09-{d:02d}': {'sii': 0, 'otc': 0} for d in range(1, 21)}
    wd9 = [date(2026, 9, d) for d in range(1, 21) if date(2026, 9, d).weekday() < 5]
    okm, why = month_verdict({'days': days}, wd9)
    ok('⑤ 整月 0 筆 → 可疑(⛔ 不寫)', not okm, why)
    for k in list(days)[:12]:
        days[k] = {'sii': 30, 'otc': 10}
    okm, why = month_verdict({'days': days}, wd9)
    ok('⑤ 大部分有資料、幾天 0 筆(假日)→ 照寫', okm, why)
    doc = {'rows': [['2330', '台積電', '2026-09-10', '13:54:04', '9 月營收', 'sii'], ['2330', '台積電', '2026-09-15', '15:21:38', '第三季 EPS', 'sii']]}
    c_ok, why = cross_check(doc, [['2330', '台積電', '2026-09-10', '13:54:04', '9 月營收', 'co'], ['2330', '台積電', '2026-09-15', '15:21:38', '第三季 EPS', 'co']])
    ok('⑥ 對表:兩條查法都有 → 過', c_ok, why)
    c_bad, why = cross_check(doc, [['2330', '台積電', f'2026-09-{d:02d}', '10:00:00', f'x{d}', 'co'] for d in range(1, 11)])
    ok('⑥ 決定性對照:全市場那份漏掉那家公司 → 沒過(⛔ 不推)', c_bad is False, why)
    ok('⑥ 那家公司這個月沒有 → 不判(換下一家)', cross_check(doc, [])[0] is None)
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
