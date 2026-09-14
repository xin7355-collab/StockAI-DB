#!/usr/bin/env python3
"""🔁 當沖榜(同日雙向成交)守門 —— V76.3.6。

【為什麼要有這支】
`broker_dt.json` 從 V76.2.8 上線到 V76.3.5 **一筆都沒產出過**,而 workflow 全綠、
job log 只寫「0 家/0 日」看不出原因。實跑 #574 的 log 逐字:
  「🚀 分點全市場批次完成:2758 檔 × **API 新抓 0 天** + 分支還原 15 天」
  「🔁 當沖(同日雙向成交):**0 家/0 日**」
真因:`by_date` 的每一天都是「還原」來的,而**兩種還原格式都只存淨額**
(`chips_deep` 的 compact 甚至 `if not net: continue`,純當沖分點淨額≈0 直接被丟掉)
→ 還原時偽造 `buy = net if net>0 else 0` → **買賣必有一邊是 0**
→ `min(buy,sel)` 恆為 0 → 每一列都被 continue。而穩態下 API 永遠不再抓
(have + 分支還原就湊滿 22 天)→ **這個榜在舊格式下永遠不可能有資料**。

⭐ 這支釘的是**用意**:
  ⓐ 只有淨額的天 ⛔ 不可以被當成當沖(那是偽造出來的單邊量)
  ⓑ 帶 `dt` 那一小塊的天 → 收得到(還原也算數)
  ⓒ 髒資料守門(單日 ±12% 以外)還在
  ⓓ 寫入端要把 `dt` 存進 hist 快照,而且 Sniper 覆寫那條路 ⛔ 不可以把它弄丟
  ⓔ 「更完整才覆蓋」:一輪只跑 70 檔 ⛔ 不可以蓋掉上一輪跑 2,700 檔的同一天
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import miner  # noqa: E402

fail = []
ck = lambda ok, msg: None if ok else fail.append(msg)


def _src(fn_name):
    """取函式原始碼並**剝掉 `#` 註解** —— ⛔ 不剝的話斷言會被『我自己寫的註解』救活
    (本 repo 已經犯過三次:註解裡引用了要禁止的舊寫法)。"""
    s = Path(ROOT / 'miner.py').read_text(encoding='utf-8')
    m = re.search(r'\n(def |    )' + re.escape(fn_name) + r'\b', s)
    return s, re.sub(r'#[^\n]*', '', s)


ALL, ALL_NC = _src('_dt_collect')

# ── ⓐ 只有淨額的天:⛔ 不可以收到任何一筆 ──────────────────────────────
miner._DT_ACC = {}
slot_net_only = {
    '甲券商': {'broker_name': '甲券商', 'net': 500, 'buy': 500, 'sel': 0, 'pv': 50000.0, 'vol': 500},
    '乙券商': {'broker_name': '乙券商', 'net': -400, 'buy': 0, 'sel': 400, 'pv': 40000.0, 'vol': 400},
}
miner._dt_collect('2026-09-07', slot_net_only)
ck(not miner._DT_ACC, f'ⓐ 只有淨額的天竟然收到當沖資料 → 那是偽造出來的單邊量({miner._DT_ACC})')

# ── ⓑ 帶 dt 那一小塊(還原來的)→ 收得到 ─────────────────────────────
miner._DT_ACC = {}
slot_dt = {
    '丙券商': {'broker_name': '丙券商', 'net': 0, 'buy': 0, 'sel': 0, 'pv': 0.0, 'vol': 0,
               'dtq': 1000, 'bvol': 1000, 'bpv': 100.0 * 1000, 'svol': 1000, 'spv': 102.0 * 1000},
}
miner._dt_collect('2026-09-07', slot_dt)
got = (miner._DT_ACC.get('2026-09-07') or {}).get('丙券商')
ck(bool(got), 'ⓑ 帶 `dt` 還原資料的天收不到 → 還原路徑沒接上(這個榜就永遠是空的)')
if got:
    ck(got['n'] == 1 and got['w'] == 1 and got['q'] == 1000,
       f'ⓑ 收到的數字不對:{got}(應為 n=1 w=1 q=1000)')
    ck(abs(got['r'] - 2.0) < 1e-6, f'ⓑ 報酬算錯:{got["r"]}(100→102 應為 +2.0%)')

# ── ⓑ2 純當沖(淨額 0)也要收得到 —— ⛔ 這正是按淨額排序會整批砍掉的那一群 ──
ck(bool(got) and slot_dt['丙券商']['net'] == 0,
   'ⓑ2 測資的淨額不是 0 → 這條沒有在驗「純當沖分點」(那才是會被截掉的那一群)')

# ── ⓒ 髒資料守門(±12%)還在 ────────────────────────────────────────
miner._DT_ACC = {}
miner._dt_collect('2026-09-07', {'丁券商': {'broker_name': '丁券商', 'dtq': 100, 'buy': 100, 'sel': 100,
                                            'bvol': 100, 'bpv': 100.0 * 100,
                                            'svol': 100, 'spv': 150.0 * 100}})
ck(not miner._DT_ACC, 'ⓒ 單日 +50% 的髒資料被收進來了 → 物理上不可能,守門不見了')

# ── ⓓ 寫入端:hist 快照要帶 dt,而且 Sniper 覆寫不可以把它弄丟 ──────────
ck("_snap2['dt'] = _dt2" in ALL_NC,
   'ⓓ hist 每日快照沒有存 `dt` → 還原之後就沒有雙向資料,ⓑ 那條路等於沒有來源')
ck("_prev_dt" in ALL_NC and "_day_snaps[str(_dd)]['dt'] = _prev_dt" in ALL_NC,
   'ⓓ2 Sniper 覆寫最新那天時沒有把 `dt` 接回來 → 最有價值的那一天每輪都被洗掉')
ck("_h.get('dt')" in ALL_NC,
   'ⓓ3 hist 還原端沒有讀 `dt` → 存了也拿不回來')

# ── ⓓ4 ⛔ 不可以只收「最後一天」(穩態下最後一天一定是還原來的) ───────────
ck("sorted(by_date.keys())[-1]])" not in ALL_NC and "for _dtd in sorted(by_date.keys()):" in ALL_NC,
   'ⓓ4 `_dt_collect` 又退回「只收最後一天」→ 穩態下最後一天一定是還原來的 = 永遠收到空的')

# ── ⓔ 「更完整才覆蓋」 ────────────────────────────────────────────
ck("len(_rows_new) >= len(_by_d.get(_d)" in ALL_NC,
   'ⓔ 少了「更完整才覆蓋」→ 一輪只跑 70 檔就會蓋掉上一輪跑 2,700 檔的那一天')

# ── ⓕ 0 家的時候一定要說為什麼(陷阱 #22) ─────────────────────────────
ck('_dt_why' in ALL_NC and '本輪原始資料裡有雙向成交的天數' in ALL,
   'ⓕ 當沖榜 0 家時沒有印出原因 →「壞了」跟「原始資料本來就沒有」長得一模一樣')

# ── ⓖ 前端空狀態要講真話(⛔ 不可再寫「等下一輪採礦就有」) ───────────────
idx = (ROOT / 'index.html').read_text(encoding='utf-8')
ck('當沖榜要等下一輪盤後採礦才會出現' not in idx,
   'ⓖ 前端還寫著「等下一輪採礦就會出現」→ 已經等了很多輪,那句話是假的')
ck('從 ${\'V76.3.6\'} 才開始累積' in idx or '才開始累積' in idx,
   'ⓖ2 前端沒有說明「這個榜是從哪一版才開始一天一天長」')

if fail:
    print('❌ BROKER_DT_FAIL')
    for f in fail:
        print('   ・' + f)
    sys.exit(1)
print('✅ BROKER_DT_PASS(全部通過)')
