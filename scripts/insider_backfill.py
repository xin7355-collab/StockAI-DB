#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📝 公開資訊觀測站「股權轉讓事前申報日報表」歷史回補(V80.1.7,計畫 B4)

使用者(2026-11-01):「早知道先機,贏多一點少輸一點」→ 計畫 B4:大股東 / 董監 / 經理人要賣股票,
**賣之前就要先公開申報**(有效期間一個月)—— 這是「法律逼他提早說」的事,本站從來沒存過。

探路(insider_src_probe.py,macro_probe which=mops_insider 第四輪,run 41369110795):
  第一層 POST /mops/web/ajax_t56sb12_q1(上市)/ _q2(上櫃)→ 回一個自動送出的表單(autoForm)
  第二層照那個表單原樣 POST /mops/web/ajax_t56sb12 {run:'', step:'2', year, month, day, report:SY|OY, firstin:'true'}
  → 全市場那一天的申報,2011-10-28 照樣查得到(上市 11 筆、上櫃 3 筆);沒有申報的日子回「無持股轉讓之情形」。

⛔ 不進 data / gh-pages:寫獨立 orphan 分支 `insider_deep`(陷阱 #41;只增不減)。⛔ 不吃 FinMind 額度、不用任何金鑰。
存法:insider_deep/{YYYY-MM}.json.gz = {'m', 'days': {日期: {'sii': n, 'otc': n}}, 'rows': [[市場, 原文欄位…]]}
  ⭐ 每一列存「原文欄位」(⛔ 只存解析過的)→ 之後發現欄位對錯了還能重解析;解析只有一份 `parse_cells`(研究也 import 它)。
  ⭐ 一天兩個市場都有結果(含 0 筆)才算那天做完 → 可續跑;今天與昨天⛔ 不算做完(可能還沒申報完)。

請求:第二層的表單是「學來的」(⛔ 猜欄位):每一棒先照兩層走,同一個市場連續 2 天
  「第一層給的表單」==「拿學到的表單換日期」→ 之後才直接送第二層(一天 1 次請求);直接送失敗就退回兩層。

守門:
  ① 被擋(「因為安全性考量」)→ 退避 60 / 120 / 240 秒,連 3 次就收工(保留已抓的,⛔ 不硬打)
  ② 「無持股轉讓之情形」/「查無」= 那天 0 筆(⛔ 不是錯);其他(502、連不上、看不懂的網頁)= 那天沒做完(下一棒再試)
  ③ 只收「申報日期 == 查的那一天」的列(⛔ 不信任頁面多給的)
  ④ 每一列都要對得上「目前持股 − 預定轉讓 = 轉讓後持股」(自有、信託兩欄各算)→ 一個月 <90% 對得上 =
     欄位錯位(格式改了)→ ⛔ 不寫那個月、印原文
  ⑤ 一個過去的月份,平日 >60% 兩個市場加起來都是 0 筆 → 可疑,⛔ 不寫;連 3 個月整月 0 筆 → 判定歷史到這裡為止
  ⑥ 連續 30 次請求都失敗(不是被擋)→ 這一棒收工(⛔ 一直打壞掉的主機)
  ⑦ 空過守門:這一棒一天都沒做完 → exit 1

跑法:FROM=2005-01 MAX_MIN=330 OUT_DIR=insider_deep python3 scripts/insider_backfill.py
      python3 scripts/insider_backfill.py --selftest
"""
import calendar
import gzip
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mops_probe as mp              # noqa: E402  ⭐ host / UA / 被擋偵測 / 去標籤 / 表單欄位 只有一份
import insider_src_probe as isp      # noqa: E402  ⭐ 自動表單 / 第一層表單 / 表格列 只有一份(⛔ 不抄)

TW = timezone(timedelta(hours=8))
FROM = (os.environ.get('FROM') or '2005-01').strip()                # 🔧 空字串守門(check_env_default)
MAX_MIN = float(os.environ.get('MAX_MIN') or '330')
OUT_DIR = Path(os.environ.get('OUT_DIR') or 'insider_deep')
SLEEP = float(os.environ.get('INSIDER_SLEEP') or '1.5')             # 每次請求之間(MOPS 對機器人敏感)
MARKETS = {'sii': 't56sb12_q1', 'otc': 't56sb12_q2'}                # 上市 / 上櫃
EMPTY_MSG = ('無持股轉讓之情形', '查無')
ID_MIN = 0.90
EMPTY_MAX = 0.60
STOP_EMPTY_MONTHS = 3
BLOCK_MAX = 3
FAIL_RUN_MAX = 30
LEARN_OK = 2                     # 學到的第二層表單要連續對上幾天才直接送
_ROC = re.compile(r'^(\d{2,3})/(\d{1,2})/(\d{1,2})$')
_CODE = re.compile(r'^\d{4,6}[A-Z]?$')
# 原文欄位(從申報日期那一格往後數)── 探路第四輪的表頭與資料列對過(t56sb12_q1 / q2 一樣)
FIELDS = ('date', 'code', 'name', 'role', 'holder', 'method', 'shares', 'daily_max', 'transferee',
          'held_own', 'held_trust', 'plan_own', 'plan_trust', 'after_own', 'after_trust', 'period')


# ───────────────────────── 純函式(--selftest 直接打) ─────────────────────────
def roc_iso(s):
    m = _ROC.match((s or '').strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3))
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def _int(s):
    t = (s or '').replace(',', '').strip()
    return int(t) if re.fullmatch(r'-?\d+', t) else None


def parse_cells(cells):
    """一列原文欄位 → dict(找不到「民國日期 + 股票代號」那兩格 → None)。
    ⭐ 從申報日期那一格往後照 FIELDS 對;日期前面如果還有格子(「異動情形」)放 chg。
    ok = 「目前持股 − 預定轉讓 = 轉讓後持股」自有、信託兩欄都對得上(欄位錯位的話幾乎不可能剛好對上)。"""
    cells = [str(c).strip() for c in (cells or [])]
    i0 = next((i for i, c in enumerate(cells) if roc_iso(c) and i + 1 < len(cells) and _CODE.match(cells[i + 1])), None)
    if i0 is None or len(cells) - i0 < len(FIELDS):
        return None
    r = {k: cells[i0 + j] for j, k in enumerate(FIELDS)}
    r['date'] = roc_iso(r['date'])
    r['chg'] = ' '.join(cells[:i0]).strip()
    n = {k: _int(r[k]) for k in ('held_own', 'held_trust', 'plan_own', 'plan_trust', 'after_own', 'after_trust')}
    r.update({k + '_n': v for k, v in n.items()})
    r['ok'] = all(v is not None for v in n.values()) and \
        n['held_own'] - n['plan_own'] == n['after_own'] and n['held_trust'] - n['plan_trust'] == n['after_trust']
    return r


def parse_rows(html):
    """→ [原文欄位清單](只收 parse_cells 認得的列)。"""
    return [c for c in isp.generic_rows(html, min_td=10) if parse_cells(c)]


def classify(status, text):
    """一次第二層查詢:'ok'(有列)/ 'empty'(MOPS 說沒有)/ 'blocked' / 'fail'。"""
    if status != 200:
        return 'fail'
    if mp.is_blocked(text):
        return 'blocked'
    if parse_rows(text):
        return 'ok'
    t = mp.strip_tags(text or '')
    if any(k in t for k in EMPTY_MSG):
        return 'empty'
    return 'fail'


def second_form(tmpl, d):
    """學到的第二層表單換成另一天(⛔ 不加欄位,只換 year / month / day;格式 = 第一層送出去的格式,兩位數補 0)。
    ⚠️ 對不對由 Fetcher 驗:連續 LEARN_OK 天「這樣組出來的」==「伺服器第一層真的給的」才直接送 —— 格式不一樣就永遠走兩層。"""
    f = dict(tmpl)
    f.update(year=str(d.year - 1911), month=f'{d.month:02d}', day=f'{d.day:02d}')
    return f


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


def month_verdict(doc, wdays):
    """過去的月份:①兩個市場加起來 0 筆的平日 >60% → 可疑 ②有 ≥10 列時,恆等式對得上 <90% → 欄位錯位。回 (ok, 說明)。"""
    done = [d.isoformat() for d in wdays if all(m in (doc['days'].get(d.isoformat()) or {}) for m in MARKETS)]
    if not done:
        return False, '一天都沒做完'
    zero = sum(1 for d in done if sum(doc['days'][d].values()) == 0)
    rz = zero / len(done)
    pr = [parse_cells(r[1:]) for r in doc['rows']]
    pr = [p for p in pr if p]
    rid = (sum(1 for p in pr if p['ok']) / len(pr)) if pr else 1.0
    why = f'{len(done)} 天做完 ・0 筆 {zero} 天({rz:.0%})・{len(pr)} 列 ・恆等式對得上 {rid:.0%}'
    if rz > EMPTY_MAX:
        return False, why
    if len(pr) >= 10 and rid < ID_MIN:
        return False, why + ' → 欄位可能錯位'
    return True, why


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
    doc['rows'].sort(key=lambda r: (str(roc_iso(next((c for c in r[1:] if roc_iso(c)), '')) or ''), r[0], r[1:]))
    (OUT_DIR / f"{doc['m']}.json.gz").write_bytes(gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')))


# ───────────────────────── 網路 ─────────────────────────
class Fetcher:
    """一個市場一天 → ('ok' | 'empty' | 'blocked' | 'fail', 原文欄位清單)。第二層表單照第一層給的學(⛔ 猜)。"""

    def __init__(self, sess, post):
        self.sess, self.post = sess, post
        self.fields = {}      # 市場 → 官方頁面的表單欄位(第一層照它組;⛔ 猜)
        self.tmpl = {}        # 市場 → 學到的第二層表單
        self.match = {}       # 市場 → 連續對上幾天
        self.act = {}         # 市場 → 第二層網址
        self.direct = 0

    def first_form(self, mk, d):
        if not self.fields.get(mk):                     # ⚠️ 沒拿到就下次再拿(⛔ 把「沒拿到」記住一整棒)
            r = self.post('GET', f'{mp.HOST}/mops/web/{MARKETS[mk]}', None)
            if r is None or mp.is_blocked(r.text or ''):
                return None
            self.fields[mk] = mp.form_fields(r.text or '')['fields']
        fs = isp.r2_forms('day', self.fields[mk], '', days=(d,))
        return fs[0][1] if fs else None

    def fetch(self, mk, d):
        if self.match.get(mk, 0) >= LEARN_OK and self.act.get(mk):
            r = self.post('POST', self.act[mk], second_form(self.tmpl[mk], d))
            if r is not None:
                k = classify(r.status_code, r.text or '')
                if k in ('ok', 'empty', 'blocked'):
                    self.direct += 1
                    return k, (parse_rows(r.text) if k == 'ok' else [])
            self.match[mk] = 0                                   # 直接送沒結果 → 退回兩層、重新學
        f1 = self.first_form(mk, d)
        if not f1:
            return 'fail', []
        r1 = self.post('POST', f'{mp.HOST}/mops/web/ajax_{MARKETS[mk]}', f1)
        if r1 is None:
            return 'fail', []
        if mp.is_blocked(r1.text or ''):
            return 'blocked', []
        act, kv = isp.auto_form(r1.text or '')
        if not act:
            return 'fail', []
        url = act if act.startswith('http') else mp.HOST + act
        r2 = self.post('POST', url, kv)
        if r2 is None:
            return 'fail', []
        k = classify(r2.status_code, r2.text or '')
        if k in ('ok', 'empty'):
            same = self.tmpl.get(mk) is not None and second_form(self.tmpl[mk], d) == kv and self.act.get(mk) == url
            self.match[mk] = self.match.get(mk, 0) + 1 if same else 1
            self.tmpl[mk], self.act[mk] = kv, url
        return k, (parse_rows(r2.text) if k == 'ok' else [])


def main():
    import requests
    t0 = time.time()
    today = (datetime.now(TW) - timedelta(days=1)).date()        # 今天與昨天⛔ 不算做完 → 只做到前天
    sess = requests.Session()
    hdr = {**mp.UA, 'Referer': f'{mp.HOST}/mops/web/index'}
    st_path = OUT_DIR / '_status.json'
    try:
        status = json.loads(st_path.read_text(encoding='utf-8')) if st_path.exists() else {}
    except Exception:
        status = {}
    stop_at = status.get('earliest_empty')
    n = {'req': 0, 'blocks': 0, 'fail_run': 0}
    done_days, months_done, empty_run = 0, [], 0
    reason, more = 'done', 0

    def post(method, url, form):
        for att in range(3):
            if n['fail_run'] >= FAIL_RUN_MAX:
                return None
            time.sleep(SLEEP)
            try:
                r = sess.post(url, data=form, headers=hdr, timeout=60) if method == 'POST' else sess.get(url, headers=hdr, timeout=60)
                r.encoding = r.encoding or 'utf-8'
                n['req'] += 1
                if mp.is_blocked(r.text or ''):
                    n['blocks'] += 1
                    print(f'   ⛔ 被擋(第 {n["blocks"]} 次)→ 退避 {60 * 2 ** (n["blocks"] - 1)} 秒', flush=True)
                    if n['blocks'] >= BLOCK_MAX:
                        return r
                    time.sleep(60 * 2 ** (n['blocks'] - 1))
                    continue
                if r.status_code >= 500:
                    raise RuntimeError(f'HTTP {r.status_code}')
                n['fail_run'] = 0
                return r
            except Exception as e:
                n['fail_run'] += 1
                print(f'   ⚠️ {type(e).__name__}: {str(e)[:80]}(第 {att + 1} 次)', flush=True)
                time.sleep(5 * 3 ** att)
        return None

    fx = Fetcher(sess, post)
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
        print(f'📝 {mo}:要做 {len(todo)} 次(平日 {len(wd)} 天 × 2 市場)', flush=True)
        for d, m in todo:
            if (time.time() - t0) / 60 > MAX_MIN:
                reason, more = 'time', 1
                break
            k, rows = fx.fetch(m, d)
            if n['blocks'] >= BLOCK_MAX:                 # ⚠️ 不管這一次回什麼:被擋滿 3 次就收工(⛔ 繼續打)
                reason, more = 'blocked', 0
                break
            if n['fail_run'] >= FAIL_RUN_MAX:
                reason, more = 'fail', 0
                print(f'   ❌ 連續 {FAIL_RUN_MAX} 次請求失敗 → 這一棒收工', flush=True)
                break
            if k in ('ok', 'empty'):
                iso = d.isoformat()
                rows = [c for c in rows if (parse_cells(c) or {}).get('date') == iso]       # ③ 只收那一天的
                doc['days'].setdefault(iso, {})[m] = len(rows)
                doc['rows'] = [r for r in doc['rows'] if not (r[0] == m and (parse_cells(r[1:]) or {}).get('date') == iso)] + [[m] + c for c in rows]
        if reason in ('blocked', 'fail'):
            okp, _ = month_verdict(doc, [d for d in wd if all(x in (doc['days'].get(d.isoformat()) or {}) for x in MARKETS)])
            if doc['days'] and okp:
                save_month(doc)
            break
        okm, why = month_verdict(doc, wd)
        alldone = all(all(m in (doc['days'].get(d.isoformat()) or {}) for m in MARKETS) for d in wd)
        if not okm and doc['days']:
            print(f'   ⚠️ {mo} 可疑:{why} → ⛔ 不寫', flush=True)
            for r in doc['rows'][:3]:
                print(f'      原文 {r}', flush=True)
            if alldone and all(sum(v.values()) == 0 for v in doc['days'].values()):
                empty_run += 1
                if empty_run >= STOP_EMPTY_MONTHS:
                    status['earliest_empty'] = mo
                    print(f'⏹️ 連 {STOP_EMPTY_MONTHS} 個月整月 0 筆 → 判定歷史到 {mo} 為止', flush=True)
                    break
            if reason == 'time':
                break
            continue
        empty_run = 0
        save_month(doc)
        done_days += sum(1 for d in wd if all(m in (doc['days'].get(d.isoformat()) or {}) for m in MARKETS))
        print(f'   ✅ {mo}:{why}', flush=True)
        if alldone:
            months_done.append(mo)
        if reason == 'time':
            break
    status.update({'updated': datetime.now(TW).isoformat(timespec='minutes'),
                   'months': sorted(p.name[:7] for p in OUT_DIR.glob('*.json.gz')) if OUT_DIR.exists() else [],
                   'last_run': {'reason': reason, 'reqs': n['req'], 'blocks': n['blocks'], 'direct': fx.direct,
                                'months_done': months_done}})
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    st_path.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding='utf-8')
    ok_push = done_days > 0 or reason == 'time'
    if not ok_push:
        print('❌ 這一棒一天都沒做完(空過守門)', flush=True)
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f'more={more}\nreason={reason}\npush={1 if ok_push else 0}\n')
    print(f'🏁 {reason} ・請求 {n["req"]} 次(直接送第二層 {fx.direct} 次)・被擋 {n["blocks"]} 次 ・做完 {len(months_done)} 個月 ・'
          f'{round((time.time() - t0) / 60, 1)} 分', flush=True)
    return 0 if ok_push else 1


# ───────────────────────── selftest ─────────────────────────
def selftest():
    bad = []

    def ok(nm, c, e=''):
        print(f"  {'✅' if c else '❌'} {nm}{'' if c else '  ' + str(e)[:300]}")
        if not c:
            bad.append(nm)
    # 探路第四輪的原文(上市 2026-10-30 那兩列、上櫃 2021-10-29 一列)
    A = ['115/10/30', '3006', '晶豪科', '董事本人', '山一投資有限公司', '一般交易(每日得轉讓股數限制)', '1,621,000', '523,190', '',
         '3,299,000', '0', '1,621,000', '0', '1,678,000', '0', '115/11/02 ~ 115/12/01']
    B = ['110/10/29', '1786', '科妍', '董事本人 及由受託人持有者', '韓開程', '贈與', '', '', '陳翰杰',
         '0', '1,573,250', '0', '123,250', '0', '1,450,000', '110/10/29 ~ 110/10/31']
    pa, pb = parse_cells(A), parse_cells(B)
    ok('① 解析:日期西元、代號、身分、方式、股數', pa and pa['date'] == '2026-10-30' and pa['code'] == '3006' and pa['method'].startswith('一般交易')
       and pa['plan_own_n'] == 1621000 and pa['ok'], pa)
    ok('① 信託那欄也對得上(贈與:自有 0、信託 1,573,250 − 123,250 = 1,450,000)', pb and pb['ok'] and pb['plan_trust_n'] == 123250, pb)
    pc = parse_cells(['撤銷'] + A)
    ok('② 日期前面多一格(異動情形)→ 放 chg、其餘照對', pc and pc['chg'] == '撤銷' and pc['code'] == '3006' and pc['ok'], pc)
    shifted = A[:6] + A[7:] + ['']                                   # 少一格(欄位往前錯一位)
    ok('③ 決定性對照:欄位錯一位 → 恆等式對不上(ok=False)', parse_cells(shifted) and parse_cells(shifted)['ok'] is False, parse_cells(shifted))
    ok('③ 沒有日期 + 代號那兩格 → None', parse_cells(['公司代號', '名稱'] + [''] * 20) is None)
    html = '<table>' + ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in (A, B)) + \
           '<tr><th>申報日期</th><th>公司代號</th></tr></table>'
    ok('④ 分類:有列 ok', classify(200, html) == 'ok')
    ok('④ 「無持股轉讓之情形」→ empty(那天 0 筆,⛔ 不是錯)', classify(200, "<h4><font color='red'>無持股轉讓之情形</font></h4>") == 'empty')
    ok('④ 被擋 / 502 / 看不懂的網頁 → blocked / fail / fail',
       classify(200, '因為安全性考量') == 'blocked' and classify(502, html) == 'fail' and classify(200, '<html>別的網頁</html>') == 'fail')
    t = {'run': '', 'step': '2', 'year': '115', 'month': '10', 'day': '30', 'report': 'SY', 'firstin': 'true'}
    f2 = second_form(t, date(2021, 3, 5))
    ok('⑤ 學到的第二層表單換日期:民國年、補 0、其他欄位一個都不動',
       f2 == {'run': '', 'step': '2', 'year': '110', 'month': '03', 'day': '05', 'report': 'SY', 'firstin': 'true'}, f2)
    ok('⑤ 決定性對照:學到的表單換回同一天 == 原表單', second_form(t, date(2026, 10, 30)) == t)
    mb = months_back('2026-08', date(2026, 10, 20))
    ok('⑥ 月份由新到舊、含起點', mb == ['2026-10', '2026-09', '2026-08'], mb)
    wd = [date(2026, 9, d) for d in range(1, 21) if date(2026, 9, d).weekday() < 5]
    doc = {'days': {d.isoformat(): {'sii': 0, 'otc': 0} for d in wd}, 'rows': []}
    ok('⑦ 整月兩個市場都 0 筆 → 可疑(⛔ 不寫)', month_verdict(doc, wd)[0] is False)
    for d in wd[:10]:
        doc['days'][d.isoformat()] = {'sii': 3, 'otc': 1}
    doc['rows'] = [['sii'] + A] * 12
    ok('⑦ 大部分有資料 + 恆等式對得上 → 照寫', month_verdict(doc, wd)[0] is True, month_verdict(doc, wd))
    doc['rows'] = [['sii'] + shifted] * 12
    ok('⑦ 決定性對照:同一個月欄位錯位 → ⛔ 不寫', month_verdict(doc, wd)[0] is False, month_verdict(doc, wd))

    # ⑧ Fetcher:先兩層 → 連續 2 天對上才直接送第二層;直接送失敗退回兩層
    class R:
        def __init__(self, text, code=200):
            self.text, self.status_code, self.encoding = text, code, 'utf-8'
    calls = []
    page = "<form><input name='encodeURIComponent' value='1'><input name='step' value='1'><input name='firstin' value='1'>" \
           "<input name='year'><input name='month'><input name='day'></form>"

    def fake_post(method, url, form):
        calls.append((method, url.rsplit('/', 1)[-1], dict(form or {})))
        if method == 'GET':
            return R(page)
        if url.endswith('ajax_t56sb12_q1'):
            kv = ''.join(f"<input type='hidden' name='{k}' value='{v}'>" for k, v in
                         (('run', ''), ('step', '2'), ('year', form['year']), ('month', form['month']), ('day', form['day']),
                          ('report', 'SY'), ('firstin', 'true')))
            return R(f"<form name='autoForm' action='/mops/web/ajax_t56sb12' method='post'>{kv}</form>")
        if url.endswith('ajax_t56sb12'):
            return R(html if form.get('day') != '07' else "<h4>無持股轉讓之情形</h4>")
        return None
    fx = Fetcher(None, fake_post)
    res = [fx.fetch('sii', date(2026, 10, d)) for d in (30, 29, 28, 27)]
    kinds = [k for k, _ in res]
    n_first = sum(1 for c in calls if c[1] == 'ajax_t56sb12_q1')
    ok('⑧ 前 2 天走兩層(學表單)、第 3 天起直接送第二層', kinds == ['ok'] * 4 and n_first == 2 and fx.direct == 2, (kinds, n_first, fx.direct))
    ok('⑧ 直接送的表單 == 第一層會給的那份(只換日期)',
       [c[2] for c in calls if c[1] == 'ajax_t56sb12'][-1] == {'run': '', 'step': '2', 'year': '115', 'month': '10', 'day': '27',
                                                               'report': 'SY', 'firstin': 'true'}, calls[-1])
    k7, _ = fx.fetch('sii', date(2026, 10, 7))
    ok('⑧ 沒有申報的那天 → empty', k7 == 'empty', k7)
    calls.clear()

    def bad_direct(method, url, form):
        if url.endswith('ajax_t56sb12') and fx2.match.get('sii', 0) >= LEARN_OK and len([c for c in calls if c[1] == 'x']) == 0:
            calls.append(('POST', 'x', {}))
            return R('Unreachable Server', 502)
        return fake_post(method, url, form)
    fx2 = Fetcher(None, bad_direct)
    out2 = [fx2.fetch('sii', date(2026, 10, d))[0] for d in (30, 29, 28)]
    ok('⑧ 決定性對照:直接送回 502 → 退回兩層照樣拿到(⛔ 當成那天沒資料)', out2 == ['ok', 'ok', 'ok'] and fx2.match['sii'] == 1, (out2, fx2.match))

    # ⑨ ⭐ 走正式入口 main()(假 requests、假時鐘、暫存資料夾)
    import tempfile
    import types
    g = globals()
    saved = {k: g[k] for k in ('OUT_DIR', 'FROM', 'SLEEP', 'datetime')}
    saved_req, saved_sleep = sys.modules.get('requests'), time.sleep

    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 3, 10, 0, tzinfo=TW)

    def run_main(server):
        tmp = Path(tempfile.mkdtemp(prefix='insbf-'))
        cnt = {'n': 0}

        class Sess:
            def get(self, url, **k):
                cnt['n'] += 1
                return server('GET', url, None)

            def post(self, url, data=None, **k):
                cnt['n'] += 1
                return server('POST', url, data)
        fake = types.ModuleType('requests')
        fake.Session = Sess
        sys.modules['requests'] = fake
        g.update(OUT_DIR=tmp, FROM='2026-09', SLEEP=0, datetime=FakeDT)
        time.sleep = lambda s: None
        try:
            rc = main()
        finally:
            g.update(saved)
            time.sleep = saved_sleep
            if saved_req is not None:
                sys.modules['requests'] = saved_req
            else:
                sys.modules.pop('requests', None)
        st = json.loads((tmp / '_status.json').read_text(encoding='utf-8'))
        return rc, tmp, st, cnt['n']

    def good(method, url, form):
        if method == 'GET':
            return R(page)
        if url.endswith(('ajax_t56sb12_q1', 'ajax_t56sb12_q2')):
            rep = 'SY' if url.endswith('q1') else 'OY'
            kv = ''.join(f"<input type='hidden' name='{k}' value='{v}'>" for k, v in
                         (('run', ''), ('step', '2'), ('year', form['year']), ('month', form['month']), ('day', form['day']),
                          ('report', rep), ('firstin', 'true')))
            return R(f"<form name='autoForm' action='/mops/web/ajax_t56sb12' method='post'>{kv}</form>")
        roc = f"{form['year']}/{form['month']}/{form['day']}"
        row = [roc] + A[1:]
        return R('<table><tr>' + ''.join(f'<td>{c}</td>' for c in row) + '</tr></table>')
    rc, tmp, st, nreq = run_main(good)
    m9 = load_month.__globals__['gzip'].decompress((tmp / '2026-09.json.gz').read_bytes()) if (tmp / '2026-09.json.gz').exists() else b''
    d9 = json.loads(m9) if m9 else {}
    ok('⑨ main 跑完:9 月每個平日兩個市場都做完、每天 1 列、而且是那一天的', rc == 0 and len(d9.get('days', {})) == 22
       and all(v == {'sii': 1, 'otc': 1} for v in d9['days'].values()) and len(d9['rows']) == 44, (rc, d9.get('days', {}).get('2026-09-01'), len(d9.get('rows', []))))
    ok('⑨ 大部分走「直接送第二層」(一天 1 次請求)', st['last_run']['direct'] > 30 and st['last_run']['months_done'] == ['2026-10', '2026-09'],
       st['last_run'])
    blocked = lambda method, url, form: R('因為安全性考量,您的連線已被阻擋')
    rcb, tmpb, stb, nb = run_main(blocked)
    ok('⑨ 決定性對照:一直被擋 → 3 次就收工(⛔ 繼續打)、exit 1、什麼都不寫', rcb == 1 and stb['last_run']['reason'] == 'blocked'
       and stb['last_run']['blocks'] == BLOCK_MAX and nb <= BLOCK_MAX + 1 and not list(tmpb.glob('*.json.gz')), (rcb, stb['last_run'], nb))
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
