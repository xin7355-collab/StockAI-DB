#!/usr/bin/env python3
"""🔢 連次量(盤中第 N 次爆量)分 K 探針 —— 驗「空在爆量漲不動、買在爆量跌不動」。

來源:逐字稿【當沖心法】權證小哥:
  「用**連次量**抓轉折,空在**爆量漲不動**、買在**爆量跌不動**」
  「連次量爆量急拉,這時候容易轉折」「連次量綠色的急殺,他容易反彈」
  「第一次的最大量,那個是**發動量**;可能十幾次、二十幾次…」
  「兩個都亮燈然後遇到急拉的話…容易轉折更容易往下」

📖 連次量的定義(照他的描述):把當天的分 K 依成交量排序,某根 K 的量是當天
   「第 N 大」→ 那根就是「第 N 次量」。**次數越小 = 那根量越猛**。
   他強調的是「爆量之後價格有沒有跟上」,不是爆量本身。

⛔ 為什麼要這支:V71.9.8 已用**日線**版驗過(`volstall_probe.py`,64,990 事件),
   兩個方向都在雜訊內、而且方向跟他說的相反 → 日線版**不成立**。
   但他講的是**盤中**,日線把一整天壓成一根,本來就測不出「盤中第幾次爆量」。
   → 這支用真正的分 K 重驗一次。這是唯一能誠實回答的方法。

⭐ 鐵則(ORB 那次的教訓,⛔ 不可省):
   ・**必須扣掉當沖來回成本**(手續費 0.1425%×2×折數 + 賣出證交稅 0.15% 當沖減半)
     → 預設 COST_PCT=0.25%。**毛利為正不代表能賺**。
   ・要有**乾淨對照組**:同樣是爆量分 K,分「漲不動 / 跌不動 / 量價同向」比較。
   ・要看**各檔的鑑別度**,不能只看 pooled 平均(ORB 那次各股勝率 12.5%~43.8% 差很大)。

⚠️ 時間戳的坑(已踩過,寫死在這裡):Shioaji kbars 的 `ts` **已經是台灣牆鐘(naive)**,
   要用 `datetime.fromtimestamp(ts/1e9, tz=timezone.utc)` 讀才得到正確的 09:00~13:30。
   ⛔ **不可再套 +8**,否則會變成 17:00~21:30,時間閘門全部誤判。

跑法:GitHub Actions 手動 Run `volseq_probe.yml`(沙箱連不到 Shioaji)。
⛔ 本探針**不寫 gh-pages / data 分支**,零部署衝突風險。
"""
import json
import os
import statistics
from datetime import datetime, timedelta, timezone

TW = timezone(timedelta(hours=8))

# ⭐ V2(使用者質疑後重做):第一版把 16 檔 pooled 在一起測,是**錯的做法** ——
#    他自己明說「標的要**大波**,不要中華電信、不要中鋼,太牛」,
#    而實測發現我第一版用的 2330/2317/2454 按年化波動率其實落在**低波動組**,
#    等於拿他明說「不要碰」的股票在測他的方法 → 結論當然難看。
# ⭐ 改成**三組分層**(從 data/ 實測波動率 + 日成交額 >3 億挑出,才有分 K 流動性):
TEST_GROUPS = {
    '⭐ 高波動(他說適合)': ['5386', '6182', '3595', '6727', '2472', '8150',
                            '2327', '8064', '2493', '6683', '4939', '3163'],
    '➖ 中波動':          ['3105', '3661', '3135', '2379', '3653', '6139',
                            '1815', '8069', '3693', '4927', '5243', '6805'],
    '🐢 低波動(他說不要碰)': ['5388', '2385', '2883', '1795', '2354', '3005',
                            '2885', '2330', '0056', '5876', '2886', '3045'],
}
TEST_SYMS = [s for g in TEST_GROUPS.values() for s in g]
_SYM_GROUP = {s: g for g, syms in TEST_GROUPS.items() for s in syms}

HOLD_MINS = (5, 10, 20, 30)      # 進場後持有幾分鐘(當沖尺度)
TOPN = (1, 2, 3, 5)              # 「第 N 次量」的 N
COST_PCT = 0.25                  # 當沖來回成本(%),⛔ 不可拿掉
MIN_EVT = 60                     # 每桶至少幾筆才報數字
STALL_BODY = 0.15                # 「漲不動」:爆量 K 的漲幅 ≤ 這個 %(且收在下半部)


def _line(s):
    print(s, flush=True)


def _t(ts_ns):
    # ⚠️ Shioaji kbars ts 已是台灣牆鐘(naive),用 UTC 讀即得正確 09:00~13:30(⛔ 勿再套 TW+8)
    return datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)


def find_contract(api, code):
    for exch_name in ('TSE', 'OTC'):
        try:
            exch = getattr(api.Contracts.Stocks, exch_name, None)
            if exch is None:
                continue
            try:
                c = exch[code]
            except Exception:
                c = None
            if c is not None:
                return c
        except Exception:
            continue
    try:
        for exch in api.Contracts.Stocks:
            for c in exch:
                if getattr(c, 'code', '') == code:
                    return c
    except Exception:
        pass
    return None


def scan_day(db, topn_set):
    """對某一天的分 K 找出「第 N 次量」事件。
    回傳 list of {rank, kind, i}(kind: stall_up / stall_dn / same_up / same_dn)"""
    out = []
    if len(db) < 40:
        return out
    # 依量排序取「第 N 大」;⛔ 只看 09:05 之後(開盤第一根量必然最大,是結構性的不是訊號)
    cand = [(i, b) for i, b in enumerate(db)
            if b['v'] > 0 and (b['t'].hour * 60 + b['t'].minute) >= 9 * 60 + 5]
    if len(cand) < 30:
        return out
    ranked = sorted(cand, key=lambda x: -x[1]['v'])
    for rank, (i, b) in enumerate(ranked[:max(topn_set)], start=1):
        if rank not in topn_set:
            continue
        prev_c = db[i - 1]['c'] if i > 0 else b['o']
        if not (prev_c > 0) or not (b['h'] > b['l']):
            continue
        chg = (b['c'] - prev_c) / prev_c * 100
        pos = (b['c'] - b['l']) / (b['h'] - b['l']) * 100
        if chg <= STALL_BODY and pos <= 40 and b['h'] > prev_c:
            kind = 'stall_up'      # 爆量衝高但收不上去 → 他說要「空」
        elif chg >= -STALL_BODY and pos >= 60 and b['l'] < prev_c:
            kind = 'stall_dn'      # 爆量殺低但收得回來 → 他說要「買」
        elif chg > STALL_BODY:
            kind = 'same_up'       # 量價同向(對照)
        elif chg < -STALL_BODY:
            kind = 'same_dn'
        else:
            kind = 'other'
        out.append({'rank': rank, 'kind': kind, 'i': i})
    return out


def main():
    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    result = {'ok': False, 'note': '', 'rows': []}
    if not key or not sec:
        _line('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY')
        _save(result)
        return 2
    try:
        import shioaji as sj
    except Exception as e:
        _line(f'❌ shioaji 未安裝: {e}')
        _save(result)
        return 2

    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=key, secret_key=sec, fetch_contract=True)
        except TypeError:
            api.login(api_key=key, secret_key=sec)
            try:
                api.fetch_contracts(contract_download=True)
            except Exception:
                pass
        _line('✅ Shioaji 登入成功')
    except Exception as e:
        _line(f'❌ Shioaji 登入失敗: {e}')
        _save(result)
        return 2

    today = datetime.now(TW).date()
    start = (today - timedelta(days=150)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')
    _line(f'📅 kbars {start} ~ {end} ・{len(TEST_SYMS)} 檔 ・持有 {HOLD_MINS} 分 ・扣成本 {COST_PCT}%')
    _line('⚠️ 報酬全部是**扣成本後的淨值**(ORB 那次的教訓:毛利正不代表能賺)')
    _line('=' * 74)

    # bucket: (rank, kind) -> {hold: [淨報酬%]}
    from collections import defaultdict
    buk = defaultdict(lambda: defaultdict(list))       # (組別, rank, kind) -> {hold: [淨%]}
    gross = defaultdict(lambda: defaultdict(list))    # 同鍵 -> {hold: [毛%]} (看是不是被成本吃掉)
    per_sym = defaultdict(lambda: defaultdict(list))
    topn_set = set(TOPN)
    total_days = 0

    for sym in TEST_SYMS:
        c = find_contract(api, sym)
        if c is None:
            _line(f'[{sym}] ⚠️ 無合約')
            continue
        try:
            kb = api.kbars(c, start=start, end=end)
            ts = list(kb.ts)
            op, hi, lo, cl = list(kb.Open), list(kb.High), list(kb.Low), list(kb.Close)
            vol = list(getattr(kb, 'Volume', [0] * len(ts)))
            bars = [{'t': _t(ts[i]), 'o': op[i], 'h': hi[i], 'l': lo[i], 'c': cl[i], 'v': vol[i]}
                    for i in range(len(ts))]
        except Exception as e:
            _line(f'[{sym}] ❌ {type(e).__name__}: {str(e)[:110]}')
            continue

        by_day = defaultdict(list)
        for b in bars:
            by_day[b['t'].strftime('%Y-%m-%d')].append(b)
        nday = 0
        for d in sorted(by_day):
            db = sorted(by_day[d], key=lambda x: x['t'])
            evs = scan_day(db, topn_set)
            if not evs:
                continue
            nday += 1
            for e in evs:
                i = e['i']
                entry = db[i]['c']
                if not (entry > 0):
                    continue
                for hm in HOLD_MINS:
                    j = i + hm
                    if j >= len(db):
                        continue
                    ex = db[j]['c']
                    if not (ex > 0):
                        continue
                    # 他說「漲不動要空」→ 做空的報酬是反向;「跌不動要買」→ 做多
                    raw = (ex - entry) / entry * 100
                    if e['kind'] in ('stall_up', 'same_up'):
                        net = -raw - COST_PCT      # 空單
                    else:
                        net = raw - COST_PCT       # 多單
                    g = _SYM_GROUP.get(sym, '?')
                    buk[(g, e['rank'], e['kind'])][hm].append(net)
                    gross[(g, e['rank'], e['kind'])][hm].append(-raw if e['kind'] in ('stall_up', 'same_up') else raw)
                    if e['kind'] in ('stall_up', 'stall_dn'):
                        per_sym[sym][e['kind']].append(net if hm == 10 else None)
        total_days = max(total_days, nday)
        _line(f'[{sym}] {len(bars)} 筆分K ・{nday} 個有事件的交易日')

    try:
        api.logout()
    except Exception:
        pass

    if not buk:
        _line('❌ 沒有任何事件,無法下結論')
        _save(result)
        return 0

    _line('')
    _line(f'📊 結果(分 K 深度最多 {total_days} 交易日;淨值 = 已扣 {COST_PCT}% 當沖成本)')
    _line('⭐ 依「該股波動率」分三組報 —— 他明說「標的要大波,不要中華電/中鋼太牛」,')
    _line('   所以 pooled 在一起測是錯的,必須分組才問得出「是不是只對特定股票有用」。')
    label = {'stall_up': '爆量漲不動(他說空)', 'stall_dn': '爆量跌不動(他說買)',
             'same_up': '量價同漲(對照·做空)', 'same_dn': '量價同跌(對照·做多)'}
    best = None
    for g in TEST_GROUPS:
        _line('')
        _line(f'── {g} ' + '─' * 46)
        _line(f'{"第N次":<6}{"型態":<26}{"n":>6}{"毛10分":>9}{"淨10分":>9}{"淨30分":>9}{"10分勝率":>9}')
        any_row = False
        for rank in TOPN:
            for kind in ('stall_up', 'stall_dn', 'same_up', 'same_dn'):
                v = buk.get((g, rank, kind)) or {}
                gv = gross.get((g, rank, kind)) or {}
                n = len(v.get(10) or [])
                if n < MIN_EVT:
                    continue
                any_row = True
                net10 = statistics.median(v[10])
                net30 = statistics.median(v[30]) if v.get(30) else 0
                gr10 = statistics.median(gv[10]) if gv.get(10) else 0
                w = sum(1 for x in v[10] if x > 0) / n * 100
                _line(f'{rank:<6}{label[kind]:<26}{n:>6}{gr10:>+8.3f}%{net10:>+8.3f}%{net30:>+8.3f}%{w:>8.1f}%')
                result['rows'].append({'group': g, 'rank': rank, 'kind': kind, 'n': n,
                                       'gross10': round(gr10, 4), 'net10': round(net10, 4),
                                       'net30': round(net30, 4), 'win10': round(w, 1)})
                if kind.startswith('stall') and (best is None or net10 > best[0]):
                    best = (net10, g, rank, kind, n, w, gr10)
        if not any_row:
            _line('   (樣本不足,略過)')

    _line('')
    _line('📌 結論')
    if best is None:
        _line('   ⏳ 「漲不動 / 跌不動」樣本不足,無法下結論。')
    else:
        v, g, rank, kind, n, w, gr = best
        _line(f'   全部組別裡最好的一組:{g} × 第 {rank} 次量 × {label[kind]}')
        _line(f'   → 毛 10 分 {gr:+.3f}% ・**淨 10 分 {v:+.3f}%** ・勝率 {w:.1f}%(n={n})')
        if v > 0.05:
            _line(f'   ✅ **扣成本後仍為正** → 這一組值得做(⚠️ 只對「{g}」,⛔ 別套到其他股票)')
        elif v > -0.05:
            _line('   ➖ 扣成本後約略打平 → 邊際被成本吃掉,⛔ 先不做(同 ORB 的結論)')
        else:
            _line('   ❌ 連最好的一組扣成本後都是負的 → ⛔ 不做')
    _line('')
    _line('⭐ 怎麼讀「毛」和「淨」的差:')
    _line('   毛 ≈ 0 → 訊號出現後價格根本沒動(方向性不存在),不是被成本吃掉而已。')
    _line('   毛 > 0 但淨 < 0 → 有方向但賺不過成本(ORB 那次就是這種)。')
    _line('')
    _line('⚠️ 限制:分 K 深度有限(Shioaji 免費約 100 交易日),涵蓋的行情型態有限;')
    _line('   震盪盤沒有邊際不代表趨勢盤也沒有。每組 12 檔,組內 pooled。')
    result['ok'] = True
    _save(result)
    return 0


def _save(result):
    try:
        os.makedirs('data', exist_ok=True)
        with open('data/_volseq_probe.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        _line('💾 已寫 data/_volseq_probe.json(僅 artifact,⛔ 不進 gh-pages)')
    except Exception as e:
        _line(f'⚠️ 結果寫檔失敗:{e}')


if __name__ == '__main__':
    raise SystemExit(main())
