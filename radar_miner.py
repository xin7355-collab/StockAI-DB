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

    def _fetch_openapi(url, status_label, threshold_label):
        """TWSE OpenAPI v1 解析(RESTful JSON list,row 含 Code / CompanyCode 等鍵)。"""
        try:
            r = requests.get(url, headers=headers, timeout=10)
            rows = r.json()
            if not isinstance(rows, list):
                return {}
            out = {}
            for row in rows:
                if not isinstance(row, dict):
                    continue
                # TWSE OpenAPI 不同端點欄位名略異(Code / CompanyCode / 證券代號 皆有可能)
                sym = str(row.get('Code') or row.get('CompanyCode')
                          or row.get('證券代號') or '').strip()
                if sym and sym.isdigit():
                    out[sym] = {"status": status_label, "threshold": threshold_label}
            return out
        except Exception as e:
            print(f"   ⚠️ {status_label} OpenAPI 失敗:{e}")
            return {}

    # ── 注意股(TWSE OpenAPI v1)──
    attention = _fetch_openapi(
        "https://openapi.twse.com.tw/v1/announcement/notice",
        "⚠️ 注意股", "注意條款觸發")
    print(f"   · 注意股:{len(attention)} 檔")

    # ── 處置股(TWSE OpenAPI v1,後面合併會覆蓋注意股以呈現更嚴重狀態)──
    disposal = _fetch_openapi(
        "https://openapi.twse.com.tw/v1/announcement/punish",
        "🚨 處置中", "已關禁閉")
    print(f"   · 處置股:{len(disposal)} 檔")

    # 合併:處置覆蓋注意
    result = {**attention, **disposal}

    # 斷崖防護:全失敗時沿用昨日 cache,絕不寫空檔
    if not result and ATTENTION_FILE.exists():
        print("🛡️  全部 API 失敗,沿用昨日 attention_status.json,不覆蓋")
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
            # 條件：法人(外資+投信)連買3天、剛站上月線 (昨天在月線下，今天在月線上)、成交量放大
            inst_buy_3d = all(
                (r.get('foreign_net', 0) + r.get('trust_net', 0)) > 0
                for r in data[-3:]
            )
            cross_20ma = (pc <= p_ma20 and c > ma20)
            v_avg_5 = sum(d.get('volume', 0) for d in data[-5:]) / 5
            vol_expanding = v > v_avg_5

            if inst_buy_3d and cross_20ma and vol_expanding:
                matrix['swing'].append({
                    'sym': sym,
                    'close': round(c, 2),
                    'turnover_e': turnover_e,
                    'gain': day_gain,
                    'status': "剛站上月線+法人連買"
                })

            # --- 🎯 戰區三：狙擊手 (籌碼集中) ---
            # 條件：乖離率極低(股價貼著月線)，但特定大戶籌碼高度集中
            # ⚠️ 僅 CHIP_WATCHLIST(~50檔) 有分點資料，故此區候選天然受限
            bias_20 = (c - ma20) / ma20 * 100
            if -2 <= bias_20 <= 3:  # 股價在月線附近盤整
                # 試圖讀取 chips 資料夾中的分點資料
                chip_file = CHIPS_DIR / f"{sym}.json"
                if chip_file.exists():
                    chip_data = json.loads(chip_file.read_text(encoding='utf-8'))
                    chips_list = chip_data.get('chips', [])
                    if chips_list:
                        latest_chip = chips_list[-1]
                        tot_buy = latest_chip.get('tot_buy', 0)
                        if tot_buy > 0:
                            # 計算前三大買超券商佔比
                            top3_buy = sum(
                                b.get('buy', 0)
                                for b in sorted(
                                    latest_chip.get('buyers', []),
                                    key=lambda x: -x.get('net', 0)
                                )[:3]
                            )
                            concentration = top3_buy / tot_buy * 100

                            # 如果前三大主力吃掉 30% 以上的買盤，且股價還沒漲
                            if concentration >= 30:
                                matrix['sniper'].append({
                                    'sym': sym,
                                    'close': round(c, 2),
                                    'turnover_e': turnover_e,
                                    'gain': day_gain,
                                    'status': f"主力高度集中 {round(concentration, 1)}%"
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


if __name__ == '__main__':
    main()
    # 🚨 雷達矩陣完成後,順手抓注意/處置股名單(獨立 try,失敗不影響雷達)
    try:
        fetch_attention_disposal_status()
    except Exception as e:
        print(f"💥 處置神器頂層異常(不影響雷達矩陣):{e}")
