#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📐 PE 自身歷史位階採礦(V73.3.9)—— 產出 `data/pe_band.json`。

🚨 CLAUDE.md 原本判定**不要做**:
     「歷史 P/E 價格帶:我只有**當前** PE、沒有歷史 EPS → 用現在的 EPS 回推歷史 PE,
       算出來只是把價格區間換個名字(等於位階溫度計),**是假的河流圖**,不要做。」
   ⭐ `TaiwanStockPER` 給的是**每一天當時的真實 PE**(不是回推)→ 那個理由不成立了。

✅ 而且**先驗證過才做**(`scripts/pe_band_probe.py`,300 檔跨代號段均勻抽樣、11 年):
     PE 最低 10% → 60 日 **+0.68pp**(前半 +0.74 / 後半 +0.36 同向;拿掉 2022 仍 +0.61)
     PE 最低 25% → **+0.63pp** ・中間 −0.31 ・最高 25% −0.43 ・最高 10% **−0.49**
   ⭐ **完全單調 + 反向檢定成立** → 六道關卡全過。
   ⛔ 但幅度小(60 日 +0.68pp,扣來回成本 0.44% 只剩 +0.24pp)→ 前端只當**背景資訊**,
      ⛔ 不下進場指令、不計分。

⛔ **PB 位階實測不成立,刻意不採**:最低 10% 前半 +0.32 / 後半 **−2.32** 方向相反。
   ⚠️ 別因為「PE 成立就順便把 PB 一起做」—— 那正是本專案一再犯的錯。

📦 只存**摘要**(當下 PE + 位階 + 分布),⛔ 不存 11 年逐日(2,700 檔會爆體積)。
   ⭐ 冪等:每次重跑都重算當下位階,⛔ 不累積、不需要「先還原舊檔」。

⛔ 安全:只記「第幾把 token」,絕不印金鑰值。
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

API = 'https://api.finmindtrade.com/api/v4/data'
DATA = Path(os.getenv('DATA_DIR', 'data'))
OUT = DATA / 'pe_band.json'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
LIMIT = int(os.getenv('LIMIT', '99999'))
MAX_MIN = int(os.getenv('MAX_MIN', '180'))
SLEEP = float(os.getenv('SLEEP', '0.08'))
WIN = 750           # 位階看「近 3 年」—— 跟探針驗證時用的窗口**必須一致**
MIN_N = 200         # 這檔至少要有幾天 PE 才算得出位階(⛔ 不足就不給,別硬判)
MIN_OK = 300        # 🚧 自我保護:成功不足這個數就不覆寫舊檔(同 fund_sweep 的做法)

_ti = 0
REASON = Counter()


def fm(dataset, data_id, start):
    global _ti
    last = 'no-token'
    for k in range(max(1, len(TOKENS))):
        i = (_ti + k) % max(1, len(TOKENS))
        q = {'dataset': dataset, 'data_id': data_id, 'start_date': start}
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=45) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            last = f'http{e.code}'
            REASON[last] += 1
            continue        # ⭐ V72.5.3:403/400 要換 token 再試,⛔ 不可當成「沒資料」
        except Exception as e:
            last = type(e).__name__
            REASON['net'] += 1
            continue
        rows = (j or {}).get('data') or []
        if rows:
            _ti = (i + 1) % max(1, len(TOKENS))
            return rows, None
        REASON['empty'] += 1
        last = 'empty'
    return None, last


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS')
        return 1
    syms = sorted(p.stem for p in DATA.glob('*.json')
                  if p.stem.isdigit() and len(p.stem) == 4)
    if not syms:
        print('❌ data/ 裡沒有個股 JSON → 中止(⛔ 不可產出空檔)')
        return 1
    # 只要近 3 年就夠算位階(⛔ 不抓 11 年 —— 那會讓每次呼叫的回應大 3 倍卻用不到)
    start = time.strftime('%Y-%m-%d', time.gmtime(time.time() - 3.2 * 365 * 86400))
    print(f'📐 PE 自身位階採礦 ・{len(syms)} 檔 ・token {len(TOKENS)} 把 ・start={start}')

    out, t0, done, ok, thin = {}, time.time(), 0, 0, 0
    for sym in syms:
        if done >= LIMIT or (time.time() - t0) / 60 > MAX_MIN:
            print(f'⏹️ 到達上限,本輪處理 {done} 檔')
            break
        done += 1
        rows, err = fm('TaiwanStockPER', sym, start)
        time.sleep(SLEEP)
        if not rows:
            continue
        rows.sort(key=lambda x: str(x.get('date') or ''))
        vals = [(str(r.get('date') or '')[:10], r.get('PER')) for r in rows]
        pes = [v for _, v in vals if isinstance(v, (int, float)) and v > 0]
        if len(pes) < MIN_N:
            thin += 1
            continue
        w = pes[-WIN:]
        cur_d, cur = next(((d, v) for d, v in reversed(vals)
                           if isinstance(v, (int, float)) and v > 0), (None, None))
        if cur is None:
            continue
        pct = round(sum(1 for x in w if x <= cur) / len(w) * 100, 1)
        q = statistics.quantiles(w, n=20)
        out[sym] = {
            'pe': round(float(cur), 2),
            'pct': pct,                                   # 現在的 PE 在近 3 年的百分位
            'lo': round(min(w), 2), 'hi': round(max(w), 2),
            'p25': round(statistics.quantiles(w, n=4)[0], 2),
            'med': round(statistics.median(w), 2),
            'p75': round(statistics.quantiles(w, n=4)[2], 2),
            'p5': round(q[0], 2), 'p95': round(q[18], 2),
            'n': len(w), 'd': cur_d,
        }
        ok += 1
        if done % 300 == 0:
            print(f'   … {done}/{len(syms)} ・{(time.time()-t0)/60:.0f} 分 ・成功 {ok} ・歷史太短 {thin}')

    print(f'\n📊 處理 {done} 檔 ・✅ 成功 {ok} ・⏭️ 歷史太短 {thin} ・{(time.time()-t0)/60:.0f} 分')
    if REASON:
        print('   失敗分類:' + ' ・'.join(f'{k}×{v}' for k, v in REASON.most_common(6)))

    # 🚧 空過守門:成功太少就**不覆寫**舊檔(⛔ 寧可留舊的,也不要產出殘缺清單)
    if ok < MIN_OK:
        print(f'❌ 只成功 {ok} 檔(<{MIN_OK})→ ⛔ 不覆寫舊檔,這一輪視為無效')
        return 1

    cover = Counter(k[0] for k in out)
    payload = {
        'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'n': ok, 'win': WIN, 'cover': dict(sorted(cover.items())),
        # ⭐ 實測成績一起寫進去,前端顯示時直接引用(⛔ 別在前端另外寫死一份)
        'edge': {'lo10': 0.68, 'lo25': 0.63, 'mid': -0.31, 'hi25': -0.43, 'hi10': -0.49,
                 'horizon': 60, 'cost': 0.44, 'files': 300, 'years': 11,
                 'note': 'PB 位階實測不成立(前後半段方向相反),刻意不採'},
        'data': out,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'✅ 寫出 {OUT}({OUT.stat().st_size/1024:.0f} KB)・涵蓋 {dict(sorted(cover.items()))}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
