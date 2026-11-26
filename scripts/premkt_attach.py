#!/usr/bin/env python3
"""🧊 V82.7.0 macro_cron「🧊 凍結」那一步的入口:把 scripts/forecast_freeze.mjs 算好的 { d, at, out, radar }
塞進 data/macro_risk.json 裡「這一輪剛寫的那一筆」(邏輯在 macro_miner._premkt_attach,⛔ 另寫一份)。

為什麼不直接 `python macro_miner.py --attach`:這一步 ⛔ 需要任何金鑰,而 check_workflow_paths 的
「同一支腳本在每個 workflow 給的金鑰要一致」守門是看腳本名 —— 用另一個入口 = 明講「這一步不用金鑰」,
⛔ 為了過守門把用不到的金鑰也塞給這一步(多給一份金鑰 = 多一個外洩的地方)。
⛔ 跑採礦(只匯入 macro_miner 拿那一支函式);永遠 exit 0(凍結失敗 ⛔ 擋總經推送),只有參數錯 exit 2。

用法:python scripts/premkt_attach.py /tmp/freeze.json [data/macro_risk.json]
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main(argv):
    if not argv:
        print('用法:python scripts/premkt_attach.py /tmp/freeze.json [data/macro_risk.json]')
        return 2
    sys.path.insert(0, str(ROOT))
    try:
        import macro_miner
    except Exception as e:   # 載入失敗也 ⛔ 擋推送
        print(f'  🧊 ⚠️ 載入 macro_miner 失敗(不影響推送):{str(e)[:120]}')
        return 0
    _ok, msg = macro_miner._premkt_attach(argv[0], argv[1] if len(argv) > 1 else None)
    print('  🧊 ' + msg)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
