#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏦 法人買賣超 / 融資券 歷史回補(V73.3.6)

🚨 為什麼要做:`data/{sym}.json` 的 `foreign_net` **只回溯到 2026/04**(約 60 個交易日),
   害 CLAUDE.md 裡至少 5 條功能長期卡在「樣本不足以回測」:
   券資比軋空・板塊偷布局・投量比・籌碼訊號勝率・「外資認錯回補」…

⭐ 但那**不是資料源的限制** —— `miner.py` 只把 FinMind 當「今天的備援」在用
   (`start_date=end_date=今天`,一次抓一天)。探針實測(2026-08-12):
     TaiwanStockInstitutionalInvestorsBuySell  data_id=2330 start=2015-01-01
       → ✅ 13,411 列 / **2,827 個交易日 / 2015-01-05 起** / 1.4 秒
     TaiwanStockMarginPurchaseShortSale        → ✅ 2015 起
   **一檔一次呼叫就拿到 11 年。**

📐 這支怎麼做:
   ・逐檔把「這一檔 K 線已經有的那些日子」的法人/融資券補齊(⛔ 不加新的日期列)
   ・⛔ **實跑寫入優先**:已經有非 0 值的日期**不覆蓋**,只補 0/缺的
   ・⛔ 冪等:再跑一次不會變壞;已補滿的直接跳過(可分批、可續跑)

💾 只寫 `data/*.json` → 由 workflow 推 **data 分支**。
   ⭐ 不用推 gh-pages:`miner.py::seed_db_from_json` 每天會把 JSON 讀回 SQLite
      (已確認它有帶 foreign_net/trust_net/dealer_net/margin_balance/short_balance),
      再 export 回 JSON 並部署 → 隔天自動出現在前端。
   ⛔ 這也避免跟 daily_miner 的 gh-pages force-push 打架。

⛔ 安全:只用 GitHub Secrets 的 FINMIND_TOKENS,只記「第幾把」,絕不印金鑰值。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://api.finmindtrade.com/api/v4/data'
DATA_DIR = Path(os.getenv('DATA_DIR', 'data'))
# ⚠️ ⛔ 不可用 `.strip()` —— 金鑰中間常夾一個空白(V73.2.7 實測 4 把有 3 把中招)
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
LIMIT = int(os.getenv('LIMIT') or '99999')   # V75.1.3 空字串守門
MAX_MIN = int(os.getenv('MAX_MIN') or '300')         # 時間預算(GitHub job 上限 6 小時)
SLEEP = float(os.getenv('SLEEP', '0.12'))
# ⭐ 補到「已經有 K 線的那些日子」即可 —— K 線本身只有 2~3 年,補更早也沒有價格可以配對
MIN_FILL_RATIO = float(os.getenv('MIN_FILL_RATIO', '0.80'))   # 已補到這個比例就跳過

# 🗄️ V79.3.6 deep 模式(MODE=deep):2012~2023-06 每檔法人 → 獨立分支 inst_deep(⛔ 不碰 data/*.json)
#   為什麼:data/*.json 的法人只有 2023-06 起(K 線就那麼長)→「外資連買」「外資突然大買」那幾條都沒驗過空頭。
#   使用者:「沒有資料,該回測就回測、該挖礦就挖礦」。
MODE = (os.getenv('MODE') or 'fill').strip()
DEEP_FROM = os.getenv('DEEP_FROM') or '2012-01-01'
DEEP_TO = os.getenv('DEEP_TO') or '2023-06-30'          # 跟 data/*.json 重疊一個月 → 對表用
DEEP_DIR = Path(os.getenv('DEEP_DIR') or 'inst_deep')
UNIVERSE = os.getenv('UNIVERSE') or ''                   # 檔案:一行一個代號
CHECK_MIN_DAYS = 200                                     # 對表至少要這麼多「兩邊都有、而且不是 0」的天
CHECK_MIN_RATE = 0.90

_tok_i = 0
STAT = {'ok': 0, 'skip': 0, 'nodata': 0, 'fail': 0, 'filled_inst': 0, 'filled_margin': 0}
REASON = {}


def _rec(k):
    REASON[k] = REASON.get(k, 0) + 1


def fm(dataset, data_id, start_date, timeout=45, end_date=None):
    """回 (rows, err)。每一把 token 都試過才放棄(V72.5.3:403/400 要換 token,⛔ 不可當成沒資料)。
    end_date 預設 None = 網址跟 V79.3.5 以前一字不差(fill 模式不受影響);deep 模式才帶。"""
    global _tok_i
    tries = max(1, len(TOKENS))
    last = 'no-token'
    for k in range(tries):
        i = (_tok_i + k) % max(1, len(TOKENS))
        q = {'dataset': dataset, 'data_id': data_id, 'start_date': start_date}
        if end_date:
            q['end_date'] = end_date
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=timeout) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode('utf-8', 'replace'))
                msg = str(body.get('msg') or '')[:80]
            except Exception:
                msg = ''
            last = f'http{e.code}:{msg}'
            _rec(f'http{e.code}')
            continue
        except Exception as e:
            last = f'{type(e).__name__}'
            _rec('net')
            continue
        if not isinstance(j, dict) or j.get('status') not in (200, None):
            last = f"status={j.get('status') if isinstance(j, dict) else '?'}"
            _rec('status')
            continue
        _tok_i = (i + 1) % max(1, len(TOKENS))      # 成功後也輪動,平均分散額度
        return (j.get('data') or []), None
    return None, last


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def agg_inst(rows):
    """FinMind 一檔一天回多列(每個法人身分一列)→ 聚合成 {date: {f,t,d}}(單位:股)。"""
    out = {}
    for r in rows:
        d = _d(r.get('date'))
        if not d:
            continue
        nm = str(r.get('name') or '')
        net = (float(r.get('buy') or 0) - float(r.get('sell') or 0))
        o = out.setdefault(d, {'f': 0.0, 't': 0.0, 'd': 0.0})
        # ⚠️ FinMind 的 name 是**英文列舉**(V41.28 踩過:舊版只比中文 → 全部歸 0)
        if nm in ('Foreign_Investor', 'Foreign_Dealer_Self'):
            o['f'] += net
        elif nm in ('Investment_Trust',):
            o['t'] += net
        elif nm in ('Dealer_self', 'Dealer_Hedging', 'Dealer'):
            o['d'] += net
    return out


def agg_margin(rows):
    """{date: {mb, sb}} —— 融資餘額 / 融券餘額(單位:張,FinMind 給的就是張)。"""
    out = {}
    for r in rows:
        d = _d(r.get('date'))
        if not d:
            continue
        out[d] = {
            'mb': float(r.get('MarginPurchaseTodayBalance') or 0),
            'sb': float(r.get('ShortSaleTodayBalance') or 0),
        }
    return out


def deep_pack(m):
    """agg_inst 的 {date:{f,t,d}}(股)→ 欄位式 {d:[日期], f:[], t:[], dl:[]}(整數股,⛔ 不換成張 —— 跟 data/*.json 同單位)。"""
    ds = sorted(m)
    return {'d': ds,
            'f': [int(round(m[x]['f'])) for x in ds],
            't': [int(round(m[x]['t'])) for x in ds],
            'dl': [int(round(m[x]['d'])) for x in ds]}


def deep_check(pack, rows):
    """跟 data/*.json 重疊那段對表(外資):回 (可比天數, 一致天數)。只比兩邊都不是 0 的天(0 可能是「當時沒抓到」)。"""
    have = {_d(r.get('date')): r.get('foreign_net') for r in (rows or []) if r.get('foreign_net')}
    n = hit = 0
    for d, f in zip(pack.get('d') or [], pack.get('f') or []):
        v = have.get(d)
        if not v or not f:
            continue
        n += 1
        hit += abs(v - f) <= max(1000, abs(v) * 0.01)     # 1 張或 1% 以內
    return n, hit


def read_universe(path):
    """一行一個代號 → 只留 4 碼、⛔ 不收 00 開頭(ETF);去重保序。"""
    out, seen = [], set()
    try:
        lines = Path(path).read_text(encoding='utf-8').split()
    except Exception:
        return []
    for x in lines:
        x = x.strip()
        if len(x) == 4 and x.isdigit() and not x.startswith('0') and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def main_deep():
    """deep 模式:已經有檔的跳過(可續跑);額度用完(402/429)就等 5 分鐘再試,最多 6 次。"""
    import gzip
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS → 回補需要金鑰')
        return 1
    syms = read_universe(UNIVERSE)
    if len(syms) < 500:
        print(f'❌ 母體只有 {len(syms)} 檔(< 500)→ UNIVERSE 可能沒做好,⛔ 不跑')
        return 1
    DEEP_DIR.mkdir(parents=True, exist_ok=True)
    pace = max(SLEEP, 6.2 / max(1, len(TOKENS)))          # 免費層 600 次/小時/把 → 每把每 6 秒一次
    todo = [x for x in syms if not (DEEP_DIR / f'{x}.json.gz').exists()]
    print(f'🗄️ 法人深歷史 {DEEP_FROM} ~ {DEEP_TO} ・母體 {len(syms)} 檔 ・已有 {len(syms) - len(todo)} ・要抓 {len(todo)} '
          f'・token {len(TOKENS)} 把 ・每次間隔 {pace:.1f} 秒 ・預算 {MAX_MIN} 分', flush=True)
    t0 = time.time()
    done = wrote = empty = waits = 0
    cn = ch = 0
    for sym in todo:
        if done >= LIMIT or (time.time() - t0) / 60 > MAX_MIN:
            print(f'⏹️ 到達上限(LIMIT {LIMIT} / {MAX_MIN} 分)→ 本輪結束,下次接著補', flush=True)
            break
        data, err = None, None
        for _ in range(6):
            data, err = fm('TaiwanStockInstitutionalInvestorsBuySell', sym, DEEP_FROM, end_date=DEEP_TO, timeout=90)
            if data is not None or not err or not (err.startswith('http402') or err.startswith('http429')):
                break
            waits += 1
            print(f'   ⏳ {sym} 額度用完({err})→ 等 5 分鐘', flush=True)
            time.sleep(300)
        time.sleep(pace)
        done += 1
        if data is None:
            _rec('deep_' + (err or '?')[:14])
            continue
        pack = deep_pack(agg_inst(data))
        if not pack['d']:
            empty += 1                                   # 那段期間還沒上市 → 照寫空檔,下次才不會一直重抓
        with gzip.open(DEEP_DIR / f'{sym}.json.gz', 'wt', encoding='utf-8') as f:
            json.dump(pack, f, separators=(',', ':'))
        wrote += 1
        p = DATA_DIR / f'{sym}.json'
        if p.exists():
            try:
                a, b = deep_check(pack, json.loads(p.read_text(encoding='utf-8')))
                cn += a; ch += b
            except Exception:
                pass
        if done % 100 == 0:
            print(f'   … {done} 檔 ・{(time.time() - t0) / 60:.0f} 分 ・寫入 {wrote}(空 {empty})・等額度 {waits} 次 '
                  f'・對表 {ch}/{cn}', flush=True)
    have = sum(1 for x in syms if (DEEP_DIR / f'{x}.json.gz').exists())
    print(f'\n📊 本輪 {done} 檔 ・寫入 {wrote}(那段期間沒資料 {empty})・等額度 {waits} 次 ・累計 {have}/{len(syms)}')
    if REASON:
        print('   失敗分類:' + ' ・'.join(f'{k}×{v}' for k, v in sorted(REASON.items(), key=lambda x: -x[1])[:8]))
    rate = (ch / cn) if cn else None
    print(f'   🔎 跟 data/*.json 重疊那段對表(外資):{ch}/{cn}' + (f'({rate:.1%})' if cn else ''))
    # 🚧 空過守門(陷阱 #9)+ 對表守門(陷阱 #17:單位 / 欄位對不上 = 不是同一個東西)
    if done > 0 and wrote == 0:
        print('❌ 處理了但一檔都沒寫 → 這一輪無效(金鑰 / 額度 / 資料集名),⛔ 不推')
        return 1
    if wrote >= 50 and cn < CHECK_MIN_DAYS:
        print(f'❌ 寫了 {wrote} 檔但可對表只有 {cn} 天(< {CHECK_MIN_DAYS})→ 重疊那段可能沒抓到,⛔ 不推')
        return 1
    if cn >= CHECK_MIN_DAYS and rate < CHECK_MIN_RATE:
        print(f'❌ 對表一致率 {rate:.1%} < {CHECK_MIN_RATE:.0%} → 單位或欄位跟 data/*.json 不一樣,⛔ 不推')
        return 1
    return 0


def selftest():
    bad = []

    def ok(name, cond, extra=''):
        print(f"  {'✅' if cond else '❌'} {name}{(' ・' + str(extra)) if extra and not cond else ''}")
        if not cond:
            bad.append(name)

    m = agg_inst([
        {'date': '2015-03-02', 'name': 'Foreign_Investor', 'buy': 5000, 'sell': 2000},
        {'date': '2015-03-02', 'name': 'Foreign_Dealer_Self', 'buy': 100, 'sell': 0},
        {'date': '2015-03-02', 'name': 'Investment_Trust', 'buy': 0, 'sell': 700},
        {'date': '2015-03-02', 'name': 'Dealer_Hedging', 'buy': 10, 'sell': 0},
        {'date': '2015/03/03', 'name': 'Foreign_Investor', 'buy': 0, 'sell': 9000},
    ])
    pk = deep_pack(m)
    ok('① 外資 = 外資 + 外資自營、日期排序、斜線日期', pk['d'] == ['2015-03-02', '2015-03-03'] and pk['f'] == [3100, -9000], pk)
    ok('① 投信 / 自營分開(單位:股)', pk['t'] == [-700, 0] and pk['dl'] == [10, 0], pk)
    rows = [{'date': '2015/03/02', 'foreign_net': 3100}, {'date': '2015/03/03', 'foreign_net': 0}, {'date': '2015/03/04', 'foreign_net': 50}]
    ok('② 對表:兩邊都有才算、0 不算', deep_check(pk, rows) == (1, 1), deep_check(pk, rows))
    ok('② 單位差 1,000 倍 → 對不上', deep_check({'d': pk['d'], 'f': [x * 1000 for x in pk['f']]}, rows) == (1, 0))
    ok('② 正負號反 → 對不上', deep_check({'d': pk['d'], 'f': [-x for x in pk['f']]}, rows) == (1, 0))
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        u = Path(td) / 'u.txt'
        u.write_text('2330\n0050\n2330\n1101\n00878\nabcd\n 2317 \n', encoding='utf-8')
        ok('③ 母體:只留 4 碼、不收 0 開頭、去重', read_universe(u) == ['2330', '1101', '2317'], read_universe(u))
        ok('③ 母體檔不存在 → 空', read_universe(Path(td) / 'nope.txt') == [])
    # ④ fill 模式的網址一字不變(沒帶 end_date 就沒有 end_date)
    import inspect
    src = inspect.getsource(fm)
    ok('④ end_date 只有帶了才放進網址', "if end_date:\n            q['end_date'] = end_date" in src)
    ok('④ 預設模式是 fill', (os.getenv('MODE') or 'fill').strip() == 'fill' or MODE == 'deep')
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS → 回補需要金鑰')
        return 1
    files = sorted(p for p in DATA_DIR.glob('*.json')
                   if p.stem.isdigit() or (p.stem and p.stem[0].isdigit()))
    print(f'🏦 法人/融資券 歷史回補 ・{len(files)} 檔候選 ・token {len(TOKENS)} 把 ・上限 {LIMIT} 檔 / {MAX_MIN} 分')
    t0 = time.time()
    done = 0
    for p in files:
        if done >= LIMIT:
            print(f'⏹️ 到達 LIMIT={LIMIT},本輪結束(下次再跑會接著補)')
            break
        if (time.time() - t0) / 60 > MAX_MIN:
            print(f'⏹️ 到達時間預算 {MAX_MIN} 分,本輪結束(下次再跑會接著補)')
            break
        sym = p.stem
        try:
            rows = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            STAT['fail'] += 1
            continue
        if not isinstance(rows, list) or len(rows) < 60:
            STAT['skip'] += 1
            continue
        # ── 跳過條件:綁「補到什麼程度」而不是「有沒有做過」(陷阱 #10)──
        have_i = sum(1 for r in rows if (r.get('foreign_net') or r.get('trust_net') or r.get('dealer_net')))
        have_m = sum(1 for r in rows if (r.get('margin_balance') or r.get('short_balance')))
        need_i = have_i < len(rows) * MIN_FILL_RATIO
        need_m = have_m < len(rows) * MIN_FILL_RATIO
        if not need_i and not need_m:
            STAT['skip'] += 1
            continue
        start = _d(rows[0].get('date')) or '2015-01-01'
        changed = 0
        if need_i:
            data, err = fm('TaiwanStockInstitutionalInvestorsBuySell', sym, start)
            if data:
                m = agg_inst(data)
                for r in rows:
                    d = _d(r.get('date'))
                    v = m.get(d)
                    if not v:
                        continue
                    # ⛔ 實跑寫入優先:已經有非 0 值就不動(只補 0/缺的)
                    if not r.get('foreign_net') and v['f']:
                        r['foreign_net'] = int(round(v['f'])); changed += 1
                    if not r.get('trust_net') and v['t']:
                        r['trust_net'] = int(round(v['t'])); changed += 1
                    if not r.get('dealer_net') and v['d']:
                        r['dealer_net'] = int(round(v['d'])); changed += 1
                STAT['filled_inst'] += 1
            elif err:
                _rec('inst_' + err[:14])
            time.sleep(SLEEP)
        if need_m:
            data, err = fm('TaiwanStockMarginPurchaseShortSale', sym, start)
            if data:
                m = agg_margin(data)
                for r in rows:
                    d = _d(r.get('date'))
                    v = m.get(d)
                    if not v:
                        continue
                    if not r.get('margin_balance') and v['mb']:
                        r['margin_balance'] = int(round(v['mb'])); changed += 1
                    if not r.get('short_balance') and v['sb']:
                        r['short_balance'] = int(round(v['sb'])); changed += 1
                STAT['filled_margin'] += 1
            elif err:
                _rec('mgn_' + err[:14])
            time.sleep(SLEEP)
        done += 1
        if changed:
            p.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            STAT['ok'] += 1
        else:
            STAT['nodata'] += 1
        if done % 100 == 0:
            el = (time.time() - t0) / 60
            print(f'   … {done} 檔 ・{el:.0f} 分 ・寫入 {STAT["ok"]} ・跳過 {STAT["skip"]} ・沒補到 {STAT["nodata"]}')

    el = (time.time() - t0) / 60
    print(f'\n📊 本輪:處理 {done} 檔 / {el:.0f} 分')
    print(f'   ✅ 有寫入 {STAT["ok"]} ・⏭️ 已補滿跳過 {STAT["skip"]} ・➖ 抓不到 {STAT["nodata"]} ・❌ 壞檔 {STAT["fail"]}')
    print(f'   法人補了 {STAT["filled_inst"]} 檔 ・融資券補了 {STAT["filled_margin"]} 檔')
    # ⭐ 分類統計(V72.5.3 的教訓:先加分類統計,再下結論 —— 沒有它會把權限問題誤診成逾時)
    if REASON:
        print('   失敗分類:' + ' ・'.join(f'{k}×{v}' for k, v in sorted(REASON.items(), key=lambda x: -x[1])[:8]))

    # 🚧 空過守門:一檔都沒寫成功 = 這一輪無效,⛔ 不可讓 workflow 綠燈騙人(陷阱 #9)
    if done > 0 and STAT['ok'] == 0:
        print('❌ 處理了檔案但一筆都沒寫進去 → 這一輪無效(可能金鑰/欄位名有問題),⛔ 別當成「補完了」')
        return 1
    return 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main_deep() if MODE == 'deep' else main())
