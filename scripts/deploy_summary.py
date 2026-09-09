#!/usr/bin/env python3
"""📋 部署結果摘要 —— 寫進 GitHub Actions 的 Summary 面板(不會被 log 上限截斷)

⚠️ 為什麼需要(2026-08-04 實測):
   GitHub 的 job log API **只回最後 5,000 行**,而部署 job 的 orphan commit
   會逐檔印 `create mode`(實測 **4,976 行、只涵蓋 3 秒**)——
   於是 `daily_signal_scan` / `market_stats` 那幾步印的東西**被永久擠出可讀視窗**。

   ⛔ 這讓 CLAUDE.md 的鐵則「『修完沒生效』時第一件事是看 workflow log 的實際輸出」形同失效
      —— V72.2.1 就是靠那句 log(「⏭️ TWSE 基本面回空,跳過產業 PE 聚合」)才找到真因的。

→ 這支把「這輪到底產出了什麼」寫進 `$GITHUB_STEP_SUMMARY`(Actions 頁面上方那塊),
  那裡不會被截斷,而且不用翻 log。

⛔ 純診斷:任何錯誤都吞掉、永遠 exit 0,**絕不可以因為它失敗而擋部署**。

跑法:python3 scripts/deploy_summary.py <STOCKS> <CHIPS> <DATE>
"""
import json
import os
import sys
from pathlib import Path

# 這幾個檔「該有哪些頂層 key」—— 少了就代表那一半靜默失敗了(同 data_audit 的 D2 類)
EXPECTED = {
    'market_stats.json': ('pb', 'margin'),
    'today_signals.json': ('bull', 'bull_total', 'bull_syms', 'scanned'),
    'breadth.json': (),
    'radar.json': (),
    'top_picks.json': (),
    'macro_risk.json': (),
}


def main() -> int:
    out = []
    stocks = sys.argv[1] if len(sys.argv) > 1 else '?'
    chips = sys.argv[2] if len(sys.argv) > 2 else '?'
    date = sys.argv[3] if len(sys.argv) > 3 else ''

    out.append(f'## 📡 部署結果 {date}')
    out.append('')
    out.append(f'K線 **{stocks}** 檔 ・分點 **{chips}** 檔')
    out.append('')
    out.append('| 檔案 | 大小 | 關鍵欄位(少了就是那半靜默失敗) |')
    out.append('|---|---|---|')

    for fn, keys in EXPECTED.items():
        p = Path('data') / fn
        if not p.exists() or p.stat().st_size == 0:
            out.append(f'| `{fn}` | ❌ 沒有或空的 | — |')
            continue
        size = f'{p.stat().st_size:,} B'
        try:
            j = json.loads(p.read_text(encoding='utf-8'))
        except Exception as e:
            out.append(f'| `{fn}` | {size} | ❌ 解析失敗:{str(e)[:60]} |')
            continue
        bits = []
        if isinstance(j, dict):
            for k in keys:
                v = j.get(k)
                good = v is not None and (not hasattr(v, '__len__') or len(v) > 0)
                extra = f'={v}' if isinstance(v, (int, float)) else ''
                bits.append(('✅' if good else '❌') + f' `{k}`{extra}')
            errs = [k for k in j if k.endswith('_error') and j[k]]
            if errs:
                bits.append(f'⚠️ error 欄位 {len(errs)} 個:{", ".join(errs[:5])}')
        out.append(f'| `{fn}` | {size} | {" ・".join(bits) or "—"} |')

    # 今日訊號榜:順便把「有沒有被截斷」講清楚(no silent caps)
    try:
        ts = json.loads((Path('data') / 'today_signals.json').read_text(encoding='utf-8'))
        tot, shown, syms = ts.get('bull_total'), len(ts.get('bull') or []), ts.get('bull_syms')
        out.append('')
        if tot is None:
            out.append('> ⚠️ `today_signals.json` 沒有 `bull_total`/`bull_syms` → 顯示端算不出總數,只能拿截斷後的長度充數')
        else:
            cut = f'(上限 {ts.get("bull_cap")},**有截斷**)' if tot > shown else '(沒有截斷)'
            out.append(f'> 🎯 今日訊號:**{syms} 檔 / {tot} 筆**,輸出 {shown} 筆 {cut}')
    except Exception:
        pass

    text = '\n'.join(out) + '\n'
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        try:
            with open(path, 'a', encoding='utf-8') as fh:
                fh.write(text)
        except Exception as e:            # pragma: no cover
            print(f'(寫 STEP_SUMMARY 失敗,不影響部署:{str(e)[:80]})')
    print(text)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:                # pragma: no cover
        # ⛔ 純診斷,任何錯都不可以擋部署
        print(f'(deploy_summary 失敗,已忽略:{str(e)[:120]})')
        raise SystemExit(0)
