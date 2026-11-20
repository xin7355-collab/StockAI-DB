#!/usr/bin/env python3
"""📚 V82.5.7 長歷史每天接著補 → data/fi_mkt_hist.json + data/taifex_hist.json(「App 加上人性」第 6 期)

為什麼要有這支:
  產業作戰室「🧠 人性」頁(scripts/mood_build.mjs)拿這兩份排「今天在自己歷史排第幾」,
  但它們只有手動補挖(hist_backfill.yml)→ 停在 10/19:買賣權比 / 期貨大戶那兩條只能標「停在 10/19」,
  外資 5 日 / 20 日 / 今年也沒得算(⛔ 拿 risk_history 每天的快照加總 —— 快照會重複,陷阱 #16)。

做法(明日作戰清單那一步、排在 mood_build 之前跑;⛔ 另開排程 —— 同一個 job 先補再算,⛔ 跟它賽跑):
  讀 data/ 裡這兩份(上一步從 data 分支還原的)→ 每一條從自己的最後一天往前 OVERLAP 天抓 → 合併。
  ⭐ 解析一律呼叫補挖那兩支的函式(fi_mkt_miner / taifex_hist_miner,⛔ 第二份),來源也一樣:
    FinMind 免費層(金鑰只放 Authorization 標頭):外資現貨 spot / 外資台指期 fut(TX)/ 整體融資 mg /
      台指期近月 + 加權收盤 → 期現基差 bs / 三大法人小台(MTX,散戶多空比的分子)
    期交所下載頁(同補挖那組表單):選擇權 P/C pc / 台指期大額交易人 lt / 小台全市場未平倉(散戶多空比的分母)
      下載頁連不到 / 被擋 → P/C 與大額交易人改問期交所 OpenAPI(P/C 約 18 天、大額只有最新 1 天 → 標「沒對過」)
  一律走 lib_http.Gate:UA 寫明身分、被擋就整個網站停手(⛔ 換身分重試)、忙就退避、同一個網站固定間隔。
  守門(每一條各自判;沒過的那條沿用上一份、原因寫進 daily.err,⛔ 拖垮別條):
    ① 這次抓到的最後一天不可以比上一份還早(來源回舊資料)
    ② 重疊那幾天要對得上:對不上的天數超過兩成 → 這次的不收(同一把尺,陷阱 #17);
       重疊不到 MIN_OV 天也不收(沒辦法證明是同一把尺)—— 只有 OpenAPI 大額交易人(本來就只給 1 天)例外,標「沒對過」
    ③ 超過今天的日期丟掉
  缺幾天(加權有開盤、這條沒有,例如融資晚上才公布)→ 只記在 daily.gap(下一輪往前抓會補上),⛔ 不擋。
  上一份讀不出來 → 那一份 ⛔ 動、最後 exit 1;上一份不在 → 跳過(這支只接著補,從頭建請跑 hist_backfill)。
  有變才寫回 data/(mood_build 讀它),並複製到 OUTDIR(部署那一步只推有變的;⛔ 拿還原回來的舊檔蓋掉別人剛推的)。
  ⛔ 只描述:這兩份只拿來排名次與研究,⛔ 進任何買賣判斷。

📊 V82.5.8 同一步也收全市場當沖占比 → data/dtr_hist.json(上市;官方「當日沖銷交易統計資訊」)
  證交所 rwd dayTrading/TWTB4U?date=…(11/20 探針 run 44619022085 對過:tables 兩張,欄位照名字找)
  每一輪:先補最近 DTR_RECENT 個平日裡還沒有的,再往前補 DTR_BACK 天(慢慢長出歷史,補到 DTR_FROM 為止);
  證交所 www 每次隔 4 秒、被擋就停手;回應的日期跟問的不一樣 → 不收;
  統計表空的:最近幾天(可能還沒公布)下一輪再問、更早的(休市)記進 none 不再問。
  中間某一天失敗 → 記進 miss,下一輪回頭補(一輪最多 DTR_HOLES 個、問 DTR_GIVEUP 次都沒拿到就不再問);
  這一輪一天都沒拿到 = 來源有問題 → ⛔ 算到那幾天頭上。

跑法:python3 scripts/hist_daily.py [--selftest]
      環境變數 DATA_DIR=data・OUTDIR=(留空 = 不複製)・FINMIND_TOKENS(逗號分隔)
"""
import json
import os
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
for _p in (ROOT, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import fi_mkt_miner as FMM          # noqa: E402  補挖那支的解析(⛔ 第二份)
import taifex_hist_miner as TXM     # noqa: E402
from lib_http import Gate           # noqa: E402
from lib_jsonsafe import load_accum  # noqa: E402

FM_API = 'https://api.finmindtrade.com/api/v4/data'
OVERLAP = 45          # 每一條從自己的最後一天往前抓幾天(FinMind 偶爾修正 + 確保重疊夠對表)
MIN_OV = 5            # 重疊幾天以上才算證明得了是同一把尺
BAD_SHARE = 0.2       # 重疊那幾天對不上超過幾成就不收這次的
GAPS = {'api.finmindtrade.com': 1.0, 'www.taifex.com.tw': 1.5, 'openapi.taifex.com.tw': 1.0, 'www.twse.com.tw': 4.0}
DTR_URL = 'https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U'
DTR_RECENT = 3        # 每一輪先補最近幾個平日(還沒有的)
DTR_BACK = 30         # 每一輪往前補幾天(V82.6.3 10 → 30;證交所 www 隔 4 秒 → 一輪最多 3 + 3 + 30 = 36 次 ≈ 2.5 分)
DTR_HOLES = 3         # 每一輪最多回頭補幾個「問過但沒拿到」的洞(⛔ 永遠留著一個破洞)
DTR_GIVEUP = 3        # 同一天問 3 次都沒拿到 → 不再問(記在 miss,看得出缺哪幾天)
DTR_FROM = '2014-01-06'   # V82.6.4:探針(official_extra_probe DTR_AT,run 44788198298)問 2014-01-06 / 2018-01-02 / 2022-10-03 → 統計表都有、6 個欄位跟現在一字不差 → 往前延
#   (2014-01-06 那天可以當沖的只有 150 檔、買進金額占比 0.69%;2018 約 24%、2022 約 46% → 中間有制度斷點,研究要切開、人性頁只跟近 3 年比)
DTR_FIELDS = (('成交股數', '比重'), ('買進', '金額', '比重'), ('賣出', '金額', '比重'), ('總成交股數',), ('總買進成交金額',), ('總賣出成交金額',))
FI_KEYS = ('spot', 'fut', 'mg', 'bs')
TX_KEYS = ('pc', 'lt', 'rl')


def _tw_now():
    return datetime.now(timezone(timedelta(hours=8)))


def _close(a, b, ab, rel):
    try:
        a, b = float(a), float(b)
    except (TypeError, ValueError):
        return False
    return abs(a - b) <= max(ab, abs(b) * rel)


# 每一條「同一天兩份算不算一樣」:門檻沿用補挖那支跟快照對表的 TOL(⛔ 另編)
def same_spot(n, o):
    return all(_close(n[i], o[i], *FMM.TOL['spot']) for i in range(3))


def same_fut(n, o):
    return _close(n, o, *FMM.TOL['fut'])


def same_mg(n, o):
    return _close(n, o, *FMM.TOL['mg'])


def same_bs(n, o):
    return _close(n[0], o[0], *FMM.TOL['bs']) and _close(n[2], o[2], 0.5, 0.0)


def same_pc(n, o):
    return _close(n[0], o[0], 0.5, 0.01) and _close(n[1], o[1], 0.5, 0.01)


def same_lt(n, o):
    ks = [k for k in ('all', 'spec') if isinstance(o, dict) and k in o]
    if not ks or not isinstance(n, dict) or any(k not in n for k in ks):
        return False
    return all(_close(n[k][2], o[k][2], 1, 0.005) and _close(n[k][0], o[k][0], 50, 0.02) and _close(n[k][1], o[k][1], 50, 0.02) for k in ks)


def same_rl(n, o):
    return _close(n[3], o[3], 0.5, 0.0) and _close(n[2], o[2], 1, 0.005)


SAME = {'spot': same_spot, 'fut': same_fut, 'mg': same_mg, 'bs': same_bs, 'pc': same_pc, 'lt': same_lt, 'rl': same_rl}


def merge(prev, new, same, today_iso, need_ov=True):
    """prev / new = {YYYY-MM-DD: 值} → (合併後, 新增的日期, 重疊天數, 不收的原因 '')。
    同一天用這次的(來源偶爾修正);守門 ①②③ 見檔頭。"""
    prev = prev or {}
    new = {d: v for d, v in (new or {}).items() if d and d <= today_iso}
    if not new:
        return dict(prev), [], 0, ''
    ov = sorted(d for d in new if d in prev)
    if prev:
        lp, ln = max(prev), max(new)
        if ln < lp:
            return dict(prev), [], len(ov), f'這次抓到的最後一天 {ln} 比上一份的 {lp} 還早 → 這次的不收'
        if len(ov) >= MIN_OV:
            bad = [d for d in ov if not same(new[d], prev[d])]
            if len(bad) > BAD_SHARE * len(ov):
                b = bad[-1]
                return dict(prev), [], len(ov), f'重疊 {len(ov)} 天有 {len(bad)} 天對不上(例:{b} 這次 {new[b]} vs 上一份 {prev[b]})→ 這次的不收'
        elif need_ov:
            return dict(prev), [], len(ov), f'這次跟上一份只重疊 {len(ov)} 天(< {MIN_OV}),證明不了是同一把尺 → 這次的不收'
    added = sorted(d for d in new if d not in prev)
    out = dict(prev)
    out.update(new)
    return {d: out[d] for d in sorted(out)}, added, len(ov), ''


def win_start(series, today):
    """從這一條的最後一天往前 OVERLAP 天;沒有就從今天往前。"""
    last = max(series) if series else None
    base = date.fromisoformat(last) if last else today
    return (base - timedelta(days=OVERLAP)).isoformat()


def months_between(a_iso, today):
    y, m = int(a_iso[:4]), int(a_iso[5:7])
    out = []
    while (y, m) <= (today.year, today.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def fm_fetch(gate, tokens, dataset, start, end, data_id=None):
    """FinMind 一段區間(一次請求);輪 token。→ (rows 或 None, 原因)。⛔ 金鑰只放標頭、⛔ 印出來。"""
    q = {'dataset': dataset, 'start_date': start, 'end_date': end}
    if data_id:
        q['data_id'] = data_id
    last = '沒有金鑰'
    for i, t in enumerate(tokens or ['']):
        hdr = {'Authorization': f'Bearer {t}'} if t else {}
        res, why = gate.get(FM_API, params=q, headers=hdr, expect='json')
        if res is None:
            page = (gate.fail_page.get('api.finmindtrade.com') or '')[:80]
            last = f'第 {i + 1} 把 {why}' + (f'({page})' if page and not why.startswith('斷路') else '')
            if why.startswith('斷路'):
                break
            continue
        try:
            j = res.json()
        except Exception:  # noqa: BLE001
            last = f'第 {i + 1} 把 回應讀不出 JSON'
            continue
        if isinstance(j, dict) and j.get('status') in (200, None) and isinstance(j.get('data'), list):
            return j['data'], ''
        last = f"第 {i + 1} 把 status={j.get('status') if isinstance(j, dict) else '?'} {str((j or {}).get('msg') if isinstance(j, dict) else '')[:60]}"
    return None, last


def taifex_down(gate, url, months, extra=None):
    """期交所下載頁(同補挖那組表單)按月 POST → (合併後 {日期: 值}, 原因 '')。
    被擋 / 回網頁 → Gate 斷路、後面的月份 ⛔ 再送。"""
    if url == TXM.DOWN_PC:
        parse = TXM.parse_pc_csv
    elif url == TXM.DOWN_LT:
        parse = TXM.parse_lt_csv
    else:
        parse = TXM.parse_fut_csv
    got, errs = {}, []
    for y, m in months:
        form = {'down_type': '1', 'queryStartDate': f'{y}/{m:02d}/01', 'queryEndDate': f'{y}/{m:02d}/{TXM._month_end(y, m):02d}'}
        if url == TXM.DOWN_LT:
            form['commodity_id'] = 'TX'
        form.update(extra or {})
        res, why = gate.post(url, data=form, expect='csv')
        if res is None:
            errs.append(f'{y}/{m:02d} {why}')
            if why.startswith('斷路'):
                break
            continue
        part, perr = parse(TXM._decode(res.content))
        if perr:
            errs.append(f'{y}/{m:02d} 格式不同:{perr}')
            continue
        got.update(part)
    return got, ('、'.join(errs) if errs and not got else ('部分月份抓不到:' + '、'.join(errs) if errs else ''))


def openapi(gate, url, parse):
    res, why = gate.get(url, expect='json')
    if res is None:
        return {}, why
    try:
        return parse(res.json()), ''
    except Exception as e:  # noqa: BLE001
        return {}, f'讀不出 JSON({type(e).__name__})'


def _put(doc, rep, key, fetched, via, today_iso, cal, need_ov=True, fetch_err=''):
    """把這一條合併進 doc,並記下報告。cal = 加權有開盤的日子(找 gap 用;None = 不判)。"""
    old = doc.get(key) or {}
    prev_last = max(old) if old else ''
    if fetched is None or (not fetched and fetch_err):
        rep['err'][key] = fetch_err or '抓不到'
        rep['last'][key] = prev_last
        return False
    merged, added, nov, why = merge(old, fetched, SAME[key], today_iso, need_ov=need_ov)
    rep['last'][key] = max(merged) if merged else ''
    rep['add'][key] = len(added)
    rep['via'][key] = via + ('' if nov >= MIN_OV or not added else f'(只重疊 {nov} 天,沒對過)')
    if fetch_err:
        rep['err'][key] = fetch_err
    if why:
        rep['err'][key] = why
        return False
    if cal:
        gap = [d for d in cal if prev_last < d <= today_iso and d not in merged]
        if gap:
            rep['gap'][key] = gap[-10:]
    changed = merged != old
    if changed:
        doc[key] = merged
    return changed


def run(gate, fi_doc, tx_doc, today, tokens, log=print):
    """→ (fi_doc 或 None, tx_doc 或 None, 報告 {fi:{…}, tx:{…}}, 哪幾份有變)。doc = 上一份(⛔ 原地改,呼叫端給複本)。"""
    today_iso = today.isoformat()
    rep = {}
    changed = set()
    cal = None
    if fi_doc is not None:
        r = rep['fi'] = {'add': {}, 'last': {}, 'via': {}, 'err': {}, 'gap': {}}
        # 加權收盤:期現基差的另一腿 + 找 gap 的日曆(⛔ 另抓一次)
        s_bs = win_start(fi_doc.get('bs') or {}, today)
        ix_rows, e_ix = fm_fetch(gate, tokens, 'TaiwanStockPrice', s_bs, today_iso, 'TAIEX')
        ix = FMM.parse_ix(ix_rows) if ix_rows is not None else None
        cal = sorted(ix) if ix else None
        for key, ds, data_id, parse in (('spot', 'TaiwanStockTotalInstitutionalInvestors', None, FMM.parse_spot),
                                        ('fut', 'TaiwanFuturesInstitutionalInvestors', 'TX', FMM.parse_fut),
                                        ('mg', 'TaiwanStockTotalMarginPurchaseShortSale', None, FMM.parse_mg)):
            rows, e = fm_fetch(gate, tokens, ds, win_start(fi_doc.get(key) or {}, today), today_iso, data_id)
            if _put(fi_doc, r, key, parse(rows) if rows is not None else None, 'FinMind', today_iso, cal, fetch_err=e):
                changed.add('fi')
        tx_rows, e_tx = fm_fetch(gate, tokens, 'TaiwanFuturesDaily', s_bs, today_iso, 'TX')
        bs = FMM.combine_bs(FMM.parse_txnear(tx_rows), ix) if (tx_rows is not None and ix is not None) else None
        if _put(fi_doc, r, 'bs', bs, 'FinMind', today_iso, cal, fetch_err=(e_tx or e_ix) if bs is None else ''):
            changed.add('fi')
        for k in FI_KEYS:
            log(f"  {'⚠️' if k in r['err'] else '✅'} {k}:新增 {r['add'].get(k, 0)} 天 ・最後 {r['last'].get(k) or '—'}"
                f"{' ・' + r['err'][k] if k in r['err'] else ''}{' ・缺 ' + ','.join(r['gap'][k]) if k in r['gap'] else ''}")
    if tx_doc is not None:
        r = rep['tx'] = {'add': {}, 'last': {}, 'via': {}, 'err': {}, 'gap': {}}
        mons = months_between(win_start(tx_doc.get('pc') or {}, today), today)
        pc, e = taifex_down(gate, TXM.DOWN_PC, mons)
        via = '期交所下載頁'
        if not pc:
            pc2, e2 = openapi(gate, TXM.OPENAPI_PC, TXM.parse_openapi_pc)
            if pc2:
                pc, via, e = pc2, '期交所 OpenAPI(下載頁:' + (e or '空的') + ')', ''
            else:
                e = f'下載頁:{e or "空的"} ・OpenAPI:{e2 or "空的"}'
        if _put(tx_doc, r, 'pc', pc if pc else None, via, today_iso, cal, fetch_err=e):
            changed.add('tx')
        mons = months_between(win_start(tx_doc.get('lt') or {}, today), today)
        lt, e = taifex_down(gate, TXM.DOWN_LT, mons)
        via, need = '期交所下載頁', True
        if not lt:
            lt2, e2 = openapi(gate, TXM.OPENAPI_LT, TXM.parse_openapi_lt)
            if lt2:
                lt, via, e, need = lt2, '期交所 OpenAPI(下載頁:' + (e or '空的') + ')', '', False   # OpenAPI 只給最新 1 天 → 沒辦法對表
            else:
                e = f'下載頁:{e or "空的"} ・OpenAPI:{e2 or "空的"}'
        if _put(tx_doc, r, 'lt', lt if lt else None, via, today_iso, cal, need_ov=need, fetch_err=e):
            changed.add('tx')
        # 小台散戶多空比 = −三大法人小台淨未平倉 ÷ 小台全市場未平倉(TXM.merge_rl;兩腿任一抓不到 → 這條 ⛔ 動)
        s_rl = win_start(tx_doc.get('rl') or {}, today)
        inst_rows, e_i = fm_fetch(gate, tokens, 'TaiwanFuturesInstitutionalInvestors', s_rl, today_iso, 'MTX')
        oi, e_o = taifex_down(gate, TXM.DOWN_FUT, months_between(s_rl, today), {'commodity_id': 'MTX', 'commodity_id2': ''})
        rl = TXM.merge_rl(TXM.parse_finmind_inst(inst_rows), oi) if (inst_rows is not None and oi) else None
        e_rl = '' if rl is not None else ('三大法人小台(FinMind):' + e_i if inst_rows is None else '小台全市場未平倉(期交所下載頁):' + (e_o or '空的'))
        if _put(tx_doc, r, 'rl', rl, 'FinMind + 期交所下載頁', today_iso, cal, fetch_err=e_rl):
            changed.add('tx')
        for k in TX_KEYS:
            log(f"  {'⚠️' if k in r['err'] else '✅'} {k}:新增 {r['add'].get(k, 0)} 天 ・最後 {r['last'].get(k) or '—'} ・{r['via'].get(k, '—')}"
                f"{' ・' + r['err'][k] if k in r['err'] else ''}{' ・缺 ' + ','.join(r['gap'][k]) if k in r['gap'] else ''}")
    stamp = _tw_now().strftime('%Y-%m-%d %H:%M +0800')
    if 'fi' in changed:
        fi_doc['updated'] = _tw_now().strftime('%Y-%m-%d %H:%M')
        fi_doc['to'] = max(max(fi_doc[k]) for k in FI_KEYS if fi_doc.get(k))
        for k in FI_KEYS:
            s = fi_doc.get(k) or {}
            if s and isinstance(fi_doc.get('src'), dict):
                fi_doc['src'][k] = f'{min(s)} ~ {max(s)} ・{len(s)} 天(補挖 + 每天接著補)'
        fi_doc['daily'] = {'run': stamp, **rep['fi']}
    if 'tx' in changed:
        tx_doc['updated'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        tx_doc['to'] = max(max(tx_doc[k]) for k in ('pc', 'lt') if tx_doc.get(k))
        tx_doc['n'] = {k: len(tx_doc.get(k) or {}) for k in TX_KEYS}
        tx_doc['daily'] = {'run': stamp, **rep['tx']}
    return fi_doc, tx_doc, rep, changed


def parse_dtr(obj, want_iso):
    """證交所 TWTB4U → (值 [股數占比%, 買進金額占比%, 賣出金額占比%, 成交股數, 買進金額, 賣出金額] 或 None, 原因 '')。
    統計表 = 欄位含「占市場比重」那張;欄位一律照名字找(⛔ 寫死第幾欄);回應日期 ≠ 問的那天 → 不收(陷阱 #60)。"""
    if not isinstance(obj, dict):
        return None, '不是 JSON 物件'
    raw = ''.join(ch for ch in str(obj.get('date') or '') if ch.isdigit())
    if len(raw) == 8 and f'{raw[:4]}-{raw[4:6]}-{raw[6:]}' != want_iso:
        return None, f'回應日期 {raw} 跟問的 {want_iso} 不一樣'
    for t in [t for t in (obj.get('tables') or []) if isinstance(t, dict)] + ([obj] if obj.get('fields') else []):
        f = [str(x).replace(' ', '').replace('\n', '') for x in (t.get('fields') or [])]
        if not any('占市場比重' in x for x in f):
            continue
        if not t.get('data'):
            return None, 'empty'
        row = t['data'][0]

        def col(keys, ratio):
            for i, x in enumerate(f):
                if all(k in x for k in keys) and (('比重' in x) == ratio) and i < len(row):
                    try:
                        return float(str(row[i]).replace(',', '').replace('%', '').strip())
                    except ValueError:
                        return None
            return None
        v = [col(DTR_FIELDS[0], True), col(DTR_FIELDS[1], True), col(DTR_FIELDS[2], True),
             col(DTR_FIELDS[3], False), col(DTR_FIELDS[4], False), col(DTR_FIELDS[5], False)]
        if None in v[:3] or not all(0 <= x <= 100 for x in v[:3]):
            return None, f'統計表欄位對不上:{f}'
        return v, ''
    return None, 'empty'


def _weekdays_back(start, n, stop_iso='0000-00-00', skip=()):
    """從 start(含)往回找 n 個平日(⛔ 包含 skip 裡的、⛔ 早於 stop)。"""
    out, d = [], start
    while len(out) < n and d.isoformat() >= stop_iso:
        if d.weekday() < 5 and d.isoformat() not in skip:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out


def run_dtr(gate, doc, today, log=print):
    """全市場當沖占比:doc = 上一份(⛔ 原地改;None = 第一次)→ (doc, 有沒有變, 報告)。
    一輪 = 最近 DTR_RECENT 個平日裡還沒有的 + 最多 DTR_HOLES 個洞(問過但沒拿到、⛔ 休市)+ 往前 DTR_BACK 天。
    洞:中間某一天連線失敗 / 回應不對 → 記進 miss(次數),下一輪回頭再問;滿 DTR_GIVEUP 次就不再問(留在 miss 看得出缺哪天)。"""
    doc = doc if isinstance(doc, dict) else {}
    d, none = dict(doc.get('d') or {}), list(doc.get('none') or [])
    miss = {k: int(v) for k, v in (doc.get('miss') or {}).items() if isinstance(v, (int, float))}
    rep = {'add': [], 'err': {}, 'asked': 0, 'holes': 0}
    fails = []                           # 這一輪失敗的(⛔ 最近幾天、⛔ 被擋)→ 這一輪有拿到別天的,才算那一天自己的問題
    recent = _weekdays_back(today, DTR_RECENT)
    asked_before = set(d) | set(none) | set(miss)
    lo = min(asked_before | set(recent))
    holes = [x for x in _weekdays_back(date.fromisoformat(recent[-1]) - timedelta(days=1), 99999, lo)
             if x not in d and x not in none and miss.get(x, 0) < DTR_GIVEUP][:DTR_HOLES]
    rep['holes'] = len(holes)
    targets = [x for x in recent if x not in d] + holes
    targets += _weekdays_back(date.fromisoformat(lo) - timedelta(days=1), DTR_BACK, DTR_FROM, skip=asked_before)
    for iso in targets:
        res, why = gate.get(DTR_URL, params={'date': iso.replace('-', ''), 'selectType': 'All', 'response': 'json'}, expect='json')
        rep['asked'] += 1
        if res is None:
            rep['err'][iso] = why
            if why.startswith('斷路'):     # 被擋 / 網站掛了:⛔ 算那一天的錯,整輪停手
                break
        else:
            try:
                v, why = parse_dtr(res.json(), iso)
            except Exception:  # noqa: BLE001
                v, why = None, '回應讀不出 JSON'
            if v is not None:
                d[iso] = v
                miss.pop(iso, None)
                rep['add'].append(iso)
                continue
            if why == 'empty':
                if iso not in recent:    # 最近幾天可能只是還沒公布 → 下一輪再問;更早的 = 休市,記下來不再問
                    none.append(iso)
                    miss.pop(iso, None)
                continue
            rep['err'][iso] = why
        if iso not in recent:            # 最近幾天下一輪本來就會再問 → 不記洞
            fails.append(iso)
    if rep['add']:
        for iso in fails:
            miss[iso] = miss.get(iso, 0) + 1
    elif fails:                          # 一天都沒拿到 = 整個來源有問題(改版 / 掛了),⛔ 算到那幾天頭上(不然 3 輪後全部放棄)
        rep['err']['_'] = f'這一輪一天都沒拿到 → {len(fails)} 天的失敗不記進 miss'
    old_miss = {k: int(v) for k, v in (doc.get('miss') or {}).items() if isinstance(v, (int, float))}
    changed = bool(rep['add']) or len(set(none)) != len(set(doc.get('none') or [])) or miss != old_miss
    if changed:
        doc.update({'v': 1, 'src': '證交所 rwd dayTrading/TWTB4U「當日沖銷交易統計資訊」(上市)',
                    'unit': '[成交股數占市場比重%, 買進成交金額占比%, 賣出成交金額占比%, 成交股數, 買進成交金額(元), 賣出成交金額(元)]',
                    'updated': _tw_now().strftime('%Y-%m-%d %H:%M'), 'd': {k: d[k] for k in sorted(d)}, 'none': sorted(set(none)),
                    'miss': {k: miss[k] for k in sorted(miss)},
                    'daily': {'run': _tw_now().strftime('%Y-%m-%d %H:%M +0800'), 'add': rep['add'], 'asked': rep['asked'],
                              'holes': rep['holes'], 'err': rep['err']}})
    gave_up = sorted(k for k, n in miss.items() if n >= DTR_GIVEUP)
    log(f"  {'⚠️' if rep['err'] else '✅'} dtr:問了 {rep['asked']} 天(其中回頭補洞 {rep['holes']})、新增 {len(rep['add'])} 天"
        f"{'(' + min(rep['add']) + ' ~ ' + max(rep['add']) + ')' if rep['add'] else ''} ・共 {len(d)} 天"
        f"{' ・問了 ' + str(DTR_GIVEUP) + ' 次都沒拿到、不再問:' + ', '.join(gave_up[-5:]) if gave_up else ''}"
        f"{' ・' + '; '.join(f'{k} {v}' for k, v in list(rep['err'].items())[:3]) if rep['err'] else ''}")
    return doc, changed, rep


def _tokens():
    return FMM._tokens()


def make_gate(**kw):
    return Gate(gaps=GAPS, default_gap=1.0, timeout=40, **kw)


def main():
    data_dir = Path(os.environ.get('DATA_DIR') or 'data')
    outdir = os.environ.get('OUTDIR') or ''
    rc = 0
    docs = {}
    for name in ('fi_mkt_hist', 'taifex_hist', 'dtr_hist'):
        p = data_dir / f'{name}.json'
        if name != 'dtr_hist' and (not p.exists() or p.stat().st_size == 0):
            print(f'ℹ️ {p} 不在 → 跳過(這支只接著補;從頭建請手動跑「📚 歷史補挖」)')
            docs[name] = None
            continue
        obj, can_write = load_accum(p, {} if name == 'dtr_hist' else None, what=f'{name}.json')
        if not can_write or not isinstance(obj, dict):
            print(f'❌ {p} 讀不出來 → ⛔ 這份不動(⛔ 用這一輪蓋掉整段歷史)')
            docs[name] = None
            rc = 1
            continue
        docs[name] = obj

    def _write(name, doc):
        p = data_dir / f'{name}.json'
        tmp = p.with_suffix('.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, p)
        print(f'✅ 寫入 {p}:{p.stat().st_size:,} bytes')
        if outdir:
            os.makedirs(outdir, exist_ok=True)
            shutil.copyfile(p, os.path.join(outdir, f'{name}.json'))

    gate, today = make_gate(), _tw_now().date()
    rep = {}
    if docs['fi_mkt_hist'] is not None or docs['taifex_hist'] is not None:
        toks = [t for t in _tokens() if t]
        print(f"📚 長歷史接著補:FinMind 金鑰 {len(toks)} 把 ・往前 {OVERLAP} 天抓、重疊 ≥{MIN_OV} 天才算同一把尺")
        fi, tx, rep, changed = run(gate, docs['fi_mkt_hist'], docs['taifex_hist'], today, toks or [''])
        for name, doc, tag in (('fi_mkt_hist', fi, 'fi'), ('taifex_hist', tx, 'tx')):
            if doc is None:
                continue
            if tag in changed:
                _write(name, doc)
            else:
                print(f'ℹ️ {name}.json 沒有新的(或這次的沒過守門)→ 不寫')
    if docs['dtr_hist'] is not None:
        print(f'📊 全市場當沖占比(證交所;最近 {DTR_RECENT} 個平日 + 往前補 {DTR_BACK} 天,補到 {DTR_FROM})')
        dtr, ch_d, rep_d = run_dtr(gate, docs['dtr_hist'], today)
        if ch_d:
            _write('dtr_hist', dtr)
        else:
            print('ℹ️ dtr_hist.json 沒有新的 → 不寫')
        for k, w in list(rep_d['err'].items())[:5]:
            print(f'::warning::當沖占比 {k}:{w}')
    for tag in ('fi', 'tx'):
        for k, w in (rep.get(tag) or {}).get('err', {}).items():
            print(f'::warning::{k}:{w}')
    return rc


# ───────────────── selftest(網路 / 時間 / 睡眠全換假的,走正式入口 run / main)─────────────────
def selftest():
    import tempfile
    from urllib.parse import urlsplit
    bad = []

    def ok(n, c, e=''):
        print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:400]}")
        if not c:
            bad.append(n)

    today = date(2026, 11, 20)

    def wd(a, b):
        d, out = date.fromisoformat(a), []
        while d <= date.fromisoformat(b):
            if d.weekday() < 5:
                out.append(d.isoformat())
            d += timedelta(days=1)
        return out

    D = wd('2026-08-01', '2026-11-20')          # 加權每個平日都有(含今天)
    I = {d: k for k, d in enumerate(D)}
    sp = lambda d: [round(-100 - I[d], 2), round(10 + I[d] * 0.5, 2), -5.0]
    fu = lambda d: -90000 + I[d] * 10
    mg = lambda d: round(6000 + I[d] * 1.5, 2)
    ixv = lambda d: 40000 + I[d] * 10.0
    bsv = lambda d: 50.0 - I[d]
    pcv = lambda d: [round(90 + (I[d] % 7), 2), round(60 + (I[d] % 9), 2)]
    ltv = lambda d: {'all': [15000 + I[d], 2000 + I[d], 130000 + I[d] * 7], 'spec': [15000 + I[d], -800 + I[d], 130000 + I[d] * 7]}
    rlv = lambda d: (-11000 + I[d], 20000 + I[d], 43000 + I[d] * 3)

    def prev_docs(last='2026-10-19'):
        ds = [d for d in D if d <= last]
        fi = {'updated': '2026-10-20 09:23', 'from': '2004-01-01', 'to': last, 'unit': {}, 'src': {k: 'x' for k in FI_KEYS}, 'src_error': {}, 'check': {'spot': '對表 63/64'},
              'spot': {d: sp(d) for d in ds}, 'fut': {d: fu(d) for d in ds}, 'mg': {d: mg(d) for d in ds},
              'bs': {d: [bsv(d), ixv(d) + bsv(d), ixv(d)] for d in ds}}
        tx = {'updated': '2026-10-20T01:10:22Z', 'from': '2010-01-04', 'to': last, 'n': {}, 'pc': {d: pcv(d) for d in ds},
              'lt': {d: ltv(d) for d in ds}, 'rl': {d: [rlv(d)[0], rlv(d)[1], rlv(d)[2], round(-rlv(d)[0] / rlv(d)[2] * 100, 2)] for d in ds},
              'src': {}, 'src_error': None, 'note': 'n'}
        return fi, tx

    class R:
        def __init__(self, code, body, ctype='application/json'):
            self.status_code = code
            self.content = body if isinstance(body, bytes) else body.encode('utf-8')
            self.headers = {'content-type': ctype}

        def json(self):
            return json.loads(self.content.decode('utf-8'))

    def fm_rows(ds, dsid, a, b, opt):
        days = [d for d in D if a <= d <= b and d <= opt.get('fm_to', {}).get(ds, '2026-11-19')]
        rows = []
        for d in days:
            if ds == 'TaiwanStockTotalInstitutionalInvestors':
                f, t, dd = sp(d)
                rows += [{'date': d, 'name': 'Foreign_Investor', 'buy': f * 1e8 + 1e10, 'sell': 1e10},
                         {'date': d, 'name': 'Investment_Trust', 'buy': t * 1e8 + 1e10, 'sell': 1e10},
                         {'date': d, 'name': 'Dealer_self', 'buy': dd * 1e8 + 1e10, 'sell': 1e10},
                         {'date': d, 'name': 'total', 'buy': 9e12, 'sell': 0}]
            elif ds == 'TaiwanFuturesInstitutionalInvestors' and dsid == 'TX':
                if d < opt.get('fut_from', ''):
                    continue
                rows.append({'date': d, 'institutional_investors': 'Foreign_Investor', 'long_open_interest_balance_volume': 10000,
                             'short_open_interest_balance_volume': 10000 - fu(d)})
            elif ds == 'TaiwanFuturesInstitutionalInvestors' and dsid == 'MTX':
                n_, ls, _ = rlv(d)
                lo = (ls + n_) // 2
                rows.append({'date': d, 'name': 'Foreign_Investor', 'long_open_interest_balance_volume': lo, 'short_open_interest_balance_volume': ls - lo})
            elif ds == 'TaiwanStockTotalMarginPurchaseShortSale':
                if d <= opt.get('mg_to', '2026-11-18'):
                    rows.append({'date': d, 'name': 'MarginPurchaseMoney', 'TodayBalance': mg(d) * 1e8 * opt.get('mg_x', 1)})
            elif ds == 'TaiwanFuturesDaily':
                rows.append({'date': d, 'contract_date': '202611', 'close': ixv(d) + bsv(d), 'trading_session': 'position', 'open_interest': 80000})
                rows.append({'date': d, 'contract_date': '202612', 'close': 1.0, 'trading_session': 'position', 'open_interest': 100})
            elif ds == 'TaiwanStockPrice':
                rows.append({'date': d, 'close': ixv(d)})
        if ds == 'TaiwanStockPrice':   # 加權今天也有
            rows += [{'date': d, 'close': ixv(d)} for d in D if a <= d <= b and d > '2026-11-19' and d <= today.isoformat()]
        if opt.get('future'):
            rows.append({'date': '2026-11-27', 'name': 'MarginPurchaseMoney', 'TodayBalance': 1e8, 'close': 1.0})
        return rows

    def month_csv(kind, y, m):
        ds = [d for d in D if d.startswith(f'{y}-{m:02d}') and d <= '2026-11-19']
        if kind == 'pc':
            return '日期,賣權成交量,買權成交量,買賣權成交量比率%,賣權未平倉量,買權未平倉量,買賣權未平倉量比率%\n' + ''.join(
                f'{d.replace("-", "/")},1,1,{pcv(d)[0]},1,1,{pcv(d)[1]}\n' for d in ds)
        if kind == 'lt':
            h = '日期,商品(契約),商品名稱,到期月份(週別),交易人類別,前五大交易人買方,前五大交易人賣方,前十大交易人買方,前十大交易人賣方,全市場未沖銷部位數\n'
            out = []
            for d in ds:
                a = ltv(d)
                for ty, key in (('0', 'all'), ('1', 'spec')):
                    t5, t10, oi_ = a[key]
                    out.append(f'{d.replace("-", "/")},TX,臺股期貨,202611,{ty},{t5 + 1000},1000,{t10 + 2000},2000,{oi_}\n')
            return h + ''.join(out)
        h = '交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,結算價,未沖銷契約數,最後最佳買價,最後最佳賣價,歷史最高價,歷史最低價,是否因訊息面暫停交易,交易時段,價差對單式委託成交量\n'
        return h + ''.join(f'{d.replace("-", "/")},MTX,202611,1,1,1,1,0,0,100,1,{rlv(d)[2]},1,1,1,1,,一般,0\n' for d in ds)

    def fake(opt=None):
        opt = opt or {}
        calls, t = [], [0.0]

        def send(method, url, headers=None, timeout=None, params=None, data=None):
            calls.append({'m': method, 'url': url, 'params': dict(params or {}), 'data': dict(data or {}), 'headers': dict(headers or {})})
            host = urlsplit(url).netloc
            if host == 'api.finmindtrade.com':
                tok = (headers or {}).get('Authorization', '')
                if opt.get('bad_tok') and tok == 'Bearer ' + opt['bad_tok']:
                    return R(400, json.dumps({'msg': 'Token is illegal.', 'status': 400}))
                p = params or {}
                if opt.get('fm_down'):
                    return R(503, 'busy')
                rows = fm_rows(p.get('dataset'), p.get('data_id'), p.get('start_date'), p.get('end_date'), opt)
                return R(200, json.dumps({'msg': 'success', 'status': 200, 'data': rows}))
            if host == 'www.taifex.com.tw':
                if opt.get('tf_block'):
                    return R(200, '<html><body>系統維護中</body></html>', 'text/html')
                y, m = int(data['queryStartDate'][:4]), int(data['queryStartDate'][5:7])
                kind = 'pc' if url == TXM.DOWN_PC else ('lt' if url == TXM.DOWN_LT else 'fut')
                return R(200, month_csv(kind, y, m), 'text/html;charset=MS950')
            if host == 'www.twse.com.tw':
                return opt['tw'](params or {}) if opt.get('tw') else R(404, 'nf')
            if host == 'openapi.taifex.com.tw':
                if url == TXM.OPENAPI_PC:
                    return R(200, json.dumps([{'Date': d.replace('-', ''), 'PutCallVolumeRatio%': str(pcv(d)[0]), 'PutCallOIRatio%': str(pcv(d)[1])}
                                              for d in D if opt.get('pc_from', '2026-10-12') <= d <= '2026-11-19']))
                d = '2026-11-19'
                a = ltv(d)
                return R(200, json.dumps([{'Date': d.replace('-', ''), 'Contract': 'TX', 'TypeOfTraders': ty, 'Top5Buy': str(a[k][0] + 1000), 'Top5Sell': '1000',
                                           'Top10Buy': str(a[k][1] + 2000), 'Top10Sell': '2000', 'OIOfMarket': str(a[k][2])} for ty, k in (('0', 'all'), ('1', 'spec'))]))
            return R(404, 'nf')
        g = make_gate(send=send, sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0])
        return g, calls

    quiet = lambda *_: None
    # ① 正常:兩份都接到 11/19(融資晚上才公布 → 到 11/18);早期的日子留著;gap 記今天(加權有、這條沒有)
    fi, tx = prev_docs()
    g, calls = fake()
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('① 兩份都有變', ch == {'fi', 'tx'}, ch)
    ok('① 外資現貨接到 11/19、值 = 官方每日(外資 / 投信 / 自營)', max(fi['spot']) == '2026-11-19' and fi['spot']['2026-11-19'] == sp('2026-11-19'), (max(fi['spot']), fi['spot'].get('2026-11-19')))
    ok('① 融資到 11/18(今天晚上才公布)、gap 記 11/19 與 11/20', max(fi['mg']) == '2026-11-18' and rep['fi']['gap'].get('mg') == ['2026-11-19', '2026-11-20'], (max(fi['mg']), rep['fi']['gap']))
    ok('① 期現基差 = 近月(未平倉最大)− 加權', fi['bs']['2026-11-19'] == [bsv('2026-11-19'), ixv('2026-11-19') + bsv('2026-11-19'), ixv('2026-11-19')], fi['bs'].get('2026-11-19'))
    ok('① 外資台指期接上', fi['fut']['2026-11-19'] == fu('2026-11-19'), fi['fut'].get('2026-11-19'))
    ok('① 更早的日子留著、日期由舊到新', '2026-08-03' in fi['spot'] and list(fi['spot']) == sorted(fi['spot']), list(fi['spot'])[:2])
    ok('① P/C / 大額交易人 / 散戶多空比接到 11/19', all(max(tx[k]) == '2026-11-19' for k in TX_KEYS) and tx['pc']['2026-11-19'] == pcv('2026-11-19')
       and tx['lt']['2026-11-19'] == ltv('2026-11-19') and tx['rl']['2026-11-19'][3] == round(-rlv('2026-11-19')[0] / rlv('2026-11-19')[2] * 100, 2),
       {k: (max(tx[k]), tx[k][max(tx[k])]) for k in TX_KEYS})
    ok('① 檔頭:to / n / daily 都更新、補挖的對表紀錄 check 留著', fi['to'] == '2026-11-19' and tx['to'] == '2026-11-19' and tx['n']['pc'] == len(tx['pc'])
       and fi['daily']['add']['spot'] == len([d for d in D if '2026-10-19' < d <= '2026-11-19']) and fi['check'] == {'spot': '對表 63/64'}, (fi['to'], tx['to'], fi.get('daily', {}).get('add')))
    nm = len(months_between('2026-09-04', today))
    ok('①b 每條只有一次請求(FinMind 6 次 + 期交所下載頁 3 種 × 往前 45 天跨到的月份)', len([c for c in calls if 'finmindtrade' in c['url']]) == 6
       and len([c for c in calls if 'www.taifex' in c['url']]) == 3 * nm and nm == 3, (nm, [c['url'][-20:] for c in calls]))
    fmc = [c for c in calls if 'finmindtrade' in c['url']]
    ok('①c 金鑰只在 Authorization 標頭(⛔ 網址 / 參數)、UA 寫明 StockAI-DB',
       all('tokA' not in c['url'] and 'tokA' not in json.dumps(c['params']) and c['headers'].get('Authorization') == 'Bearer tokA' for c in fmc)
       and all('StockAI-DB' in c['headers'].get('User-Agent', '') for c in calls), fmc[0])
    ok('①d 往前抓 45 天(外資現貨從 09/04 起)', fmc and any(c['params'].get('dataset') == 'TaiwanStockTotalInstitutionalInvestors' and c['params'].get('start_date') == '2026-09-04' for c in fmc),
       [c['params'] for c in fmc][:3])

    # ② 最後一天倒退 → 那條不收、其他照收
    fi, tx = prev_docs()
    g, _ = fake({'fm_to': {'TaiwanStockTotalInstitutionalInvestors': '2026-10-10'}})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('② 外資現貨這次只到 10/10(比上一份 10/19 早)→ 不收、寫原因;融資照收', max(fi['spot']) == '2026-10-19' and '還早' in rep['fi']['err'].get('spot', '')
       and max(fi['mg']) == '2026-11-18', (max(fi['spot']), rep['fi']['err']))

    # ③ 單位對不上(融資 ×100)→ 不收;⭐ 決定性對照:同一份 ×1 → 收(就是 ①)
    fi, tx = prev_docs()
    g, _ = fake({'mg_x': 100})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('③ 融資單位差 100 倍 → 重疊那幾天對不上 → 這次的不收、上一份原封不動', max(fi['mg']) == '2026-10-19' and '對不上' in rep['fi']['err'].get('mg', '')
       and fi['mg'] == prev_docs()[0]['mg'], rep['fi']['err'].get('mg'))

    # ④ 第一把金鑰被拒(400)→ 換第二把;FinMind ⛔ 斷路(400 不是擋頁)
    fi, tx = prev_docs()
    g, calls = fake({'bad_tok': 'tokBad'})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokBad', 'tokB'], log=quiet)
    ok('④ 第一把 400 → 第二把拿到、FinMind 沒有斷路', max(fi['spot']) == '2026-11-19' and 'api.finmindtrade.com' not in g.open, (max(fi['spot']), g.open))

    # ⑤ 期交所網站回擋頁 → 整個網站停手(只送 1 次);P/C 改 OpenAPI(18 天、對得上)、大額交易人 OpenAPI 只有 1 天 → 標沒對過;散戶多空比這輪不動
    fi, tx = prev_docs()
    g, calls = fake({'tf_block': True})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('⑤ 期交所網站擋頁 → 斷路,之後 ⛔ 再送(只送 1 次)', len([c for c in calls if 'www.taifex' in c['url']]) == 1 and 'www.taifex.com.tw' in g.open,
       [c['url'] for c in calls if 'www.taifex' in c['url']])
    ok('⑤ P/C 改用 OpenAPI 接上(重疊對過)', max(tx['pc']) == '2026-11-19' and 'OpenAPI' in rep['tx']['via'].get('pc', '') and '沒對過' not in rep['tx']['via'].get('pc', ''),
       rep['tx']['via'])
    ok('⑤ 大額交易人 OpenAPI 只有 11/19 一天 → 收但標「沒對過」', max(tx['lt']) == '2026-11-19' and '沒對過' in rep['tx']['via'].get('lt', ''), rep['tx']['via'])
    ok('⑤ 散戶多空比(分母在期交所網站)這輪不動、寫原因', max(tx['rl']) == '2026-10-19' and '小台全市場未平倉' in rep['tx']['err'].get('rl', ''), rep['tx']['err'])
    # ⑤b OpenAPI 的 P/C 跟上一份完全不重疊(歷史停太久)→ 證明不了同一把尺 → 不收(⛔ 拿沒對過的接上去;只有大額交易人例外)
    fi, tx = prev_docs()
    g, _ = fake({'tf_block': True, 'pc_from': '2026-10-23'})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('⑤b OpenAPI 的 P/C 跟上一份只重疊 0 天 → 不收、寫原因', max(tx['pc']) == '2026-10-19' and '只重疊 0 天' in rep['tx']['err'].get('pc', ''), rep['tx']['err'].get('pc'))

    # ⑥ 重疊不夠(證明不了同一把尺)→ 不收:FinMind 外資台指期只回 10/16 起
    fi, tx = prev_docs()
    g, _ = fake({'fut_from': '2026-10-16'})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('⑥ 外資台指期只重疊 2 天 → 不收(⛔ 拿證明不了的資料接上去)', max(fi['fut']) == '2026-10-19' and '只重疊 2 天' in rep['fi']['err'].get('fut', ''), rep['fi']['err'].get('fut'))

    # ⑦ 未來的日期丟掉
    fi, tx = prev_docs()
    g, _ = fake({'future': True})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('⑦ 超過今天的日期 ⛔ 收', max(fi['mg']) == '2026-11-18', max(fi['mg']))

    # ⑧ FinMind 整個掛掉(503 退避後斷路)→ 四條都不動;期交所那份照接
    fi, tx = prev_docs()
    g, _ = fake({'fm_down': True})
    fi, tx, rep, ch = run(g, fi, tx, today, ['tokA'], log=quiet)
    ok('⑧ FinMind 掛掉 → 外資 / 融資 / 基差都不動、寫原因;P/C 照接', ch == {'tx'} and all(max(fi[k]) == '2026-10-19' for k in FI_KEYS)
       and all(k in rep['fi']['err'] for k in FI_KEYS) and max(tx['pc']) == '2026-11-19', (ch, rep['fi']['err']))

    # ⑨ 走正式入口 main():有變才寫、OUTDIR 只放有變的;上一份壞檔 → 那份不動、exit 1;不在 → 跳過
    td = tempfile.mkdtemp()
    dd, od = os.path.join(td, 'data'), os.path.join(td, 'out')
    os.makedirs(dd)
    fi0, tx0 = prev_docs()
    with open(os.path.join(dd, 'fi_mkt_hist.json'), 'w', encoding='utf-8') as f:
        json.dump(fi0, f)
    bad_bytes = b'{"pc":{"2026-10-19":[1,2]'      # 截斷
    with open(os.path.join(dd, 'taifex_hist.json'), 'wb') as f:
        f.write(bad_bytes)
    g, _ = fake()
    _mg, _tok, _now = make_gate, _tokens, _tw_now
    globals()['make_gate'] = lambda **kw: g
    globals()['_tokens'] = lambda: ['tokA']
    globals()['_tw_now'] = lambda: datetime(2026, 11, 20, 18, 30, tzinfo=timezone(timedelta(hours=8)))
    os.environ['DATA_DIR'], os.environ['OUTDIR'] = dd, od
    try:
        rc = main()
        fi_new = json.load(open(os.path.join(dd, 'fi_mkt_hist.json'), encoding='utf-8'))
        ok('⑨ main:fi 接上並寫回、OUTDIR 有它', max(fi_new['spot']) == '2026-11-19' and os.path.exists(os.path.join(od, 'fi_mkt_hist.json')), max(fi_new['spot']))
        ok('⑨ main:taifex_hist 壞檔 → 一個位元組都沒動、OUTDIR 沒有它、exit 1', open(os.path.join(dd, 'taifex_hist.json'), 'rb').read() == bad_bytes
           and not os.path.exists(os.path.join(od, 'taifex_hist.json')) and rc == 1, rc)
        # 再跑一次:沒有新的 → 不寫(檔案一樣、OUTDIR 清空後還是空)
        shutil.rmtree(od)
        before = open(os.path.join(dd, 'fi_mkt_hist.json'), 'rb').read()
        g2, _ = fake()
        globals()['make_gate'] = lambda **kw: g2
        os.remove(os.path.join(dd, 'taifex_hist.json'))
        rc2 = main()
        ok('⑨ 再跑一次沒有新的 → ⛔ 寫、OUTDIR 沒東西;taifex_hist 不在 → 跳過(⛔ 從頭建)', open(os.path.join(dd, 'fi_mkt_hist.json'), 'rb').read() == before
           and not os.path.exists(od) and rc2 == 0 and not os.path.exists(os.path.join(dd, 'taifex_hist.json')), (rc2, os.path.exists(od)))
    finally:
        globals()['make_gate'], globals()['_tokens'], globals()['_tw_now'] = _mg, _tok, _now
        os.environ.pop('DATA_DIR', None)
        os.environ.pop('OUTDIR', None)

    # ⑪ 📊 全市場當沖占比(證交所 TWTB4U;表的形狀照 11/20 探針 run 44619022085 的真實回應)
    F6 = ['當日沖銷交易總成交股數', '當日沖銷交易總成交股數占市場比重%', '當日沖銷交易總買進成交金額', '當日沖銷交易總買進成交金額占市場比重%',
          '當日沖銷交易總賣出成交金額', '當日沖銷交易總賣出成交金額占市場比重%']
    LIST_T = {'title': '115年11月20日 當日沖銷交易標的', 'fields': ['證券代號', '證券名稱', '暫停現股賣出後\n現款買進當沖註記'], 'data': [['2330', '台積電', '']]}
    HOLI = {'2026-11-12'}

    def tw_ok(ymd):
        k = I.get(f'{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}', 0)
        row = [f'{4_259_348_000 + k:,}', '27.83' if ymd == '20261119' else f'{25 + k % 7:.2f}', '389,437,473,750', '41.29' if ymd == '20261119' else f'{38 + k % 5:.2f}',
               '389,961,679,540', '41.35' if ymd == '20261119' else f'{38 + k % 5 + 0.06:.2f}']
        return {'date': ymd, 'selectType': 'All', 'stat': 'OK', 'tables': [{'title': '115年11月19日 當日沖銷交易統計資訊', 'fields': F6, 'data': [row]}, LIST_T]}

    def tw_route(mode=''):
        def f(pr):
            ymd = pr.get('date', '')
            iso = f'{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}'
            if mode == 'block':
                return R(200, '<html>Security</html>', 'text/html')
            if mode == 'wrongdate':
                return R(200, json.dumps(tw_ok('20260101')))
            if iso >= '2026-11-20' or iso in HOLI:   # 今天還沒開盤 / 休市:統計表空、標的表照樣有(⛔ 當成有資料)
                return R(200, json.dumps({'date': ymd, 'stat': 'OK', 'tables': [{'title': None, 'fields': None, 'data': []}, LIST_T]}))
            return R(200, json.dumps(tw_ok(ymd)))
        return f
    g, calls = fake({'tw': tw_route()})
    dd1, ch1, r1 = run_dtr(g, None, today, log=quiet)
    tw_calls = [c for c in calls if 'twse' in c['url']]
    ok(f'⑪ 第一次:最近 {DTR_RECENT} 個平日(今天還沒開盤 → 先不收、⛔ 記成休市)+ 往前 {DTR_BACK} 天,一共問 {DTR_RECENT + DTR_BACK} 次', r1['asked'] == DTR_RECENT + DTR_BACK == len(tw_calls)
       and '2026-11-20' not in dd1['d'] and '2026-11-20' not in dd1['none'] and '2026-11-19' in dd1['d'], (r1['asked'], sorted(dd1['d'])[:3], dd1.get('none')))
    ok('⑪ 11/19 照名字找欄位:股數占比 27.83、買進 41.29、賣出 41.35、股數 / 金額也收', dd1['d'].get('2026-11-19') == [27.83, 41.29, 41.35, 4259348000.0 + I['2026-11-19'], 389437473750.0, 389961679540.0],
       dd1['d'].get('2026-11-19'))
    ok('⑪ 休市(更早、統計表空)→ 記進 none 不再問;⛔ 把「當日沖銷交易標的」那張當成有資料', dd1['none'] == ['2026-11-12'] and '2026-11-12' not in dd1['d'], dd1.get('none'))
    ok('⑪ 證交所固定間隔 4 秒、UA 寫明', g.gaps.get('www.twse.com.tw') == 4.0 and all('StockAI-DB' in c['headers'].get('User-Agent', '') for c in tw_calls))
    g, calls = fake({'tw': tw_route()})
    dd2, ch2, r2 = run_dtr(g, json.loads(json.dumps(dd1)), today, log=quiet)
    asked2 = [c['params'].get('date') for c in calls if 'twse' in c['url']]
    ok(f'⑪ 第二次:已經有的 / 休市的 ⛔ 再問;今天(還沒公布)照問;再往前補 {DTR_BACK} 天', r2['asked'] == 1 + DTR_BACK and '20261119' not in asked2 and '20261112' not in asked2 and '20261120' in asked2
       and len(dd2['d']) == len(dd1['d']) + DTR_BACK, (r2['asked'], asked2[:4], len(dd2['d'])))
    g, _ = fake({'tw': tw_route('wrongdate')})
    dd3, ch3, r3 = run_dtr(g, None, today, log=quiet)
    ok('⑪ 回應的日期跟問的不一樣 → ⛔ 收、寫原因', not dd3.get('d') and not ch3 and any('不一樣' in v for v in r3['err'].values()), r3['err'])
    g, calls = fake({'tw': tw_route('block')})
    dd4, ch4, r4 = run_dtr(g, None, today, log=quiet)
    ok('⑪ 證交所擋頁 → 停手(只問 1 次)', r4['asked'] == 1 and len([c for c in calls if 'twse' in c['url']]) == 1 and not ch4, r4)
    full_back = {'v': 1, 'd': {x: [30.0, 40.0, 40.0, 1.0, 1.0, 1.0] for x in _weekdays_back(date(2026, 11, 19), 9000, DTR_FROM)}, 'none': []}
    g, _ = fake({'tw': tw_route()})
    _, _, r5 = run_dtr(g, full_back, today, log=quiet)
    ok(f'⑪ 已經補到 {DTR_FROM} → 只問最近還沒有的(今天),⛔ 再往前', r5['asked'] == 1, r5['asked'])
    ok('⑪ parse_dtr:統計表欄位對不上(少了比重)→ 不收、寫原因', parse_dtr({'date': '20261119', 'tables': [{'fields': ['占市場比重 x'], 'data': [['a']]}]}, '2026-11-19')[0] is None)
    # ⑪b 洞:中間某一天失敗 → 記 miss → 下一輪回頭補;一直失敗 → 3 次後不再問;最近幾天 / 被擋 ⛔ 記洞
    def tw_flaky(bad, fails):
        cnt = {}

        def f(pr):
            ymd = pr.get('date', '')
            if ymd in bad:
                cnt[ymd] = cnt.get(ymd, 0) + 1
                if fails is None or cnt[ymd] <= fails:
                    return R(200, json.dumps({'date': ymd, 'stat': 'OK', 'tables': [{'fields': ['占市場比重 x'], 'data': [['a']]}]}))
            return tw_route()(pr)
        return f
    flaky = tw_flaky({'20261113'}, 1)
    g, _ = fake({'tw': flaky})
    h1, _, rh1 = run_dtr(g, None, today, log=quiet)
    ok('⑪b 第一次:中間那天(11/13)回應不對 → 記進 miss 1 次、⛔ 進 d / none', h1['miss'] == {'2026-11-13': 1} and '2026-11-13' not in h1['d']
       and '2026-11-13' not in h1['none'] and rh1['holes'] == 0, (h1.get('miss'), rh1['holes']))
    g, calls = fake({'tw': flaky})
    h2, _, rh2 = run_dtr(g, json.loads(json.dumps(h1)), today, log=quiet)
    a2 = [c['params'].get('date') for c in calls if 'twse' in c['url']]
    ok(f'⑪b 第二次:回頭補洞(排在往前補之前)→ 拿到了、從 miss 拿掉;一共 1 + 1 + {DTR_BACK} = {2 + DTR_BACK} 次', rh2['holes'] == 1 and a2[1] == '20261113'
       and '2026-11-13' in h2['d'] and not h2['miss'] and rh2['asked'] == 2 + DTR_BACK, (rh2['holes'], a2[:3], h2.get('miss'), rh2['asked']))
    ok('⑪b 決定性對照:沒有補洞的寫法 → 那一天永遠缺(第二次問的日子裡沒有它)', '20261113' in a2 and '20261113' not in
       [x.replace('-', '') for x in _weekdays_back(date(2026, 11, 20), 3)] + [x.replace('-', '') for x in _weekdays_back(date.fromisoformat(min(h1['d'])) - timedelta(days=1), DTR_BACK, DTR_FROM)])
    dead = tw_flaky({'20261113'}, None)
    hh, n_ask = None, []
    for _ in range(DTR_GIVEUP + 1):
        g, calls = fake({'tw': dead})
        hh, _, _ = run_dtr(g, json.loads(json.dumps(hh)) if hh else None, today, log=quiet)
        n_ask.append(sum(1 for c in calls if c['params'].get('date') == '20261113'))
    ok(f'⑪b 一直失敗:問了 {DTR_GIVEUP} 次就不再問、留在 miss(看得出缺哪天)', n_ask == [1] * DTR_GIVEUP + [0] and hh['miss'] == {'2026-11-13': DTR_GIVEUP}, (n_ask, hh.get('miss')))
    g, _ = fake({'tw': tw_flaky({'20261119'}, None)})
    h3, _, _ = run_dtr(g, None, today, log=quiet)
    ok('⑪b 最近幾天失敗 ⛔ 記洞(下一輪本來就會再問)', '2026-11-19' not in h3.get('miss', {}) and '2026-11-19' not in h3['d'], h3.get('miss'))
    g, _ = fake({'tw': tw_route('block')})
    h4, _, _ = run_dtr(g, json.loads(json.dumps(h1)), today, log=quiet)
    ok('⑪b 被擋(斷路)⛔ 算那一天的錯:miss 不變', h4.get('miss', h1['miss']) == {'2026-11-13': 1}, h4.get('miss'))
    g, _ = fake({'tw': tw_route('wrongdate')})
    h5, ch5, r5b = run_dtr(g, json.loads(json.dumps(h1)), today, log=quiet)
    ok('⑪b 一天都沒拿到(來源改版 / 掛了)→ ⛔ 把失敗算到那幾天頭上(miss 不變、不寫)', not ch5 and h5.get('miss') == {'2026-11-13': 1}
       and '_' in r5b['err'], (ch5, h5.get('miss')))

    # ⑫ 走正式入口 main():dtr_hist.json 不在 → 第一次建(長歷史兩份不在照樣跑這段);壞檔 → 一個位元組都不動 + exit 1
    td2 = tempfile.mkdtemp()
    dd2, od2 = os.path.join(td2, 'data'), os.path.join(td2, 'out')
    os.makedirs(dd2)
    g, _ = fake({'tw': tw_route()})
    _mg, _now = make_gate, _tw_now
    globals()['make_gate'] = lambda **kw: g
    globals()['_tw_now'] = lambda: datetime(2026, 11, 20, 18, 30, tzinfo=timezone(timedelta(hours=8)))
    os.environ['DATA_DIR'], os.environ['OUTDIR'] = dd2, od2
    try:
        rc = main()
        dj = json.load(open(os.path.join(dd2, 'dtr_hist.json'), encoding='utf-8'))
        ok('⑫ main:dtr_hist.json 不在 → 第一次建、OUTDIR 有它、exit 0(長歷史兩份不在 ⛔ 擋住這段)', rc == 0 and len(dj['d']) == (DTR_RECENT - 1) + (DTR_BACK - 1)
           and os.path.exists(os.path.join(od2, 'dtr_hist.json')) and dj['none'] == ['2026-11-12'], (rc, len(dj.get('d') or {})))
        badd = b'{"d":{"2026-11-19":[27.83,'
        with open(os.path.join(dd2, 'dtr_hist.json'), 'wb') as f:
            f.write(badd)
        shutil.rmtree(od2)
        g2, _ = fake({'tw': tw_route()})
        globals()['make_gate'] = lambda **kw: g2
        rc2 = main()
        ok('⑫ main:dtr_hist.json 壞檔 → 一個位元組都不動、OUTDIR 沒有它、exit 1', rc2 == 1 and open(os.path.join(dd2, 'dtr_hist.json'), 'rb').read() == badd
           and not os.path.exists(os.path.join(od2, 'dtr_hist.json')), rc2)
    finally:
        globals()['make_gate'], globals()['_tw_now'] = _mg, _now
        os.environ.pop('DATA_DIR', None)
        os.environ.pop('OUTDIR', None)

    # ⑩ 靜態:解析一律呼叫補挖那兩支(⛔ 自己再寫一份)、金鑰 ⛔ 進網址
    src = open(__file__, encoding='utf-8').read()
    body = src.split('# ───────────────── selftest')[0]
    import re as _re
    dup = _re.findall(r'def (parse_(?:spot|fut|mg|txnear|ix|pc_csv|lt_csv|fut_csv|finmind_inst|openapi_\w+)|combine_bs|merge_rl)\(', body)
    ok('⑩ 解析呼叫 FMM / TXM 的函式(⛔ 自己另寫一份補挖那兩支的解析)', all(x in body for x in ('FMM.parse_spot', 'FMM.parse_mg', 'FMM.combine_bs', 'TXM.parse_pc_csv', 'TXM.merge_rl'))
       and not dup, dup)
    ok('⑩ 金鑰只放標頭', ("q['" + "token']") not in body and 'Authorization' in body)

    print('\n✅ HIST_DAILY_SELFTEST_PASS' if not bad else '\n❌ 失敗:' + ', '.join(bad))
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
