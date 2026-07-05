#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌙 fund_sweep.py — 全市場基本面「滾動夜間補齊」(V49.2)

痛點:FinMind 免費版「不帶 data_id 的全市場 bulk」抓營收/財報 = 回 0 筆,
      所以 daily_miner 只逐檔補了 HOT_CHIPS_LIMIT=100 檔的 YoY/毛利,
      其餘 ~1900 檔冷門/中型股(如帆宣 6196)前端一直顯「採礦更新中」。

解法(使用者採用):晚上另跑一支只抓基本面的輕量採礦,逐檔(免費可跑)+ 節流,
      「滾動式」每晚挑最舊/沒抓過的 N 檔補,約 4-5 個交易夜就把全市場輪一遍,
      之後永遠優先刷最舊的 → 全市場都維持在 ~5 天內新鮮。

為何不影響白天:採礦機用的是 GitHub Secrets 的 FINMIND_TOKENS + GitHub IP,
      跟你手機前端 localStorage 的 FinMind key 是「不同 token、不同 IP」,
      兩者額度完全分開 → 夜間燒採礦 token 不會吃到你白天手機查的次數。

連動安全(關鍵):輸出寫進「獨立檔」data/fund_yoy_gm.json,不動 daily_miner
      重建的 fundamentals_cache.json;daily_miner 的 deploy 用 `git archive origin/data`
      鋪底層會自動保留這個獨立檔 → 不會被下午的完整採礦洗掉。前端 X 光機把它當
      YoY/毛利的 fallback 來源讀。

環境變數:
  FUND_NIGHTLY_BUDGET  每晚最多補幾檔(預設 1500,約 1-2 晚輪完全市場;token 不足會自動降級只補到能補的)
  FUND_SLEEP           每檔之間 sleep 秒數,節流防 429(預設 3.0)
  FUND_MIN_HITS        本次至少成功幾檔才算數、才讓 workflow 部署(預設 20)
  FINMIND_TOKENS       (沿用 miner.py)逗號分隔多組 token,fm_request 自動輪動
"""
import os
import sys
import json
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

# 復用 miner.py 的逐檔基本面抓取 + token 輪動(import 只觸發 module 級常數/session,不跑 __main__)
import miner

DATA_DIR = Path('data')
FC_PATH = DATA_DIR / 'fundamentals_cache.json'      # daily_miner 產的全市場 PE/殖利率(當「宇宙」用)
OUT_PATH = DATA_DIR / 'fund_yoy_gm.json'            # 🌙 本腳本專屬輸出(獨立檔,daily deploy 會保留)

BUDGET = int(os.getenv('FUND_NIGHTLY_BUDGET', '1500'))
SLEEP = float(os.getenv('FUND_SLEEP', '3.0'))
MIN_HITS = int(os.getenv('FUND_MIN_HITS', '20'))

# 🚀 平行分片(matrix):SHARD_TOTAL 個 shard 各綁「一組專屬 token」同時開工,額度分開不互撞。
#    SHARD_TOTAL=1(預設)= 舊的單一 job 行為,完全向下相容。
SHARD_INDEX = int(os.getenv('SHARD_INDEX', '0'))
SHARD_TOTAL = int(os.getenv('SHARD_TOTAL', '1'))
SHARD_OUT = DATA_DIR / f'fund_yoy_gm.shard{SHARD_INDEX}.json'   # 分片模式的 partial 輸出(給 merge job 合併)

# 分片模式:把本 shard 的 FinMind token 池「釘死」成專屬那一組 → 各 shard 額度獨立,不會共用一批 token 一起撞 429
if SHARD_TOTAL > 1 and miner.FINMIND_TOKENS:
    _pin = miner.FINMIND_TOKENS[SHARD_INDEX % len(miner.FINMIND_TOKENS)]
    miner.FINMIND_TOKENS = [_pin]
    miner.FINMIND_TOKEN = _pin
    miner._finmind_token_idx = 0
    print(f"🔑 shard {SHARD_INDEX}/{SHARD_TOTAL} 綁定專屬 FinMind token #{(SHARD_INDEX % 4) + 1}(額度獨立)")


def _in_my_shard(sym: str) -> bool:
    """按股號穩定分工:SHARD_TOTAL=1 時全收;否則 int(股號) % SHARD_TOTAL 命中本 shard 才收。"""
    if SHARD_TOTAL <= 1:
        return True
    try:
        n = int(sym)
    except Exception:
        n = sum(ord(c) for c in str(sym))
    return (n % SHARD_TOTAL) == SHARD_INDEX


TPE = timezone(timedelta(hours=8))


def _now_iso() -> str:
    return datetime.now(TPE).strftime('%Y-%m-%d %H:%M')


def _latest_gm_num(trend_str: str):
    """從 '40.1%→42.3% (↑2.2pp)' 這種趨勢字串取最後一個數字當最新毛利率(%)。"""
    if not trend_str:
        return None
    import re
    nums = re.findall(r'(-?\d+(?:\.\d+)?)%', str(trend_str))
    if nums:
        try:
            return round(float(nums[-1]), 1)
        except Exception:
            return None
    return None


def load_universe() -> list:
    """從 fundamentals_cache.json 的 key 當全市場宇宙(daily_miner 已用 TWSE bulk 補了全市場 PE)。"""
    if not FC_PATH.exists():
        print(f"❌ 找不到 {FC_PATH},無法決定全市場宇宙 — 先讓 daily_miner 跑一次")
        return []
    try:
        fc = json.loads(FC_PATH.read_text(encoding='utf-8'))
    except Exception as e:
        print(f"❌ 讀 {FC_PATH} 失敗:{e}")
        return []
    uni = []
    for k in fc.keys():
        if str(k).startswith('__'):
            continue
        if miner._valid_stock(str(k)):
            uni.append(str(k))
    return sorted(set(uni))


def load_existing() -> dict:
    if OUT_PATH.exists():
        try:
            d = json.loads(OUT_PATH.read_text(encoding='utf-8'))
            if isinstance(d, dict):
                return d
        except Exception as e:
            print(f"⚠️ 讀舊 {OUT_PATH} 失敗(當空的重建):{e}")
    return {}


def pick_targets(universe: list, existing: dict) -> list:
    """滾動挑選:先濾出本 shard 負責的股(分片模式),再沒抓過優先、照 ts 由舊到新,取前 BUDGET 檔。"""
    mine = [s for s in universe if _in_my_shard(s)]
    def sort_key(sym):
        e = existing.get(sym)
        ts = (e or {}).get('ts') if isinstance(e, dict) else None
        # 沒抓過 → 空字串排最前;有抓過 → 照 ts 字串(舊的在前)
        return (ts is not None, ts or '')
    return sorted(mine, key=sort_key)[:BUDGET]


def main():
    universe = load_universe()
    if not universe:
        print("⏭️ 宇宙為空,結束(不部署)")
        # 不寫檔 → workflow 用檔案 mtime/內容判斷是否部署
        return 0
    existing = load_existing()
    targets = pick_targets(universe, existing)
    never = sum(1 for s in universe if s not in existing)
    print(f"🌙 全市場 {len(universe)} 檔 | 從未補 {never} 檔 | 本晚預算 {BUDGET} → 實抓 {len(targets)} 檔 | 節流 {SLEEP}s/檔")

    hits = 0
    t_start = time.time()
    for i, sym in enumerate(targets, 1):
        try:
            fund = miner.fetch_finmind_fundamentals(sym) or {}
        except Exception as e:
            print(f"  ⚠️ {sym} 抓取例外:{e}")
            fund = {}
        yoy = fund.get('revenue_yoy')
        gmt = fund.get('gross_margin_trend') or ''
        gm = _latest_gm_num(gmt)
        rec = bool(fund.get('is_record_high'))
        tri = sum(1 for k in ('gross_margin_trend', 'op_margin_trend', 'net_margin_trend')
                  if '↑' in (fund.get(k) or ''))
        # 至少要有 YoY 或 毛利趨勢才算有效補到(避免存一堆空殼)
        if yoy is not None or gmt:
            entry = {'ts': _now_iso()}
            if yoy is not None:
                try:
                    entry['yoy'] = round(float(yoy), 1)
                except Exception:
                    pass
            if gmt:
                entry['gmt'] = gmt
            if gm is not None:
                entry['gm'] = gm
            if rec:
                entry['rec'] = True
            if tri:
                entry['tri'] = tri
            existing[sym] = entry
            hits += 1
        else:
            # 沒抓到也記個 ts,避免下一晚又優先重抓同一批死檔(下次自然排到後面)
            prev = existing.get(sym) if isinstance(existing.get(sym), dict) else {}
            prev = dict(prev)
            prev['ts'] = _now_iso()
            existing[sym] = prev
        if i % 25 == 0:
            el = int(time.time() - t_start)
            print(f"  … {i}/{len(targets)} 檔 | 命中 {hits} | 已跑 {el}s")
        time.sleep(SLEEP)

    # 🚀 分片模式:只輸出「本 shard 處理過的股」的 partial 檔給 merge job 合併,不自己 gate/部署。
    #    (即使命中少也照寫 partial;merge job 統一 gate 總命中數,漏抓的股保留舊 partition)
    if SHARD_TOTAL > 1:
        part = {s: existing[s] for s in targets if s in existing}
        part['__shard'] = {
            'index': SHARD_INDEX, 'total': SHARD_TOTAL,
            'processed': len(targets), 'hits': hits, 'generated': _now_iso(),
        }
        DATA_DIR.mkdir(exist_ok=True)
        SHARD_OUT.write_text(json.dumps(part, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f"✅ shard {SHARD_INDEX} 寫入 {SHARD_OUT}:處理 {len(targets)} 檔 / 命中 {hits} 檔(交給 merge 合併)")
        return 0

    # 單一 job 模式(SHARD_TOTAL=1):維持原本自己 gate + 寫全檔的行為
    if hits < MIN_HITS:
        print(f"❌ 本次僅命中 {hits} 檔(< 門檻 {MIN_HITS}),疑似 token 全被限流/斷網 → 不覆寫、不部署,保留舊檔")
        return 2   # workflow 判 exit code:非 0 → 不部署

    covered = sum(1 for k, v in existing.items()
                  if not str(k).startswith('__') and isinstance(v, dict) and ('yoy' in v or 'gmt' in v))
    existing['__status'] = {
        'generated': _now_iso(),
        'universe': len(universe),
        'covered': covered,
        'this_run_hits': hits,
        'budget': BUDGET,
        'source': 'fund_sweep_nightly',
    }
    DATA_DIR.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(existing, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"✅ 寫入 {OUT_PATH}:本晚命中 {hits} 檔,全市場已覆蓋 {covered}/{len(universe)} 檔 YoY/毛利")
    return 0


def merge_mode():
    """🔀 merge job:把老 fund_yoy_gm.json + 各 shard partial 疊起來 → 寫全檔。
       疊法:老檔打底,每個 shard 的 partition entries 覆蓋上去(partition 互斥,無衝突)。
       gate:所有 shard 本晚總命中 < MIN_HITS → 不覆寫、不部署(回 2),保留線上舊檔。"""
    merged = load_existing()               # 老的全市場檔(workflow 已從 origin/data 還原)
    base_keys = sum(1 for k in merged if not str(k).startswith('__'))
    total_hits = 0
    shards_seen = 0
    for i in range(SHARD_TOTAL if SHARD_TOTAL > 1 else 4):
        p = DATA_DIR / f'fund_yoy_gm.shard{i}.json'
        if not p.exists():
            print(f"⚠️ 缺 shard{i} partial({p}),跳過(該 partition 保留舊資料)")
            continue
        try:
            d = json.loads(p.read_text(encoding='utf-8'))
        except Exception as e:
            print(f"⚠️ shard{i} partial 壞掉,跳過:{e}")
            continue
        meta = d.pop('__shard', {}) if isinstance(d, dict) else {}
        total_hits += int(meta.get('hits', 0) or 0)
        shards_seen += 1
        for sym, entry in d.items():
            if str(sym).startswith('__'):
                continue
            merged[sym] = entry
        print(f"  ✅ 疊入 shard{i}:{len(d)} 檔 / 命中 {meta.get('hits', '?')}")

    if shards_seen == 0:
        print("❌ 完全沒有任何 shard partial → 不部署,保留舊檔")
        return 2
    if total_hits < MIN_HITS:
        print(f"❌ 全 shard 本晚總命中 {total_hits} 檔(< 門檻 {MIN_HITS}),疑似 token 全被限流 → 不覆寫、不部署")
        return 2

    universe = load_universe()
    covered = sum(1 for k, v in merged.items()
                  if not str(k).startswith('__') and isinstance(v, dict) and ('yoy' in v or 'gmt' in v))
    merged['__status'] = {
        'generated': _now_iso(),
        'universe': len(universe),
        'covered': covered,
        'this_run_hits': total_hits,
        'shards': shards_seen,
        'budget': BUDGET,
        'source': 'fund_sweep_nightly_parallel',
    }
    DATA_DIR.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(merged, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"✅ merge 完成:{shards_seen} shard 總命中 {total_hits} 檔 | 全市場覆蓋 {covered}/{len(universe)} 檔(老檔 {base_keys} → 新 {covered})")
    return 0


if __name__ == '__main__':
    if '--merge' in sys.argv:
        sys.exit(merge_mode())
    sys.exit(main())
