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
   ⑦ 🔁 V82.3.0 連線被重設 / 逾時 → 等 5 / 15 / 30 秒再試;第一輪跑完還有沒抓到的 → 等 60 秒每個再試一次;
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
# 🔁 V82.3.0 第一次實跑(11/13)連線被重設 4 次 → 漏了 11/13 上櫃重大訊息、11/12 上市申報轉讓,log 還沒寫是哪一天哪個市場。
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
MOPS_COLS = ['s', 'n', 'd', 't', 'sub', 'mk', 'cat']
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
    """backfill 格式 [代號, 名稱, 日期, 時間, 主旨, 市場] → App 用的列(只收代號、加類別)。"""
    return [[r[0], r[1], r[2], r[3], r[4], mk, MEP.classify(r[4])] for r in raw if _CODE.match(str(r[0]))]


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

    raw_m, raw_i = {}, {}
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
    print(f'📢 抓 {", ".join(d.isoformat() for d in days)} ・請求 {n["req"]} 次 ・成功 {n["ok"]} 次 ・連線錯誤 {n["err"]} 次'
          f' ・被擋 {n["blocks"]} 次 ・重大訊息 {sum(len(v) for v in got_m.values())} 則 ・申報 {sum(len(v) for v in got_i.values())} 筆', flush=True)
    if todo:
        print(f'⚠️ 最後還是沒抓到:{miss_txt}(研究分支 ⛔ 標完成;下一輪會再抓「今天 + 前一個平日」,更早的要手動派 back 或等 backfill)', flush=True)
    _gh_summary(f'📢 mops_daily:請求 {n["req"]} 次 ・成功 {n["ok"]} 次 ・連線錯誤 {n["err"]} 次 ・被擋 {n["blocks"]} 次'
                + (f'\n\n⚠️ 最後還是沒抓到:{miss_txt}' if todo else '\n\n✅ 每一天每個市場都抓到了'))
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

    def server_factory(blocked=False, fail=None):
        calls = []

        def handle(method, url, data):
            calls.append((method, url.rsplit('/', 1)[-1]))
            if fail and fail(method, url, data):
                raise ConnectionResetError(104, 'Connection reset by peer')
            if blocked:
                return R('因為安全性考量,您的連線已被阻擋')
            if method == 'GET':
                return R(page)
            if url.endswith('ajax_t05st01'):
                y, m, dd = int(data['year']) + 1911, int(data['month']), int(data['b_date'])
                return R(mops_html(date(y, m, dd), data['TYPEK']))
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

        # ⑨~⑫ 🔁 連線被重設(V82.3.0:11/13 第一次實跑被重設 4 次 → 漏兩段,log 沒寫是哪一天哪個市場)
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
