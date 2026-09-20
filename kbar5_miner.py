#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📼 5 分 K 逐日累積(永豐 Shioaji api.kbars)→ kbar5 分支 kbar5/{YYYY-MM}.json.gz
──────────────────────────────────────────────────────────────────────────
為什麼要有這支(V77.0.1 的結論):
  12 條盤中口訣裡有 3 條(下午時段 / 開盤 10 分鐘站回 / 第一根 5 分 K 上影)**非分 K 不可**,
  而本 repo **一根分 K 都沒有存下來** —— `orb_probe` / `intraday_probe` / `volseq_probe`
  都是現抓 Shioaji、只寫結論 JSON;`live_quotes.json` 每 5 分覆蓋、`tick_flow.json` 每天覆蓋。
  後果:① `api.kbars()` 只回溯 81~120 天 → 六關的「逐年同向 / 去最好年」**天生過不了**
        ② **每次重跑窗口都往後滑,兩次結果不會一樣**。
  → 使用者 2026-09-14 明示「開始存分k」。

⛔ 三個刻意的設計(改之前先讀):
  ① **存獨立分支 `kbar5`,⛔ 不進 gh-pages** —— 前端根本不需要它(只給探針用),
     而 gh-pages 有 1GB 上限。連帶**完全避開陷阱 #41**(daily_miner 的 orphan force-push
     只吃 `data/`,碰不到別的分支)。同型前例:klines_deep / chips_deep / fin_deep。
  ② **按月分檔 + gzip**:每天只重寫**當月那一檔**,⛔ 不是每天重傳整年。
     實測 gzip 壓縮率 3.4x → 80 檔 × 54 根未壓縮 144KB/天、壓後 ~42KB/天、250 天 ~10.5MB。
  ③ **收盤後跑一次就好,⛔ 不做盤中迴圈** —— kbars 收盤後一次給當天完整 1 分 K,自己 agg 成 5 分。
     → ⛔ 不需要 `intraday_window.py` 那套節拍、⛔ 不吃排程配額。

⚠️⚠️ 母體的代價(使用者選「當日成交量前 80」,照做,但**必須誠實揭露**):
  名單每天變 → ① 某一檔在歷史上會斷斷續續 ② **天生只收「當天夠熱」的日子 = 選樣偏誤**。
  → 三件事一起做,⛔ 一件都不能省:
    ・檔案裡存**每日實際清單**(`d[date].syms`),回測時才算得出「這一檔在窗口內有幾天」
    ・meta 寫 `universe` + 一句偏誤說明
    ・**探針端**用這份資料時要有「這檔至少 N 天」與「⚠️ 母體有選樣偏誤」的輸出,
      ⛔ 不可把結論講得像全市場(同「回算要誠實揭露偏差」那四條)

需 GitHub Secrets:SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(同 live_snapshot / tick_flow,只做行情免憑證)
⚠️ 釘 `shioaji<1.7`(1.7 移除 `login(fetch_contract=)`,同 live_snapshot / tick_flow / orb_probe)

輸出 kbar5/{YYYY-MM}.json.gz:
  {
    "updated": ISO時間, "universe": "daily_top80_by_volume", "bias": "…",
    "month": "2026-09",
    "d": { "2026-09-12": { "syms": ["2330", …],
                           "k": { "2330": [[hm, o, h, l, c, v], …] },
                           "idx": { "TXF": [[hm, o, h, l, c, v], …] } } }   ← V77.3.8 起(台指期近月,日盤 08:45~13:45)
  }
  hm = 該根**開始**時間的台北牆鐘分鐘數(09:00 = 540;整數)—— 比存字串省一半空間,而且探針好比大小。
  🚨 V77.3.8 更正:舊註解寫「距 09:00 幾分鐘」是**名實不符** —— agg5 從第一天起存的就是絕對分鐘
     (selftest ① 釘 [540,545,550] 就是鐵證),⛔ 格式一個位元組都沒改,只把說明改對。
     所以台指期 08:45 = 525,天生不需要負數,也不會出現「股票用 A 口徑、期貨用 B 口徑」。

📈 V77.3.8 加收台指期近月(老余逐字稿的盤中主張八成在指數期貨,只有個股永遠測不到):
  ・獨立鍵 d[date].idx["TXF"],⛔ 不進 syms(股票母體 / bias 不變;期貨沒有選樣偏誤,別把兩件事混在一句話裡)
  ・只留**日盤 08:45~13:45**;夜盤(15:00~次日 05:00)⛔ 不收,三個理由:
    ① 夜盤的「交易日」是次一營業日,跟 d[date] 的日曆日對不起來 → 併進來會錯日
    ② 股票沒有夜盤 → 兩邊窗口不同,探針一不小心就拿不同長度的序列互比
    ③ 這次的用途是「盤中口訣」,全部發生在日盤
  ・抓不到只印一行,⛔ 不影響股票那半、⛔ 不影響 MIN_STOCKS 判定;已有 k 的舊日期只**補** idx 欄位、k/syms 一個位元組不動

⚠️ 本檔在無網路/無憑證 sandbox 無法實測;請在 GitHub Actions(有 Secrets)Run 看 log 驗證。
   本機可跑 `python3 kbar5_miner.py --selftest`(純函式,不打網路、不寫 kbar5/)。
"""
import os
import sys
import json
import gzip
import glob
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))
OUT_DIR = 'kbar5'
TOP_N = 80              # 照抄 tick_flow_miner 的母體(使用者選的)
MIN_STOCKS = 20         # 有效 < 20 檔 → 判定異常,不覆寫(自我修復,保留舊檔)
KEEP_MONTHS = 12        # 滾動保留 12 個月(約 2,500 萬 bytes 壓縮後)
BACKFILL_DAYS = 120     # 第一次跑:kbars 能回溯多少就抓多少(實測深度 81~120 天)
BAR_MIN = 5             # 5 分 K
SESS_OPEN = 9 * 60      # 09:00(台北牆鐘)
SESS_CLOSE = 13 * 60 + 30
IDX_SYMS = [('TXF', 'TXFR1')]   # 台指期近月連續(Shioaji 的 R1 = 近月);⛔ 不收小台,要加就加這裡
IDX_OPEN = 8 * 60 + 45          # 08:45 日盤開盤(hm 525,比股票早 15 分)
IDX_CLOSE = 13 * 60 + 45        # 13:45 日盤收盤(最後一根 5 分 K 的 hm = 820)


def _line(s):
    print(s, flush=True)


def _t(ts_ns):
    """🚨 Shioaji kbars 的 ts 是**奈秒**,而且已經是台灣牆鐘(naive)
    → 用 UTC 讀才得到正確的 09:00~13:30。⛔ 別再套 +8(orb_probe 實測踩過)。"""
    return datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)


def _hm(t):
    return t.hour * 60 + t.minute


def agg5(bars, n=BAR_MIN):
    """1 分 K → n 分 K(⛔ 用**時間**對齊,不可用「每 n 根」—— 中間缺 K 會錯位)。
    ⚠️ 不跨日:呼叫端自己把**同一天**的 1 分 K 丟進來。
    照抄 `intraday_probe.agg()`,⛔ 不發明第二套(兩份實作一定會漂移)。"""
    out, cur, key = [], None, None
    for b in bars:
        k = _hm(b['t']) // n
        if k != key:
            if cur:
                out.append(cur)
            key = k
            cur = {'hm': (_hm(b['t']) // n) * n, 'o': b['o'], 'h': b['h'], 'l': b['l'], 'c': b['c'], 'v': b['v']}
        else:
            cur['h'] = max(cur['h'], b['h'])
            cur['l'] = min(cur['l'], b['l'])
            cur['c'] = b['c']
            cur['v'] += b['v']
    if cur:
        out.append(cur)
    return out


def _r(v, d=2):
    try:
        return round(float(v), d)
    except Exception:
        return 0.0


def split_days(bars, lo=SESS_OPEN, hi=SESS_CLOSE):
    """把一整段 1 分 K 拆成 {日期: [該日盤中 1 分 K]}。
    ⛔ 只留盤中段(預設 09:00~13:30;台指期傳 IDX_OPEN/IDX_CLOSE = 08:45~13:45)——
       盤後零星撮合會把最後一根 5 分 K 弄髒;期貨的夜盤(15:00~次日 05:00)也在這裡被丟掉。
    ⛔ 不寫第二支 split_days_fut(兩份實作一定會漂移)。"""
    by = {}
    for b in bars:
        hm = _hm(b['t'])
        if hm < lo or hm > hi:
            continue
        by.setdefault(b['t'].strftime('%Y-%m-%d'), []).append(b)
    return by


def pack(k5):
    """5 分 K → 緊湊陣列 [[hm, o, h, l, c, v], …](⛔ 不存字串時間,省一半空間)"""
    return [[b['hm'], _r(b['o']), _r(b['h']), _r(b['l']), _r(b['c']), int(b['v'])] for b in k5]


# ── 月檔讀寫(gzip)────────────────────────────────────────────────
def _mpath(month):
    return os.path.join(OUT_DIR, f'{month}.json.gz')


def load_month(month):
    p = _mpath(month)
    if not os.path.exists(p):
        return None
    try:
        with gzip.open(p, 'rt', encoding='utf-8') as f:
            j = json.load(f)
        if isinstance(j, dict) and isinstance(j.get('d'), dict):
            return j
    except Exception as e:
        # ⛔ 壞檔不可靜默當成「沒有」→ 那會把整個月洗掉(陷阱 #18 同型)
        _line(f'❌ {p} 讀不起來({type(e).__name__}: {str(e)[:80]})→ ⛔ 這一版**不覆寫**它,請人工處理')
        raise
    return None


def save_month(month, days):
    os.makedirs(OUT_DIR, exist_ok=True)
    payload = {
        'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'month': month,
        'bar_min': BAR_MIN,
        'universe': 'daily_top80_by_volume',
        # ⚠️ 這一句是給**未來讀這份資料的人**看的,⛔ 不可刪:
        'bias': ('名單是「當日成交量前 80」,每天會變 → ① 某一檔在歷史上會斷斷續續 '
                 '② 天生只收「當天夠熱」的日子 = 選樣偏誤。回測時一律先算「這檔在窗口內有幾天」,'
                 '且結論⛔ 不可講得像全市場。每日實際清單在 d[date].syms。'),
        'fmt': 'k[sym] = [[hm(台北牆鐘分鐘,09:00=540), open, high, low, close, volume], …]',
        'idx_universe': 'TXFR1 台指期近月連續(日盤 08:45~13:45)',
        'fmt_idx': 'idx[TXF] = [[hm(台北牆鐘分鐘,08:45=525), open, high, low, close, volume], …]',
        'idx_note': '⛔ 夜盤(15:00~次日05:00)不收 —— 夜盤的交易日是次一營業日,跟 d[date] 的日曆日對不起來',
        'idx_days': sum(1 for v in days.values() if isinstance(v, dict) and v.get('idx')),
        'days': len(days),
        'd': days,
    }
    with gzip.open(_mpath(month), 'wt', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    return payload


def prune_months(keep=KEEP_MONTHS):
    files = sorted(glob.glob(os.path.join(OUT_DIR, '*.json.gz')))
    if len(files) <= keep:
        return []
    drop = files[:-keep]
    for p in drop:
        try:
            os.remove(p)
        except Exception:
            pass
    return drop


def merge_day(months, date, syms, kmap, idx=None):
    """把某一天塞進 months(dict: month → {date: {...}}),⭐ **實跑寫入優先**:
    已經有的日期就**不覆蓋**(同 CLAUDE.md 回算鐵則第 2 條),免得回補把真實那筆洗掉。
    V77.3.8:多了 idx(台指期)——
      ・已有 k 的日期:k / syms 一個位元組不動;**沒有 idx 而這次有** → 只補 idx、回 'idx'(補欄位不是覆蓋,
        上線前的月檔天生沒有 idx,不補就永遠沒有)
      ・kmap 為空 → 回 False,⛔ 不可只靠 idx 生出一天(會出現 syms: [] 的幽靈日)"""
    mon = date[:7]
    d = months.setdefault(mon, {})
    if date in d and d[date].get('k'):
        if idx and not d[date].get('idx'):
            d[date]['idx'] = idx
            return 'idx'
        return False
    if not kmap:
        return False
    d[date] = {'syms': syms, 'k': kmap}
    if idx:
        d[date]['idx'] = idx
    return True


def fetch_k5(api, contract, start, end, lo=SESS_OPEN, hi=SESS_CLOSE):
    """一個合約:api.kbars → 1 分 K → 拆日(只留盤中段)→ agg 成 5 分 K → pack。
    股票與台指期**共用這一支**(⛔ agg / split / pack 只有一份)。回 (by_date_packed, n_bars, n5)。"""
    kb = api.kbars(contract, start=start, end=end)
    ts = list(kb.ts)
    if not ts:
        return {}, 0, 0
    op, hi_, lo_, cl = list(kb.Open), list(kb.High), list(kb.Low), list(kb.Close)
    vol = list(getattr(kb, 'Volume', [0] * len(ts)))
    bars = [{'t': _t(ts[i]), 'o': op[i], 'h': hi_[i], 'l': lo_[i], 'c': cl[i], 'v': vol[i]}
            for i in range(len(ts))]
    by = split_days(bars, lo, hi)
    out, n5 = {}, 0
    for d, bs in by.items():
        k5 = agg5(bs)
        if not k5:
            continue
        out[d] = pack(k5)
        n5 += len(k5)
    return out, len(bars), n5


def idx_contract(api, code):
    """台指期近月連續合約:先試 Contracts.Futures.TXF[code](TXFR1),再 getattr;都沒有回 None(呼叫端只印一行)。"""
    cat = getattr(getattr(api, 'Contracts', None), 'Futures', None)
    cat = getattr(cat, 'TXF', None) if cat is not None else None
    if cat is None:
        return None
    try:
        c = cat[code]
        if c is not None:
            return c
    except Exception:
        pass
    return getattr(cat, code, None)


# ── selftest(純函式,⛔ 不打網路)──────────────────────────────────
def _selftest():
    fails = []

    def ok(n, c, e=''):
        print(f'{"✅" if c else "❌"} {n}{"" if c else "  " + str(e)[:200]}')
        if not c:
            fails.append(n)

    base = datetime(2026, 9, 12, 9, 0, tzinfo=timezone.utc)
    # ① agg5 用時間對齊:中間缺 4 根(09:04~09:07)
    #   🚨 測資刻意設計成 **4 + 3 根**(0,1,2,3 / 8,9,10)—— 第一版用 5+2,
    #      「每 n 根」剛好也切在同一個地方 → **注入驗證叫不出來**(假綠燈,當場踩到)。
    #      4+3:照時間 → 3 支(540 / 545 / 550);照「每 5 根」→ 只有 2 支,而且第一支
    #      會把 09:08 那根混進 09:00 那支裡。
    bars = []
    for i in list(range(0, 4)) + list(range(8, 11)):
        bars.append({'t': base + timedelta(minutes=i), 'o': 100 + i, 'h': 101 + i, 'l': 99 + i, 'c': 100 + i, 'v': 10})
    k5 = agg5(bars)
    ok('① 缺 K 時仍照時間對齊(⛔ 不可用「每 n 根」)',
       len(k5) == 3 and [b['hm'] for b in k5] == [540, 545, 550], [b['hm'] for b in k5])
    ok('①b OHLC 聚合正確', k5[0]['o'] == 100 and k5[0]['h'] == 104 and k5[0]['l'] == 99 and k5[0]['c'] == 103 and k5[0]['v'] == 40, k5[0])
    ok('①c 第二支只含 08/09 兩筆、⛔ 不可把 09:08 混進第一支', k5[1]['v'] == 20 and k5[1]['o'] == 108 and k5[0]['v'] == 40, [k5[0], k5[1]])

    # ② 盤後零星撮合要被濾掉(13:30 之後)
    dirty = bars + [{'t': base.replace(hour=14, minute=30), 'o': 1, 'h': 1, 'l': 1, 'c': 1, 'v': 1}]
    by = split_days(dirty)
    ok('② 盤後(14:30)那根要被濾掉,⛔ 不可弄髒最後一根 5 分 K', all(_hm(b['t']) <= SESS_CLOSE for b in by['2026-09-12']), len(by['2026-09-12']))

    # ③ 跨日要分開(⛔ agg5 不跨日)
    two = bars + [{'t': base + timedelta(days=1, minutes=i), 'o': 50, 'h': 50, 'l': 50, 'c': 50, 'v': 5} for i in range(3)]
    by2 = split_days(two)
    ok('③ 兩天要拆成兩個 key', sorted(by2.keys()) == ['2026-09-12', '2026-09-13'], list(by2.keys()))

    # ④ pack 緊湊化
    p = pack(k5)
    ok('④ pack 是 6 欄純數字(hm 是整數分鐘)', len(p[0]) == 6 and isinstance(p[0][0], int), p[0])

    # ⑤ ⭐ 實跑寫入優先:已經有的日期⛔ 不可被回補覆蓋
    months = {}
    merge_day(months, '2026-09-12', ['2330'], {'2330': [[540, 1, 1, 1, 1, 1]]})
    changed = merge_day(months, '2026-09-12', ['2317'], {'2317': [[540, 9, 9, 9, 9, 9]]})
    ok('⑤ 已經有的日期⛔ 不可被覆蓋(回算鐵則:實跑寫入優先)',
       changed is False and months['2026-09']['2026-09-12']['syms'] == ['2330'], months['2026-09'])

    # ⑥ 每日清單一定要存(⛔ 沒有它就算不出「這檔在窗口內有幾天」= 選樣偏誤無法揭露)
    ok('⑥ 每一天都要存 syms', 'syms' in months['2026-09']['2026-09-12'])

    # ⑦ 月份 key 切對
    months2 = {}
    merge_day(months2, '2026-10-01', ['2330'], {'2330': [[540, 1, 1, 1, 1, 1]]})
    ok('⑦ 跨月要分到不同月檔', '2026-10' in months2 and '2026-09' not in months2, list(months2.keys()))

    # ⑧ 台指期日盤窗口 08:45~13:45:08:45 與 13:45 要留、13:50 要丟;⭐ 同一批用**股票**窗口跑,08:45 必須被丟(對照組)
    fut = [{'t': base.replace(hour=8, minute=45), 'o': 1, 'h': 1, 'l': 1, 'c': 1, 'v': 1},
           {'t': base, 'o': 2, 'h': 2, 'l': 2, 'c': 2, 'v': 1},
           {'t': base.replace(hour=13, minute=45), 'o': 3, 'h': 3, 'l': 3, 'c': 3, 'v': 1},
           {'t': base.replace(hour=13, minute=50), 'o': 4, 'h': 4, 'l': 4, 'c': 4, 'v': 1}]
    byf = split_days(fut, IDX_OPEN, IDX_CLOSE)
    hms = [_hm(b['t']) for b in byf.get('2026-09-12', [])]
    ok('⑧ 台指期窗口:留 08:45 / 13:45、丟 13:50', hms == [525, 540, 825], hms)
    k5f = agg5(byf['2026-09-12'])
    ok('⑧b agg 後第一根 hm == 525(09:00 之前那根真的留下來了)', k5f and k5f[0]['hm'] == 525, k5f and k5f[0]['hm'])
    bys = split_days(fut)
    ok('⑧c 對照組:同一批用股票窗口跑,08:45 那根必須被丟(⛔ 沒有這條,「窗口參數沒生效」叫不出來)',
       [_hm(b['t']) for b in bys.get('2026-09-12', [])] == [540], [_hm(b['t']) for b in bys.get('2026-09-12', [])])

    # ⑨ 夜盤要被丟光(15:05 與次日 01:30)
    night = [{'t': base.replace(hour=15, minute=5), 'o': 1, 'h': 1, 'l': 1, 'c': 1, 'v': 1},
             {'t': (base + timedelta(days=1)).replace(hour=1, minute=30), 'o': 1, 'h': 1, 'l': 1, 'c': 1, 'v': 1}]
    ok('⑨ 夜盤(15:05 / 次日 01:30)一根都不可留', split_days(night, IDX_OPEN, IDX_CLOSE) == {}, split_days(night, IDX_OPEN, IDX_CLOSE))

    # ⑩ idx 三態:抓失敗不弄壞股票 / kmap 空⛔ 不可生出幽靈日 / 舊日期只補 idx、k 不動
    m3 = {}
    merge_day(m3, '2026-09-12', ['2330'], {'2330': [[540, 1, 1, 1, 1, 1]]}, None)
    ok('⑩ idx=None 時 d[date] 沒有 idx 鍵、k/syms 正常', 'idx' not in m3['2026-09']['2026-09-12'] and m3['2026-09']['2026-09-12']['syms'] == ['2330'])
    r0 = merge_day(m3, '2026-09-13', [], {}, {'TXF': [[525, 1, 1, 1, 1, 1]]})
    ok('⑩b kmap 為空 + 只有 idx → False,⛔ 不可生出這一天', r0 is False and '2026-09-13' not in m3['2026-09'], r0)
    r1 = merge_day(m3, '2026-09-12', ['2317'], {'2317': [[540, 9, 9, 9, 9, 9]]}, {'TXF': [[525, 7, 7, 7, 7, 7]]})
    ok("⑩c 已有 k 沒有 idx 的舊日期:回 'idx'、idx 補上、k/syms 仍是第一次那份",
       r1 == 'idx' and m3['2026-09']['2026-09-12']['idx'] == {'TXF': [[525, 7, 7, 7, 7, 7]]} and m3['2026-09']['2026-09-12']['syms'] == ['2330']
       and '2317' not in m3['2026-09']['2026-09-12']['k'], m3['2026-09']['2026-09-12'])
    r2 = merge_day(m3, '2026-09-12', ['2317'], {'2317': [[540, 9, 9, 9, 9, 9]]}, {'TXF': [[525, 8, 8, 8, 8, 8]]})
    ok('⑩d 已有 idx 的日期再來一次 → False,idx 也不覆蓋', r2 is False and m3['2026-09']['2026-09-12']['idx']['TXF'][0][1] == 7, r2)

    print()
    print(f'❌ {len(fails)} 條失敗' if fails else '✅ KBAR5_SELFTEST_PASS')
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        sys.exit(_selftest())

    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    if not key or not sec:
        print('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(請設 GitHub Secrets)')
        sys.exit(1)

    # 🔧 workflow 從 inputs.* 餵的環境變數在**排程觸發**時是**空字串**不是不存在
    #    → 一律 `or 預設`(check_env_default.py 會擋;V75.1.3 pe_band 四個週日零產出就是這個坑)
    days_back = int(os.environ.get('KBAR5_DAYS') or 0)

    import shioaji as sj
    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=key, secret_key=sec, fetch_contract=True)
        except TypeError:
            # shioaji ≥1.7 移除 login(fetch_contract=) 參數(登入時預設就抓合約)
            api.login(api_key=key, secret_key=sec)
        _line('✅ Shioaji 登入成功,抓合約中…')
    except Exception as e:
        print(f'❌ Shioaji 登入失敗:{e}')
        sys.exit(1)

    today = datetime.now(TW).date()

    # ── 1) 全上市櫃股票合約(濾權證/ETN/興櫃,與 live_snapshot / tick_flow 同規則)──
    stock_contracts = []
    seen = set()
    try:
        for exch in api.Contracts.Stocks:
            for c in exch:
                code = getattr(c, 'code', None) or ''
                exch_v = getattr(getattr(c, 'exchange', None), 'value', None) or str(getattr(c, 'exchange', ''))
                if 'OES' in str(exch_v).upper():
                    continue
                is_stock = code.isdigit() and len(code) == 4
                is_etf = code.startswith('00') and 4 <= len(code) <= 6
                if (is_stock or is_etf) and code not in seen:
                    seen.add(code)
                    stock_contracts.append((code, c))
    except Exception as e:
        _line(f'⚠️ 建股票合約清單出錯:{e}')

    # ── 2) 依「今日成交量」取前 TOP_N(⭐ 使用者選的母體:照抄 tick_flow_miner)──
    vol_rank = []
    B = 400
    for i in range(0, len(stock_contracts), B):
        batch = stock_contracts[i:i + B]
        try:
            snaps = api.snapshots([c for _, c in batch])
        except Exception as e:
            _line(f'⚠️ snapshot batch {i} 失敗:{e}')
            continue
        for (code, c), snap in zip(batch, snaps):
            try:
                tv = getattr(snap, 'total_volume', None) or getattr(snap, 'volume', None) or 0
                cl = getattr(snap, 'close', None)
                if cl is None or float(cl) <= 0 or int(tv) <= 0:
                    continue
                vol_rank.append((int(tv), code, c))
            except Exception:
                continue
    vol_rank.sort(key=lambda x: -x[0])
    hot = vol_rank[:TOP_N]
    _line(f'📋 全市場快照 {len(vol_rank)} 檔,取當日量前 {len(hot)} 檔')
    if len(hot) < MIN_STOCKS:
        _line(f'❌ 只挑到 {len(hot)} 檔(< {MIN_STOCKS})→ 判定異常,不覆寫(保留舊檔)')
        sys.exit(1)

    # ── 3) 決定要抓幾天 ──
    #   ⭐ 第一次跑(kbar5/ 是空的)自動回補 BACKFILL_DAYS —— kbars 回溯 81~120 天,
    #      ⛔ 不是「等半年才有樣本」,上線當天就有約 80 個交易日。
    existing = sorted(glob.glob(os.path.join(OUT_DIR, '*.json.gz')))
    if days_back <= 0:
        days_back = BACKFILL_DAYS if not existing else 5   # 平常只抓最近 5 天(補上週末/假日之後的空洞)
    start = (today - timedelta(days=days_back)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')
    _line(f'📅 kbars {start} ~ {end}(既有月檔 {len(existing)} 個 → 這輪抓 {days_back} 天)')

    # ── 4) 逐檔抓 1 分 K → 拆日 → agg 成 5 分 K ──
    per_day = {}        # date → {sym: packed}
    got = 0
    for rank, (_tv, code, c) in enumerate(hot):
        try:
            by, nb, n5 = fetch_k5(api, c, start, end)
            if not nb:
                continue
            for d, packed in by.items():
                per_day.setdefault(d, {})[code] = packed
            got += 1
            if rank < 3 or rank % 20 == 0:
                _line(f'  [{code}] {nb} 筆分K → {len(by)} 天 / {n5} 根 5 分K')
        except Exception as e:
            _line(f'  [{code}] ❌ {type(e).__name__}: {str(e)[:100]}')

    # ── 4b) 台指期近月 5 分 K(V77.3.8)—— ⛔ 一定要在 logout 之前;失敗只印一行、不影響股票那半 ──
    idx_day = {}        # date → {'TXF': packed}
    for code, cont_code in IDX_SYMS:
        try:
            ic = idx_contract(api, cont_code)
            if ic is None:
                _line(f'⚠️ 台指期 {cont_code} 找不到合約 → 這輪只有股票(⛔ 不影響股票判定)')
                continue
            by, nb, n5 = fetch_k5(api, ic, start, end, IDX_OPEN, IDX_CLOSE)
            for d, packed in by.items():
                idx_day.setdefault(d, {})[code] = packed
            _line(f'📈 台指期 {cont_code}:{nb} 筆分K → {len(by)} 天 / {n5} 根 5 分K(日盤 08:45~13:45;夜盤⛔ 不收)')
            if by:
                d0 = sorted(by)[0]
                # 🔎 給 Actions log 用的自我驗證:_t() 的時區假設若對期貨不成立,這兩個數字就不會是 525 / 820
                _line(f'   🔎 自我驗證 {d0}:第一根 hm={by[d0][0][0]}(應為 525)、最後一根 hm={by[d0][-1][0]}(應為 820)')
        except Exception as e:
            _line(f'⚠️ 台指期抓取失敗:{type(e).__name__}: {str(e)[:120]} → ⛔ 這輪只有股票,不影響覆寫判定')
    try:
        api.logout()
    except Exception:
        pass

    # ⛔ got 只數股票 —— 台指期⛔ 不可算進 MIN_STOCKS(它是附加欄位,不是母體)
    if got < MIN_STOCKS:
        _line(f'❌ 只抓到 {got} 檔(< {MIN_STOCKS})→ 判定異常,不覆寫(保留舊檔)')
        sys.exit(1)
    if not per_day:
        _line('❌ 一天都沒抓到 → 不覆寫')
        sys.exit(1)

    # ── 5) 併進月檔(⭐ 實跑寫入優先:已有的日期不覆蓋)──
    months = {}
    touched = sorted({d[:7] for d in per_day})
    for mon in touched:
        old = load_month(mon)
        months[mon] = dict(old['d']) if old else {}
    added, filled = 0, 0
    for d in sorted(set(per_day) | set(idx_day)):
        kmap = per_day.get(d, {})
        r = merge_day(months, d, sorted(kmap.keys()), kmap, idx_day.get(d))
        if r == 'idx':
            filled += 1
        elif r:
            added += 1

    total_days = 0
    for mon in touched:
        p = save_month(mon, months[mon])
        total_days += p['days']
        sz = os.path.getsize(_mpath(mon))
        _line(f'💾 {_mpath(mon)} · {p["days"]} 天 · {sz / 1024:.0f} KB(壓縮後)')

    dropped = prune_months()
    if dropped:
        _line(f'🧹 滾動保留 {KEEP_MONTHS} 個月 → 刪掉 {len(dropped)} 個舊月檔:{", ".join(os.path.basename(x) for x in dropped)}')

    allf = sorted(glob.glob(os.path.join(OUT_DIR, '*.json.gz')))
    tot = sum(os.path.getsize(x) for x in allf)
    idx_days = sum(1 for mon in touched for v in months[mon].values() if isinstance(v, dict) and v.get('idx'))
    _line(f'✅ 5 分 K 累積完成:這輪新增 {added} 天 · 本次動到 {len(touched)} 個月 · '
          f'全部 {len(allf)} 個月檔 / {tot / 1048576:.1f} MB · 台指期 {idx_days} 天(其中舊日期回補欄位 {filled} 天)')
    _line('⚠️ 母體是「當日成交量前 80」→ 名單每天變,回測時務必先算「這檔在窗口內有幾天」'
          '並揭露選樣偏誤(檔案裡的 bias 欄有寫)')


if __name__ == '__main__':
    main()
