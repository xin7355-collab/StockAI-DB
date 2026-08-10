#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🕳️ 深歷史探針(階段2 前置)—— 一次問完 FinMind「到底給不給得起」

⭐ 為什麼要先寫探針:沙箱連不到 FinMind(proxy 403),而「改採礦 → 等 workflow → 看輸出」
   一輪要 10 分鐘。V72.7.0 分析師焦點就是這樣連跑 7 輪只驗了 7 個假設,
   最後寫探針 9 秒問完四組。⛔ 這次不重蹈覆轍。

這支**只讀不寫任何產物**,把答案印進 log + 寫一份小 JSON,回答四題:
  ① TaiwanStockPrice 給 start_date 能回溯到多久?一檔真的只要 1 次呼叫嗎?
  ② 有沒有**下市股票**的資料?(倖存者偏誤能不能修 → 決定階段3 做不做得成)
  ③ 有沒有**還原股價**(除權息調整)的資料集?(除權息斷崖能不能修)
  ④ 一檔 5 年的 JSON 有多大?(推估 2,700 檔要多少空間 → 決定能不能只推 data 分支)

⛔ 安全:只印「第幾把 token」,絕不把 token 值印進 log(全專案鐵律)。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

API = 'https://api.finmindtrade.com/api/v4/data'
# 🚨 V73.2.7:⛔ 不可用 `.strip()` —— 它只清頭尾,而金鑰**中間**常夾一個空白
#   (從 FinMind 網頁複製時把換行帶進來)→ FinMind 回 `Token is illegal.`。
#   這支探針 V2 就是栽在這裡,把 3 把好金鑰誤判成「無效/過期」。
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
OUT = os.getenv('OUT', 'history_probe_result.json')
# 代表性樣本:大型/中型/ETF/上櫃 各一(⛔ 不用全市場,探針只要問「給不給」)
SAMPLE = ['2330', '2317', '0050', '5483']


def classify(msg):
    """把 FinMind 的錯誤訊息壓成一句結論(同 macro_miner._classify_finmind_fail)。

    ⭐ 這三類**完全不同**,處置也不同,⛔ 別混為一談(CLAUDE.md 2026-07-30 實測):
      ・`Token is illegal.`            → 金鑰無效/過期 → 該把要換掉
      ・`Your level is register.`      → 金鑰**有效**,只是帳號在免費層 → 這個資料集要更高等級
      ・其他                            → 真的抓不到(網路/資料集名稱/沒資料)
    """
    m = (msg or '').lower()
    if 'illegal' in m or 'invalid token' in m:
        return 'bad_token'
    if 'level is register' in m or 'update your user level' in m:
        return 'free_tier'
    if 'limit' in m or 'too many' in m or '402' in m:
        return 'quota'
    return 'other'


# 每一把 token 的實測分類統計(⛔ 只記索引,絕不記 token 值)
TOK_STAT = {}
_CLS_NAME = {'ok': '✅ 成功', 'bad_token': '⛔ 金鑰無效/過期',
             'free_tier': '⚠️ 免費層(金鑰有效)', 'quota': '⏳ 額度用盡',
             'other': '➖ 其他', 'net': '🌐 網路層失敗'}


def _C(cls):
    return _CLS_NAME.get(cls, cls)


def fm(dataset, extra=None, tok_i=0, timeout=60):
    """回 (rows, err, used_i)。⛔ 只回報第幾把 token,不回報 token 值。

    🚨 V2 修正(首跑實測抓到):4 把 token 有 3 把回 HTTP 400 ——
       第一版每組固定用某一把,結果「還原股價/除權息」那組剛好全用到壞的,
       ❌ 就被誤讀成「FinMind 沒有這些資料」。
       這正是 CLAUDE.md V72.5.3 的教訓:**400/403 要換下一把再試,
       ⛔ 不可當成「沒資料」**。→ 這裡一律把每一把都試過才放棄。

    🚨 V3 修正:`urlopen` 遇到 400 會丟 `HTTPError`,而**錯誤原文在 body 裡** ——
       V2 只記 `str(e)`(= "HTTP Error 400: Bad Request")就把它丟掉了,
       於是「金鑰無效」與「帳號在免費層」長得一模一樣,⛔ 分不出該換金鑰還是該升等級。
       → 一律 `e.read()` 讀 body 再分類。
    """
    tries = max(1, len(TOKENS)) if TOKENS else 1
    last = 'no-token'
    for k in range(tries):
        q = {'dataset': dataset}
        q.update(extra or {})
        i = (tok_i + k) % max(1, len(TOKENS))
        if TOKENS:
            q['token'] = TOKENS[i]
        url = API + '?' + urllib.parse.urlencode(q)
        raw = None
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            # ⭐ 關鍵:400 的真正原因在 body,不在 e 的字串表示
            try:
                raw = e.read().decode('utf-8', 'replace')[:200]
            except Exception:
                raw = ''
            try:
                raw = str((json.loads(raw) or {}).get('msg') or raw)[:160]
            except Exception:
                pass
            cls = classify(raw)
            TOK_STAT.setdefault(i + 1, {}).setdefault(cls, 0)
            TOK_STAT[i + 1][cls] += 1
            last = f'第{i+1}把/HTTP {e.code}/{cls}/{raw}'
            continue
        except Exception as e:
            TOK_STAT.setdefault(i + 1, {}).setdefault('net', 0)
            TOK_STAT[i + 1]['net'] += 1
            last = f'第{i+1}把/{type(e).__name__}: {str(e)[:100]}'
            continue
        if not isinstance(j, dict):
            last = 'resp 不是 dict'
            continue
        if j.get('status') not in (200, None):
            msg = str(j.get('msg'))[:160]
            cls = classify(msg)
            TOK_STAT.setdefault(i + 1, {}).setdefault(cls, 0)
            TOK_STAT[i + 1][cls] += 1
            last = f"第{i+1}把/status={j.get('status')}/{cls}/{msg}"
            continue
        TOK_STAT.setdefault(i + 1, {}).setdefault('ok', 0)
        TOK_STAT[i + 1]['ok'] += 1
        return (j.get('data') or []), None, i + 1
    return None, f'{tries} 把 token 全失敗;最後一個錯誤 → {last}', None


def main():
    res = {'probed_at': datetime.utcnow().isoformat() + 'Z', 'tokens': len(TOKENS)}
    print(f"🕳️ 深歷史探針 ・token {len(TOKENS)} 把")
    if not TOKENS:
        print("⚠️ 沒有 FINMIND_TOKENS → 只能測匿名額度,結果會偏悲觀(⛔ 別據此下結論)")

    # ── ① 深度:一次呼叫能拿多久 ──────────────────────────────────────
    print("\n① TaiwanStockPrice 深度(一檔一次呼叫)")
    res['depth'] = {}
    res['token_ok'] = set()
    for i, sym in enumerate(SAMPLE):
        t0 = time.time()
        rows, err, used = fm('TaiwanStockPrice',
                             {'data_id': sym, 'start_date': '2008-01-01'}, tok_i=i)
        el = time.time() - t0
        if err:
            print(f"   {sym}: ❌ {err}")
            res['depth'][sym] = {'err': err}
            continue
        ds = sorted(r.get('date', '') for r in rows if r.get('date'))
        size = len(json.dumps(rows, ensure_ascii=False))
        print(f"   {sym}: ✅ {len(rows):5} 筆 ・{ds[0] if ds else '?'} ~ {ds[-1] if ds else '?'}"
              f" ・{el:.1f}s ・原始 JSON {size/1024:.0f} KB ・用第 {used} 把")
        res['token_ok'].add(used)
        res['depth'][sym] = {'n': len(rows), 'from': ds[0] if ds else None,
                             'to': ds[-1] if ds else None, 'sec': round(el, 1), 'bytes': size}
        if i == 0 and rows:
            print(f"   欄位:{sorted(rows[0].keys())}")
            res['fields'] = sorted(rows[0].keys())

    # ── ② 下市股票(倖存者偏誤能不能修)───────────────────────────────
    print("\n② 下市股票清單(決定階段3 的倖存者偏誤修不修得掉)")
    res['delisted'] = {}
    for ds_name in ['TaiwanStockDelisting', 'TaiwanStockInfoWithWarrant', 'TaiwanStockInfo']:
        rows, err, _u = fm(ds_name, {}, tok_i=1)
        if err:
            print(f"   {ds_name}: ❌ {err}")
            res['delisted'][ds_name] = {'err': err}
        else:
            print(f"   {ds_name}: ✅ {len(rows)} 筆" + (f" ・欄位 {sorted(rows[0].keys())}" if rows else ''))
            res['delisted'][ds_name] = {'n': len(rows),
                                        'fields': sorted(rows[0].keys()) if rows else []}

    # ── ③ 還原股價(除權息斷崖能不能修)──────────────────────────────
    print("\n③ 還原股價 / 除權息(決定除權息斷崖怎麼修)")
    res['adjust'] = {}
    for ds_name, extra in [
        ('TaiwanStockPriceAdj', {'data_id': '2330', 'start_date': '2020-01-01'}),
        ('TaiwanStockDividend', {'data_id': '2330', 'start_date': '2015-01-01'}),
        ('TaiwanStockDividendResult', {'data_id': '2330', 'start_date': '2015-01-01'}),
    ]:
        rows, err, _u = fm(ds_name, extra, tok_i=2)
        if err:
            print(f"   {ds_name}: ❌ {err}")
            res['adjust'][ds_name] = {'err': err}
        else:
            print(f"   {ds_name}: ✅ {len(rows)} 筆" + (f" ・欄位 {sorted(rows[0].keys())}" if rows else ''))
            res['adjust'][ds_name] = {'n': len(rows),
                                      'fields': sorted(rows[0].keys()) if rows else []}

    # ── ⑤ 每一把 token 逐一實測「階段2 真正要用的資料集」 ─────────────────
    # ⭐ 使用者問:「那 3 把免費的是不是能抓別的、能不能加速、要不要獨立?」
    #    ⛔ 憑推論答不了 —— **免費層 ≠ 抓不到東西**,它只是某些高階資料集要付費。
    #    所以這裡**一把一把、一個資料集一個資料集**地問,答案才是實測的。
    print("\n⑤ 每一把 token × 階段2 要用的資料集(決定免費那幾把能不能一起幹活)")
    res['per_token'] = {}
    PROBE_DS = [
        ('TaiwanStockPrice', {'data_id': '2330', 'start_date': '2008-01-01'}, '日 K 深歷史(階段2 主力)'),
        ('TaiwanStockMonthRevenue', {'data_id': '2330', 'start_date': '2015-01-01'}, '月營收'),
        ('TaiwanStockDelisting', {}, '下市清單(階段3)'),
        ('TaiwanStockTradingDailyReport', {'date': '2026-08-06'}, '分點籌碼(付費層)'),
        # ⭐ V73.2.7 重測台指 VIX:CLAUDE.md 當時的結論(「沒有一把能開」「帳號等級不足」)
        #    是用 `.strip()` 版跑出來的 —— **付費那把根本沒被正確送出去過**。
        #    金鑰正規化修好之後,這一格才是第一次的有效測試。
        ('TaiwanOptionVix', {'start_date': '2026-07-01'}, '台指 VIX'),
    ]
    for ti in range(len(TOKENS)):
        row = {}
        for ds_name, extra, label in PROBE_DS:
            q = {'dataset': ds_name}
            q.update(extra)
            q['token'] = TOKENS[ti]
            try:
                t0 = time.time()
                with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=60) as r:
                    jj = json.loads(r.read().decode('utf-8'))
                n = len(jj.get('data') or [])
                row[ds_name] = {'ok': True, 'n': n, 'sec': round(time.time() - t0, 1)}
                print(f"   第 {ti+1} 把 × {label:<22} ✅ {n:5} 筆 ・{time.time()-t0:.1f}s")
            except urllib.error.HTTPError as e:
                try:
                    raw = str((json.loads(e.read().decode('utf-8', 'replace')) or {}).get('msg') or '')[:120]
                except Exception:
                    raw = ''
                cls = classify(raw)
                row[ds_name] = {'ok': False, 'cls': cls, 'msg': raw}
                print(f"   第 {ti+1} 把 × {label:<22} ❌ {_C(cls)} ・{raw[:70]}")
            except Exception as e:
                row[ds_name] = {'ok': False, 'cls': 'net', 'msg': str(e)[:80]}
                print(f"   第 {ti+1} 把 × {label:<22} 🌐 {type(e).__name__}")
            time.sleep(0.4)
        res['per_token'][str(ti + 1)] = row

    # ── ④ 空間推估 ────────────────────────────────────────────────
    ok = [v for v in res['depth'].values() if v.get('bytes')]
    if ok:
        # 只留回測要用的欄位(date/open/high/low/close/volume)後大約剩多少
        avg = sum(v['bytes'] for v in ok) / len(ok)
        slim = avg * 0.45          # 實測經驗:砍掉冗欄大約剩四成五
        for n in (2700,):
            print(f"\n④ 空間推估:一檔平均 {avg/1024:.0f} KB(精簡後約 {slim/1024:.0f} KB)"
                  f" → {n} 檔約 {slim*n/1e6:.0f} MB")
            res['space_mb_estimate'] = round(slim * n / 1e6)
        print("   ⚠️ gh-pages 上限 1GB、已用約 388MB → 若超過就**只推 data 分支**(前端不讀深歷史)")

    res['token_ok'] = sorted(res.get('token_ok') or [])
    res['token_stat'] = {str(k): v for k, v in sorted(TOK_STAT.items())}
    print(f"\n🔑 每一把 token 的實測分類(⛔ 只記第幾把,不記金鑰值)")
    for i in sorted(TOK_STAT):
        st = TOK_STAT[i]
        print(f"   第 {i} 把:" + ' ・'.join(f"{_C(k)} ×{v}" for k, v in sorted(st.items(), key=lambda x: -x[1])))
    print("   ⭐ 判讀:「金鑰無效」要換掉;「免費層」是**金鑰好的**,只是這個資料集要更高等級 ——"
          "\n      後者拿去抓**免費層開放的資料集**(日 K/月營收/法人)照樣有額度,⛔ 別急著移除")
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(f"\n📤 已寫入 {OUT}")

    # 🚧 空過守門:一檔都沒問到 = 這份結果無效,⛔ 不可當成「FinMind 給不起」
    if not ok:
        print("❌ 一檔都沒拿到 → 這份探針無效(可能是 token 沒給/全部無效),⛔ 別據此下結論")
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
