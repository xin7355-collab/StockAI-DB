"""
radar_miner.py — 首席 AI 司令部：三大戰略雷達矩陣引擎
特色：極低記憶體消耗、無 Pandas 依賴、逐檔串流掃描全台股
輸出：data/radar_matrix.json

⚠️ 注意：
  - 🏎️ 渣男賽車 / 🐢 烏龜過河 掃描全市場 data/*.json（約 2000 檔）。
  - 🎯 狙擊手 依賴分點籌碼 data/chips/*.json，而 chips 只對 CHIP_WATCHLIST
    （約 50 檔熱門股）產出，故狙擊手實際只會掃到監控清單內的標的，屬正常設計限制。
"""
import os
import json
import requests
from pathlib import Path
from datetime import date, datetime

DATA_DIR = Path("data")
CHIPS_DIR = DATA_DIR / "chips"
OUTPUT_FILE = DATA_DIR / "radar_matrix.json"
ATTENTION_FILE = DATA_DIR / "attention_status.json"

# 1 億 = 10^8（成交額顯示單位）
YI = 100_000_000


def calculate_ma(data, period):
    """計算簡單移動平均線 (MA)"""
    if len(data) < period:
        return 0
    return sum(d['close'] for d in data[-period:]) / period


def fetch_attention_disposal_status():
    """🚨 處置神器爬蟲:抓 TWSE 注意股 + 處置股名單,寫 data/attention_status.json。

    斷崖防護:若兩個端點都失敗且舊檔存在,沿用昨日資料,絕不覆蓋成空檔。
    """
    print("\n🚨 啟動【處置神器】爬蟲偵蒐部隊...")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9",
        "Referer": "https://www.twse.com.tw/",
    }

    def _roc_to_iso(s):
        """民國日期字串轉 ISO:'1150610' / '115/06/10' → '2026-06-10';失敗回 None"""
        import re as _re
        m = _re.search(r'(\d{2,3})[/\-.]?(\d{2})[/\-.]?(\d{2})', str(s or ''))
        if not m:
            return None
        try:
            y = int(m.group(1))
            y = y + 1911 if y < 1911 else y   # 民國→西元;若已是西元 4 位則 regex 抓 3 位會錯,故再防呆
            if y < 2000:
                return None
            return f"{y:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        except Exception:
            return None

    def _fetch_openapi(url, status_label, threshold_label, parse_punish=False):
        """TWSE OpenAPI v1 解析(RESTful JSON list)。
        嚴格 sym 驗證:必為 4 位純數字(上市/上櫃)或 00 開頭 5 位數(ETF)。
        parse_punish=True 時額外解析:分盤間隔(每N分鐘)、處置迄日(出關日)。
        欄位名多候選 + 全防呆:解析失敗自動退回基本 status/threshold,絕不炸。
        回傳 (fetch_ok, out_dict)。
        """
        import re as _re
        try:
            r = requests.get(url, headers=headers, timeout=10)
            rows = r.json()
            if not isinstance(rows, list):
                return (False, {})
            # 偵錯:印第一筆 row 完整 schema,讓 workflow log 揭露 OpenAPI 真實欄位名
            if rows and isinstance(rows[0], dict):
                print(f"   [debug] {url.rsplit('/',1)[-1]} 首筆 keys: {list(rows[0].keys())[:12]}")
                print(f"   [debug] 首筆 sample: {str(rows[0])[:300]}")
            out = {}
            for row in rows:
                if not isinstance(row, dict):
                    continue
                sym = str(row.get('Code') or row.get('CompanyCode')
                          or row.get('Symbol') or row.get('StockNo')
                          or row.get('證券代號') or '').strip()
                if not (sym and ((sym.isdigit() and len(sym) == 4) or
                                 (sym.startswith('00') and len(sym) == 5 and sym.isdigit()))):
                    continue
                rec = {"status": status_label, "threshold": threshold_label}
                if parse_punish:
                    try:
                        # 把整列值串起來掃(欄名各版本不同:DispositionMeasures/處置內容/Remark…)
                        blob = ' '.join(str(v) for v in row.values() if v)
                        # 分盤間隔:「每5分鐘」「每20分鐘」「約每 5 分鐘」
                        m_int = _re.search(r'每\s*(\d+)\s*分鐘', blob)
                        if m_int:
                            rec['interval'] = int(m_int.group(1))
                        # 處置期間迄日 = 出關日:期間格式常見「115/06/05～115/06/18」或「1150605-1150618」
                        #   抓 blob 中所有民國日期,取「最大」那個當迄日(起日必小於迄日)
                        dates = [_roc_to_iso(x) for x in _re.findall(r'\d{2,3}[/\-.]\d{2}[/\-.]\d{2}|\d{7}', blob)]
                        dates = sorted(d for d in dates if d)
                        if dates:
                            rec['end_date'] = dates[-1]
                    except Exception:
                        pass   # 任何解析失敗退回基本欄位
                out[sym] = rec
            return (True, out)
        except Exception as e:
            print(f"   ⚠️ {status_label} OpenAPI 失敗:{e}")
            return (False, {})

    notice_ok, attention = _fetch_openapi(
        "https://openapi.twse.com.tw/v1/announcement/notice",
        "⚠️ 注意股", "注意條款觸發")
    print(f"   · 注意股:{len(attention)} 檔 (fetch_ok={notice_ok})")

    punish_ok, disposal = _fetch_openapi(
        "https://openapi.twse.com.tw/v1/announcement/punish",
        "🚨 處置中", "已關禁閉", parse_punish=True)
    _with_end = sum(1 for v in disposal.values() if v.get('end_date'))
    _with_int = sum(1 for v in disposal.values() if v.get('interval'))
    print(f"   · 處置股:{len(disposal)} 檔 (fetch_ok={punish_ok},含出關日 {_with_end} 檔,含分盤間隔 {_with_int} 檔)")

    result = {**attention, **disposal}

    # 斷崖防護:只在「兩個端點都 fetch 失敗(網路/parse 全爆)」時沿用昨日 cache。
    # 若 fetch 成功但 result 是空 dict,代表今日全市場無事,合法寫入空檔覆蓋掉昨日。
    if not (notice_ok or punish_ok) and ATTENTION_FILE.exists():
        print("🛡️  兩個 OpenAPI 端點都失敗,沿用昨日 attention_status.json,不覆蓋")
        return

    payload = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "stocks": result,
    }
    try:
        ATTENTION_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
        print(f"✅ 處置神器:寫入 {len(result)} 檔注意/處置股 → {ATTENTION_FILE}")
    except Exception as e:
        print(f"❌ attention_status.json 寫檔失敗(不影響其他流程):{e}")


def main():
    print("🚀 啟動【首席雷達矩陣】全市場掃描引擎...")

    # 準備三個戰區的空名單
    matrix = {
        'momentum': [],  # 🏎️ 渣男賽車
        'swing': [],     # 🐢 烏龜過河
        'sniper': []     # 🎯 狙擊手
    }

    processed_count = 0

    # 掃描 data 資料夾下所有的股票 JSON 檔
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        # 過濾掉非股票代號的檔案 (例如 radar.json / macro_cache.json)
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue

        try:
            raw_data = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw_data, list) or len(raw_data) < 22:
                continue

            # 取最近 25 天資料來運算
            data = raw_data[-25:]
            latest = data[-1]
            prev = data[-2]

            c = latest.get('close', 0)
            pc = prev.get('close', 0)
            v = latest.get('volume', 0)  # 單位是股數

            if c <= 0 or pc <= 0 or v <= 0:
                continue

            # 基礎指標計算
            ma5 = calculate_ma(data, 5)
            ma20 = calculate_ma(data, 20)
            p_ma20 = calculate_ma(data[:-1], 20)  # 昨天的 20MA

            # 當日成交金額 (新台幣)
            turnover = c * v
            turnover_e = round(turnover / YI, 2)  # 換算成「億」
            # 漲跌幅
            day_gain = round((c - pc) / pc * 100, 2)

            # --- 🏎️ 戰區一：渣男賽車 (極速動能) ---
            # 條件：成交額 > 5億、近5天有單日漲幅 >= 7%、收盤站上5日線且5MA>20MA
            max_gain_5d = max(
                (
                    (data[i]['close'] - data[i - 1]['close']) / data[i - 1]['close'] * 100
                    for i in range(-5, 0) if data[i - 1]['close'] > 0
                ),
                default=0,
            )

            if turnover >= 500_000_000 and max_gain_5d >= 7.0 and c > ma5 and ma5 > ma20:
                matrix['momentum'].append({
                    'sym': sym,
                    'close': round(c, 2),
                    'turnover_e': turnover_e,
                    'gain': day_gain,
                    'status': f"最高動能 {round(max_gain_5d, 1)}%"
                })

            # --- 🐢 戰區二：烏龜過河 (波段起漲) ---
            # 放寬條件:法人「近5日內 ≥3 天買超」+「近3日內首次站月線」+ 量增
            # 原 AND 三嚴條件導致候選極稀(常 0 檔),改為彈性 AND 仍嚴格但有實用性
            inst_buy_days_5 = sum(
                1 for r in data[-5:]
                if (r.get('foreign_net', 0) + r.get('trust_net', 0)) > 0
            )
            inst_support = inst_buy_days_5 >= 3
            # 近 3 日內任一日從月線下穿月線上(首次站月線)
            cross_20ma_recent = False
            for k in range(-3, 0):
                if k - 1 < -len(data):
                    continue
                kc = data[k].get('close', 0)
                kpc = data[k - 1].get('close', 0) if abs(k - 1) <= len(data) else 0
                # 用該天的 ma20 近似(資料只到 last,近3日內用 ma20 近似可接受)
                if kpc > 0 and kpc <= ma20 and kc > ma20:
                    cross_20ma_recent = True
                    break
            v_avg_5 = sum(d.get('volume', 0) for d in data[-5:]) / 5
            vol_expanding = v > v_avg_5

            if inst_support and cross_20ma_recent and vol_expanding:
                matrix['swing'].append({
                    'sym': sym,
                    'close': round(c, 2),
                    'turnover_e': turnover_e,
                    'gain': day_gain,
                    'status': f"近3日站月線+法人買{inst_buy_days_5}/5天"
                })

            # --- 🎯 戰區三：狙擊手 (籌碼集中) ---
            # 條件：乖離率極低(股價貼著月線)，但特定大戶籌碼高度集中
            # ⚠️ 僅 CHIP_WATCHLIST(~50檔) 有分點資料，故此區候選天然受限
            bias_20 = (c - ma20) / ma20 * 100
            sniper_added = False
            if -2 <= bias_20 <= 3:  # 股價在月線附近盤整
                # 主路徑:分點籌碼集中(僅 CHIP_WATCHLIST ~50 檔有資料)
                chip_file = CHIPS_DIR / f"{sym}.json"
                if chip_file.exists():
                    chip_data = json.loads(chip_file.read_text(encoding='utf-8'))
                    chips_list = chip_data.get('chips', [])
                    if chips_list:
                        latest_chip = chips_list[-1]
                        tot_buy = latest_chip.get('tot_buy', 0)
                        if tot_buy > 0:
                            top3_buy = sum(
                                b.get('buy', 0)
                                for b in sorted(
                                    latest_chip.get('buyers', []),
                                    key=lambda x: -x.get('net', 0)
                                )[:3]
                            )
                            concentration = top3_buy / tot_buy * 100
                            if concentration >= 30:
                                matrix['sniper'].append({
                                    'sym': sym, 'close': round(c, 2),
                                    'turnover_e': turnover_e, 'gain': day_gain,
                                    'status': f"主力高度集中 {round(concentration, 1)}%"
                                })
                                sniper_added = True

                # 🎯 替代路徑(全市場可判,不需分點):法人連買 + 貼月線 + 量增
                # 解決原本 sniper 常 0 檔(分點只覆蓋 50 檔)→ 讓 1900+ 檔也有機會入選
                if not sniper_added and turnover >= 100_000_000:
                    inst_buy_5d = sum(
                        1 for r in data[-5:]
                        if (r.get('foreign_net', 0) + r.get('trust_net', 0)) > 0
                    )
                    v_avg_5s = sum(d.get('volume', 0) for d in data[-5:]) / 5
                    if inst_buy_5d >= 4 and v > v_avg_5s:  # 近5日法人買≥4天 + 量增
                        matrix['sniper'].append({
                            'sym': sym, 'close': round(c, 2),
                            'turnover_e': turnover_e, 'gain': day_gain,
                            'status': f"法人連買{inst_buy_5d}/5天+貼月線"
                        })

            processed_count += 1

        except Exception:
            # 遇到髒資料直接跳過，絕不當機
            continue

    # 三區皆以當日成交額由大到小排序（流動性優先，散戶較好進出）
    matrix['momentum'].sort(key=lambda x: x['turnover_e'], reverse=True)
    matrix['swing'].sort(key=lambda x: x['turnover_e'], reverse=True)
    matrix['sniper'].sort(key=lambda x: x['turnover_e'], reverse=True)

    # 輸出最終雷達矩陣
    output = {
        'updated': date.today().isoformat(),
        'scanned_count': processed_count,
        'data': {
            'momentum': matrix['momentum'][:20],  # 各取最強的前 20 檔
            'swing': matrix['swing'][:20],
            'sniper': matrix['sniper'][:20]
        }
    }

    DATA_DIR.mkdir(exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(output, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8'
    )

    print(f"✅ 雷達矩陣建構完畢！共掃描 {processed_count} 檔。")
    print(f"   🏎️ 渣男賽車: {len(output['data']['momentum'])} 檔")
    print(f"   🐢 烏龜過河: {len(output['data']['swing'])} 檔")
    print(f"   🎯 狙擊手: {len(output['data']['sniper'])} 檔")
    print(f"💾 已匯出至 {OUTPUT_FILE}")


# ────────────────────────────────────────────────────────────
# 🚨 戰區二升級:處置門檻價預估算式(純運算,不打 API)
# ────────────────────────────────────────────────────────────
def estimate_attention_threshold(ohlcv_data):
    """近 10 日 OHLCV 分析,模擬下一日達 TWSE 注意/處置條款機率。
    回傳 dict:{score: 0-100, status: '🚨/⚠️/✅', reasons: [...]}

    參考 TWSE 三大主要條款:
    1. 連 3 日累計漲跌 18% → 預警
    2. 近 6 日累計漲跌 25% → 預警
    3. 近 10 中 6 個營業日 |日漲跌| > 5% → 預警
    """
    if not isinstance(ohlcv_data, list) or len(ohlcv_data) < 6:
        return None
    last_10 = ohlcv_data[-10:]
    if len(last_10) < 3:
        return None

    score = 0
    reasons = []

    # 條款 1:連 3 日累計漲跌
    try:
        if len(last_10) >= 4:
            chg_3day = (last_10[-1]['close'] - last_10[-4]['close']) / last_10[-4]['close'] * 100
            if abs(chg_3day) > 15:
                score += 35
                reasons.append(f"連 3 日累 {chg_3day:+.1f}%(近 18% 門檻)")
            elif abs(chg_3day) > 10:
                score += 15
                reasons.append(f"連 3 日累 {chg_3day:+.1f}%")
    except (KeyError, ZeroDivisionError, TypeError):
        pass

    # 條款 2:近 6 日累計漲跌
    try:
        if len(last_10) >= 7:
            chg_6day = (last_10[-1]['close'] - last_10[-7]['close']) / last_10[-7]['close'] * 100
            if abs(chg_6day) > 22:
                score += 35
                reasons.append(f"6 日累 {chg_6day:+.1f}%(近 25% 門檻)")
            elif abs(chg_6day) > 15:
                score += 15
                reasons.append(f"6 日累 {chg_6day:+.1f}%")
    except (KeyError, ZeroDivisionError, TypeError):
        pass

    # 條款 3:近 10 日大波動天數
    try:
        big_move = 0
        for i in range(1, len(last_10)):
            prev_close = last_10[i-1].get('close', 0)
            if prev_close > 0:
                daily_chg = (last_10[i]['close'] - prev_close) / prev_close * 100
                if abs(daily_chg) > 5:
                    big_move += 1
        if big_move >= 5:
            score += 30
            reasons.append(f"10 日 {big_move}/10 大波動(近 6 次門檻)")
        elif big_move >= 4:
            score += 15
            reasons.append(f"10 日 {big_move}/10 大波動")
    except (KeyError, TypeError):
        pass

    if score >= 70:
        status = '🚨 明日恐達處置門檻'
    elif score >= 40:
        status = '⚠️ 接近警戒區'
    else:
        return None  # score < 40 不存,只記錄高風險的

    return {
        'score': min(score, 100),
        'status': status,
        'reasons': reasons[:3],
        'latest_close': last_10[-1].get('close'),
    }


def build_attention_forecast():
    """掃全市場 data/*.json,對近期波動大的股票算處置門檻達標機率,
    寫 data/attention_forecast.json 供前端【🚨 妖股處置神器】顯示。
    """
    print("\n🚨 啟動【處置門檻價預估】算式(戰區二)...")
    forecast = {}
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw, list):
                continue
            est = estimate_attention_threshold(raw)
            if est:
                forecast[sym] = est
        except Exception:
            continue
    out_file = DATA_DIR / "attention_forecast.json"
    payload = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "total": len(forecast),
        "stocks": forecast,
    }
    try:
        out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"   ✅ 處置門檻預估:{len(forecast)} 檔達警戒區 → {out_file}")
    except Exception as e:
        print(f"   ❌ attention_forecast.json 寫檔失敗:{e}")


# ── 🦅 獵鷹建倉分:全市場每股 0-100 空手建倉評分(融合個股微觀 + 全球宏觀煞車)──
# 個股→族群反查(對齊 miner.py SUB_SECTORS / 前端 _industrySectors)
_FALCON_SECTORS = {
    'us': ['2330', '3711'], 'server': ['2382', '6669', '3231'],
    'power': ['1519', '1503', '1513'], 'packaging': ['2330', '3711', '3105'],
    'cpo': ['3450', '3380', '6491'], 'cooling': ['3017', '3324', '3653'],
    'robot': ['2049', '4551', '2206'], 'finance': ['2881', '2882', '2891'],
    'leo': ['3491', '2313', '6285'], 'dram': ['2408', '2344', '8299'],
}
_SYM2SECTOR = {s: k for k, syms in _FALCON_SECTORS.items() for s in syms}


def _falcon_ma(closes, n):
    return sum(closes[-n:]) / n if len(closes) >= n else None


def build_falcon_scores():
    """🦅 全市場每股算「獵鷹建倉分」(0-100,空手建倉吸引力),寫 data/falcon_scores.json。
    微觀(技術/低PE/流動性/族群/分點)在個股算,宏觀黑天鵝(讀 macro_risk.json)全市場同步套用。
    全程 try/except 包覆,任何來源缺失皆 graceful 退回中性,絕不崩潰。
    """
    print("\n🦅 啟動【獵鷹建倉分】全市場評分引擎...")
    # 1) 讀全球宏觀黑天鵝旗標(macro_miner 已在前一步產出)
    blackswan, macro_lines = {}, []
    try:
        mr = json.loads((DATA_DIR / "macro_risk.json").read_text(encoding='utf-8'))
        blackswan = mr.get("blackswan") or {}
    except Exception as e:
        print(f"   ⚠️ 讀 macro_risk.json 失敗,宏觀煞車本輪略過:{e}")
    if blackswan.get("market_bias_high"): macro_lines.append("大盤懼高×0.7")
    if blackswan.get("jpy_surge"):        macro_lines.append("日圓套利平倉-20")
    if blackswan.get("metal_oil_spike"):  macro_lines.append("金油暴漲避險-20")
    if blackswan.get("kospi_dump"):       macro_lines.append("亞股提款-10")

    # 2) 全市場 PE 快取(miner.py 產)+ 族群熱度(sector_heat.json,缺則略)
    fund_cache, sector_chg = {}, {}
    try:
        fund_cache = json.loads((DATA_DIR / "fundamentals_cache.json").read_text(encoding='utf-8'))
    except Exception:
        pass
    try:
        sh = json.loads((DATA_DIR / "sector_heat.json").read_text(encoding='utf-8'))
        for k, v in (sh.get("sectors") or {}).items():
            if isinstance(v, dict) and isinstance(v.get("chg"), (int, float)):
                sector_chg[k] = v["chg"]
    except Exception:
        pass

    from datetime import date as _date
    today = _date.today()
    scores = {}
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            rows = raw if isinstance(raw, list) else (raw.get('data') or raw.get('ohlcv') or [])
            if not isinstance(rows, list) or len(rows) < 22:
                continue
            closes = [r.get('close') for r in rows if r.get('close')]
            if len(closes) < 22:
                continue
            c = closes[-1]
            ma5, ma20, ma60 = _falcon_ma(closes, 5), _falcon_ma(closes, 20), _falcon_ma(closes, 60)
            base, factors = 50, []

            # ── 技術面 (±25) ──
            if ma20:
                if c > ma20:
                    base += 10; factors.append("站上月線+10")
                else:
                    base -= 15; factors.append("跌破月線-15")
                bias20 = (c - ma20) / ma20 * 100
                if 0 <= bias20 <= 8:
                    base += 5; factors.append("乖離健康+5")
                elif bias20 > 15:
                    base -= 10; factors.append("乖離過熱-10")
            if ma5 and ma20 and ma60 and ma5 > ma20 > ma60:
                base += 10; factors.append("多頭排列+10")
            if ma60 and c > ma60:
                base += 5; factors.append("站季線+5")

            # ── 低本益比 (±10) ──
            pe = (fund_cache.get(sym) or {}).get('pe')
            if isinstance(pe, (int, float)):
                if pe <= 0:
                    base -= 10; factors.append("虧損-10")
                elif pe < 15:
                    base += 10; factors.append(f"低PE{pe:.0f}+10")
                elif pe <= 25:
                    base += 3
                elif pe > 40:
                    base -= 5; factors.append(f"高PE{pe:.0f}-5")

            # ── 小型股流動性陷阱 (±, volume 股數 ÷1000 = 張) ──
            vols = [r.get('volume', 0) or 0 for r in rows[-5:]]
            avg_lots = (sum(vols) / len(vols) / 1000) if vols else 0
            if avg_lots < 200:
                base -= 30; factors.append("殭屍量-30")
            elif avg_lots < 500:
                base -= 10; factors.append("量稀-10")
            elif avg_lots > 50000:
                base += 5; factors.append("大量+5")

            # ── 同族群龍頭連動 (±5,僅 ~30 檔有族群) ──
            sec = _SYM2SECTOR.get(sym)
            if sec and sec in sector_chg:
                if sector_chg[sec] > 1:
                    base += 5; factors.append("族群強+5")
                elif sector_chg[sec] < -1:
                    base -= 5; factors.append("族群弱-5")

            # ── 主力分點連續性 (±8,僅 ~50 檔有 chips) ──
            try:
                cf = CHIPS_DIR / f"{sym}.json"
                if cf.exists():
                    cj = json.loads(cf.read_text(encoding='utf-8'))
                    days = cj if isinstance(cj, list) else (cj.get('chips') or [])
                    if days:
                        last = days[-1]
                        bnet = sum(b.get('net', 0) for b in (last.get('buyers') or []))
                        snet = sum(abs(s.get('net', 0)) for s in (last.get('sellers') or []))
                        if bnet > snet * 1.2:
                            base += 8; factors.append("主力買超+8")
                        elif snet > bnet * 1.2:
                            base -= 8; factors.append("主力賣超-8")
            except Exception:
                pass

            # ── 看盤時間軸信任度(資料新鮮度)──
            stale = False
            try:
                ld = str(rows[-1].get('date', '')).replace('/', '-')
                last_dt = _date.fromisoformat(ld)
                if (today - last_dt).days > 4:   # >4 日曆日(約 >2 交易日)視為舊
                    base -= 5; stale = True; factors.append("資料偏舊-5")
            except Exception:
                pass

            base = max(0, min(100, round(base)))

            # ── 🌍 全球宏觀黑天鵝煞車(全市場同步)──
            score = base
            if blackswan.get("market_bias_high"):
                score = round(score * 0.7)
            if blackswan.get("jpy_surge") or blackswan.get("metal_oil_spike"):
                score -= 20
            if blackswan.get("kospi_dump"):
                score -= 10
            score = max(0, min(100, score))

            if score >= 75:   label = "🦅 強力建倉"
            elif score >= 60: label = "✅ 可建倉"
            elif score >= 45: label = "🟡 觀望"
            else:             label = "🔴 避開"

            scores[sym] = {"score": score, "base": base, "label": label,
                           "factors": factors[:6], "stale": stale, "close": round(c, 2)}
        except Exception:
            continue

    payload = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "macro_flags": blackswan,
        "macro_lines": macro_lines,
        "total": len(scores),
        "stocks": scores,
    }
    try:
        (DATA_DIR / "falcon_scores.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f"   ✅ 獵鷹建倉分:{len(scores)} 檔評分完成,宏觀煞車={macro_lines or '無'} → falcon_scores.json")
    except Exception as e:
        print(f"   ❌ falcon_scores.json 寫檔失敗:{e}")


if __name__ == '__main__':
    main()
    # 🚨 雷達矩陣完成後,順手抓注意/處置股名單(獨立 try,失敗不影響雷達)
    try:
        fetch_attention_disposal_status()
    except Exception as e:
        print(f"💥 處置神器頂層異常(不影響雷達矩陣):{e}")
    # 🚨 戰區二:處置門檻價預估(純算式,失敗也不影響上面兩個)
    try:
        build_attention_forecast()
    except Exception as e:
        print(f"💥 處置門檻預估頂層異常(不影響其他):{e}")
    # 🦅 獵鷹建倉分:全市場空手建倉評分(獨立 try,需 macro_risk.json 已產出)
    try:
        build_falcon_scores()
    except Exception as e:
        print(f"💥 獵鷹建倉分頂層異常(不影響其他):{e}")
