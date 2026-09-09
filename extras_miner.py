#!/usr/bin/env python3
"""V21.5 extras_miner — 為「⚖️ 多空優勢計分卡」補三項全市場資料。

在 daily_miner.yml deploy job 並行 7 腳本之後跑(此時 data/*.json 已是合併後全市場最新版,
適合算全市場排名)。失敗不影響主採礦,前端規則自動降級為「⚪ 待採礦補資料」。

輸出:
  - data/inst_rank.json    全市場 5 日法人累積排名(投信/外資/自營各 Top 50)
  - data/day_trade.json    全市場當沖比(TWSE TWTB4U)
  - data/tdcc.json         千張大戶集保戶股權(每天試抓,週末資料才會更新)
"""
import csv
import io
import json
from datetime import datetime, date, timedelta
from pathlib import Path

import requests

DATA_DIR = Path('data')
DATA_DIR.mkdir(exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (StockAI-DB extras_miner)'}


def _valid_sym(s: str) -> bool:
    """跟 miner.py 同樣的個股代號判斷(4 碼數字或 00 開頭 ETF)。"""
    return (s.isdigit() and len(s) == 4) or s.startswith('00')


def generate_inst_rank():
    """讀全市場 data/{sym}.json,算近 5 日法人累積,輸出 Top 50。"""
    rows = []
    for f in DATA_DIR.glob('*.json'):
        sym = f.stem
        if not _valid_sym(sym):
            continue
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            # V27.5 修:data/{sym}.json 是「list of 日記錄」(miner.py 直接 dump records),非 {daily:[]} dict
            #          原 data.get('daily') 對 list 會丟 AttributeError → 整支被 except 吞掉 → 排行長期空
            daily = (data if isinstance(data, list) else (data.get('daily') or []))[-5:]
            if len(daily) < 3:
                continue
            rows.append({
                'sym': sym,
                'foreign_5d': sum(int(r.get('foreign_net') or 0) for r in daily),
                'trust_5d':   sum(int(r.get('trust_net') or 0) for r in daily),
                'dealer_5d':  sum(int(r.get('dealer_net') or 0) for r in daily),
            })
        except Exception:
            continue

    if not rows:
        print('⚠️ inst_rank: 全市場 data/*.json 為空,跳過')
        return

    out = {
        'updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'total': len(rows),
        'foreign_top': sorted(rows, key=lambda r: -r['foreign_5d'])[:50],
        'trust_top':   sorted(rows, key=lambda r: -r['trust_5d'])[:50],
        'dealer_top':  sorted(rows, key=lambda r: -r['dealer_5d'])[:50],
    }
    (DATA_DIR / 'inst_rank.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    print(f'✅ inst_rank.json 已寫({len(rows)} 檔參與排序,各 Top 50)')


def fetch_day_trade():
    """TWSE TWTB4U 全市場當沖比 — 一次拉完。
    V27.5:① 新版 /rwd/zh/afterTrading/ 端點優先(舊 /exchangeReport/ 常回空)
           ② 解析 0 檔時保留上次,不覆蓋成空(避免前端顯假象)+ 印首列供除錯。"""
    for back in range(6):
        d = date.today() - timedelta(days=back)
        if d.weekday() < 5:
            break
    date_str = d.strftime('%Y%m%d')
    urls = [
        f'https://www.twse.com.tw/rwd/zh/afterTrading/TWTB4U?date={date_str}&response=json',
        f'https://www.twse.com.tw/exchangeReport/TWTB4U?date={date_str}&response=json',
    ]
    j = None
    for url in urls:
        try:
            r = requests.get(url, timeout=20, headers=UA)
            if r.status_code == 200 and (r.json().get('data') or []):
                j = r.json()
                break
            print(f'⚠️ day_trade HTTP {r.status_code} / 空 @ {url[:55]}')
        except Exception as e:
            print(f'⚠️ day_trade try error: {str(e)[:60]}')
    if not j:
        print('⚠️ day_trade: 兩端點皆空,保留上次 day_trade.json 不覆蓋')
        return
    data = {}
    rows = j.get('data', []) or []
    for row in rows:
        if not row or len(row) < 6:
            continue
        sym = str(row[0]).strip()
        if not _valid_sym(sym):
            continue
        try:
            vol = int(str(row[3]).replace(',', '') or '0')
            day_vol = int(str(row[4]).replace(',', '') or '0')
            ratio = float(str(row[5]).replace(',', '').replace('%', '') or '0')
        except (ValueError, TypeError):
            continue
        if vol > 0:
            data[sym] = {'ratio_pct': ratio, 'vol': vol, 'day_vol': day_vol}
    if not data:
        print(f'⚠️ day_trade: 解析 0 檔(欄位可能變動),首列={rows[0] if rows else "無"};保留上次不覆蓋')
        return
    out = {
        'updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'date': date_str,
        'data': data,
    }
    (DATA_DIR / 'day_trade.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    print(f'✅ day_trade.json 已寫({len(data)} 檔當沖比, date={date_str})')


def fetch_tdcc_holdings():
    """TDCC 集保戶股權分散表(1-5)— 每週更新,每天試抓,內容無變動就保留。

    取「15. 1000張以上」級距佔比 = 千張大戶持股 %
    跟上次比對算 top_pct_week_chg。
    """
    # ⚡ V69.8.6 P3-4:優先改讀 tdcc_sweep 已產出的 data/tdcc_holders.json(同一份 TDCC id=1-5,
    #    它每週六抓、進 data 分支、deploy 已還原)→ 免再下載數十 MB CSV(原本每交易日重抓一次,
    #    每週多 100+ MB 傳輸 + 30-90 秒 parse,而內容一週只變一次)。讀不到才 fallback 下載。
    try:
        th_file = DATA_DIR / 'tdcc_holders.json'
        if th_file.exists():
            th = json.loads(th_file.read_text(encoding='utf-8'))
            data_by_sym = {}
            latest_d8 = None
            for sym, v in th.items():
                if sym.startswith('_') or not isinstance(v, dict):
                    continue
                h = v.get('h')
                if not isinstance(h, list) or not h:
                    continue
                last = h[-1]
                try:
                    pct = float(last[1])
                    d8 = str(last[0])
                except Exception:
                    continue
                if not (0 < pct <= 100):
                    continue
                prev_pct = None
                if len(h) >= 2:
                    try: prev_pct = float(h[-2][1])
                    except Exception: pass
                data_by_sym[sym] = {'top_pct': round(pct, 3),
                                    'top_pct_week_chg': round(pct - prev_pct, 3) if prev_pct is not None else 0.0}
                if not latest_d8 or d8 > latest_d8: latest_d8 = d8
            if len(data_by_sym) >= 100:
                out = {'updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
                       'date': latest_d8 or date.today().strftime('%Y%m%d'),
                       'data': data_by_sym, 'src': 'tdcc_holders'}
                (DATA_DIR / 'tdcc.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
                print(f'✅ tdcc.json 已從 tdcc_holders.json 轉出({len(data_by_sym)} 檔,零下載)')
                return
            print(f'⚠️ tdcc_holders.json 只轉出 {len(data_by_sym)} 檔 → fallback 下載 CSV')
    except Exception as e:
        print(f'⚠️ tdcc_holders 轉換失敗({e})→ fallback 下載 CSV')

    url = 'https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5'
    try:
        r = requests.get(url, timeout=30, headers=UA)
        if r.status_code != 200:
            print(f'⚠️ tdcc: HTTP {r.status_code}')
            return
        # 載入上週的 tdcc.json 算週變化
        prev_file = DATA_DIR / 'tdcc.json'
        prev_data = {}
        if prev_file.exists():
            try:
                prev = json.loads(prev_file.read_text(encoding='utf-8'))
                prev_data = prev.get('data') or {}
            except Exception:
                pass

        reader = csv.DictReader(io.StringIO(r.text))
        # V27.5 — TDCC CSV 欄名會變(占集保庫存比例% ↔ 占集保庫存數比例%)→ 原寫死欄名抓不到 → 全 0.0
        #          改「模糊比對」抓欄位,容忍欄名增刪「數」字等變動
        fieldnames = reader.fieldnames or []
        def _col(*keys):
            for fn in fieldnames:
                if any(k in (fn or '') for k in keys):
                    return fn
            return None
        col_sym, col_grade = _col('證券代號', '代號'), _col('持股分級', '分級')
        col_pct, col_date  = _col('比例'), _col('資料日期', '日期')
        # V27.6 — 修 V27.5 過度加總(全 >100%):① 兩段式先找最新一期 ② 只取第 15 級「1,000,001 股以上」
        #          (=千張+)單一級,不加總(避開跨多週 + 合計列重複)③ 只收 0<pct≤100 合理值
        rows_all = list(reader)
        latest_date = None
        for row in rows_all:
            d = (row.get(col_date) or '').strip() if col_date else ''
            if d and (not latest_date or d > latest_date):
                latest_date = d
        data_by_sym = {}
        for row in rows_all:
            if col_date and latest_date and (row.get(col_date) or '').strip() != latest_date:
                continue   # 只算最新一期
            sym = (row.get(col_sym) or '').strip() if col_sym else ''
            grade = (row.get(col_grade) or '').strip() if col_grade else ''
            if not _valid_sym(sym) or not grade or not grade[0].isdigit():
                continue
            try:
                grade_num = int(grade.split('.')[0].split('-')[0].strip())
                pct = float((row.get(col_pct) or '0').strip()) if col_pct else 0.0
            except (ValueError, TypeError):
                continue
            # 千張大戶 = 第 15 級「1,000,001 股以上」(1 張=1000 股 → 千張+);TDCC 1-5 此級為最大持股級
            if grade_num == 15 and 0 < pct <= 100:
                data_by_sym[sym] = {'top_pct': round(pct, 3)}

        if not data_by_sym:
            print('⚠️ tdcc: CSV 解析後 0 檔(疑無第 15 級或欄名變),跳過保留上次')
            return
        # V27.6 防呆:千張大戶正常 0-100%;若收不到足量合理值 = 解析錯 → 不覆蓋成誤導值(保留上次/待採礦)
        if len(data_by_sym) < 100:
            print(f'⚠️ tdcc: 僅 {len(data_by_sym)} 檔合理值,疑級距/欄名變動。CSV 欄={fieldnames};保留上次不覆蓋')
            return

        for sym, info in data_by_sym.items():
            prev_pct = (prev_data.get(sym) or {}).get('top_pct')
            info['top_pct_week_chg'] = round(info['top_pct'] - prev_pct, 3) if prev_pct is not None else 0.0

        out = {
            'updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'date': latest_date or date.today().strftime('%Y%m%d'),
            'data': data_by_sym,
        }
        prev_file.write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
        print(f'✅ tdcc.json 已寫({len(data_by_sym)} 檔千張大戶, date={latest_date or "今天"})')
    except Exception as e:
        print(f'⚠️ tdcc: {e}')


if __name__ == '__main__':
    print('═════ V21.5 extras_miner 啟動 ═════')
    print('\n[1/3] generate_inst_rank — 全市場 5 日法人累積排名')
    generate_inst_rank()
    print('\n[2/3] fetch_day_trade — TWSE 全市場當沖比')
    fetch_day_trade()
    print('\n[3/3] fetch_tdcc_holdings — 千張大戶集保股權')
    fetch_tdcc_holdings()
    print('\n═════ V21.5 extras_miner 完成 ═════')
