#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
當沖/大盤方向 免費資料採礦 → data/daytrade_pack.json
─────────────────────────────────────────────────────────────
盤後(EOD)抓「當沖熱度 + 選擇權 P/C Ratio + 大額交易人 + 借券賣出」等免費官方資料,
給前端當沖頁/大盤頁做:①當沖客最愛榜 ②大盤方向(P/C Ratio) ③主力口袋(大額交易人) ④空方壓力。

全部走「官方 OpenAPI(JSON)」,不爬 HTML,格式穩;抓不到的來源自動略過(不整批失敗)。
⚠️ 沙盒連不到 TWSE/TAIFEX,只能在 GitHub Actions 跑;首次會在 log 印出各來源「欄位名 + 首筆範例」
   讓我校準解析,之後鎖定欄名。無金鑰、免費。
"""
import sys
import json
import urllib.request
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))
UA = 'Mozilla/5.0 (StockAI-DB daytrade miner)'


def _now_str():
    return datetime.now(TW).strftime('%m/%d %H:%M')


def fetch_json(url, tag):
    """抓 JSON;印出首筆欄位讓我校準;失敗回 None(不中斷其他來源)。"""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode('utf-8-sig', errors='replace')
        data = json.loads(raw)
        if isinstance(data, list):
            print(f'  [{tag}] list {len(data)} 筆', flush=True)
            if data:
                print(f'  [{tag}] 欄位: {list(data[0].keys())}', flush=True)
                print(f'  [{tag}] 首筆: {json.dumps(data[0], ensure_ascii=False)[:300]}', flush=True)
        elif isinstance(data, dict):
            print(f'  [{tag}] dict keys: {list(data.keys())[:20]}', flush=True)
        return data
    except Exception as e:
        print(f'  [{tag}] ❌ {type(e).__name__}: {str(e)[:160]}', flush=True)
        return None


def _num(s):
    """'1,234' / '1234.5' / '--' → float 或 None"""
    if s is None:
        return None
    try:
        t = str(s).replace(',', '').replace('%', '').strip()
        if t in ('', '-', '--', 'N/A'):
            return None
        return float(t)
    except Exception:
        return None


def _find(d, *cands):
    """在 dict 找第一個命中的鍵(容忍欄名差異)"""
    for c in cands:
        if c in d:
            return d[c]
    # 模糊比對(去空白)
    low = {str(k).replace(' ', ''): v for k, v in d.items()}
    for c in cands:
        cc = c.replace(' ', '')
        if cc in low:
            return low[cc]
    return None


def get_day_trade():
    """TWSE 每日當日沖銷交易標的及成交量值 → 當沖熱度榜"""
    print('📊 當沖熱度(TWSE TWTB4U)…', flush=True)
    data = fetch_json('https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U', 'TWTB4U')
    if not isinstance(data, list) or not data:
        return None
    out = []
    for row in data:
        if not isinstance(row, dict):
            continue
        code = _find(row, 'Code', 'SecuritiesCompanyCode', 'StockNo', '證券代號')
        name = _find(row, 'Name', '證券名稱')
        vol = _num(_find(row, 'Volume', 'TotalVolume', '當日沖銷交易成交股數', '成交股數'))
        code = str(code).strip() if code else ''
        if not code.isdigit() or len(code) < 4:
            continue
        out.append({'code': code, 'name': str(name or '').strip(), 'dtVol': int(vol) if vol else 0})
    out.sort(key=lambda x: -x['dtVol'])
    print(f'  ✅ 當沖標的 {len(out)} 檔', flush=True)
    return out[:100]   # 前 100 熱門


def get_pc_ratio():
    """TAIFEX 臺指選擇權 Put/Call Ratio(成交量比 + 未平倉量比)→ 大盤方向"""
    print('🎯 選擇權 P/C Ratio(TAIFEX PutCallRatio)…', flush=True)
    data = fetch_json('https://openapi.taifex.com.tw/v1/PutCallRatio', 'PutCallRatio')
    if not isinstance(data, list) or not data:
        return None
    # OpenAPI 通常回整年/近月序列,取最新一筆(日期最大)
    def _date(r):
        return str(_find(r, 'Date', '日期') or '')
    rows = [r for r in data if isinstance(r, dict)]
    if not rows:
        return None
    rows.sort(key=_date)
    last = rows[-1]
    vol_ratio = _num(_find(last, 'PutCallVolumeRatio%', 'PutCallVolumeRatio', '買賣權成交量比率%', '買賣權成交量比率'))
    oi_ratio = _num(_find(last, 'PutCallOIRatio%', 'PutCallOIRatio', '買賣權未平倉量比率%', '買賣權未平倉量比率'))
    res = {'date': _date(last), 'volRatio': vol_ratio, 'oiRatio': oi_ratio}
    print(f'  ✅ P/C: {res}', flush=True)
    return res


def main():
    pack = {'updated': datetime.now(TW).isoformat(), 'ts': _now_str()}
    ok = 0

    dt = get_day_trade()
    if dt:
        pack['dayTrade'] = dt
        ok += 1

    pc = get_pc_ratio()
    if pc and (pc.get('volRatio') is not None or pc.get('oiRatio') is not None):
        pack['pcRatio'] = pc
        ok += 1

    if ok == 0:
        print('❌ 所有來源都失敗 → 不產出 JSON(保留舊檔)', flush=True)
        sys.exit(1)

    with open('daytrade_pack.json', 'w', encoding='utf-8') as f:
        json.dump(pack, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ 當沖資料包完成:{ok} 個來源 → daytrade_pack.json', flush=True)


if __name__ == '__main__':
    main()
