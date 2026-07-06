#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
⚡ 當沖熱度採礦 (daytrade_probe.py)

用途:抓 TWSE 官方「每日當日沖銷交易標的及成交量值」(TWTB4U)→ 每檔當沖成交股數,
      輸出獨立檔 data/daytrade_stats.json。前端當沖頁用「當沖量 ÷ 該股當日總量(前端自有K線量)」
      算當沖比重,顯「這檔市場當沖多不多 = 適不適合沖」。

實測踩雷紀錄(2026-07-06):
  - openapi.twse.com.tw 對 GitHub Actions IP 回 HTTP 200 空陣列 [] → 改用 www.twse.com.tw/rwd
    正規盤後端點(miner.py 的 twse_ohlcv 實證此 host 從 GitHub 可用)。
  - bot-like UA 會被 TWSE 回空 → 用 iPhone 瀏覽器 UA(對齊 miner._HDRS)。

設計:純 TWSE 免費端點,全市場一次呼叫,不吃 FinMind 額度、不逐檔迴圈;帶 __debug 自我診斷欄;
      命中 < DT_MIN_HITS(30)rc=1 不覆寫、不部署,保留線上舊檔。
"""
import os
import sys
import json
import time
import datetime

try:
    import requests
except ImportError:
    print("需要 requests:pip install requests", file=sys.stderr)
    sys.exit(2)

# www.twse.com.tw/exchangeReport 盤後端點(實證:此 host+path 回合法 JSON;rwd 路徑回 HTML,openapi 回空)
# 每日當日沖銷交易標的:報表代碼不確定(TWTB4U 回 stat=OK 但空)→ 試多個代碼 × selectType,哪個回 fields>0 用哪個
_EXR = 'https://www.twse.com.tw/exchangeReport/'
_DT_REPORTS = ['TWT84U', 'TWTB4U', 'TWT92U']
_DT_SELTYPES = ['All', 'ALLBUT0999', '']

def _dt_urls(d):
    for rep in _DT_REPORTS:
        for st in _DT_SELTYPES:
            q = f'response=json&date={d}' + (f'&selectType={st}' if st else '')
            yield rep, f'{_EXR}{rep}?{q}'

HDRS = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'}

OUT = os.environ.get('DT_OUT', 'data/daytrade_stats.json')
MIN_HITS = int(os.environ.get('DT_MIN_HITS', '30'))


def _num(v):
    if v is None:
        return None
    s = str(v).strip().replace(',', '')
    if s in ('', '--', '---', 'N/A', 'null'):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _taipei_today():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()


def _get_one(url):
    try:
        r = requests.get(url, headers=HDRS, timeout=25)
        body = r.text or ''
        if r.status_code != 200 or not body.strip():
            return None, f"HTTP {r.status_code}, {len(body)}B"
        try:
            j = r.json()
        except Exception as je:
            return None, f"200 非JSON({str(je)[:30]}) 前50:{body[:50]!r}"
        stat = j.get('stat')
        if stat != 'OK':
            return None, f"stat={stat!r}"
        return j, f"OK fields={len(j.get('fields', []))} data={len(j.get('data', []))}"
    except Exception as e:
        return None, f"{type(e).__name__}:{str(e)[:50]}"


def fetch_twtb4u(date_yyyymmdd):
    """試多報表代碼 × selectType,第一個 fields>0 且有 data 的就用。回傳 (j_or_None, note)"""
    notes = []
    for rep, url in _dt_urls(date_yyyymmdd):
        j, note = _get_one(url)
        st = url.split('selectType=', 1)[1] if 'selectType=' in url else '(none)'
        notes.append(f"{rep}/{st}:{note}")
        if j and j.get('fields') and j.get('data'):
            return j, ' | '.join(notes)
        time.sleep(0.4)
    return None, ' | '.join(notes)


def main():
    print("⚡ 當沖熱度採礦開始")
    debug = {'attempts': []}

    # 從台北今天往回找最近一個「有當沖資料」的交易日(涵蓋假日/當日未公布)
    j = None
    used_date = None
    base = _taipei_today()
    for back in range(0, 4):
        d = base - datetime.timedelta(days=back)
        ymd = d.strftime('%Y%m%d')
        jj, note = fetch_twtb4u(ymd)
        debug['attempts'].append({'date': ymd, 'note': note})
        print(f"  🔎 TWTB4U {ymd}: {note}")
        if jj and jj.get('data'):
            j = jj
            used_date = ymd
            break
        time.sleep(1.0)

    if not j:
        print("❌❌ 全部日期/URL 樣式都抓不到當沖資料 → rc=1 不部署")
        print("=== FULL DEBUG (複製給 Claude 校準)===")
        print(json.dumps(debug, ensure_ascii=False))
        print("=== END DEBUG ===")
        try:
            os.makedirs('data', exist_ok=True)
            with open('data/daytrade_stats.debug.json', 'w', encoding='utf-8') as f:
                json.dump({'__debug': debug}, f, ensure_ascii=False, indent=1)
        except Exception:
            pass
        return 1

    fields = j.get('fields', [])
    debug['used_date'] = used_date
    debug['fields'] = fields
    if j.get('data'):
        debug['sample_row'] = j['data'][0]
    print(f"  🔎 fields: {fields}")
    if j.get('data'):
        print(f"  🔎 sample: {j['data'][0]}")

    # TWT84U = 官方「可(得為)當日沖銷交易標的清單」(逐檔,無成交量)→ 收錄清單即代表該檔可現股當沖
    def fi(*kws):
        for i, f in enumerate(fields):
            if any(k in str(f) for k in kws):
                return i
        return None
    i_code = fi('證券代號', '股票代號', '代號')
    i_vol = fi('成交股數')   # 若未來換到有成交量的報表,這裡就會抓到 → 順便存 v
    print(f"  🔎 i_code={i_code}, i_vol={i_vol}")

    stats = {}
    if i_code is not None:
        for row in (j.get('data') or []):
            try:
                code = str(row[i_code]).strip()
            except Exception:
                continue
            if not (code.isdigit() and len(code) == 4) and not code.startswith('00'):
                continue
            entry = 1   # 預設:1 = 在官方可當沖清單內
            if i_vol is not None and i_vol < len(row):
                dv = _num(row[i_vol])
                if dv and dv > 0:
                    entry = {'v': int(dv)}
            stats[code] = entry

    twse_hits = len(stats)
    print(f"  📊 上市(TWSE)可當沖命中 {twse_hits} 檔")

    # ── 上櫃(TPEX)可當沖清單:試多候選端點,格式不確定→通用解析 + debug 印到 stdout ──
    tpex_added = 0
    tpex_debug = []
    # ⚠️ 不可放 tpex_disposal_information(那是「處置股」= 禁當沖,語意相反,首跑誤併過 22 檔已移除)
    #    可當沖清單約 800+ 檔 → 加 TPEX_MIN 門檻,小清單一律不信(擋掉處置/注意等錯資料集)
    TPEX_MIN = 200
    tpex_urls = [
        'https://www.tpex.org.tw/openapi/v1/tpex_intraday_trading_securities',
        'https://www.tpex.org.tw/openapi/v1/tpex_daytrading_transaction',
        'https://www.tpex.org.tw/www/zh-tw/intraday/dayTradList?type=json',
    ]
    for u in tpex_urls:
        try:
            r = requests.get(u, headers=HDRS, timeout=20)
            body = (r.text or '')
            note = f"HTTP {r.status_code}, {len(body)}B"
            rows = None
            if r.status_code == 200 and body.strip():
                try:
                    jj = r.json()
                    if isinstance(jj, list):
                        rows = jj
                    elif isinstance(jj, dict):
                        rows = jj.get('data') or jj.get('aaData') or (jj.get('tables', [{}])[0].get('data') if jj.get('tables') else None)
                    note += f", json={type(jj).__name__}, rows={len(rows) if rows else 0}"
                    if rows:
                        note += f", sample={rows[0]}"
                except Exception as je:
                    note += f", 非JSON 前50:{body[:50]!r}"
            tpex_debug.append({'url': u.rsplit('/', 1)[-1], 'note': note})
            print(f"  🔎 TPEX {u.rsplit('/',1)[-1]}: {note}")
            if rows and len(rows) >= TPEX_MIN:   # 只信「大清單」= 真的可當沖(小清單多為處置/注意等錯資料集)
                for row in rows:
                    code = None
                    if isinstance(row, dict):
                        for k in ('Code', 'SecuritiesCompanyCode', 'code', '證券代號', 'stkno', 'StockNo'):
                            if k in row and str(row[k]).strip():
                                code = str(row[k]).strip(); break
                    elif isinstance(row, list) and row:
                        code = str(row[0]).strip()
                    if code and ((code.isdigit() and len(code) == 4) or code.startswith('00')):
                        if code not in stats:
                            stats[code] = 1
                            tpex_added += 1
                if tpex_added:
                    print(f"  ✅ TPEX 併入上櫃可當沖 {tpex_added} 檔(用 {u.rsplit('/',1)[-1]})")
                    break
            elif rows:
                print(f"  ⏭️ TPEX {u.rsplit('/',1)[-1]} 只有 {len(rows)} 列(<{TPEX_MIN})→ 不信,跳過")
        except Exception as e:
            tpex_debug.append({'url': u.rsplit('/', 1)[-1], 'note': f"{type(e).__name__}:{str(e)[:40]}"})
            print(f"  🔎 TPEX {u.rsplit('/',1)[-1]}: {type(e).__name__}:{str(e)[:40]}")
    debug['tpex'] = tpex_debug

    hits = len(stats)
    print(f"  📊 可當沖總命中 {hits} 檔(上市 {twse_hits} + 上櫃 {tpex_added})")

    if hits < MIN_HITS:
        print(f"❌ 命中 {hits} < DT_MIN_HITS({MIN_HITS}) → rc=1 不覆寫(保留舊檔)")
        try:
            os.makedirs('data', exist_ok=True)
            with open('data/daytrade_stats.debug.json', 'w', encoding='utf-8') as f:
                json.dump({'__debug': debug, 'hits': hits}, f, ensure_ascii=False, indent=1)
        except Exception:
            pass
        return 1

    out = {
        '__meta': {
            'date': used_date,
            'updated_utc': datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M'),
            'hits': hits,
            'source': 'TWSE TWT84U(上市)+ TPEX(上櫃)官方可當日沖銷交易標的清單',
            'twse': twse_hits, 'tpex': tpex_added,
            'note': 'sym→1 = 官方可現股當沖(上市+上櫃)',
        },
    }
    out.update(stats)

    os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f"✅ 已寫 {OUT}({hits} 檔,日期 {used_date})")
    return 0


if __name__ == '__main__':
    sys.exit(main())
