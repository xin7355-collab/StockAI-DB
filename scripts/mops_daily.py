#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📢 每天的「重大訊息」+「股權轉讓事前申報」(V82.2.9,使用者 11/13 選「兩份都收」)

為什麼要這支:歷史早就回補好了(重大訊息 `mops_deep` 2010 起、申報轉讓 `insider_deep` 2010 起),
但只是研究用 —— App 沒有「每天」那一份,所以避雷專欄(減資彌補虧損 / 庫藏股買完)在你的庫存永遠跳不出來,
週報也沒辦法列「你的股票這週發生的事」。

⭐ 一個字都不自己解析:
   重大訊息 = `mops_backfill.form / classify / parse_rows`(端點、參數、民國年都在那)、分類 = `mops_event_probe.classify`
   申報轉讓 = `insider_backfill.Fetcher / parse_cells`(兩層表單照官方給的學)、分類 = `insider_event_probe.method_cls / role_cls`
   ⛔ 自己不抄第二份;那幾支改了,這裡跟著變。

每次跑:抓「今天 + 前一個平日」× 上市 / 上櫃 → 晚上才公告的,隔天那輪會補到。一天約 10~14 次請求。
⚠️ 休市日 MOPS 回「查無」→ 那天記 0 筆(同 backfill);⛔ 另外抓休市表(多一個請求、也多一個會壞的地方)。
輸出(只留最近 KEEP_DAYS 個日曆天;同一天同一市場重抓 = 整天換掉 → 冪等):
   data/mops_recent.json      cols = s 代號 / n 名稱 / d 日期 / t 時間 / sub 主旨 / mk 市場 / cat 類別
                              + 🔎 V82.7.5 kind 大小類(訂單 / 增資 / 收購 / 處分 / 取得 / 庫藏股 / 減資,mops_backfill.size_kind)
                                / amt 金額(億,那則自己的幣別)/ cur 幣別 / ev 金額那句原文(≤120 字)
                              ⭐ 金額 = 內文說明欄照 lib_mops_amount 明文規則抓(⛔ AI);只有那幾類才抓內文、每輪最多 DETAIL_MAX 則,
                                 上一份抓過的同一則直接沿用(⛔ 每輪重抓);被擋 / 不是內文頁 → amt 留空(⛔ 寫 0)。
                                 amt = None 且 ev = None → 還沒抓;ev = '' → 抓了、說明欄沒有金額。舊的 7 欄列補空欄位(⛔ 丟掉)
   data/insider_recent.json   cols = s / n / d 申報日 / role 身分 / rc 身分類 / method 方式 / mc 方式類 / sh 預定轉讓股數 / chg 異動 / mk
   <MD_OUT>/mops_daily_patch.json  這一輪抓到的「今天以前」那幾天(研究分支要的原文格式)→ `--apply-deep` 併進研究分支
       (workflow 推研究分支失敗 → 重抓分支、再併一次;⛔ 對二進位月檔 rebase)

守門:
   ① 被擋(「因為安全性考量」)→ 退避 60 / 120 秒,第 3 次就整輪收工(⛔ 硬打);已抓到的照寫
   ② 這一輪一次都沒成功(全部被擋 / 連不上)→ ⛔ 不覆蓋舊檔、exit 1(紅燈)
   ③ 某一天某個市場這次 0 筆、但上一份有 → 多半是被擋或還沒好 → 保留上一份那天的、印 ⚠️(⛔ 用 0 蓋掉)
   ④ 累積檔讀壞了 → ⛔ 不寫回(lib_jsonsafe.load_accum,陷阱 #61)
   ⑤ 今天 ⛔ 進研究分支(今天還沒結束;這一輪在隔天傍晚跑 → 昨天已經結束);研究分支同一天同一市場這次 0 筆但原本有 → 不動
   ⑥ App 那份只收股票 / ETF 代號(4~6 碼);申報轉讓只收「目前持股 − 預定轉讓 = 轉讓後持股」對得上的列(欄位錯位就不收)
      研究分支那份照 backfill 的存法(原文、⛔ 篩)—— 兩邊同一份資料,只是用途不同
   ⑦ 🔁 V82.3.1 連線被重設 / 逾時 → 等 5 / 15 / 30 秒再試;第一輪跑完還有沒抓到的 → 等 60 秒每個再試一次;
      最後還是沒抓到 → log 與 Step Summary 寫是哪一天哪個市場、記進檔頭 miss、研究分支 ⛔ 標完成。
      App 照 days 有沒有那一格判斷「那天那市場沒抓到」(⛔ 說成沒有公告)

跑法:python3 scripts/mops_daily.py
      MD_DEEP_MOPS=<mops_deep 資料夾> python3 scripts/mops_daily.py --apply-deep <patch> --only mops
      MD_DEEP_INS=<insider_deep 資料夾> python3 scripts/mops_daily.py --apply-deep <patch> --only insider
      python3 scripts/mops_daily.py --selftest
"""
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(1, str(_HERE.parent))
import mops_probe as mp              # noqa: E402  host / UA / 被擋偵測 只有一份
import mops_backfill as MB           # noqa: E402  重大訊息 表單 / 分類 / 解析 / 月檔
import insider_backfill as IB        # noqa: E402  申報轉讓 兩層表單 / 解析 / 月檔
import mops_event_probe as MEP       # noqa: E402  重大訊息主旨 → 類別(⛔ 第二份)
import lib_mops_amount as LA         # noqa: E402  🔎 V82.7.5 內文說明欄 → 金額(⛔ 第二份)
import insider_event_probe as IEP    # noqa: E402  申報 身分 / 方式 → 分類(⛔ 第二份)
from lib_jsonsafe import load_accum  # noqa: E402  累積檔讀壞 ⛔ 當成沒有

TW = timezone(timedelta(hours=8))
OUT = Path(os.environ.get('MD_OUT') or 'data')
DEEP_MOPS = Path(os.environ.get('MD_DEEP_MOPS') or 'mops_deep')
DEEP_INS = Path(os.environ.get('MD_DEEP_INS') or 'insider_deep')
BACK = min(10, max(1, int(os.environ.get('MD_BACK') or '2')))  # 抓幾個平日(含今天;最多 10)
KEEP_DAYS = max(2, int(os.environ.get('MD_KEEP') or '14'))      # 最近幾個日曆天
SLEEP = float(os.environ.get('MOPS_SLEEP') or '1.2')
BLOCK_MAX = 3
# 🔁 V82.3.1 第一次實跑(11/13)連線被重設 4 次 → 漏了 11/13 上櫃重大訊息、11/12 上市申報轉讓,log 還沒寫是哪一天哪個市場。
#   連線錯誤(被重設 / 逾時)→ 等 5 / 15 / 30 秒再試(一共試 4 次);第一輪跑完還有沒抓到的 → 等 60 秒、每個再試一次。
#   退避加起來最多 WAIT_BUDGET 秒(⛔ 一直連不上時把 20 分鐘的時限吃光)。
CONN_WAIT = (5, 15, 30)
PASS2_WAIT = 60
WAIT_BUDGET = 600
MARKETS = ('sii', 'otc')
_CODE = re.compile(r'^\d{4,6}[A-Z]?$')
# 避雷那兩類(mops_event_probe 16 年:能當買進理由的 0 類、之後比較差的就這兩類)—— App 讀這張表顯示名字
AVOID = {'buyback_end': '庫藏股買完 / 期滿 / 註銷', 'cap_red_loss': '減資彌補虧損'}
MOPS_FILE, INS_FILE, PATCH_FILE = 'mops_recent.json', 'insider_recent.json', 'mops_daily_patch.json'
MOPS_COLS = ['s', 'n', 'd', 't', 'sub', 'mk', 'cat', 'kind', 'amt', 'cur', 'ev', 'nw']
MOPS_COLS_OLD = 7                     # V82.7.5 以前的列只有 7 欄 → merge_recent 補空欄位
DETAIL_MAX = max(0, int(os.environ.get('MD_DETAIL_MAX') or '60'))   # 🔎 每輪最多抓幾則內文(每則約 0.8 秒 + SLEEP)
INS_COLS = ['s', 'n', 'd', 'role', 'rc', 'method', 'mc', 'sh', 'chg', 'mk']
SRC_MOPS = '公開資訊觀測站 重大訊息(t05st01,全市場單日)'
SRC_INS = '公開資訊觀測站 股權轉讓事前申報日報表(t56sb12)'


# ───────────────────────── 純函式(--selftest 直接打) ─────────────────────────
def target_days(today, back=None):
    """今天往回 back 個平日(含今天;今天是週末 → 從上一個平日算)。由舊到新。"""
    back = BACK if back is None else back
    out, d = [], today
    while len(out) < back:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return sorted(out)


def mops_app_rows(raw, mk):
    """backfill 格式 [代號, 名稱, 日期, 時間, 主旨, 市場] → App 用的列(只收代號、加類別 + 🔎 大小類;金額三欄先空著)。"""
    out = []
    for r in raw:
        if not _CODE.match(str(r[0])):
            continue
        cat = MEP.classify(r[4])
        out.append([r[0], r[1], r[2], r[3], r[4], mk, cat, MB.size_kind(r[4], cat), None, None, None, None])
    return out


# 📰 V82.7.5「新聞也報」:同一檔、公告那天的前一天 ~ 後一天,新聞標題講到同一類的有幾則(data/news_buzz.json 的 t,
#   news_buzz_miner 已經只收「標題真的講到這一檔」的;⛔ 論壇貼文)。只描述 —— 新聞多寡研究過沒有預測力(EXP-20261128-01)。
#   ⛔ 反過來用新聞猜「只有新聞、公司沒公告」:11/24~26 實測 3 天 75 則候選(嚴格版 10 則)幾乎全是評論 / 舊聞 / 認錯公司 → 不做。
NEWS_FILE = 'news_buzz.json'
NW_KW = {'訂單': r'訂單|接單|大單|得標|標案|採購案|簽約|合約',
         '增資': r'增資|現增|募資|私募|發行新股|存託憑證|GDR',
         '收購': r'收購|併購|合併|入股',
         '處分': r'處分|出售|售地|賣地|賣廠|出脫',
         '取得': r'取得|購置|買地|購地|買廠|購廠|擴廠|建廠',
         '庫藏股': r'庫藏股|買回',
         '減資': r'減資|退還股款'}
NW_SKIP = re.compile(r'股市爆料同學會|個股概覽|討論區|PTT|Dcard', re.I)


def news_count(rows, cols, buzz):
    """rows(照 cols 的 list)→ 就地寫 nw 欄,回 {'hit','zero','na'}。
    那幾天都沒有標題紀錄(不在新聞熱度名單 / 標題只留 10 天)→ 不動(新的列 None;⛔ 寫 0:不知道 ≠ 沒有;舊的列留上一輪算的)。"""
    S = (buzz or {}).get('s') or {}
    ix = {k: cols.index(k) for k in ('s', 'd', 'kind', 'nw')}
    st = {'hit': 0, 'zero': 0, 'na': 0}
    for r in rows:
        kind = r[ix['kind']]
        if kind not in NW_KW:
            continue
        days = S.get(str(r[ix['s']])) or {}
        try:
            d0 = date.fromisoformat(str(r[ix['d']]))
        except ValueError:
            continue
        titles, seen = [], False
        for k in (-1, 0, 1):
            x = days.get((d0 + timedelta(days=k)).isoformat())
            if isinstance(x, dict) and isinstance(x.get('t'), list):
                seen = True
                titles += [t for t in x['t'] if not NW_SKIP.search(str(t))]
        if not seen:
            st['na'] += 1
            continue
        n = sum(1 for t in titles if re.search(NW_KW[kind], str(t)))
        r[ix['nw']] = n
        st['hit' if n else 'zero'] += 1
    return st


def fill_amounts(got, acts, prev_rows, fetch, budget):
    """🔎 V82.7.5 那幾類(kind 有值)補金額:上一份抓過的同一則(代號 / 日期 / 時間 / 主旨)直接沿用;其他照 acts 的參數抓內文。
    fetch(form, what) → html 或 None(None = 被擋滿 / 連不上 → 這一輪不再抓)。回 {'reuse','fetch','amt','none','skip','stop'}。"""
    st = {'reuse': 0, 'fetch': 0, 'amt': 0, 'none': 0, 'skip': 0, 'stop': 0}
    prev = {(r[0], r[2], r[3], r[4]): r[8:11] for r in (prev_rows or [])
            if isinstance(r, list) and len(r) >= 11 and (r[8] is not None or r[10] is not None)}
    for (iso, mk), rows in sorted(got.items()):
        for r in rows:
            if not r[7]:
                continue
            key = (r[0], r[2], r[3], r[4])
            if key in prev:
                pv = list(prev[key])
                if pv[2]:                                  # 🩹 V82.7.6 有原句 → 照現在的金額規則重算(App 清單裡的舊列下一輪自己修好)
                    a = LA.reparse_ev(pv[2])
                    pv = [LA.to_yi(a['amt']), a['cur'], a['ev']] if a else [None, None, '']
                r[8:11] = pv
                st['reuse'] += 1
                continue
            f = MB.detail_form((acts.get((iso, mk)) or {}).get((r[0], r[3], r[4])))
            if not f or st['stop'] or st['fetch'] >= budget:
                st['skip'] += 1
                continue
            html = fetch(f, f'內文 {r[0]} {iso} {r[3]}')
            st['fetch'] += 1
            if html is None:
                st['stop'] = 1
                continue
            say = MB.parse_detail(html)
            if not say:                       # 不是內文頁 → 留空(下一輪再試)
                st['skip'] += 1
                continue
            a = LA.parse_amount(say)
            if a:
                r[8:11] = [LA.to_yi(a['amt']), a['cur'], a['ev']]
                st['amt'] += 1
            else:
                r[8:11] = [None, None, '']
                st['none'] += 1
    return st


def ins_app_rows(cells, mk):
    """申報轉讓原文欄位 → App 用的列(恆等式對得上、只收代號)。預定轉讓股數 = 自有 + 信託。"""
    out = []
    for c in cells:
        p = IB.parse_cells(c)
        if not p or not p.get('ok') or not _CODE.match(p.get('code') or ''):
            continue
        sh = (p.get('plan_own_n') or 0) + (p.get('plan_trust_n') or 0)
        out.append([p['code'], p.get('name', ''), p['date'], p.get('role', ''), IEP.role_cls(p.get('role')),
                    p.get('method', ''), IEP.method_cls(p.get('method')), sh, p.get('chg', ''), mk])
    return out


def merge_recent(doc, got, cols, src, today, keep=None, now=None, miss=None):
    """上一份 + 這一輪(got = {(日期, 市場): [列…]})→ (新的一份, 警告清單)。
    ③ 這次 0 筆但上一份那天那市場有 → 保留上一份(⛔ 用 0 蓋掉)。
    🔁 miss = 這一輪最後還是沒抓到的 [(日期, 市場)] → 記進檔頭 miss {日期: [市場]}(以前抓到過那天那市場就不算);
       之後哪一輪抓到了就拿掉。⛔ 沒抓到 ≠ 那天沒有公告(App 照 days 有沒有那一格判斷,這一欄給人看 log 用)。"""
    keep = KEEP_DAYS if keep is None else keep
    im = cols.index('mk')
    rows = [r for r in ((doc or {}).get('rows') or []) if isinstance(r, list) and len(r) == len(cols)]
    if cols is MOPS_COLS:   # 🔎 V82.7.5 以前的 7 欄列 → 補空欄位(⛔ 丟掉;那幾天這一輪不一定會重抓)
        rows += [r + [None] * (len(cols) - len(r)) for r in ((doc or {}).get('rows') or [])
                 if isinstance(r, list) and len(r) == MOPS_COLS_OLD]
    days = {k: dict(v) for k, v in ((doc or {}).get('days') or {}).items() if isinstance(v, dict)}
    pm = {k: set(v) for k, v in ((doc or {}).get('miss') or {}).items() if isinstance(v, list)}
    warn = []
    for (iso, mk), new in sorted(got.items()):
        pm.get(iso, set()).discard(mk)                 # 這一輪抓到了 → 不再算沒抓到
        old = [r for r in rows if r[2] == iso and r[im] == mk]
        if not new and old:
            warn.append(f'{iso} {mk} 這次 0 筆、上一份有 {len(old)} 筆 → 保留上一份')
            continue
        rows = [r for r in rows if not (r[2] == iso and r[im] == mk)] + new
        days.setdefault(iso, {})[mk] = len(new)
    for iso, mk in (miss or []):
        if (days.get(iso) or {}).get(mk) is not None:  # 以前抓到過那天那市場 → 手上有資料,不算沒抓到
            continue
        pm.setdefault(iso, set()).add(mk)
    lo = (today - timedelta(days=keep - 1)).isoformat()
    rows = [r for r in rows if r[2] >= lo]
    days = {k: v for k, v in days.items() if k >= lo}
    pm = {k: sorted(v) for k, v in pm.items() if v and k >= lo}
    it = cols.index('t') if 't' in cols else None
    rows.sort(key=lambda r: (r[2], str(r[it]) if it is not None else '', r[im], r[0]))
    ds = sorted(days)
    now = now or datetime.now(TW)
    out = {'v': 1, 'updated': now.isoformat(timespec='minutes'), 'src': src, 'keep': keep,
           'from': ds[0] if ds else None, 'to': ds[-1] if ds else None,
           'days': {k: days[k] for k in ds}, 'miss': {k: pm[k] for k in sorted(pm)}, 'cols': cols, 'rows': rows}
    if cols is MOPS_COLS:
        out['avoid'] = AVOID
    return out, warn


def apply_deep(patch, kind, deep_dir, now=None):
    """把 patch 裡「今天以前」的那幾天併進研究分支的月檔(backfill 的 load_month / save_month,整天換掉)。
    ⑤ 這次 0 筆但月檔那天那市場原本有 → 不動。回 (改了幾個「日·市場」, 說明清單)。"""
    mod = MB if kind == 'mops' else IB
    old_dir = mod.OUT_DIR
    mod.OUT_DIR = Path(deep_dir)
    notes, changed = [], 0
    try:
        days = (patch or {}).get(kind) or {}
        by_mo = {}
        for key, rows in days.items():
            iso, mk = key.split('|')
            by_mo.setdefault(iso[:7], []).append((iso, mk, rows))
        for mo, items in sorted(by_mo.items()):
            doc = mod.load_month(mo)
            for iso, mk, rows in sorted(items):
                if kind == 'mops':
                    def same(r, iso=iso, mk=mk):
                        return r[2] == iso and r[5] == mk
                    new = [list(r) for r in rows]
                else:
                    def same(r, iso=iso, mk=mk):
                        return r[0] == mk and (IB.parse_cells(r[1:]) or {}).get('date') == iso
                    new = [[mk] + list(c) for c in rows]
                have = [r for r in doc['rows'] if same(r)]
                if not new and have:
                    notes.append(f'{iso} {mk} 這次 0 筆、月檔原本有 {len(have)} 筆 → 不動')
                    continue
                doc['rows'] = [r for r in doc['rows'] if not same(r)] + new
                doc['days'].setdefault(iso, {})[mk] = len(new)
                changed += 1
            mod.save_month(doc)
        st_path = Path(deep_dir) / '_status.json'
        try:
            st = json.loads(st_path.read_text(encoding='utf-8')) if st_path.exists() else {}
        except Exception:  # noqa: BLE001
            st = {}
        st['months'] = sorted(p.name[:7] for p in Path(deep_dir).glob('*.json.gz'))
        st['daily'] = {'updated': (now or datetime.now(TW)).isoformat(timespec='minutes'),
                       'days': sorted({k.split('|')[0] for k in days})}
        Path(deep_dir).mkdir(parents=True, exist_ok=True)
        st_path.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding='utf-8')
    finally:
        mod.OUT_DIR = old_dir
    return changed, notes


def _gh_out(**kv):
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            for k, v in kv.items():
                f.write(f'{k}={v}\n')


def _gh_summary(txt):
    """Actions 的 Step Summary(本機跑沒有這個環境變數 → 什麼都不做)。"""
    out = os.environ.get('GITHUB_STEP_SUMMARY')
    if out:
        try:
            with open(out, 'a', encoding='utf-8') as f:
                f.write(txt + '\n')
        except OSError:
            pass


# ───────────────────────── 網路(正式入口) ─────────────────────────
def main(now=None, sess=None, sleep=time.sleep, out_dir=None):
    if sess is None:
        import requests
        sess = requests.Session()
    out_dir = Path(out_dir or OUT)
    now = now or datetime.now(TW)
    today = now.date()
    days = target_days(today)
    n = {'req': 0, 'blocks': 0, 'ok': 0, 'err': 0, 'waited': 0}
    hdr = {**mp.UA, 'User-Agent': 'Mozilla/5.0 mops_daily/1.0', 'Referer': f'{mp.HOST}/mops/web/t05st01'}
    ctx = {'what': ''}

    def post(method, url, form, what=None):
        """回 response 或 None(連不上 4 次 / 被擋滿 3 次)。
        連線錯誤 → 等 5 / 15 / 30 秒再試;被擋 → 退避再試,第 3 次就整輪收工。每一則都寫是哪一天、哪個市場。"""
        label = what or ctx['what'] or url.rsplit('/', 1)[-1]
        att = 0
        while True:
            if n['blocks'] >= BLOCK_MAX:
                return None
            sleep(SLEEP)
            try:
                r = sess.post(url, data=form, headers=hdr, timeout=60) if method == 'POST' else sess.get(url, headers=hdr, timeout=60)
                r.encoding = r.encoding or 'utf-8'
                n['req'] += 1
            except Exception as e:  # noqa: BLE001
                n['err'] += 1
                more = att < len(CONN_WAIT) and n['waited'] < WAIT_BUDGET
                print(f'   ⚠️ {label}:{type(e).__name__} {str(e)[:80]}(第 {att + 1} 次'
                      f'{f",等 {CONN_WAIT[att]} 秒再試" if more else ",這一輪先放棄"})', flush=True)
                if not more:
                    return None
                n['waited'] += CONN_WAIT[att]
                sleep(CONN_WAIT[att])
                att += 1
                continue
            if mp.is_blocked(r.text or ''):
                n['blocks'] += 1
                print(f'   ⛔ {label} 被擋(第 {n["blocks"]} 次)', flush=True)
                if n['blocks'] >= BLOCK_MAX:
                    return None
                n['waited'] += 60 * n['blocks']
                sleep(60 * n['blocks'])
                continue
            return r

    raw_m, raw_i, acts_m = {}, {}, {}
    fx = IB.Fetcher(sess, post)

    def get_m(d, mk):
        iso = d.isoformat()
        hdr['Referer'] = f'{mp.HOST}/mops/web/t05st01'
        r = post('POST', mp.HOST + MB.PATH, MB.form(mk, d), what=f'重大訊息 {iso} {mk}')
        if r is None:
            return False
        k = MB.classify(r.status_code, r.text or '')
        if k in ('ok', 'empty'):
            raw_m[(iso, mk)] = [x for x in MB.parse_rows(r.text or '', mk) if x[2] == iso] if k == 'ok' else []
            # 🔎 V82.7.5 每列「詳細資料」帶的參數(mops_probe.row_actions;⛔ 第二份)→ 抓內文用
            acts_m[(iso, mk)] = {(a['cells'][0], a['cells'][3], a['cells'][4]): a['fields']
                                 for a in mp.row_actions(r.text or '') if a['fields'] and len(a['cells']) >= 5} if k == 'ok' else {}
            n['ok'] += 1
            return True
        print(f'   ⚠️ 重大訊息 {iso} {mk}:{k}', flush=True)
        return False

    def get_i(d, mk):
        iso = d.isoformat()
        hdr['Referer'] = f'{mp.HOST}/mops/web/index'
        ctx['what'] = f'申報轉讓 {iso} {mk}'
        try:
            k, cells = fx.fetch(mk, d)
        finally:
            ctx['what'] = ''
        if k in ('ok', 'empty'):
            raw_i[(iso, mk)] = [c for c in cells if (IB.parse_cells(c) or {}).get('date') == iso] if k == 'ok' else []
            n['ok'] += 1
            return True
        print(f'   ⚠️ 申報轉讓 {iso} {mk}:{k}', flush=True)
        return False

    todo = [('mops', d, mk) for d in days for mk in MARKETS if not get_m(d, mk)]
    todo += [('insider', d, mk) for d in days for mk in MARKETS if not get_i(d, mk)]
    # 🔁 第二輪:第一輪跑完還有沒抓到的 → 等一下、每個再試一次(被擋滿 / 退避用完就不試)
    if todo and PASS2_WAIT and n['blocks'] < BLOCK_MAX and n['waited'] < WAIT_BUDGET:
        print(f'⏳ 還有 {len(todo)} 個沒抓到 → 等 {PASS2_WAIT} 秒、每個再試一次', flush=True)
        n['waited'] += PASS2_WAIT
        sleep(PASS2_WAIT)
        todo = [x for x in todo if not (get_m if x[0] == 'mops' else get_i)(x[1], x[2])]
    miss = {'mops': [(d.isoformat(), mk) for kd, d, mk in todo if kd == 'mops'],
            'insider': [(d.isoformat(), mk) for kd, d, mk in todo if kd == 'insider']}
    MKN = {'sii': '上市', 'otc': '上櫃'}
    miss_txt = '、'.join(f'{"重大訊息" if kd == "mops" else "申報轉讓"} {d.isoformat()} {MKN.get(mk, mk)}' for kd, d, mk in todo)

    got_m = {k: mops_app_rows(v, k[1]) for k, v in raw_m.items()}
    got_i = {k: ins_app_rows(v, k[1]) for k, v in raw_i.items()}
    # 🔎 V82.7.5 那幾類補金額(上一份抓過的沿用;被擋 / 連不上 → 不再抓,列照寫、金額留空)
    det = {'reuse': 0, 'fetch': 0, 'amt': 0, 'none': 0, 'skip': 0, 'stop': 0}
    if got_m:
        prev_m, _ = load_accum(out_dir / MOPS_FILE, {}, what=MOPS_FILE)

        def fetch(form, what):
            hdr['Referer'] = f'{mp.HOST}/mops/web/t05st01'
            rr = post('POST', mp.HOST + MB.PATH, form, what=what)
            return None if rr is None else (rr.text or '')
        det = fill_amounts(got_m, acts_m, (prev_m or {}).get('rows'), fetch, DETAIL_MAX)
        print(f'🔎 內文:沿用上一份 {det["reuse"]} 則 ・這輪抓 {det["fetch"]} 則(有金額 {det["amt"]}、沒有金額 {det["none"]})'
              f' ・沒抓 {det["skip"]} 則' + (' ・⛔ 被擋 / 連不上 → 這一輪停抓' if det['stop'] else ''), flush=True)
    print(f'📢 抓 {", ".join(d.isoformat() for d in days)} ・請求 {n["req"]} 次 ・成功 {n["ok"]} 次 ・連線錯誤 {n["err"]} 次'
          f' ・被擋 {n["blocks"]} 次 ・重大訊息 {sum(len(v) for v in got_m.values())} 則 ・申報 {sum(len(v) for v in got_i.values())} 筆', flush=True)
    if todo:
        print(f'⚠️ 最後還是沒抓到:{miss_txt}(研究分支 ⛔ 標完成;下一輪會再抓「今天 + 前一個平日」,更早的要手動派 back 或等 backfill)', flush=True)
    _gh_summary(f'📢 mops_daily:請求 {n["req"]} 次 ・成功 {n["ok"]} 次 ・連線錯誤 {n["err"]} 次 ・被擋 {n["blocks"]} 次'
                + (f'\n\n⚠️ 最後還是沒抓到:{miss_txt}' if todo else '\n\n✅ 每一天每個市場都抓到了')
                + f'\n\n🔎 內文:沿用 {det["reuse"]} ・抓 {det["fetch"]}(有金額 {det["amt"]}、沒有 {det["none"]})・沒抓 {det["skip"]}')
    if n['ok'] == 0:
        print('❌ 這一輪一次都沒成功 → ⛔ 不覆蓋舊檔', flush=True)
        _gh_out(push=0)
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)
    wrote = 0
    for fname, got, cols, src, ms in ((MOPS_FILE, got_m, MOPS_COLS, SRC_MOPS, miss['mops']),
                                      (INS_FILE, got_i, INS_COLS, SRC_INS, miss['insider'])):
        if not got:
            print(f'   ⏭️ {fname}:這一輪沒有成功抓到 → 不動', flush=True)
            continue
        prev, can_write = load_accum(out_dir / fname, {}, what=fname)
        if not can_write:
            continue
        doc, warn = merge_recent(prev, got, cols, src, today, now=now, miss=ms)
        if fname == MOPS_FILE:
            buzz, _ = load_accum(out_dir / NEWS_FILE, {}, what=NEWS_FILE)
            if buzz:
                nst = news_count(doc['rows'], cols, buzz)
                print(f'📰 新聞也報:有 {nst["hit"]} 則 ・0 則 {nst["zero"]} ・那幾天沒有新聞紀錄 {nst["na"]}', flush=True)
            else:
                print(f'📰 {NEWS_FILE} 讀不到 → 「新聞也報」這一輪不算(⛔ 寫 0)', flush=True)
        for w in warn:
            print(f'   ⚠️ {fname}:{w}', flush=True)
        (out_dir / fname).write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        wrote += 1
        print(f'   ✅ {fname}:{doc["from"]} ~ {doc["to"]} ・{len(doc["rows"]):,} 列', flush=True)
    t0 = today.isoformat()
    patch = {'made': now.isoformat(timespec='minutes'),
             'mops': {f'{iso}|{mk}': rows for (iso, mk), rows in raw_m.items() if iso < t0},
             'insider': {f'{iso}|{mk}': rows for (iso, mk), rows in raw_i.items() if iso < t0}}
    (out_dir / PATCH_FILE).write_text(json.dumps(patch, ensure_ascii=False), encoding='utf-8')
    _gh_out(push=1 if wrote else 0, deep=1 if (patch['mops'] or patch['insider']) else 0)
    return 0 if wrote else 1


# ───────────────────────── selftest ─────────────────────────
def selftest():
    # ⚠️ V82.3.1:workflow 用 MD_BACK=5 手動補抓時 selftest 也在同一個環境跑 → 讀到 5 天就全紅(11/13 #2 實際踩到)
    #    → 環境變數決定的那幾個值在這裡釘死,跑完還原(⛔ 讓測試結果跟著環境變)
    global BACK, KEEP_DAYS
    keep_env = (BACK, KEEP_DAYS)
    BACK, KEEP_DAYS = 2, 14
    try:
        return _selftest()
    finally:
        BACK, KEEP_DAYS = keep_env


def _selftest():
    import shutil
    import tempfile
    bad = []

    def ok(nm, c, e=''):
        print(f"  {'✅' if c else '❌'} {nm}{'' if c else '  ' + str(e)[:300]}")
        if not c:
            bad.append(nm)

    # ① 抓哪幾天
    ok('① 平日:今天 + 前一個平日', target_days(date(2026, 11, 13), 2) == [date(2026, 11, 12), date(2026, 11, 13)])
    ok('① 週一 → 上週五 + 今天', target_days(date(2026, 11, 16), 2) == [date(2026, 11, 13), date(2026, 11, 16)])
    ok('① 週六手動跑 → 週四 + 週五', target_days(date(2026, 11, 14), 2) == [date(2026, 11, 12), date(2026, 11, 13)])

    # ② 分類一律照 mops_event_probe / insider_event_probe(⛔ 第二份)
    raw = [['2330', '台積電', '2026-11-12', '13:54:04', '公告本公司董事會決議減資彌補虧損', 'sii'],
           ['1101', '台泥', '2026-11-12', '14:00:00', '公告本公司庫藏股買回期滿', 'sii'],
           ['2317', '鴻海', '2026-11-12', '15:00:00', '公告本公司董事會通過合併財務報告', 'sii'],
           ['公司代號', '名稱', '2026-11-12', '', '表頭', 'sii']]
    app = mops_app_rows(raw, 'sii')
    cats = {r[0]: r[6] for r in app}
    ok('② 減資彌補虧損 → cap_red_loss、庫藏股期滿 → buyback_end', cats.get('2330') == 'cap_red_loss' and cats.get('1101') == 'buyback_end', cats)
    ok('② 決定性對照:「合併財務報告」→ finrep(⛔ 算成合併收購)', cats.get('2317') == 'finrep', cats)
    ok('② 不是代號的列不收', len(app) == 3, app)
    ok('② 類別函式就是 mops_event_probe 那支', all(r[6] == MEP.classify(r[4]) for r in app))
    A = ['115/11/12', '3006', '晶豪科', '董事本人', '山一投資有限公司', '一般交易(每日得轉讓股數限制)', '1,621,000', '523,190', '',
         '3,299,000', '0', '1,621,000', '0', '1,678,000', '0', '115/11/13 ~ 115/12/12']
    B = ['115/11/12', '1786', '科妍', '董事本人 及由受託人持有者', '韓開程', '贈與', '', '', '陳翰杰',
         '0', '1,573,250', '0', '123,250', '0', '1,450,000', '115/11/12 ~ 115/11/30']
    shifted = A[:6] + A[7:] + ['']
    ia = ins_app_rows([A, B, shifted], 'sii')
    ok('③ 申報:身分類 / 方式類照 insider_event_probe、股數 = 自有 + 信託', len(ia) == 2 and ia[0][4] == 'dir' and ia[0][6] == 'mkt'
       and ia[0][7] == 1621000 and ia[1][6] == 'gift' and ia[1][7] == 123250, ia)
    ok('③ 決定性對照:欄位錯一位(恆等式對不上)→ 不收', all(r[0] != shifted[1] or r[7] != 0 for r in ia) and len(ia) == 2)

    # ④ 合併:冪等、0 筆不蓋掉、14 天外刪掉
    today = date(2026, 11, 13)
    now = datetime(2026, 11, 13, 18, 30, tzinfo=TW)
    old_doc = {'rows': [['2330', '台積電', '2026-10-20', '09:00:00', '舊的', 'sii', 'other'],
                        ['2330', '台積電', '2026-11-12', '13:54:04', '昨天上一份', 'sii', 'other'],
                        ['3008', '大立光', '2026-11-12', '10:00:00', '上櫃那天', 'otc', 'other']],
               'days': {'2026-10-20': {'sii': 1}, '2026-11-12': {'sii': 1, 'otc': 1}}}
    got = {('2026-11-12', 'sii'): app, ('2026-11-12', 'otc'): []}
    d1, w1 = merge_recent(old_doc, got, MOPS_COLS, SRC_MOPS, today, keep=14, now=now)
    ok('④ 同一天同一市場整天換掉(上一份那筆不見、新的 3 筆在)', sum(1 for r in d1['rows'] if r[2] == '2026-11-12' and r[5] == 'sii') == 3
       and not any(r[4] == '昨天上一份' for r in d1['rows']), d1['rows'])
    ok('④ 這次 0 筆但上一份有 → 保留上一份 + 警告', any(r[4] == '上櫃那天' for r in d1['rows']) and w1, w1)
    ok('④ 14 天外的刪掉', not any(r[2] == '2026-10-20' for r in d1['rows']) and '2026-10-20' not in d1['days'], d1['days'])
    d2, _ = merge_recent(d1, got, MOPS_COLS, SRC_MOPS, today, keep=14, now=now)
    ok('④ 跑兩次結果一樣(冪等)', d2['rows'] == d1['rows'] and d2['days'] == d1['days'])
    d0, _ = merge_recent({}, {('2026-11-12', 'otc'): []}, MOPS_COLS, SRC_MOPS, today, keep=14, now=now)
    ok('④ 決定性對照:上一份沒有那天 → 0 筆照記(休市日就是這樣)', d0['days'].get('2026-11-12') == {'otc': 0}, d0['days'])
    ok('④ 檔頭帶避雷兩類名字、欄位名', d1.get('avoid') == AVOID and d1['cols'] == MOPS_COLS and d1['from'] == '2026-11-12')

    # ⑤ 走正式入口 main()(假網路、假時鐘、暫存資料夾)
    class R:
        def __init__(self, text, code=200):
            self.text, self.status_code, self.encoding = text, code, 'utf-8'

    def mops_html(d, mk):
        roc = f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'
        rows = [('2330', '台積電', '13:54:04', '公告本公司董事會決議減資彌補虧損'), ('2317', '鴻海', '15:00:00', '公告本公司董事會通過合併財務報告')] \
            if mk == 'sii' else [('6488', '環球晶', '16:00:00', '公告本公司代子公司公告取得設備')]
        return '<table>' + ''.join(f'<tr><td>{c}</td><td>{n}</td><td>{roc}</td><td>{t}</td><td>{s}</td></tr>' for c, n, t, s in rows) + '</table>'
    page = "<form><input name='encodeURIComponent' value='1'><input name='step' value='1'><input name='firstin' value='1'>" \
           "<input name='year'><input name='month'><input name='day'></form>"

    def server_factory(blocked=False, fail=None, listf=None, detail=None):
        calls = []

        def handle(method, url, data):
            is_det = url.endswith('ajax_t05st01') and bool(data) and data.get('step') == '2'   # 申報轉讓第二層也是 step 2(ajax_t56sb12)→ 只算重大訊息內文
            calls.append((method, 'detail') if is_det else (method, url.rsplit('/', 1)[-1]))
            if fail and fail(method, url, data):
                raise ConnectionResetError(104, 'Connection reset by peer')
            if blocked:
                return R('因為安全性考量,您的連線已被阻擋')
            if method == 'GET':
                return R(page)
            if url.endswith('ajax_t05st01') and data.get('step') == '2':
                return R(detail(data) if detail else '<html>別的網頁</html>')
            if url.endswith('ajax_t05st01'):
                y, m, dd = int(data['year']) + 1911, int(data['month']), int(data['b_date'])
                return R((listf or mops_html)(date(y, m, dd), data['TYPEK']))
            if url.endswith(('ajax_t56sb12_q1', 'ajax_t56sb12_q2')):
                rep = 'SY' if url.endswith('q1') else 'OY'
                kv = ''.join(f"<input type='hidden' name='{k}' value='{v}'>" for k, v in
                             (('run', ''), ('step', '2'), ('year', data['year']), ('month', data['month']), ('day', data['day']),
                              ('report', rep), ('firstin', 'true')))
                return R(f"<form name='autoForm' action='/mops/web/ajax_t56sb12' method='post'>{kv}</form>")
            if url.endswith('ajax_t56sb12'):
                if data.get('report') == 'OY':
                    return R("<h4>無持股轉讓之情形</h4>")
                roc = f"{data['year']}/{data['month']}/{data['day']}"
                row = [roc] + A[1:]
                return R('<table><tr>' + ''.join(f'<td>{c}</td>' for c in row) + '</tr></table>')
            return R('<html>別的網頁</html>', 404)

        class Sess:
            def get(self, url, **k):
                return handle('GET', url, None)

            def post(self, url, data=None, **k):
                return handle('POST', url, data)
        return Sess(), calls

    tmp = Path(tempfile.mkdtemp(prefix='mopsd-'))
    try:
        sess, calls = server_factory()
        rc = main(now=now, sess=sess, sleep=lambda s: None, out_dir=tmp)
        dm = json.loads((tmp / MOPS_FILE).read_text(encoding='utf-8'))
        di = json.loads((tmp / INS_FILE).read_text(encoding='utf-8'))
        pt = json.loads((tmp / PATCH_FILE).read_text(encoding='utf-8'))
        ok('⑤ main 跑完:兩天 × 兩個市場的重大訊息都在、類別有算', rc == 0 and dm['from'] == '2026-11-12' and dm['to'] == '2026-11-13'
           and sum(1 for r in dm['rows'] if r[6] == 'cap_red_loss') == 2 and len(dm['rows']) == 6, (rc, dm.get('days')))
        ok('⑤ 申報轉讓:上市兩天各 1 筆、上櫃「無持股轉讓」記 0 筆', len(di['rows']) == 2
           and di['days'].get('2026-11-13') == {'sii': 1, 'otc': 0} and di['rows'][0][6] == 'mkt', di.get('days'))
        ok('⑤ 研究分支 patch:只有今天以前(今天 ⛔)', sorted(pt['mops']) == ['2026-11-12|otc', '2026-11-12|sii']
           and sorted(pt['insider']) == ['2026-11-12|otc', '2026-11-12|sii'], (sorted(pt['mops']), sorted(pt['insider'])))
        ok('⑤ patch 是 backfill 的原文格式(重大訊息 6 欄、申報原文欄位)', all(len(r) == 6 for v in pt['mops'].values() for r in v)
           and pt['insider']['2026-11-12|sii'][0][1] == '3006', pt['insider'].get('2026-11-12|sii'))
        nreq = len(calls)
        ok('⑤ 請求數不誇張(兩天 × 兩市場 × 兩種 ≤ 16 次)', nreq <= 16, nreq)
        # ⑥ 研究分支:併進月檔(backfill 的 load_month 讀得回來)
        deep = tmp / 'deep_m'
        ch, notes = apply_deep(pt, 'mops', deep, now=now)
        MB.OUT_DIR, keep_dir = deep, MB.OUT_DIR
        try:
            mdoc = MB.load_month('2026-11')
        finally:
            MB.OUT_DIR = keep_dir
        ok('⑥ 重大訊息併進研究分支:那天兩個市場都標做完、列數對', ch == 2 and mdoc['days'].get('2026-11-12') == {'sii': 2, 'otc': 1}
           and len(mdoc['rows']) == 3 and '2026-11-13' not in mdoc['days'], (ch, mdoc['days']))
        deep_i = tmp / 'deep_i'
        chi, _ = apply_deep(pt, 'insider', deep_i, now=now)
        IB.OUT_DIR, keep_dir = deep_i, IB.OUT_DIR
        try:
            idoc = IB.load_month('2026-11')
        finally:
            IB.OUT_DIR = keep_dir
        ok('⑥ 申報轉讓併進研究分支:原文存法 [市場, 欄位…]、parse_cells 讀得回來', chi == 2 and idoc['rows'][0][0] == 'sii'
           and (IB.parse_cells(idoc['rows'][0][1:]) or {}).get('date') == '2026-11-12', idoc['rows'][:1])
        ch2, _ = apply_deep(pt, 'mops', deep, now=now)
        MB.OUT_DIR, keep_dir = deep, MB.OUT_DIR
        try:
            mdoc2 = MB.load_month('2026-11')
        finally:
            MB.OUT_DIR = keep_dir
        ok('⑥ 併兩次一樣(冪等)', mdoc2['rows'] == mdoc['rows'] and mdoc2['days'] == mdoc['days'])
        pt0 = {'mops': {'2026-11-12|sii': []}}
        ch0, n0 = apply_deep(pt0, 'mops', deep, now=now)
        MB.OUT_DIR, keep_dir = deep, MB.OUT_DIR
        try:
            mdoc3 = MB.load_month('2026-11')
        finally:
            MB.OUT_DIR = keep_dir
        ok('⑥ 這次 0 筆但月檔原本有 → 不動', ch0 == 0 and n0 and mdoc3['days']['2026-11-12']['sii'] == 2, (ch0, n0))
        st = json.loads((deep / '_status.json').read_text(encoding='utf-8'))
        ok('⑥ _status.json 的月份清單有新的月份', '2026-11' in st.get('months', []) and st.get('daily'), st)
        # ⑦ 決定性對照:一直被擋 → 收工、exit 1、⛔ 覆蓋舊檔
        before = (tmp / MOPS_FILE).read_bytes()
        sess_b, calls_b = server_factory(blocked=True)
        rcb = main(now=now, sess=sess_b, sleep=lambda s: None, out_dir=tmp)
        ok('⑦ 一直被擋 → 第 3 次就收工、exit 1、舊檔一個位元組都沒動', rcb == 1 and len(calls_b) <= BLOCK_MAX
           and (tmp / MOPS_FILE).read_bytes() == before, (rcb, len(calls_b)))
        # ⑧ 累積檔讀壞 → ⛔ 寫回
        (tmp / INS_FILE).write_text('{"rows": [1,2', encoding='utf-8')
        sess2, _ = server_factory()
        rcc = main(now=now, sess=sess2, sleep=lambda s: None, out_dir=tmp)
        ok('⑧ 申報檔讀壞 → 不寫回(壞檔留著等人修)、重大訊息照寫', (tmp / INS_FILE).read_text(encoding='utf-8') == '{"rows": [1,2'
           and rcc == 0, rcc)

        # ⑨~⑫ 🔁 連線被重設(V82.3.1:11/13 第一次實跑被重設 4 次 → 漏兩段,log 沒寫是哪一天哪個市場)
        import contextlib
        import io

        def is_pair(url, data, mk, day):
            return url.endswith('ajax_t05st01') and bool(data) and data.get('TYPEK') == mk and int(data.get('b_date') or 0) == day

        def run_main(fail, sub):
            dd = tmp / sub
            dd.mkdir(exist_ok=True)
            s, c = server_factory(fail=fail)
            buf, waits = io.StringIO(), []
            with contextlib.redirect_stdout(buf):
                r = main(now=now, sess=s, sleep=waits.append, out_dir=dd)
            doc = json.loads((dd / MOPS_FILE).read_text(encoding='utf-8')) if (dd / MOPS_FILE).exists() else None
            pt_ = json.loads((dd / PATCH_FILE).read_text(encoding='utf-8')) if (dd / PATCH_FILE).exists() else None
            return r, doc, pt_, buf.getvalue(), c, waits

        cnt = {'n': 0}

        def fail_twice(method, url, data):
            if is_pair(url, data, 'otc', 12):
                cnt['n'] += 1
                return cnt['n'] <= 2
            return False
        r9, d9, p9, log9, _, _ = run_main(fail_twice, 'r9')
        ok('⑨ 上櫃 11/12 連線被重設兩次 → 第 3 次抓到:有資料、試了 3 次、沒有 miss', r9 == 0 and cnt['n'] == 3
           and (d9 or {}).get('days', {}).get('2026-11-12', {}).get('otc') == 1 and (d9 or {}).get('miss') == {}
           and '2026-11-12|otc' in (p9 or {}).get('mops', {}), (r9, cnt, (d9 or {}).get('days'), (d9 or {}).get('miss')))
        ok('⑨ log 寫是哪一天哪個市場', '重大訊息 2026-11-12 otc' in log9 and '等 5 秒再試' in log9, log9[-400:])

        def fail_always(method, url, data):
            return is_pair(url, data, 'otc', 12)
        r10, d10, p10, log10, c10, w10 = run_main(fail_always, 'r10')
        ok('⑩ 一直連不上 → miss 記那一天那個市場、其他照寫', r10 == 0 and (d10 or {}).get('miss') == {'2026-11-12': ['otc']}
           and 'otc' not in (d10 or {}).get('days', {}).get('2026-11-12', {}) and (d10 or {}).get('days', {}).get('2026-11-12', {}).get('sii') == 2,
           (r10, (d10 or {}).get('miss'), (d10 or {}).get('days')))
        ok('⑩ 研究分支 patch 沒有它(⛔ 標完成)', '2026-11-12|otc' not in (p10 or {}).get('mops', {}) and '2026-11-12|sii' in (p10 or {}).get('mops', {}),
           sorted((p10 or {}).get('mops', {})))
        ok('⑩ 第二輪有再試、最後一行列出沒抓到的(中文市場名)', '還有 1 個沒抓到' in log10 and '最後還是沒抓到:重大訊息 2026-11-12 上櫃' in log10, log10[-500:])
        ok('⑩ 試的次數有上限(第一輪 4 次 + 第二輪 4 次)', sum(1 for m, u in c10 if u == 'ajax_t05st01') == 4 + 4 + 3, c10)
        # 上一份那天那市場有 → 不算沒抓到、資料保留;之後抓到 → miss 拿掉
        rr, dr, _, _, _, _ = run_main(fail_always, 'r9')
        ok('⑩ 上一份已經有那天那市場 → 不記 miss、上一份那筆留著', rr == 0 and (dr or {}).get('miss') == {}
           and any(r[2] == '2026-11-12' and r[5] == 'otc' for r in (dr or {}).get('rows', [])), (dr or {}).get('miss'))
        ra, da, _, _, _, _ = run_main(None, 'r10')
        ok('⑩ 之後哪一輪抓到了 → miss 拿掉', ra == 0 and (da or {}).get('miss') == {} and (da or {}).get('days', {}).get('2026-11-12', {}).get('otc') == 1,
           (da or {}).get('miss'))

        # ⑪ 決定性對照:退回舊的「試 2 次、沒有第二輪」→ 同一個「被重設兩次」就漏掉
        global CONN_WAIT, PASS2_WAIT
        keep_cw, keep_p2 = CONN_WAIT, PASS2_WAIT
        CONN_WAIT, PASS2_WAIT = (5,), 0
        try:
            cnt['n'] = 0
            r11, d11, _, _, _, _ = run_main(fail_twice, 'r11')
        finally:
            CONN_WAIT, PASS2_WAIT = keep_cw, keep_p2
        ok('⑪ 決定性對照:只試 2 次、沒有第二輪 → 同一個情況會漏(miss 有它)', r11 == 0 and (d11 or {}).get('miss') == {'2026-11-12': ['otc']},
           (r11, (d11 or {}).get('miss')))

        # ⑫ 全部連不上 → exit 1、⛔ 覆蓋;退避加起來有上限(⛔ 把 20 分鐘的時限吃光)
        r12, d12, _, log12, c12, w12 = run_main(lambda m, u, d: True, 'r12')
        backoff = sum(x for x in w12 if x != SLEEP)
        ok('⑫ 全部連不上 → exit 1、沒有寫檔', r12 == 1 and d12 is None, (r12, d12 is None))
        ok('⑫ 退避加起來 ≤ 上限 + 最後一次(⛔ 一直等)', backoff <= WAIT_BUDGET + PASS2_WAIT + max(CONN_WAIT), backoff)

        # ⑬ 🔎 V82.7.5 內文 → 金額(列表每列帶「詳細資料」參數;內文用 2026-11-27 真內文的節錄)
        def det_list(d, mk):
            roc = f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'
            rows = [('4588', '玖鼎電力', '15:35:20', '本公司獲得台電公司「模組化智慧型電表」金額約 新台幣1.64億元(未稅)', '1'),
                    ('2409', '友達', '16:00:10', '本公司處分華亞廠不動產及其相關廠務附屬設施', '3'),
                    ('2330', '台積電', '13:54:04', '公告本公司將參加法人說明會', '1')] if mk == 'sii' else []
            oc = ("document.t05st01_fm.action='ajax_t05st01';document.t05st01_fm.seq_no.value='{q}';document.t05st01_fm.spoke_time.value='{t}';"
                  "document.t05st01_fm.spoke_date.value='{d}';document.t05st01_fm.co_id.value='{c}';document.t05st01_fm.TYPEK.value='{mk}';openWindow(this.form ,'');")
            return '<table>' + ''.join(
                f'<tr><td>{c}</td><td>{n}</td><td>{roc}</td><td>{t}</td><td>{sb}</td><td><input type=button value="詳細資料" onclick="'
                + oc.format(q=q, t=int(t.replace(':', '')), d=d.strftime('%Y%m%d'), c=c, mk=mk) + '"></td></tr>' for c, n, t, sb, q in rows) + '</table>'
        DET = {'4588': '說明 1.事實發生日:115/11/27 5.主要內容（解除者不適用）:本公司參與台電公司標案「模組化智慧型電表」 取得訂單金額約1.64億元(新台幣，未稅金額) 6.限制條款:無',
               '2409': '說明 5.交易單位數量、每單位價格及交易總金額: 土地面積： 65,260.09平方公尺 附屬設備一批 交易總金額:新台幣 197億元(未稅) 6.交易相對人:矽品'}
        det_calls = []

        def det_page(data):
            det_calls.append(data['co_id'])
            return f"<html>本資料由 (上市公司) {data['co_id']} 公司提供 序號 {data['seq_no']}<table><tr><td>{DET.get(data['co_id'], '說明 1.事實發生日:115/11/27')}</td></tr></table>以上資料均由各公司依發言當時所屬市場別之規定申報後</html>"

        def run_det(sub, detail=det_page, env_max=None):
            dd = tmp / sub
            dd.mkdir(exist_ok=True)
            global DETAIL_MAX
            keep_dm = DETAIL_MAX
            if env_max is not None:
                DETAIL_MAX = env_max
            try:
                s_, c_ = server_factory(listf=det_list, detail=detail)
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    r_ = main(now=now, sess=s_, sleep=lambda x: None, out_dir=dd)
            finally:
                DETAIL_MAX = keep_dm
            doc = json.loads((dd / MOPS_FILE).read_text(encoding='utf-8')) if (dd / MOPS_FILE).exists() else {}
            rows = {(x[0], x[2]): dict(zip(doc.get('cols') or [], x)) for x in doc.get('rows', [])}
            return r_, rows, c_, buf.getvalue()

        r13, rw13, c13, log13 = run_det('r13')
        a4588, a2409, a2330 = rw13.get(('4588', '2026-11-13'), {}), rw13.get(('2409', '2026-11-13'), {}), rw13.get(('2330', '2026-11-13'), {})
        ok('⑬ 訂單 → 金額 1.64 億、新台幣、帶那句原文;處分 → 197 億', r13 == 0 and a4588.get('kind') == '訂單' and a4588.get('amt') == 1.64
           and a4588.get('cur') == 'TWD' and '1.64億元' in (a4588.get('ev') or '') and a2409.get('kind') == '處分' and a2409.get('amt') == 197.0,
           (r13, a4588, a2409))
        ok('⑬ 不是那幾類(法說會)→ ⛔ 抓內文、金額空著', a2330.get('kind') == '' and a2330.get('amt') is None and '2330' not in det_calls, (a2330, det_calls))
        ok('⑬ 內文請求只有那幾類 × 兩天(4 次)', sum(1 for m, u in c13 if u == 'detail') == 4, [u for m, u in c13 if u == 'detail'])
        n1 = len(det_calls)
        r13b, rw13b, c13b, _ = run_det('r13')
        ok('⑬ 第二輪:上一份抓過的同一則直接沿用(0 次內文請求、金額一樣)', r13b == 0 and sum(1 for m, u in c13b if u == 'detail') == 0
           and rw13b.get(('4588', '2026-11-13'), {}).get('amt') == 1.64 and len(det_calls) == n1, sum(1 for m, u in c13b if u == 'detail'))
        r13c, rw13c, _, log13c = run_det('r13c', detail=lambda d: '因為安全性考量,您的連線已被阻擋')
        bc = rw13c.get(('4588', '2026-11-13'), {})
        ok('⑬ 決定性對照:內文被擋 → 列照寫(rc 0)、金額留空(⛔ 寫 0)、這一輪停抓', r13c == 0 and bc.get('kind') == '訂單' and bc.get('amt') is None
           and bc.get('ev') is None and '停抓' in log13c, (r13c, bc))
        r13d, rw13d, c13d, _ = run_det('r13d', env_max=1)
        ok('⑬ 每輪上限 DETAIL_MAX = 1 → 只抓 1 則,其他留空(下一輪再抓)', r13d == 0 and sum(1 for m, u in c13d if u == 'detail') == 1
           and sum(1 for v in rw13d.values() if v.get('amt') is not None) == 1, sum(1 for m, u in c13d if u == 'detail'))
        r13e, rw13e, _, _ = run_det('r13e', detail=lambda d: '<html>別的網頁</html>')
        ok('⑬ 回來的不是內文頁(沒有「說明」)→ 留空(⛔ 當成沒有金額)', r13e == 0 and rw13e.get(('4588', '2026-11-13'), {}).get('ev') is None)
        st = fill_amounts({('2026-11-13', 'sii'): [['1', 'x', '2026-11-13', '10:00:00', '取得訂單', 'sii', 'order', '訂單', None, None, None]]},
                          {('2026-11-13', 'sii'): {('1', '10:00:00', '取得訂單'): {'seq_no': '1', 'spoke_time': '100000', 'spoke_date': '20261113', 'co_id': '1', 'TYPEK': 'sii'}}},
                          [], lambda f, w: '<td>說明 1.事實發生日:115/11/13 2.契約相對人:某公司</td>', 5)
        ok('⑬ 說明欄沒有金額 → ev 寫空字串(= 抓過、沒有),下一輪沿用不重抓', st['none'] == 1 and st['amt'] == 0, st)
        # 🩹 V82.7.6 沿用上一份的金額時照現在的規則重算(越南盾那則舊版記成新台幣 4,737 億)
        g15 = {('2026-11-13', 'sii'): [['8464', 'x', '2026-11-13', '10:00:00', '取得訂單', 'sii', 'order', '訂單', None, None, None],
                                       ['4588', 'y', '2026-11-13', '11:00:00', '標案訂單', 'sii', 'order', '訂單', None, None, None]]}
        st15 = fill_amounts(g15, {}, [['8464', 'x', '2026-11-13', '10:00:00', '取得訂單', 'sii', 'order', '訂單', 4737.73, 'TWD', '交易總金額為越南盾473,772,812,805元'],
                                      ['4588', 'y', '2026-11-13', '11:00:00', '標案訂單', 'sii', 'order', '訂單', 1.64, 'TWD', '取得訂單金額約1.64億元']],
                            lambda f, w: None, 5)
        r15 = {x[0]: x for x in g15[('2026-11-13', 'sii')]}
        ok('⑬ 🩹 沿用上一份時照現在的規則重算:越南盾 → VND(⛔ 新台幣 4,737 億);決定性對照:正常那則 1.64 億新台幣不變;0 次內文請求',
           r15['8464'][9] == 'VND' and r15['8464'][8] == 4737.73 and r15['4588'][8:10] == [1.64, 'TWD'] and st15['reuse'] == 2 and st15['fetch'] == 0,
           (r15, st15))
        d7, _ = merge_recent({'rows': [['2330', '台積電', '2026-11-12', '13:54:04', '舊格式', 'sii', 'other']], 'days': {'2026-11-12': {'sii': 1}}},
                             {}, MOPS_COLS, SRC_MOPS, today, keep=14, now=now)
        ok('⑬ V82.7.5 以前的 7 欄列 → 補空欄位留著(⛔ 丟掉)', any(len(r) == len(MOPS_COLS) and r[4] == '舊格式' and r[7] is None for r in d7['rows']), d7['rows'])

        # ⑭ 📰 新聞也報(news_buzz 的標題;同一檔、前一天 ~ 後一天、講到同一類;⛔ 論壇)
        B = {'s': {'4588': {'2026-11-13': {'t': ['玖鼎拿下台電智慧電表標案 金額1.64億', '玖鼎訂單 - 股市爆料同學會', '玖鼎股價亮燈']},
                            '2026-11-14': {'t': ['玖鼎電表採購案挹注明年營收']}},
                   '2409': {'2026-11-12': {'t': ['友達出售華亞廠 進帳197億']}, '2026-11-13': {'t': ['友達股價走強']}},
                   '2330': {'2026-11-13': {'t': ['台積電法說會在即']}},
                   '1101': {'2026-10-01': {'n': 3}}}}
        C = MOPS_COLS
        R14 = [['4588', '玖鼎', '2026-11-13', '15:35:20', '取得台電標案', 'sii', 'order', '訂單', 1.64, 'TWD', 'x', None],
               ['2409', '友達', '2026-11-13', '16:00:10', '處分華亞廠', 'sii', 'asset', '處分', 197.0, 'TWD', 'y', None],
               ['2330', '台積電', '2026-11-13', '13:54:04', '法人說明會', 'sii', 'confcall', '', None, None, None, None],
               ['1101', '台泥', '2026-11-13', '10:00:00', '取得廠房', 'sii', 'asset', '取得', None, None, None, None],
               ['1102', '亞泥', '2026-11-02', '10:00:00', '取得設備', 'sii', 'asset', '取得', None, None, None, 2]]
        st14 = news_count(R14, C, B)
        nw = {r[0]: r[11] for r in R14}
        ok('⑭ 訂單:當天 + 隔天講到「標案 / 採購案」的 2 則(⛔ 論壇那則、⛔ 股價那則)', nw['4588'] == 2, nw)
        ok('⑭ 處分:前一天「出售」也算(新聞先報、公司隔天公告)', nw['2409'] == 1, nw)
        ok('⑭ 不是那幾類(法說會)→ 不算(None)', nw['2330'] is None, nw)
        ok('⑭ 那檔有新聞紀錄、但那幾天沒有標題 → None(⛔ 寫 0:不知道 ≠ 沒有)', nw['1101'] is None and st14['na'] >= 1, (nw, st14))
        ok('⑭ 上一輪算過、這輪標題已經過期 → 留著上一輪的數字', nw['1102'] == 2, nw)
        R14b = [list(R14[0])]
        NW_SKIP_keep = NW_SKIP
        try:
            globals()['NW_SKIP'] = re.compile(r'(?!x)x')
            news_count(R14b, C, B)
        finally:
            globals()['NW_SKIP'] = NW_SKIP_keep
        ok('⑭ 決定性對照:不擋論壇 → 3 則(論壇那則被算進來)', R14b[0][11] == 3, R14b[0][11])
        dd14 = tmp / 'r13'
        (dd14 / NEWS_FILE).write_text(json.dumps(B, ensure_ascii=False), encoding='utf-8')
        r14m, rw14m, c14m, log14 = run_det('r13')
        ok('⑭ main:data/news_buzz.json 在 → 寫進 nw 欄(4588 = 2)、內文照樣沿用(0 次內文請求)', r14m == 0
           and rw14m.get(('4588', '2026-11-13'), {}).get('nw') == 2 and sum(1 for m, u in c14m if u == 'detail') == 0 and '📰 新聞也報' in log14,
           (rw14m.get(('4588', '2026-11-13')), log14[-300:]))
        r14n, rw14n, _, log14n = run_det('r13d')
        ok('⑭ main:沒有 news_buzz.json → nw 留空(⛔ 寫 0)+ log 寫讀不到', r14n == 0 and all(v.get('nw') is None for v in rw14n.values())
           and '讀不到' in log14n, log14n[-200:])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


def _cli():
    a = sys.argv[1:]
    if '--selftest' in a:
        return selftest()
    if '--apply-deep' in a:
        i = a.index('--apply-deep')
        patch = json.loads(Path(a[i + 1]).read_text(encoding='utf-8'))
        kind = a[a.index('--only') + 1] if '--only' in a else 'mops'
        if kind not in ('mops', 'insider'):
            print(f'❌ --only 要是 mops 或 insider(拿到 {kind})')
            return 2
        ch, notes = apply_deep(patch, kind, DEEP_MOPS if kind == 'mops' else DEEP_INS)
        for x in notes:
            print(f'   ⚠️ {x}')
        print(f'🗂️ {kind}:併進研究分支 {ch} 個「日·市場」')
        return 0
    return main()


if __name__ == '__main__':
    sys.exit(_cli())
