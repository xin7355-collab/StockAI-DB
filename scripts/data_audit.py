#!/usr/bin/env python3
"""🩺 全盤資料體檢 —— 一支指令查完「資料有沒有、新不新、對不對接、有沒有互相打架」。

╔══════════════════════════════════════════════════════════════════════╗
║ 這支存在的理由(使用者 2026-07-30 問的):                              ║
║   「為何我請你檢查整份資料,你還是一輪一輪才找到錯?                     ║
║     我要怎麼下指令你才能全盤找到,並檢查連動與資料連接錯誤?」            ║
║                                                                      ║
║ 老實說,之前的檢查是**結構性**的(檔案在不在、能不能解析、id 有沒有重複),║
║ 抓不到**語意性**錯誤(41,613 這個數字本身是錯的)。語意錯只有兩種抓法:  ║
║   ① 有外部對照(使用者給籌碼K線截圖)—— 這是最有效的,請繼續給          ║
║   ② 把「內部應該一致的東西」互相對帳 —— 這支就是做這件事,而且可重複跑  ║
║                                                                      ║
║ 下指令方式:直接說「跑資料體檢」,我就執行這支並逐項回報。               ║
╚══════════════════════════════════════════════════════════════════════╝

檢查五類:
  A. 檔案存在 / 可解析 / 內容非空          (前端 fetch 的每一個 data/*.json)
  B. 新鮮度                                (更新時間 vs 該檔的預期節奏)
  C. 錯誤欄位                              (任何 *_error 有值)
  D. 前後端對接                            (前端讀的欄名,後端到底有沒有產)← 連接錯誤
  E. 連動一致性                            (同一個指標出現在多個檔,值要一致)← 連動

資料來源:gh-pages 分支(= 使用者手機真正讀到的那份),用 git 讀,不打網路。
用法:python3 scripts/data_audit.py [--ref origin/gh-pages]
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TW = timezone(timedelta(hours=8))

# 每個檔的預期更新節奏(小時)。超過 → 報「過期」。
# None = 不檢查新鮮度(靜態對照表 / 手動維護 / 週月更)
CADENCE_H = {
    'macro_risk.json': 6,        # 每 4 小時 cron
    'macro_cache.json': 30,      # 每日採礦
    'radar.json': 30,
    'top_picks.json': 30,
    'breadth.json': 30,
    'daytrade.json': 30,
    'fmx_pack.json': 30,
    'sector_heat.json': 30,
    'sector_chip_flow.json': 30,
    'attention_status.json': 30,
    'disposition.json': 30,
    'lowbase_picks.json': 30,
    'broker_radar.json': 30,
    'broker_perf.json': 30,
    'global_news.json': 12,
    'radar_news.json': 12,
    'industry_pe.json': 72,
    'industry_map.json': None,
    'concept_stocks.json': 168,
    'holders.json': 240,         # 集保週更
    'insider.json': 800,         # 董監月更
    'day_trade.json': None,      # V71.5.4 已被 daytrade.json 取代,不再要求新鮮
    # 🕐 盤中才產出的:收盤後 / 假日本來就會舊,不算問題
    'live_quotes.json': None,
    'tick_flow.json': None,
    'daytrade_pack.json': None,
    'paper_trades.json': None,   # 紙上交易,有訊號才寫
}

META_KEYS = {'updated', 'generated', 'date', 'data_date', 'ts', 'miner_version', 'count', 'total'}

# 🕐 盤中才產出的檔:收盤後/假日不在 gh-pages 是正常的,不是缺口。
#    ⚠️ 要驗這幾個檔,必須**盤中**再跑一次體檢 —— 收盤後跑再久都不會出現。
INTRADAY_ONLY = {'live_quotes.json', 'tick_flow.json', 'daytrade_pack.json'}

# 📌 「刻意不在 gh-pages」的檔:報成缺口會誤導,把「為什麼」寫在這裡當活文件。
#    2026-07-30 首跑時我把這幾條都寫成「缺口待修」,逐條讀原始碼才發現是刻意的 ——
#    照著修會把已經下架的東西又接回來。工具只知道「檔案不在」,不知道「本來就不該在」。
#    ⚠️ 新增項目前務必先 grep 過:`rm -f`、`= False`、「退役」「停用」「暫停」。
# 🗂️ V72.1.2 「已被取代、payload 空掉是正常的」舊檔 —— ⛔ 別報成錯誤
#   工具只知道「檔案是空的」,不知道「它已經退休了」。
#   ⚠️ 誤報留著會讓人養成忽略體檢輸出的習慣,真的壞掉那條就被淹掉了。
SUPERSEDED = {
    'day_trade.json': 'V71.5.4 起前端改讀 daytrade.json,這個舊檔只留備援,空掉不影響',
}

DELIBERATELY_ABSENT = {
    'chief_ai_cache.json':
        'chief_ai_batch.py 2026-06 退役,daily_miner.yml 每次部署都 rm -f 這個檔;'
        '前端 V16.7 已有 stale 判定(>2 天視同無 cache)並自動 fallback radar_matrix',
    'biz_profile.json':
        'theme_news.py::main() 的 ok_b=False 是寫死的 —— run#3 已印出 TWSE/TPEX '
        '「公司基本資料」全部欄位確認官方 API 沒有業務說明文字欄。要做是先找來源,不是改程式',
}


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout


ROOT_LEVEL = {'macro_cache.json', 'futures_cache.json', 'margin_cache_stock.json'}


def read_json(ref, path):
    raw = subprocess.run(['git', 'show', f'{ref}:{path}'], capture_output=True, text=True)
    if raw.returncode != 0 and Path(path).name in ROOT_LEVEL:
        # gh-pages 上這幾個歷史因素放在根目錄,不在 data/
        raw = subprocess.run(['git', 'show', f'{ref}:{Path(path).name}'], capture_output=True, text=True)
    if raw.returncode != 0:
        return None, 'MISSING'
    try:
        return json.loads(raw.stdout), None
    except Exception as e:
        return None, f'PARSE_FAIL: {str(e)[:60]}'


def payload_size(j):
    if isinstance(j, list):
        return len(j)
    if not isinstance(j, dict):
        return 0
    real = {k: v for k, v in j.items() if k not in META_KEYS and not str(k).startswith('__')}
    if len(real) == 1:
        v = next(iter(real.values()))
        if isinstance(v, (list, dict)):
            return len(v)
    return len(real)


def parse_ts(j):
    """從常見欄位取更新時間,回 datetime(台北)或 None。"""
    if not isinstance(j, dict):
        return None
    for k in ('updated', 'generated', 'data_date', 'date'):
        v = j.get(k)
        if not isinstance(v, str) or len(v) < 8:
            continue
        t = v.strip().replace('/', '-')
        for fmt in ('%Y-%m-%d %H:%M', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S',
                    '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
            try:
                d = datetime.strptime(t[:len(datetime.now().strftime(fmt))], fmt)
                if fmt.endswith('Z'):
                    d = d.replace(tzinfo=timezone.utc).astimezone(TW)
                else:
                    d = d.replace(tzinfo=TW)
                return d
            except Exception:
                continue
        m = re.match(r'(\d{4})-(\d{2})-(\d{2})', t)
        if m:
            return datetime(int(m[1]), int(m[2]), int(m[3]), tzinfo=TW)
    return None


def frontend_fetched_files():
    """index.html 裡 fetch 的 data/*.json 檔名(去掉 data/chips/ 逐檔)。"""
    src = (ROOT / 'index.html').read_text(encoding='utf-8')
    names = set(re.findall(r"['\"`]data/([A-Za-z_][\w.^-]*\.json)['\"`?]", src))
    names |= set(re.findall(r"data/([A-Za-z_][\w.^-]*\.json)\?", src))
    return {n for n in names if '{' not in n and '$' not in n}


def macro_fields_read():
    """index.html 從 _macroRiskCache 讀了哪些欄名(mr.x / macro.x / this._macroRiskCache?.x)。"""
    src = (ROOT / 'index.html').read_text(encoding='utf-8')
    pats = [r'\bmr\.([a-z][a-z0-9_]{2,})', r'\bmacro\.([a-z][a-z0-9_]{2,})',
            r'_macroRiskCache\s*\?\?\s*\{\}\)\.([a-z][a-z0-9_]{2,})',
            r'_macroRiskCache\s*\)?\s*\?\.\s*([a-z][a-z0-9_]{2,})']
    out = set()
    for p in pats:
        out |= set(re.findall(p, src))
    # 過濾明顯是方法/JS 內建的
    skip = {'length', 'forEach', 'map', 'filter', 'then', 'catch', 'toFixed', 'slice',
            'push', 'join', 'sort', 'keys', 'values', 'includes', 'replace', 'split',
            'indexof', 'tolowercase', 'touppercase', 'concat', 'reduce', 'some', 'every'}
    return {f for f in out if f.lower() not in skip}


# 同一個指標出現在多個檔 → 值必須一致(連動對帳)
#  ⚠️ 已知結論(2026-07-30 對照籌碼K線驗過):同一指標在這兩個檔不一致時,
#     **macro_risk.json 是對的**(每 4 小時 cron,美股收完才抓);
#     macro_cache.json 由 miner.py 在 16:30 那輪抓,美股當天還沒收 → 拿到前一個 session,
#     卻被 yfinance 標上今天的日期,所以「日期一樣但數字不一樣」。
#     前端目前沒有任何卡片讀 usMacroCache 的 dji/sox/tsm/vix(已 grep 確認),所以畫面沒錯,
#     但這條對帳要留著 —— 哪天有人接了錯的那邊,這裡會立刻叫出來。
CROSS_CHECKS = [
    # (說明, 檔A, 取值路徑A, 檔B, 取值路徑B, 容差, 誰為準)
    ('費半 SOX',   'macro_risk.json', ('sox',), 'macro_cache.json', ('sox', 'close'), 0.5, 'macro_risk'),
    ('道瓊 DJI',   'macro_risk.json', ('dji',), 'macro_cache.json', ('dji', 'close'), 0.5, 'macro_risk'),
    ('VIX',        'macro_risk.json', ('vix',), 'macro_cache.json', ('vix', 'close'), 0.2, 'macro_risk'),
    ('台積電 ADR', 'macro_risk.json', ('tsm',), 'macro_cache.json', ('tsm', 'close'), 0.5, 'macro_risk'),
]


def dig(j, path):
    cur = j
    for k in path:
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur


def audit(ref):
    problems = []   # (等級, 類別, 訊息)
    add = lambda lv, cat, msg: problems.append((lv, cat, msg))
    now = datetime.now(TW)

    files = sorted(frontend_fetched_files())
    print(f'🩺 全盤資料體檢  ref={ref}  時間={now:%Y-%m-%d %H:%M} (台北)')
    print(f'   前端 fetch 的 data/*.json 共 {len(files)} 個\n')

    cache = {}
    # ── A/B/C ────────────────────────────────────────────────────────
    print('── A. 檔案存在 / 可解析 / 內容非空 ──────────────────────')
    for f in files:
        j, err = read_json(ref, f'data/{f}')
        cache[f] = j
        if err == 'MISSING':
            # 🕐 盤中才產的檔:收盤/假日不在 gh-pages 是正常的,報成 ❌ 只是噪音
            #    (跟 B 類新鮮度用同一份名單:CADENCE_H 標 None 且列在盤中清單裡的)
            if f in INTRADAY_ONLY:
                print(f'   ➖ data/{f} 不在 {ref} —— 盤中才產出,收盤/假日沒有是正常的'
                      f'(要驗這個檔必須**盤中**再跑一次)')
            elif f in DELIBERATELY_ABSENT:
                print(f'   ➖ data/{f} 不在 {ref} —— 刻意的,不是缺口:{DELIBERATELY_ABSENT[f]}')
            else:
                add('❌', 'A', f'data/{f} 在 {ref} 不存在,但前端會去 fetch')
            continue
        if err:
            add('❌', 'A', f'data/{f} {err}')
            continue
        n = payload_size(j)
        if n == 0:
            # ⚠️ V72.1.2 已被取代的舊檔不算錯 —— 每次體檢都報一次會變雜訊,
            #   真的壞掉的那條反而被淹掉(CLAUDE.md:誤報要標掉,別讓人養成忽略的習慣)。
            if f in SUPERSEDED:
                print(f'   ➖ data/{f} payload 是空的 —— 刻意的:{SUPERSEDED[f]}')
            else:
                add('❌', 'A', f'data/{f} 內容是空的(payload 0 筆)')
    print(f'   完成,問題 {sum(1 for p in problems if p[1] == "A")} 件')

    print('\n── B. 新鮮度(更新時間 vs 預期節奏)─────────────────────')
    for f in files:
        j = cache.get(f)
        if not isinstance(j, dict):
            continue
        cad = CADENCE_H.get(f, 'unknown')
        if cad is None:
            continue
        ts = parse_ts(j)
        if ts is None:
            if cad != 'unknown':
                add('⚠️', 'B', f'data/{f} 找不到更新時間欄位(updated/generated/date),無法判斷新舊')
            continue
        age_h = (now - ts).total_seconds() / 3600
        limit = 30 if cad == 'unknown' else cad
        # ⚠️ 只有日期沒有時間的檔(如 "2026-07-29"),parse 出來會是當天 00:00,
        #   於是隔天早上一律被算成「過期 32 小時」= 誤報。這種一律改用「日數」判斷。
        if ts.hour == 0 and ts.minute == 0:
            day_gap = (now.date() - ts.date()).days
            allow_days = max(1, int(round(limit / 24)) + 1)
            if day_gap > allow_days:
                add('⚠️', 'B', f'data/{f} 資料日期 {ts:%m/%d} 已距今 {day_gap} 天(預期 ≤{allow_days} 天)')
            continue
        if age_h > limit:
            add('⚠️', 'B', f'data/{f} 已過期 {age_h:.0f} 小時(預期 ≤{limit}h,更新於 {ts:%m/%d %H:%M})')
    print(f'   完成,問題 {sum(1 for p in problems if p[1] == "B")} 件')

    print('\n── C. 錯誤欄位(*_error 有值)───────────────────────────')
    for f in files:
        j = cache.get(f)
        if not isinstance(j, dict):
            continue
        for k, v in j.items():
            if str(k).endswith('_error') and v:
                add('⚠️', 'C', f'data/{f} 的 {k} = {str(v)[:70]}')
                # 🐛 V72.1.2 ⭐ 新增「值與 error **自相矛盾**」偵測 ——
                #   體檢原本只會分別報「這個 error 有值」,**看不出值本身還在**,
                #   所以 taifex_backwardation = -156.0 配「不計價差」那次它漏報了。
                #   ⛔ 這一類比「那格空著」危險得多:使用者會拿一個不該信的數字去做決定。
                #   典型成因:守門把值設成 None,但斷崖防護(last-good)又把昨天的填回去
                #   → 昨天的數字配今天的日期(陷阱 #34)。
                base = str(k)[:-len('_error')]
                bv = j.get(base)
                # ⚠️ 但要先排除**刻意的**情況,否則會誤報(首跑就誤報了 3 個)——
                #   有些 error 針對的是**衍生欄位**而不是值本身:
                #   例如 es_fut_error =「不給漲跌%」→ **價位是可信的**,只是不給方向(V72.0.5),
                #   那不叫矛盾。同理「內插/fallback/已保留舊值」都是有交代的降級,不是壞掉。
                #   ⭐ 只有 error 針對「值本身不可信」時,值還在才是真矛盾。
                _intentional = ('不給漲跌', '不給方向', '方向待確認', '內插',
                                'fallback', '已保留', '沿用', '備援')
                if (bv is not None
                        and not (isinstance(bv, (list, dict, str)) and len(bv) == 0)
                        and not any(t in str(v) for t in _intentional)):
                    add('❌', 'C', f'data/{f} 的 {base} 有值({str(bv)[:28]})但 {k} 說有問題'
                                   f' → 兩者矛盾,多半是守門清掉後又被 last-good 填回昨天的值(陷阱 #34)')
    print(f'   完成,問題 {sum(1 for p in problems if p[1] == "C")} 件')

    # ── D. 前後端對接 ────────────────────────────────────────────────
    print('\n── D. 前後端對接:前端讀的欄名,後端有沒有產 ─────────────')
    mr = cache.get('macro_risk.json')
    if isinstance(mr, dict):
        have = set(mr.keys())
        read = macro_fields_read()
        # ⚠️ V71.6.2 誤報修正:有些欄位是**前端自己算完寫進 `_macroRiskCache`** 的
        #    (如 taiex_ma240_bias / taiex_bubble_msg,`_loadTaiexMA240Bias` 用 ^TWII K 線純算式算),
        #    後端本來就不該有 → 報成「後端沒產出」是誤報,而且會把真的斷點淹掉。
        #    做法:凡是 index.html 裡出現 `_macroRiskCache.X =` 的欄位,一律視為前端自算。
        html = (ROOT / 'index.html').read_text(encoding='utf-8')
        self_computed = set(re.findall(r'_macroRiskCache(?:\s*\|\|\s*\{\})?\.([a-z][\w]*)\s*=', html))
        # 只報「看起來像後端欄位」的(有底線或已知前綴),避免誤傷區域變數
        suspicious = sorted(x for x in (read - have - self_computed) if '_' in x)
        for x in suspicious:
            add('⚠️', 'D', f'前端讀 macro_risk 的 {x},但檔案裡沒有這個欄位(可能改名或從沒產出)')
        if self_computed & read - have:
            print(f'   ➖ 前端自算(不算斷點):{sorted(self_computed & read - have)}')
        print(f'   前端讀 {len(read)} 個欄名 / 檔案有 {len(have)} 個 → 對不上的 {len(suspicious)} 個')
    else:
        add('❌', 'D', 'macro_risk.json 讀不到,無法做對接檢查')

    # ── E. 連動一致性 ────────────────────────────────────────────────
    print('\n── E. 連動一致性:同一指標在多個檔要一致 ────────────────')
    checked = 0
    for name, fa, pa, fb, pb, tol, truth in CROSS_CHECKS:
        ja, jb = cache.get(fa), cache.get(fb)
        if not isinstance(jb, dict):
            jb, _e = read_json(ref, f'data/{fb}')
        if not isinstance(ja, dict) or not isinstance(jb, dict):
            continue
        va, vb = dig(ja, pa), dig(jb, pb)
        if va is None or vb is None:
            add('⚠️', 'E', f'{name}:{fa}{list(pa)}={va} / {fb}{list(pb)}={vb} → 有一邊缺值,無法對帳')
            continue
        checked += 1
        try:
            if abs(float(va) - float(vb)) > float(tol):
                add('⚠️', 'E', f'{name} 兩處不一致:{fa}={va} vs {fb}={vb}(容差 {tol});以 {truth} 為準')
        except Exception:
            add('⚠️', 'E', f'{name}:值不是數字({va} / {vb})')
    print(f'   對帳 {checked} 組')

    # ── 總結 ─────────────────────────────────────────────────────────
    print('\n' + '═' * 66)
    bad = [p for p in problems if p[0] == '❌']
    warn = [p for p in problems if p[0] == '⚠️']
    if not problems:
        print('✅ 全部通過,沒有發現問題')
        return 0
    print(f'發現 {len(bad)} 個明確錯誤、{len(warn)} 個警告\n')
    for lv in ('❌', '⚠️'):
        for l, cat, msg in problems:
            if l == lv:
                print(f'{lv} [{cat}] {msg}')
    print('\n說明:❌ = 明確壞掉要修;⚠️ = 可能是正常現象(如週更檔、盤前尚未產出),需人工判斷。')
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', default='origin/gh-pages', help='要體檢哪個 ref(預設 origin/gh-pages)')
    args = ap.parse_args()
    sys.exit(audit(args.ref))


if __name__ == '__main__':
    main()
