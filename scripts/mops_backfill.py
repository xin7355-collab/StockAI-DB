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
      MODE=detail KINDS=訂單,增資 DEEP_DIR=mops_deep OUT_DIR=mops_detail python3 scripts/mops_backfill.py   🔎 V82.7.5 第 2 步:那幾類的內文 → 金額
      python3 scripts/mops_backfill.py --selftest
"""
import calendar
import contextlib
import gzip
import io
import json
import os
import re
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


# ───────────────────────── 🔎 V82.7.5 公告內文(評估紀錄 58:「消息多大」)─────────────────────────
# 列表每列 onclick 帶 seq_no / spoke_time / spoke_date / co_id / TYPEK(mops_probe.row_actions 解析),照官方頁面上的
# t05st01_fm 表單(step=2)送出 = 那一則的內文。mops_probe detail 模式 run 46080900577 / 46082610081:10 / 10 則拿到、
# 每則約 0.8 秒、沒被擋。⛔ 欄位名一個都不猜:DETAIL_BASE 就是那張表單的預設欄位(印在那兩輪 log 裡)。
DETAIL_BASE = {'firstin': 'true', 'b_date': '', 'e_date': '', 'TYPEK': '', 'year': '', 'month': '', 'type': '', 'co_id': '',
               'spoke_date': '', 'spoke_time': '', 'seq_no': '', 'MEETING_STEP': '', 'MODEL': '', 'ITEM': '', 'step': '2', 'off': '1'}
DETAIL_KEYS = ('seq_no', 'spoke_time', 'spoke_date', 'co_id', 'TYPEK')


def detail_form(f):
    """那一列 onclick 給的欄位 → 內文表單;五個欄位缺一個 → None(⛔ 自己編)"""
    if not f or any(not str(f.get(k) or '').strip() for k in DETAIL_KEYS):
        return None
    return {**DETAIL_BASE, **{k: str(f[k]).strip() for k in DETAIL_KEYS}}


def parse_detail(html):
    """內文頁 → 說明欄文字(去標籤、截到「以上資料均由各公司…」之前);被擋 / 不是內文頁(沒有「說明」)→ ''"""
    if not html or mp.is_blocked(html):
        return ''
    say = mp.say_section(html, 5000)
    j = say.find('以上資料均由各公司')
    return (say[:j] if j != -1 else say).strip()


# 「消息多大」值得抓內文的那幾類 —— 看主旨(代子公司 / 其他 / 取得那幾桶裡的訂單、收購也撈回來;⛔ 動 mops_event_probe.classify)
_K_SKIP = re.compile(r'衍生性|有價證券|債券|基金|票券|貨幣市場|定期存款|附買回|理財|國庫券')
_K_ORDER = re.compile(r'訂單|採購案|標案|標得|得標|接獲|承攬|獲得.{0,20}(?:金額|合約|契約|採購)')
_K_CASH = re.compile(r'現金增資|私募|現增|發行新股')
_K_MA = re.compile(r'收購|併購|股份轉換|股權')
_K_CONSOL = re.compile(r'合併(?:財務|營收|報表|報告)')
_K_SEC = re.compile(r'股票|公司債|受益憑證')   # 🔎 V82.7.5 取得 / 處分的是股票、公司債 → 理財 / 投資,⛔ 本業的消息(11/26 光明處分台積電股票、元大證買公司債)
SIZE_KINDS = ('訂單', '增資', '收購', '處分', '取得', '庫藏股', '減資')


def size_kind(sub, cat):
    """主旨 + 類別 → '訂單' / '增資' / '收購' / '處分' / '取得' / '庫藏股' / '減資';其他 → ''(⛔ 抓內文)。
    ⛔ 有價證券 / 債券 / 基金 / 衍生性商品那種(公司拿閒錢買理財)一律不算 —— 那不是本業的消息。"""
    s, c = str(sub or ''), str(cat or '')
    if _K_SKIP.search(s) or c in ('finrep', 'selfprofit', 'confcall', 'clarify', 'attn', 'dividend', 'guarantee'):
        return ''
    loose = c in ('sub', 'other', 'asset', 'order')
    if c == 'order' or (loose and _K_ORDER.search(s)):
        return '訂單'
    if c == 'cash_inc' or (loose and _K_CASH.search(s) and not re.search(r'取得|認購|參與', s)):
        return '增資'
    if c == 'ma' or (loose and _K_MA.search(s) and not _K_CONSOL.search(s)):
        return '收購'
    if loose and '處分' in s:
        return '' if _K_SEC.search(s) else '處分'
    if loose and '取得' in s:
        return '' if _K_SEC.search(s) else '取得'
    if c == 'buyback':
        return '庫藏股'
    if c in ('cap_red_cash', 'cap_red_loss'):
        return '減資'
    return ''


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


# ── 🔎 V82.7.5 第 2 步:補歷史內文(MODE=detail;評估紀錄 58)──────────────────────────
#   讀 mops_deep 的月檔(主旨)→ 那幾類(KINDS,預設 訂單 / 增資 = 事先登記 H1 / H2 要用的)→ 重抓那一天的列表拿「詳細資料」參數
#   → 一則一則抓內文 → lib_mops_amount 抓金額 → 寫 mops_detail/{YYYY-MM}.json.gz(⛔ 全文、⛔ 進 data / gh-pages)。
#   存法:{'m', 'done': {'日期|市場': [做過的大小類]}, 'rows': [[代號, 日期, 時間, 大小類, 億元|None, 幣別|None, ev, seq_no]]}
#     ev:金額那句原文;'' = 抓過、說明欄沒金額;None = 沒抓到(那一列沒有參數)。
#   守門:被擋 → 退避、第 3 次收工(保留已抓的)・內文頁上的公司代號 ≠ 要的 → ⛔ 收、累積 MISMATCH_MAX 次 → 這一棒 ⛔ 推
#        ・連不上的那一天 ⛔ 標做完(下一棒再試)・時間用完 → 接力・空過守門(還有要做的、這一棒一則都沒抓到 → exit 1)
DEEP_DIR = Path(os.environ.get('DEEP_DIR') or 'mops_deep')
KINDS = tuple(k.strip() for k in (os.environ.get('KINDS') or '訂單,增資').split(',') if k.strip())
MISMATCH_MAX = 5
_CO_RE = re.compile(r'本資料由\s*[((][^))]{0,10}[))]\s*(\d{4,6}[A-Z]?)')
_CODE_RE = re.compile(r'^\d{4,6}[A-Z]?$')


def load_month_at(base, mo, empty):
    f = Path(base) / f'{mo}.json.gz'
    if not f.exists():
        return dict(empty)
    try:
        return json.loads(gzip.decompress(f.read_bytes()).decode('utf-8'))
    except Exception:
        return dict(empty)


def detail_targets(deep_doc, kinds, done):
    """mops_deep 一個月 → {(日期, 市場): [(代號, 時間, 主旨, 大小類)]};done['日期|市場'] 已做過的大小類跳過"""
    import mops_event_probe as MEP  # noqa: E402  主旨 → 類別(⛔ 第二份;在函式裡 import,list 模式用不到)
    out = {}
    for r in (deep_doc or {}).get('rows') or []:
        if not isinstance(r, list) or len(r) < 6 or not _CODE_RE.match(str(r[0])):
            continue
        k = size_kind(r[4], MEP.classify(r[4]))
        if not k or k not in kinds or k in ((done or {}).get(f'{r[2]}|{r[5]}') or []):
            continue
        out.setdefault((r[2], r[5]), []).append((str(r[0]), str(r[3]), str(r[4]), k))
    return out


def match_fields(acts, code, t, sub):
    """列表那一頁的參數 → 這一則的(代號 / 時間 / 主旨一樣;主旨對不上就用代號 + 時間,而且那個時間只有一則才算)"""
    f = acts.get((code, t, sub))
    if f:
        return f
    same = [v for (c, tt, _), v in acts.items() if c == code and tt == t]
    return same[0] if len(same) == 1 else None


def page_code(html):
    """內文頁頁首「本資料由 (上市公司) 2515 中工 公司提供」→ '2515';找不到 → None"""
    import html as _h
    t = re.sub(r'\s+', ' ', _h.unescape(re.sub(r'<[^>]+>', ' ', str(html or ''))))
    m = _CO_RE.search(t)
    return m.group(1) if m else None


def detail_row(code, d, t, kind, html, seq):
    """內文頁 → 一列;說明欄沒金額 → ev ''(= 抓過、沒有)"""
    import lib_mops_amount as LA  # noqa: E402
    say = parse_detail(html)
    a = LA.parse_amount(say) if say else None
    return [code, d, t, kind, LA.to_yi(a['amt']) if a else None, a['cur'] if a else None, a['ev'] if a else '', str(seq or '')]


def heal_rows(doc, deep):
    """🩹 V82.7.6 舊版本(amt_v < lib_mops_amount.AMT_V)的月檔:已存的列照現在的金額規則重算一次。
    原句(ev)判斷得出來的 → 改成重算值(沒金額 → ev '');值有變、或原句看不出來(LA.needs_body:增資、「金額」開頭)
    → 那一天×市場的那一類從 done 拿掉,這一棒照完整內文重抓(完整內文 = 最後的值)。
    ⛔ 碰 ev 是 '' / None 的(抓過沒金額 / 沒抓到;新規則只會拿掉金額、不會多抓到)。回 (改了幾列, 拿掉幾個「日子|市場」)"""
    import lib_mops_amount as LA  # noqa: E402
    mk_of = {(str(r[0]), r[2], r[3]): r[5] for r in (deep or {}).get('rows') or [] if isinstance(r, list) and len(r) >= 6}
    changed, drop = 0, {}
    for r in doc.get('rows') or []:
        if not isinstance(r, list) or len(r) < 8 or not r[6]:
            continue
        if LA.needs_body(r[6], r[3]):
            new, ev = [None, None], ''
        else:
            a = LA.reparse_ev(r[6])
            new, ev = ([LA.to_yi(a['amt']), a['cur']], a['ev']) if a else ([None, None], '')
            if new == [r[4], r[5]]:
                continue
        changed += 1
        r[4], r[5], r[6] = new[0], new[1], ev
        for mk in ([mk_of[(r[0], r[1], r[2])]] if (r[0], r[1], r[2]) in mk_of else ['sii', 'otc']):
            drop.setdefault(f'{r[1]}|{mk}', set()).add(r[3])
    for key, ks in drop.items():
        if key in doc.get('done', {}):
            left = [k for k in doc['done'][key] if k not in ks]
            if left:
                doc['done'][key] = left
            else:
                doc['done'].pop(key)
    doc['amt_v'] = LA.AMT_V
    return changed, len(drop)


def detail_main(sess=None, sleep=time.sleep, now=None, out_dir=None, deep_dir=None, kinds=None, max_min=None, frm=None):
    import lib_mops_amount as LA  # noqa: E402
    if sess is None:
        import requests
        sess = requests.Session()
    out_dir, deep_dir = Path(out_dir or OUT_DIR), Path(deep_dir or DEEP_DIR)
    kinds = tuple(kinds or KINDS)
    max_min = MAX_MIN if max_min is None else max_min
    t0 = time.time()
    today = ((now or datetime.now(TW)) - timedelta(days=1)).date()
    hdr = {**mp.UA, 'Referer': f'{mp.HOST}/mops/web/t05st01'}
    n = {'list': 0, 'det': 0, 'amt': 0, 'none': 0, 'nofield': 0, 'mism': 0, 'nohdr': 0, 'blocks': 0, 'fail': 0, 'days': 0, 'heal': 0, 'heal_days': 0}
    reason, more, pending = 'done', 0, 0

    def post(f):
        """回 (類別, 文字):'ok' / 'empty' / 'blocked'(第 3 次)/ 'fail';內文頁用 'page'(有沒有內容交給呼叫端判斷)"""
        for att in range(3):
            if n['blocks'] >= BLOCK_MAX:
                return 'blocked', ''
            try:
                r = sess.post(mp.HOST + PATH, data=f, headers=hdr, timeout=60)
                r.encoding = r.encoding or 'utf-8'
                txt = r.text or ''
                if mp.is_blocked(txt):
                    n['blocks'] += 1
                    print(f'   ⛔ 被擋(第 {n["blocks"]} 次)', flush=True)
                    if n['blocks'] >= BLOCK_MAX:
                        return 'blocked', ''
                    sleep(60 * 2 ** (n['blocks'] - 1))
                    continue
                if f.get('step') == '2':
                    return ('page' if r.status_code == 200 else 'fail'), txt
                return classify(r.status_code, txt), txt
            except Exception as e:  # noqa: BLE001
                print(f'   ⚠️ {type(e).__name__}: {str(e)[:80]}(第 {att + 1} 次)', flush=True)
                sleep(3 * (att + 1))
        n['fail'] += 1
        return 'fail', ''

    stop = False
    for mo in months_back(frm or FROM, today):
        if stop:
            break
        deep = load_month_at(deep_dir, mo, {'m': mo, 'days': {}, 'rows': []})
        if not deep.get('rows'):
            continue
        doc = load_month_at(out_dir, mo, {'m': mo, 'done': {}, 'rows': [], 'amt_v': LA.AMT_V})
        doc.setdefault('done', {})
        doc.setdefault('rows', [])
        if (doc.get('amt_v') or 1) < LA.AMT_V:            # 🩹 V82.7.6 舊規則抓的月檔 → 先重算(只做一次:做完寫 amt_v)
            hc, hd = heal_rows(doc, deep)
            n['heal'] += hc
            n['heal_days'] += hd
            if hc or hd:
                print(f'🩹 {mo}:金額規則 v{LA.AMT_V} 重算 → 改 {hc} 列、{hd} 個日子×市場重抓', flush=True)
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / f'{mo}.json.gz').write_bytes(gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')))
        tg = detail_targets(deep, kinds, doc['done'])
        if not tg:
            continue
        pending += sum(len(v) for v in tg.values())
        print(f'🔎 {mo}:要抓內文 {sum(len(v) for v in tg.values())} 則({len(tg)} 個日子×市場)', flush=True)
        have = {(r[0], r[1], r[2]): i for i, r in enumerate(doc['rows'])}
        for (d, mk), items in sorted(tg.items(), reverse=True):
            if (time.time() - t0) / 60 > max_min:
                reason, more, stop = 'time', 1, True
                break
            k, txt = post(form(mk, date.fromisoformat(d)))
            n['list'] += 1
            sleep(SLEEP)
            if k == 'blocked':
                reason, stop = 'blocked', True
                break
            if k != 'ok':
                continue                                     # 連不上 / 那天說查無(主旨那份明明有)→ ⛔ 標做完,下一棒再試
            acts = {(a['cells'][0], a['cells'][3], a['cells'][4]): a['fields']
                    for a in mp.row_actions(txt) if a['fields'] and len(a['cells']) >= 5}
            day_ok = True
            for code, t, sub, kind in items:
                fd = detail_form(match_fields(acts, code, t, sub))
                if not fd:
                    row, n['nofield'] = [code, d, t, kind, None, None, None, ''], n['nofield'] + 1
                else:
                    k2, html = post(fd)
                    sleep(SLEEP)
                    if k2 == 'blocked':
                        reason, stop, day_ok = 'blocked', True, False
                        break
                    if k2 != 'page' or not parse_detail(html):
                        day_ok = False                       # 連不上 / 不是內文頁 → 下一棒再試
                        continue
                    pc = page_code(html)
                    if pc is None:
                        n['nohdr'] += 1                      # 頁首沒有「本資料由 (…公司) 代號」→ 對不了,照收(另外計數)
                    elif pc != code:
                        n['mism'] += 1
                        day_ok = False
                        print(f'   ⚠️ 內文頁的公司代號對不上:要 {code}、拿到 {pc}({d} {t})', flush=True)
                        if n['mism'] >= MISMATCH_MAX:
                            reason, stop = 'mismatch', True
                            break
                        continue
                    row = detail_row(code, d, t, kind, html, fd.get('seq_no'))
                    n['det'] += 1
                    n['amt' if row[4] is not None else 'none'] += 1
                key = (code, d, t)
                if key in have:
                    doc['rows'][have[key]] = row
                else:
                    have[key] = len(doc['rows'])
                    doc['rows'].append(row)
            if day_ok and not stop:
                doc['done'][f'{d}|{mk}'] = sorted(set(doc['done'].get(f'{d}|{mk}') or []) | set(kinds))
                n['days'] += 1
            out_dir.mkdir(parents=True, exist_ok=True)
            doc['rows'].sort(key=lambda r: (r[1], r[2], r[0]))
            have = {(r[0], r[1], r[2]): i for i, r in enumerate(doc['rows'])}
            (out_dir / f'{mo}.json.gz').write_bytes(gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')))
            if stop:
                break
    push = (n['det'] > 0 or n['heal'] > 0 or n['heal_days'] > 0) and reason != 'mismatch'   # 🩹 只有修正也要推
    if reason == 'done' and pending == 0:
        print('✅ 這幾類的內文全部抓完了(沒有要做的)', flush=True)
    elif n['det'] == 0 and reason != 'time':
        print(f'❌ 還有 {pending} 則要做、這一棒一則都沒抓到(空過守門;{reason})', flush=True)
    st_path = out_dir / '_status.json'
    try:
        status = json.loads(st_path.read_text(encoding='utf-8')) if st_path.exists() else {}
    except Exception:
        status = {}
    status.update({'updated': datetime.now(TW).isoformat(timespec='minutes'), 'kinds': list(kinds), 'amt_v': LA.AMT_V,
                   'months': sorted(p.name[:7] for p in out_dir.glob('*.json.gz')) if out_dir.exists() else [],
                   'last_run': {'reason': reason, **n, 'pending_seen': pending}})
    out_dir.mkdir(parents=True, exist_ok=True)
    st_path.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding='utf-8')
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f'more={more}\nreason={reason}\npush={1 if push else 0}\n')
    print(f'🏁 {reason} ・列表 {n["list"]} 次 ・內文 {n["det"]} 則(有金額 {n["amt"]}、沒有 {n["none"]})・沒有參數 {n["nofield"]}'
          f' ・代號對不上 {n["mism"]} ・被擋 {n["blocks"]} ・連不上 {n["fail"]} ・做完 {n["days"]} 個日子×市場'
          f' ・🩹 修正 {n["heal"]} 列(重抓 {n["heal_days"]} 個日子×市場)・{round((time.time() - t0) / 60, 1)} 分', flush=True)
    if reason == 'mismatch':
        return 1
    return 0 if (n['det'] > 0 or reason == 'time' or pending == 0) else 1


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
    # ⑦ 🔎 V82.7.5 內文表單 / 解析 / 哪幾類要抓(主旨是 2026-11-27 的真主旨)
    fld = {'seq_no': '1', 'spoke_time': '153520', 'spoke_date': '20261127', 'co_id': '4588', 'TYPEK': 'sii'}
    df = detail_form(fld)
    ok('⑦ 內文表單 = 官方 t05st01_fm 預設 + 那一列五個欄位(step=2)', df and df['step'] == '2' and df['co_id'] == '4588'
       and df['seq_no'] == '1' and set(DETAIL_BASE) <= set(df), df)
    ok('⑦ 決定性對照:少一個欄位(seq_no)→ None(⛔ 自己編)', detail_form({k: v for k, v in fld.items() if k != 'seq_no'}) is None)
    pg = '<html>公開資訊觀測站 本資料由 (上市公司) 4588 玖鼎電力 公司提供 序號 1<table><tr><td>說明</td><td>1.事實發生日:115/11/27 5.主要內容:取得訂單金額約1.64億元</td></tr></table>以上資料均由各公司依發言當時所屬市場別之規定申報後 <script>x</script></html>'
    pd = parse_detail(pg)
    ok('⑧ 內文解析:從「說明」開始、截到「以上資料均由各公司」之前', pd.startswith('說明') and '1.64億元' in pd and '以上資料' not in pd, pd)
    ok('⑧ 被擋 / 不是內文頁 → 空字串', parse_detail('因為安全性考量') == '' and parse_detail('<html>別的網頁</html>') == '')
    import mops_event_probe as MEP  # noqa: E402
    subs = {'本公司獲得台電公司「模組化智慧型電表」金額約 新台幣1.64億元(未稅)': '訂單',
            '代子公司矽品精密工業(股)公司公告取得營業用機器設備達十億元': '取得',
            '本公司處分華亞廠不動產及其相關廠務附屬設施': '處分',
            '本公司子公司取得南京能利芯科技有限公司100%股權': '收購',
            '公告本公司115年現金增資認股基準日等相關事宜 (補充每股發行價格暨代收及存儲專戶銀行)': '增資',
            '代子公司友達智慧行動系統(廈門)有限公司公告取得不動產使用權資產': '取得',
            '公告本公司將參加國泰證舉辦之「Non-Deal Roadshow」': '',
            '代子公司公告取得有價證券': '',
            '公告本公司董事會通過合併財務報告': '',
            '公告本公司董事會決議減資彌補虧損': '減資',
            # 🔎 11/26~27 真主旨:取得 / 處分的是股票、公司債(理財)→ ⛔;同一天的土地建物 → 取得(決定性對照)
            '本公司處分台灣積體電路製造(股)公司 普通股股票達實收資本額百分之二十': '',
            '元大金控代子公司元大證券公告取得元大金控115年度第二次無擔保普通公司債': '',
            '公告本公司一年內累積取得日本豐田自動車株式會社 (TOYOTA MOTOR CORPORATION)股票達新台幣三億元': '',
            '公告本公司取得土地及地上建物之相關資訊': '取得'}
    got = {k: size_kind(k, MEP.classify(k)) for k in subs}
    ok('⑨ 哪幾類要抓內文(11/26~27 真主旨):訂單 / 取得 / 處分 / 收購 / 增資 / 減資;法說 / 理財(含股票 / 公司債)/ 財報 ⛔',
       got == subs, {k[:16]: (v, subs[k]) for k, v in got.items() if v != subs[k]})
    # ⑩ 🔎 V82.7.5 第 2 步:補歷史內文(MODE=detail)—— 假網路走正式入口 detail_main()
    import tempfile
    tmpd = Path(tempfile.mkdtemp())
    deep_d, out_d = tmpd / 'deep', tmpd / 'det'
    deep_d.mkdir()
    DROWS = [['4588', '玖鼎電力', '2012-03-15', '15:35:20', '本公司獲得台電公司標案訂單', 'sii'],
             ['2515', '中工', '2012-03-15', '15:43:17', '本公司董事會決議辦理現金增資發行新股', 'sii'],
             ['2330', '台積電', '2012-03-15', '13:54:04', '公告本公司將參加法人說明會', 'sii'],
             ['2409', '友達', '2012-03-15', '16:00:10', '本公司處分華亞廠不動產', 'sii'],
             ['8077', '洛碁', '2012-03-14', '08:35:47', '本公司接獲訂單', 'otc']]
    (deep_d / '2012-03.json.gz').write_bytes(gzip.compress(json.dumps({'m': '2012-03', 'days': {}, 'rows': DROWS}, ensure_ascii=False).encode('utf-8')))
    DSAY = {'4588': '說明 5.主要內容:取得訂單金額約1.64億元(新台幣,未稅) 6.限制條款:無',
            '2515': '說明 3.交易數量、每單位價格及交易總金額: 99,200仟股,每股5元,總金額為496,000仟元 4.交易相對人:京華城',
            '2409': '說明 5.交易總金額:新台幣197億元(未稅)',
            '8077': '說明 1.事實發生日:101/03/14 2.契約相對人:某公司'}

    class _R:
        def __init__(self, t, code=200):
            self.text, self.status_code, self.encoding = t, code, 'utf-8'

    def fake(mode=''):
        calls = []

        class S:
            def post(self, url, data=None, headers=None, timeout=None):
                if data.get('step') == '2':
                    calls.append(('det', data['co_id']))
                    if mode == 'block':
                        return _R('因為安全性考量,您的連線已被阻擋')
                    code = data['co_id'] if mode != 'wrongco' else '9999'
                    hdr = '' if mode == 'nohdr' else f'本資料由 (上市公司) {code} 某公司 公司提供 序號 {data["seq_no"]}'
                    return _R(f'<html>{hdr}<table><tr><td>{DSAY.get(data["co_id"], "說明 1.事實發生日")}</td></tr></table>以上資料均由各公司依規定申報</html>')
                calls.append(('list', data['TYPEK'], data['year'], data['month'], data['b_date']))
                d = date(int(data['year']) + 1911, int(data['month']), int(data['b_date']))
                rr = [r for r in DROWS if r[2] == d.isoformat() and r[5] == data['TYPEK']]
                roc = f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'
                oc = ("document.t05st01_fm.seq_no.value='{q}';document.t05st01_fm.spoke_time.value='{t}';document.t05st01_fm.spoke_date.value='{d}';"
                      "document.t05st01_fm.co_id.value='{c}';document.t05st01_fm.TYPEK.value='{mk}';openWindow(this.form ,'');")
                body = ''.join(f'<tr><td>{r[0]}</td><td>{r[1]}</td><td>{roc}</td><td>{r[3]}</td><td>{r[4] + (" " if mode == "subdiff" else "")}</td>'
                               f'<td><input type=button value="詳細資料" onclick="{oc.format(q=i + 1, t=int(r[3].replace(":", "")), d=d.strftime("%Y%m%d"), c=r[0], mk=r[5])}"></td></tr>'
                               for i, r in enumerate(rr))
                return _R(f'<table>{body}</table>' if rr else '<html>資料庫中查無需求資料</html>')
        return S(), calls

    def run_d(mode='', kinds=('訂單', '增資'), out=None, mm=999):
        s_, c_ = fake(mode)
        buf, gho = io.StringIO(), tmpd / 'gho.txt'
        gho.write_text('')
        keep_go = os.environ.get('GITHUB_OUTPUT')
        os.environ['GITHUB_OUTPUT'] = str(gho)
        try:
            with contextlib.redirect_stdout(buf):
                rc_ = detail_main(sess=s_, sleep=lambda x: None, now=datetime(2026, 11, 28, 9, 0, tzinfo=TW), out_dir=out or out_d, deep_dir=deep_d,
                                  kinds=kinds, max_min=mm, frm='2012-01')
        finally:
            if keep_go is None:
                os.environ.pop('GITHUB_OUTPUT', None)
            else:
                os.environ['GITHUB_OUTPUT'] = keep_go
        f_ = Path(out or out_d) / '2012-03.json.gz'
        doc_ = json.loads(gzip.decompress(f_.read_bytes())) if f_.exists() else {'done': {}, 'rows': []}
        go = dict(x.split('=', 1) for x in gho.read_text().split() if '=' in x)
        return rc_, doc_, c_, buf.getvalue() + f"\n[gho] push={go.get('push')} more={go.get('more')} reason={go.get('reason')}"

    rc1, d1, c1, log1 = run_d()
    R1 = {r[0]: r for r in d1['rows']}
    ok('⑩ 只抓那幾類(訂單 / 增資):玖鼎、中工、洛碁 3 則內文(⛔ 法說會、⛔ 處分 —— 這一棒沒選)',
       sorted(x[1] for x in c1 if x[0] == 'det') == ['2515', '4588', '8077'] and '2330' not in R1 and '2409' not in R1, c1)
    ok('⑩ 金額:玖鼎 1.64 億、中工 4.96 億(每股5元 ⛔)、洛碁說明欄沒金額 → ev 空字串',
       R1.get('4588', [0] * 8)[4] == 1.64 and R1.get('2515', [0] * 8)[4] == 4.96 and R1.get('8077', [0] * 8)[6] == '' and R1['8077'][4] is None, d1['rows'])
    ok('⑩ 列表只抓有目標的日子 × 市場(3/15 上市、3/14 上櫃 = 2 次)', sum(1 for x in c1 if x[0] == 'list') == 2, [x for x in c1 if x[0] == 'list'])
    ok('⑩ 兩個日子都標做完(訂單 / 增資)', d1['done'].get('2012-03-15|sii') == ['增資', '訂單'] and d1['done'].get('2012-03-14|otc') == ['增資', '訂單'], d1['done'])
    rc2, d2, c2, _ = run_d()
    ok('⑪ 續跑:做過的 0 次請求(rc 0 = 全部抓完)', rc2 == 0 and not c2 and len(d2['rows']) == 3, (rc2, c2))
    rc3, d3, c3, _ = run_d(kinds=('訂單', '增資', '處分'))
    ok('⑪ 多選一類(處分)→ 只抓友達那 1 則、舊的不重抓', [x[1] for x in c3 if x[0] == 'det'] == ['2409'] and len(d3['rows']) == 4
       and d3['done'].get('2012-03-15|sii') == ['增資', '處分', '訂單'], (c3, d3['done']))
    rc4, d4, c4, log4 = run_d(mode='block', out=tmpd / 'b')
    ok('⑫ 被擋 → 第 3 次收工、那一天 ⛔ 標做完、rc 1(空過)', rc4 == 1 and not d4['done'] and '被擋' in log4 and 'blocked' in log4, (rc4, d4['done']))
    keep_mm = MISMATCH_MAX
    globals()['MISMATCH_MAX'] = 2
    try:
        rc5, d5, c5, log5 = run_d(mode='wrongco', out=tmpd / 'w')
    finally:
        globals()['MISMATCH_MAX'] = keep_mm
    ok('⑫ ⭐ 內文頁的公司代號對不上 → ⛔ 收、⛔ 標做完;累積到上限 → 收工 mismatch、rc 1、push 0(⛔ 推)',
       rc5 == 1 and not d5['rows'] and not d5['done'] and 'push=0' in log5 and 'reason=mismatch' in log5
       and sum(1 for x in c5 if x[0] == 'det') == 2, (rc5, d5, log5[-220:]))
    rc6, d6, c6, log6 = run_d(mode='nohdr', out=tmpd / 'n')
    ok('⑫ 頁首沒有代號(對不了)→ 照收、另外計數', rc6 == 0 and len(d6['rows']) == 3 and '代號對不上 0' in log6, (rc6, log6[-200:]))
    rc7, d7, c7, _ = run_d(mode='subdiff', out=tmpd / 's')
    ok('⑬ 主旨對不上(多一個空白)→ 用代號 + 時間對(那個時間只有一則)', rc7 == 0 and len([r for r in d7['rows'] if r[4] is not None]) == 2, d7['rows'])
    rc8, d8, c8, log8 = run_d(out=tmpd / 't', mm=-1)
    ok('⑬ 時間用完 → reason time、rc 0、more 1(接力)、⛔ 標做完', rc8 == 0 and not d8['done'] and 'more=1' in log8 and 'reason=time' in log8, log8[-160:])
    ok('⑩ 第一棒:push 1、more 0(做完了)', 'push=1' in log1 and 'more=0' in log1, log1[-120:])
    ok('⑬ 內文頁代號解析:頁首去掉標籤後找「本資料由 (上市公司) 代號」;沒有 → None',
       page_code('<p>本資料由&nbsp;<b>(上櫃公司)</b> 8077 洛碁 公司提供</p>') == '8077' and page_code('<html>別的網頁</html>') is None)
    # ⑭ 🩹 V82.7.6 舊規則抓的月檔讀進來先重算:乘錯(股數 × 總額)/ 越南盾當新台幣 → 改值 + 那一天拿掉 done → 重抓;正常列不動
    hd_ = tmpd / 'h'
    hd_.mkdir()
    old = {'m': '2012-03', 'done': {'2012-03-15|sii': ['增資', '訂單'], '2012-03-14|otc': ['增資', '訂單']},
           'rows': [['2515', '2012-03-15', '15:43:17', '增資', 245462344.0, 'TWD', '發行股數:普通股44,600,000股・發行價格計算，新台幣550,364,000元', '2'],
                    ['4588', '2012-03-15', '15:35:20', '訂單', 4737.73, 'TWD', '交易總金額為越南盾473,772,812,805元', '1'],
                    ['8077', '2012-03-14', '08:35:47', '訂單', None, None, '', '1']]}
    (hd_ / '2012-03.json.gz').write_bytes(gzip.compress(json.dumps(old, ensure_ascii=False).encode('utf-8')))
    rc9, d9, c9, log9 = run_d(out=hd_)
    R9 = {r[0]: r for r in d9['rows']}
    ok('⑭ 🩹 舊月檔先重算:乘錯那列 + 越南盾那列 → 那一天(3/15 上市)拿掉 done → 照完整內文重抓兩則;3/14 上櫃 ⛔ 動(0 次請求)',
       sorted(x[1] for x in c9 if x[0] == 'det') == ['2515', '4588'] and not any(x[0] == 'list' and x[4] == '14' for x in c9)
       and '修正 2 列' in log9 and '重抓 1 個' in log9, (c9, log9[-300:]))
    ok('⑭ 重抓後是完整內文的值(2515 4.96 億、4588 1.64 億)、檔頭 amt_v 2、done 補回、push 1(只有修正也推)',
       R9['2515'][4] == 4.96 and R9['4588'][4] == 1.64 and d9.get('amt_v') == 2 and d9['done'].get('2012-03-15|sii') == ['增資', '訂單'] and 'push=1' in log9,
       (d9.get('amt_v'), d9['done'], log9[-120:]))
    rc10, d10, c10, log10 = run_d(out=hd_)
    ok('⑭ 第二次:amt_v 已經是 2 → ⛔ 再重算、0 次請求(⛔ 每一棒都重抓)', not c10 and '修正 0 列' in log10, (c10, log10[-160:]))
    hn_ = tmpd / 'hn'
    hn_.mkdir()
    good = {'m': '2012-03', 'done': {'2012-03-15|sii': ['增資', '訂單'], '2012-03-14|otc': ['增資', '訂單']},
            'rows': [['2515', '2012-03-15', '15:43:17', '增資', 15.46, 'TWD', '募集金額為新台幣1,546,228仟元', '2'],
                     ['4588', '2012-03-15', '15:35:20', '訂單', 1.64, 'TWD', '主要內容:取得訂單金額約1.64億元', '1']]}
    (hn_ / '2012-03.json.gz').write_bytes(gzip.compress(json.dumps(good, ensure_ascii=False).encode('utf-8')))
    rc11, d11, c11, log11 = run_d(out=hn_)
    ok('⑭ ⭐ 決定性對照:舊月檔但全部正常 → 0 列改、done 不動、0 次請求、只寫 amt_v、push 0',
       not c11 and d11['done'] == good['done'] and d11.get('amt_v') == 2 and [r[4] for r in d11['rows']] == [15.46, 1.64] and 'push=0' in log11,
       (c11, d11['done'], log11[-160:]))
    hh_ = tmpd / 'hh'
    hh_.mkdir()
    gen = {'m': '2012-03', 'done': {'2012-03-15|sii': ['增資', '訂單']},
           'rows': [['2515', '2012-03-15', '15:43:17', '增資', 1.0, 'TWD', '金額:新台幣100,000,000元', '2']]}
    (hh_ / '2012-03.json.gz').write_bytes(gzip.compress(json.dumps(gen, ensure_ascii=False).encode('utf-8')))
    d12 = {'rows': [list(x) for x in gen['rows']], 'done': {k: list(v) for k, v in gen['done'].items()}}
    hc12, hdd12 = heal_rows(d12, {'rows': DROWS})
    ok('⑭ 增資「金額:」開頭(看不到前面是不是「發行總」)→ 先清掉金額、只拿掉「增資」那一類重抓(訂單照舊)',
       hc12 == 1 and hdd12 == 1 and d12['rows'][0][4] is None and d12['done'].get('2012-03-15|sii') == ['訂單'], (hc12, hdd12, d12))
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else (detail_main() if os.environ.get('MODE') == 'detail' else main()))
