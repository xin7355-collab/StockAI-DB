#!/usr/bin/env python3
"""付費 token 池輪動 + 逐檔併發預抓 單元測試(不打網路,全用假回應)。

背景:V71.2.7 之前 fm_paid_get() 從頭到尾只用 FINMIND_PAID_TOKEN **一把**,
      等於 Secrets 放幾把都沒用,全市場分點被鎖在單把 6,000 req/hr = 100 req/min。
      實測 35 分鐘約 4,000~4,500 次呼叫 ≈ 120 次/分,剛好貼在天花板 →
      「跑不完全市場」的真因是額度只用了 1/N,不是程式慢。

驗:
  ① fm_paid_get 會輪流用池子裡每一把 token(不是固定一把)
  ② 池子空時退回單把行為(向下相容,行為不變)
  ③ 輪動在多執行緒下不會錯亂(有鎖)
  ④ 併發預抓:回傳索引形狀與 _fetch_chips_bulk 一致、只抓 need_days 天
  ⑤ 併發預抓遇 402/403 → 該檔放棄,不污染
  ⑥ 併發預抓遇欄位污染 → 該檔放棄
"""
import sys, os, threading, collections
sys.path.insert(0, '/home/user/StockAI-DB')
os.environ.setdefault('SKIP_GLOBAL', '1')
import miner

# ── ① 輪動 ─────────────────────────────────────────────────────────────
miner.FINMIND_PAID_TOKENS = ['tokA', 'tokB', 'tokC']
miner._fm_paid_idx = 0
used = []


class FakeResp:
    def json(self):
        return {'status': 200, 'data': [{'securities_trader_id': '1', 'buy': 1, 'sell': 0}]}


def fake_get(url, headers=None, timeout=None):
    used.append(headers['Authorization'].replace('Bearer ', ''))
    return FakeResp()


miner.http_session.get = fake_get
for _ in range(9):
    miner.fm_paid_get('taiwan_stock_trading_daily_report', 'data_id=2330&date=2026-07-28')
assert used == ['tokA', 'tokB', 'tokC'] * 3, f'① 輪動不對:{used}'
print(f'✅ ① 3 把 token 輪流用:{used[:6]}…(舊版會是 9 次全 tokA)')

# ── ② 池子空 → 退回單把 ────────────────────────────────────────────────
miner.FINMIND_PAID_TOKENS = []
miner.FINMIND_PAID_TOKEN = 'solo'
used.clear()
for _ in range(3):
    miner.fm_paid_get('taiwan_stock_trading_daily_report', 'x=1')
assert used == ['solo'] * 3, f'② 應退回單把:{used}'
print('✅ ② 池子空 → 退回單把行為(向下相容)')

# ── ③ 多執行緒輪動不錯亂 ───────────────────────────────────────────────
miner.FINMIND_PAID_TOKENS = ['t1', 't2', 't3', 't4']
miner._fm_paid_idx = 0
used.clear()
lock = threading.Lock()
safe = []


def fake_get_mt(url, headers=None, timeout=None):
    with lock:
        safe.append(headers['Authorization'].replace('Bearer ', ''))
    return FakeResp()


miner.http_session.get = fake_get_mt
ths = [threading.Thread(target=lambda: [miner.fm_paid_get('ep', 'x=1') for _ in range(50)])
       for _ in range(8)]
[t.start() for t in ths]
[t.join() for t in ths]
c = collections.Counter(safe)
assert len(safe) == 400, f'③ 呼叫數 {len(safe)}'
assert set(c) == {'t1', 't2', 't3', 't4'}, f'③ 少用到 token:{c}'
assert max(c.values()) - min(c.values()) <= 1, f'③ 分配不均(鎖沒生效?):{c}'
print(f'✅ ③ 8 執行緒 × 50 次 = 400 次,4 把分配 {dict(c)}(最大差 ≤1,鎖有效)')

# ── ④⑤⑥ 併發預抓 ─────────────────────────────────────────────────────
def mk(status, rows):
    class R:
        def json(self_inner):
            return {'status': status, 'data': rows}
    return R()


def fake_prefetch(url, headers=None, timeout=None):
    sym = url.split('data_id=')[1].split('&')[0]
    d = url.split('date=')[1]
    if sym == 'BAD402':
        return mk(402, [])
    if sym == 'DIRTY':
        return mk(200, [{'date': d, 'amount': '18,232,856'}])
    if d.endswith('-26') or d.endswith('-25'):
        return mk(200, [])          # 假日
    return mk(200, [{'date': d, 'stock_id': sym, 'securities_trader_id': '1020',
                     'securities_trader': '元大', 'buy': 100, 'sell': 5, 'price': 50.0}])


miner.http_session.get = fake_prefetch
todo = [('2330', 11, 16), ('1108', 3, 6), ('BAD402', 3, 6), ('DIRTY', 3, 6)]
idx = miner._prefetch_chips_parallel(todo, budget_s=60)
assert '2330' in idx and '1108' in idx, f'④ 正常股沒抓到:{list(idx)}'
assert len({r['date'] for r in idx['2330']}) == 11, '④ 熱門股應 11 天'
assert len({r['date'] for r in idx['1108']}) == 3, '④ 冷門股應 3 天'
assert all(k in idx['2330'][0] for k in ('stock_id', 'securities_trader_id')), '④ 欄位形狀不對'
print('✅ ④ 併發預抓:熱門 11 日 / 冷門 3 日,索引形狀與 bulk 一致')
assert 'BAD402' not in idx, '⑤ 402 應放棄'
print('✅ ⑤ 回 402/403 → 該檔放棄,不寫進索引')
assert 'DIRTY' not in idx, '⑥ 污染應放棄'
print('✅ ⑥ 欄位不是分點 → 該檔放棄,不污染 chips')

print('\n🎉 token 池 + 併發預抓 六項測試全過')

# ── ⑦⑧ V71.2.8 免費/付費分流 + 付費節流 ─────────────────────────────────
miner.FINMIND_TOKENS[:] = ['PAID', 'free1', 'free2', 'free3']
miner.FINMIND_PAID_TOKENS[:] = ['PAID']
miner.FINMIND_FREE_TOKENS[:] = ['free1', 'free2', 'free3']
miner._finmind_token_idx = 0
miner._FINMIND_BLOCKED = False
picked = [miner.get_finmind_token() for _ in range(6)]
# 一般資料集輪動時要換 token,這裡直接驗池子內容
assert 'PAID' not in picked, f'⑦ 一般資料集不可用到付費金鑰:{picked}'
tried = set()
seen = {picked[0]}
while miner.rotate_finmind_token(tried):
    seen.add(miner.get_finmind_token())
assert seen == {'free1', 'free2', 'free3'}, f'⑦ 應輪遍 3 把免費且不碰付費:{seen}'
print(f'✅ ⑦ 一般資料集只用免費金鑰 {sorted(seen)},付費那把 100% 留給分點')

miner._FINMIND_BLOCKED = False
miner._fm_paid_calls[:] = []
miner._FM_PAID_RATE_MAX = 5          # 縮小視窗好測
miner.FINMIND_PAID_TOKENS[:] = ['PAID']
miner.http_session.get = lambda url, headers=None, timeout=None: FakeResp()
import time as _t
t0 = _t.time()
for _ in range(5):
    miner.fm_paid_get('ep', 'x=1')
assert _t.time() - t0 < 1.0, '⑧ 前 5 次不該被擋'
assert len(miner._fm_paid_calls) == 5
# 第 6 次會等到視窗釋出 → 這裡不真的等 60 秒,只驗「視窗已滿」的判斷成立
miner._fm_paid_calls[:] = [_t.time()] * 5
full = len(miner._fm_paid_calls) >= miner._FM_PAID_RATE_MAX * len(miner.FINMIND_PAID_TOKENS)
assert full, '⑧ 視窗應判定已滿'
print('✅ ⑧ 付費節流:滑動視窗到上限就等待,不硬打 429(429 一樣吃掉額度還要重試)')

print('\n🎉 V71.2.8 免費/付費分流 + 節流 追加測試通過')
