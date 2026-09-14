#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🏅 V76.2.8 券商排行榜(12 項)採礦端守門 —— ⛔ 走**正式入口** `miner.build_broker_perf()`,
   ⛔ 不在測試裡複製一份等價邏輯(陷阱 #40 第六例的教訓:量到的會是那份複製品,不是產品)。

釘住四件事:
  ⓐ `rank()` 是「三種排序各取前 30 的聯集」—— ⛔ 舊版只回勝率前 30,
     前端再從那 30 家裡挑「報酬王」→ 挑到的**不是真正的第一名**(截斷偏誤)。
  ⓑ `base` 對照組 = 把**所有**分點 pooled 起來(CLAUDE.md 顯示勝率鐵則第 2 條:基準不是 50%)。
  ⓒ 當沖報酬用「買均價 vs 賣均價」—— ⛔ 不可用買賣混在一起的 `pv/vol`(差價會被自己抵消掉)。
  ⓓ 當沖榜⛔ 不可從 `periods` 的 top-15 撈:純當沖分點淨額≈0,兩張榜都進不去。

跑法:python3 scripts/test_broker_league.py   (⛔ 不打網路、⛔ 不動 repo 的 data/)
"""
import json
import re
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FAIL = []


def ck(cond, msg):
    print(("✅ " if cond else "❌ ") + msg)
    if not cond:
        FAIL.append(msg)


def _mk_data(base: Path):
    """合成一組「整組都是真實形狀」的測資(陷阱 #40:測資格式要跟正式產物一樣)。"""
    (base / 'chips').mkdir(parents=True, exist_ok=True)
    # 一檔股票 30 個交易日,收盤 100 → 130(單調上漲 → 對照組勝率本來就很高,正是要證明的事)
    dates = [f'2026-07-{d:02d}' for d in range(1, 31)]
    arr = [{'date': dates[i], 'close': 100 + i, 'volume': 1000} for i in range(30)]
    (base / '1111.json').write_text(json.dumps(arr), encoding='utf-8')
    chips = {
        'data_date': dates[0],
        'periods': {
            '1d': {'buy': [
                # 甲:買在 100(之後一路漲)→ 三個天期都賺
                {'broker_name': '甲券商', 'net': 500, 'buy': 500, 'sel': 0, 'avg': 100.0},
                {'broker_name': '乙券商', 'net': 400, 'buy': 400, 'sel': 0, 'avg': 100.0},
            ], 'sell': [], 'days': 1, 'want': 1},
            '5d': {'buy': [], 'sell': [], 'days': 5, 'want': 5},
            '10d': {'buy': [], 'sell': [], 'days': 10, 'want': 10},
        },
    }
    (base / 'chips' / '1111.json').write_text(json.dumps(chips), encoding='utf-8')


def main():
    import miner

    with tempfile.TemporaryDirectory() as td:
        base = Path(td) / 'data'
        base.mkdir(parents=True)
        _mk_data(base)

        old_dir = miner.DATA_DIR
        miner.DATA_DIR = str(base)

        # ── 累積訊號 ───────────────────────────────────────────────
        #   ⚠️ 日期⛔ 不可用 chips 的 data_date —— build_broker_perf 會把那天的舊訊號整批換掉。
        #   ⭐ 這組測資是**刻意**設計來讓「只取勝率前 30」死掉的:
        #      40 家 W?? 勝率 100% 但只賺 +1%;BIG 勝率只有 50% 卻賺 +8.2%(全場最高);
        #      BUSY 勝率 90%、出手 60 次(全場最多)。舊寫法的 top-30 會被 40 家 W?? 塞滿
        #      → BIG 與 BUSY **兩個都被截掉**,前端再怎麼排也挑不到真正的報酬王/交易狂。
        SIG_D = '2026-07-05'          # series[4]=104 → 隔天 series[5]=105
        hist = []

        def sig(b, price, n):
            for _ in range(n):
                hist.append({'d': SIG_D, 'b': b, 's': '1111', 'p': price})

        for i in range(40):
            sig(f'W{i:02d}', 104.0, 12)          # +0.96%,12 戰全勝
        sig('BIG', 73.0, 6)                      # +43.8%
        sig('BIG', 145.0, 6)                     # −27.6% → 勝率 50%、平均 +8.1%
        sig('BUSY', 104.0, 54)                   # 全勝
        sig('BUSY', 145.0, 6)                    # 6 敗 → 勝率 90%、出手 60 次(全場最多)
        (base / 'broker_signals.json').write_text(json.dumps(hist), encoding='utf-8')

        # ── 當沖:⭐ 走**正式入口** `_dt_collect()`(⛔ 不可直接塞 _DT_ACC ——
        #    那會繞過「買均價 vs 賣均價」那段公式,注入驗證就叫不出來,V76.2.8 第一版踩過)──
        miner._DT_ACC.clear()

        def slot(**kw):
            """一列 = 分點採礦迴圈累加完的樣子(欄名跟 miner 內部完全一致)。"""
            out = {}
            for nm, (bq, ba, sq, sa) in kw.items():
                out[nm] = {'broker_name': nm, 'buy': bq, 'sel': sq, 'net': bq - sq,
                           'pv': ba * bq + sa * sq, 'vol': bq + sq,
                           'bpv': ba * bq, 'bvol': bq, 'spv': sa * sq, 'svol': sq}
            return out

        # 丁:買 100 賣 105 → +5% ・戊:買 100 賣 98 → −2% ・己:只有 4 天樣本
        for _d in [f'2026-07-{d:02d}' for d in range(10, 22)]:
            miner._dt_collect(_d, slot(丁券商=(75_000, 100.0, 75_000, 105.0),
                                       戊券商=(170_000, 100.0, 170_000, 98.0)))
        for _d in [f'2026-07-{d:02d}' for d in range(10, 14)]:
            miner._dt_collect(_d, slot(己券商=(25, 100.0, 25, 109.0)))
        # ⛔ 只買不賣 / 只賣不買 的⛔ 不算當沖
        miner._dt_collect('2026-07-10', slot(庚券商=(90_000, 100.0, 0, 0.0)))
        # 辛:買 100 萬股、只賣 1,000 股 → 當沖量是**小的那邊**(1,000),⛔ 不是 100 萬
        for _d in [f'2026-07-{d:02d}' for d in range(10, 22)]:
            miner._dt_collect(_d, slot(辛券商=(1_000_000, 100.0, 1_000, 103.0)))

        try:
            miner.build_broker_perf()
            p = json.loads((base / 'broker_perf.json').read_text(encoding='utf-8'))
        finally:
            miner.DATA_DIR = old_dir

    # ── ⓐ rank() 聯集:報酬最高的那家必須真的在榜上 ──────────────────
    print('\n── ⓐ rank() 三種排序的聯集(⛔ 不是只有勝率前 30)──')
    dayrows = p.get('daytrade') or []
    names = [r['broker'] for r in dayrows]
    ck(len(dayrows) >= 30, f'ⓐ1 隔日沖榜有 {len(dayrows)} 家(測資 42 家,截斷才會發生)')
    ck('BIG' in names,
       'ⓐ2 ⭐ 報酬最高但勝率只有 50% 的 BIG 必須在榜上 —— ⛔ 只取「勝率前 30」會被 40 家全勝的塞滿而漏掉它')
    ck('BUSY' in names,
       'ⓐ3 ⭐ 出手最多的 BUSY 也必須在榜上(同上,它勝率 90% 排在 40 家全勝的後面)')
    if dayrows:
        top_ret = max(dayrows, key=lambda r: r['avg_ret'])
        top_cnt = max(dayrows, key=lambda r: r['count'])
        ck(top_ret['broker'] == 'BIG', f"ⓐ4 報酬王 = BIG(實得 {top_ret['broker']} {top_ret['avg_ret']}%)")
        ck(top_cnt['broker'] == 'BUSY', f"ⓐ5 交易狂 = BUSY(實得 {top_cnt['broker']} {top_cnt['count']} 次)")

    # ── ⓑ base 對照組 ───────────────────────────────────────────
    print('\n── ⓑ 對照組 base(⛔ 基準不是 50%)──')
    base_obj = (p.get('base') or {}).get('daytrade')
    ck(isinstance(base_obj, dict) and base_obj, 'ⓑ1 base.daytrade 有值')
    if isinstance(base_obj, dict) and base_obj:
        tot = sum(r['count'] for r in dayrows)
        ck(base_obj['count'] >= tot,
           f"ⓑ2 ⭐ 基準是全部分點 pooled({base_obj['count']} 筆 ≥ 榜上合計 {tot}) —— ⛔ 不是榜上那幾家的平均")
        ck(abs(base_obj['win_rate'] - 50.0) > 1e-9,
           f"ⓑ3 這份單調上漲的測資下,基準勝率 {base_obj['win_rate']}% ⛔ 本來就不是 50%")

    # ── ⓒ/ⓓ 當沖榜 ──────────────────────────────────────────────
    print('\n── ⓒ 當沖(同日雙向成交)──')
    dt = p.get('dt') or []
    dtn = [r['broker'] for r in dt]
    ck(bool(dt), 'ⓒ1 當沖榜有資料')
    ck('丁券商' in dtn and '戊券商' in dtn, 'ⓒ2 樣本足的兩家都在')
    ck('己券商' not in dtn, 'ⓒ3 ⭐ 樣本不足 10 次的「己券商」⛔ 不可進榜(它報酬最高,最容易被當成冠軍)')
    d = next((r for r in dt if r['broker'] == '丁券商'), None)
    if d:
        ck(abs(d['avg_ret'] - 5.0) < 0.01,
           f"ⓒ4 ⭐ 當沖報酬 =(賣均價−買均價)/買均價,丁 = +5%(實得 {d['avg_ret']}%)—— "
           "⛔ 用買賣混在一起的 pv/vol 算會恆為 0")
        ck(d.get('q') == 75_000 * 12, f"ⓒ5 交易狂那一欄用「當沖股數」(實得 {d.get('q')})")
    e = next((r for r in dt if r['broker'] == '戊券商'), None)
    ck(bool(e) and e['avg_ret'] < 0, 'ⓒ6 賠錢的那家要顯示負報酬(⛔ 不可只收賺錢的)')
    ck(bool(e) and e.get('q', 0) > (d or {}).get('q', 0),
       'ⓒ7 ⭐ 「交易狂」(量最大)跟「報酬王」不是同一家 —— 三張榜要真的分得開')
    ck('庚券商' not in dtn, 'ⓒ9 ⛔ 只買不賣的⛔ 不算當沖(min(買,賣)=0)')
    x = next((r for r in dt if r['broker'] == '辛券商'), None)
    ck(bool(x) and x.get('q') == 1_000 * 12,
       f"ⓒ10 ⭐ 當沖量 = min(買,賣) —— 辛券商買 100 萬股但只賣 1,000 股,當沖量是 12,000 股"
       f"(實得 {x.get('q') if x else None});⛔ 用 max 會把它灌成 1,200 萬、直接霸榜交易狂")
    ck((p.get('base') or {}).get('dt') is not None, 'ⓒ8 當沖也要有自己的對照組')

    # ── ⓔ 🚨 上游截斷:`_fetch_chips_bulk` 的 top_per_day ──────────────
    src = (ROOT / 'miner.py').read_text(encoding='utf-8')
    print('\n── ⓔ 🚨 上游 `_fetch_chips_bulk` 的截斷(V76.3.1:0 家/0 日的真因就在這)──')
    #   ⭐ 走**正式入口**:直接呼叫 `_ingest`(它是 `_fetch_chips_bulk` 內的巢狀函式,
    #      沒辦法單獨 import)→ 改用「跑一次 `_fetch_chips_bulk`、把網路層 stub 掉」太重
    #      → 這裡釘**原始碼的判準**,並用一組合成資料驗那段挑選邏輯本身。
    ck('def _dt_q(' in src, 'ⓔ1 有 `_dt_q`(同日雙向成交量 = min(買,賣))')
    seg2 = src[src.index('for sid, rs in bucket.items():'):]
    seg2 = seg2[:seg2.index('idx.setdefault')]
    # 🚨 斷言前**先剝掉 `#` 註解** —— 否則會被「我自己寫的註解裡提到 `_dt_q`」救活 = 假綠燈。
    #   (實測:注入「退回只按淨額」之後 ⓔ2 照樣綠,因為註解裡還留著那三個字。
    #    CLAUDE.md 已記過同型兩次:V75.1.0 的搜尋範圍、V76.1.7 的原始碼斷言。)
    seg2 = re.sub(r'#[^\n]*', '', seg2)
    ck('_net_abs' in seg2 and '_dt_q' in seg2,
       'ⓔ2 ⭐⭐ 截斷要**兩種排序的聯集** —— ⛔ 只按淨額取前 N,純當沖分點(買1000賣1000、淨額≈0)'
       '會在資料進 `by_date` **之前**就被砍掉(實跑 #573:「當沖 0 家/0 日」)')
    ck('dt_per_day' in src.split('def _fetch_chips_bulk')[1][:200],
       'ⓔ3 `dt_per_day` 是參數(⛔ 不寫死,日後要調得動)')
    # 合成一組:25 家淨額大但完全沒當沖 + 1 家純當沖(淨額 0、雙向量最大)
    rows_syn = [{'stock_id': '1111', 'buy': 100000 - i * 10, 'sell': 0, 'price': 10.0} for i in range(25)]
    rows_syn.append({'stock_id': '1111', 'buy': 500000, 'sell': 500000, 'price': 10.0})   # 🎯 純當沖
    def _na(x): return abs(int(x.get('buy', 0)) - int(x.get('sell', 0)))
    def _dq(x): return min(int(x.get('buy', 0)), int(x.get('sell', 0)))
    old_keep = sorted(rows_syn, key=_na, reverse=True)[:25]
    ck(not any(_dq(r) > 0 for r in old_keep),
       'ⓔ4 🚧 決定性對照:**舊寫法(只按淨額前 25)真的會把那家純當沖分點砍掉** —— 沒有這條就證明不了修法有效')

    print('\n── ⓓ 當沖⛔ 不可從 periods 的 top-15 撈 ──')
    ck('_dt_collect(sorted(by_date.keys())[-1], by_date[' in src,
       'ⓓ1 ⭐ 當沖是從當日原始 `by_date` 算的 —— ⛔ 純當沖分點淨額≈0,periods 的 top-15 兩張榜都進不去')
    ck("e['bpv']" in src and "e['spv']" in src,
       'ⓓ2 買/賣各自的均價分子分母都有累加(bpv/spv)')
    ck("_e.get('bpv')" in src and "_e.get('spv')" in src and "_e.get('pv')" not in src.split('def _dt_collect')[1].split('\ndef ')[0],
       'ⓓ3 ⭐ `_dt_collect` 只讀 bpv/spv —— ⛔ 一碰到買賣混在一起的 `pv` 就等於把差價自己抵消掉')

    print()
    if FAIL:
        print(f"❌ {len(FAIL)} 條失敗:" + ' ・ '.join(FAIL))
        sys.exit(1)
    print('✅ BROKER_LEAGUE_PASS(全部通過)')


if __name__ == '__main__':
    main()
