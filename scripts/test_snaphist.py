#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""💾 V74.6.9 「現在不存、以後永遠測不了」的快照歷史(_snap_hist)

⭐ 這支釘住的是**資料完整性**:那幾類資料一旦被空檔或半份覆蓋,歷史就永久消失
  (K 線可以回補,每日快照不行)。所以每一條守門都要有測試。
"""
import json, os, sys, tempfile
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import miner

FAIL = []
def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {extra}'))
    if not cond: FAIL.append(name)

def tw(days=0):
    return (datetime.now(timezone(timedelta(hours=8))) - timedelta(days=days)).strftime('%Y-%m-%d')

d = tempfile.mkdtemp()
miner.DATA_DIR = d
P = os.path.join(d, 'h.json')
read = lambda: json.load(open(P))['days']

# ① 基本:寫得進去、同一天重跑會覆蓋(⛔ 不累加)
miner._snap_hist('h.json', {tw(2): {'2330': [1, 2]}, tw(1): {'2317': [3, 4]}}, 'T')
ok('① 兩天都寫進去', sorted(read()) == sorted([tw(2), tw(1)]), sorted(read()))
miner._snap_hist('h.json', {tw(1): {'2317': [9, 9]}}, 'T')
ok('② 同一天重跑 → 覆蓋而不是累加', read()[tw(1)] == {'2317': [9, 9]}, read()[tw(1)])

# ③ 🚧 空的不可寫 —— 🚨 最危險的是「檔案不存在 + 這輪也沒資料」:
#    沒守門就會寫出 days:{} 的空檔,把還原回來的歷史換成空的。
miner._snap_hist('h.json', {}, 'T')
ok('③ 空的 → 保留舊檔(⛔ 不覆蓋)', len(read()) == 2, len(read()))
_e = os.path.join(d, 'empty.json')
miner._snap_hist('empty.json', {}, 'T')
ok('③b 🚨 檔案不存在 + 空資料 → ⛔ 絕不可建立空檔(那會把還原的歷史換成空的)',
   not os.path.exists(_e))
miner._snap_hist('empty.json', {tw(0): {}}, 'T')
ok('③c 只有空的那一天 → 也不可建立檔案', not os.path.exists(_e))

# ④ 🚨 只增不減:模擬「workflow 還原失敗」(檔案在,但這輪只算得出 1 天)
#    ⛔ 直接寫下去會把幾百天洗掉 —— 這是本專案最貴的一種錯(V74.2.8 news_hist 的教訓)
before = dict(read())
miner._snap_hist('h.json', {tw(0): {'1303': [5, 6]}}, 'T')
ok('④ 新增第 3 天(天數變多)→ 照寫', len(read()) == 3, len(read()))
many = {tw(i): {'2330': [i, i]} for i in range(3, 13)}
json.dump({'days': many}, open(P, 'w'))
miner._snap_hist('h.json', {tw(0): {'1303': [1, 1]}}, 'T')
ok('④b 併進去之後天數變多 → 不可誤擋', len(read()) == 11, len(read()))

# ⑨ 🚨 真正擋得住「workflow 還原失敗」的是 **workflow 那層**(miner 自己那層看不到分支上的檔)。
#    ⭐ 注入驗證抓到的:把 miner 裡那條 `n_base` 判斷拿掉,測試照樣綠 —— 因為在正常路徑下
#      hist 一定 ⊇ 舊檔,那條永遠不會觸發。所以這裡改成釘**外層守門**真的會救回來。
import subprocess, shutil
GD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'news_hist_guard.py')
gp, gn = os.path.join(d, 'prev.json'), os.path.join(d, 'new.json')
json.dump({'days': {'a': 1, 'b': 2, 'c': 3}}, open(gp, 'w'))
json.dump({'days': {'a': 1}}, open(gn, 'w'))
r = subprocess.run([sys.executable, GD, gn, gp, '鉅額交易'], capture_output=True, text=True)
ok('⑨ 外層守門:新的天數變少 → 把舊的救回來(⛔ 不覆蓋)',
   len(json.load(open(gn))['days']) == 3 and '拒絕覆蓋' in r.stdout, r.stdout.strip()[:90])
json.dump({'days': {'a': 1, 'b': 2, 'c': 3, 'd': 4}}, open(gn, 'w'))
r2 = subprocess.run([sys.executable, GD, gn, gp, '借券'], capture_output=True, text=True)
ok('⑨b 天數變多 → 照過(⛔ 不可誤擋)', len(json.load(open(gn))['days']) == 4, r2.stdout.strip()[:90])
# ⑩ workflow 真的有接上那道守門(⛔ 寫好卻沒接 = 等於沒有)
WF = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       '.github', 'workflows', 'daily_miner.yml'), encoding='utf-8').read()
ok('⑩ daily_miner 有接上外層守門,而且三個檔都在清單裡',
   'hist_guard.py' in WF and all(f in WF for f in ['blocktrade_hist', 'lending_hist', 'margin_limit_hist']))
ok('⑩b 守門腳本要先 cp 到 /tmp(⛔ 後面會切分支,那裡沒有 scripts/)', 'cp scripts/news_hist_guard.py /tmp/' in WF)

# ⑤ 滾動保留:超過 keep_days 的要被裁掉,而且⛔ 不可因此觸發「只增不減」誤擋
json.dump({'days': {**{tw(600): {'2330': [1, 1]}}, **{tw(i): {'2330': [1, 1]} for i in range(5)}}}, open(P, 'w'))
miner._snap_hist('h.json', {tw(0): {'1303': [2, 2]}}, 'T', keep_days=500)
r = read()
ok('⑤ 600 天前的被裁掉', tw(600) not in r, sorted(r)[:2])
ok('⑤b 裁掉舊的⛔ 不可被「只增不減」誤擋(窗口內天數才是基準)', len(r) == 5, len(r))

# ⑥ 台北日期(⛔ 不可用 UTC —— 台北晚上會差一天)
ok('⑥ _tw_today_str 用台北時區', miner._tw_today_str() == tw(0), miner._tw_today_str())

# ⑦ 三個呼叫端都接上了(⛔ 寫好卻沒接 = 陷阱 #37)
src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'miner.py'), encoding='utf-8').read()
for f in ['blocktrade_hist.json', 'lending_hist.json', 'margin_limit_hist.json']:
    ok(f'⑦ {f} 有被 _snap_hist 寫出', f"_snap_hist('{f}'" in src)
ok('⑦b 融資限額有接進主流程', 'fetch_margin_limit' in src.split("if __name__")[0] and '_safe_step("融資限額 fetch_margin_limit"' in src)

# ⑧ 🚧 融資限額:解析不到 200 檔一律不寫(⛔ 不可寫半份)
_fml = src[src.index('def fetch_margin_limit()'):src.index('\ndef _fm_bulk_days(')]
ok('⑧ 融資限額有「<200 檔不寫」守門', 'len(mm) < 200' in _fml or 'len(m) < 200' in _fml)
ok('⑧b 融資限額有誠實揭露「只有上市」', 'TPEx' in src and '403' in src)

# ⑪ 🚨 V75.2.6:這支從 V74.6.9 上線到 2026-09-09 **一天都沒寫出來**,死在
#    「找欄名含『融資』的那一欄」—— 而 rwd 版 MI_MARGN 整張表沒有「融資/融券」字樣。
#    ⭐ 釘的是**用意**:欄位定位⛔ 不可只靠寫死索引,靠位置時必須先過表頭指紋。
ok('⑪ 欄位定位⛔ 不可只靠寫死索引 —— 要嘛具名、要嘛先過表頭指紋',
   ('OpenAPI' in _fml and 'Limit' in _fml)          # ① 具名來源
   and 'fp = (' in _fml and 'len(hdr) == 12' in _fml  # ③ 位置解析前的指紋
   and '⛔ 不靠位置硬猜' in _fml)
ok('⑪b 指紋對不上時要**印出完整 hdr** 再放棄(⛔ 不可靜默 return)',
   _fml.count('完整 hdr = {hdr}') >= 2)
ok('⑪c 🚨 寫檔前要有資料合理性守門(餘額 ≤ 限額)—— 欄位配錯時 200 檔門檻擋不住',
   'def _sane(' in _fml and 'b <= l' in _fml and '< 90' in _fml)

# ⑫ 🚨 語意:TWSE 那一欄叫「次一營業日限額」,⛔ 不是「今日限額」——
#    文案寫錯會讓日後算出來的「融資使用率」被解讀成別的東西。
ok('⑫ 限額語意有寫明(次一營業日限額 ≠ 今日限額)',
   '次一營業日限額' in _fml and '不是今日限額' in _fml)
ok('⑫b 這件事也要出現在 log 裡(⛔ 不能只寫在註解給自己看)',
   '次一營業日限額」不是今日限額' in _fml)

# ⑬ 🚨 **功能測試**(⛔ 不是字串斷言):拿**真實 log 那一行 hdr** 餵進去,
#    確認 rwd 那條路真的解析得出來。照 V75.1.3→V75.1.4 的教訓(陷阱 #40):
#    測資的欄名**逐字抄自真實回應**,⛔ 不可憑想像寫 —— 那次 12 條全綠 + 注入全過,
#    真實資料卻完全對不上。
import io, urllib.request as _ur
_REAL_HDR = ['代號', '名稱', '買進', '賣出', '現金償還', '前日餘額', '今日餘額',
             '次一營業日限額', '買進', '賣出', '現券償還', '前日餘額']

class _Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False

def _fake(payload):
    def f(req, timeout=None):
        u = req.full_url if hasattr(req, 'full_url') else str(req)
        return _Resp(json.dumps(payload('openapi' if 'openapi' in u else 'rwd')).encode())
    return f

_orig_open = _ur.urlopen
try:
    def _pl(kind):
        if kind == 'openapi':
            # 具名端點回了資料,但**沒有限額欄** → 必須自動退到 rwd(⛔ 不可就此放棄)
            return [{'Code': '2330', 'MarginPurchaseTodayBalance': '1,000'}]
        rows = []
        for i in range(300):
            sid = str(1101 + i)
            rows.append([sid, f'X{i}', '0', '0', '0', '900', '1,000', '9,000',
                         '0', '0', '0', '0'])
        return {'stat': 'OK', 'tables': [{'fields': _REAL_HDR, 'data': rows}]}
    _ur.urlopen = _fake(_pl)
    miner.DATA_DIR = d
    _MP = os.path.join(d, 'margin_limit_hist.json')
    if os.path.exists(_MP): os.remove(_MP)
    miner.fetch_margin_limit()
    got = json.load(open(_MP))['days'] if os.path.exists(_MP) else {}
    day = sorted(got)[-1] if got else ''
    ok('⑬ 用真實欄名 hdr 餵進去 → 真的解析得出來(≥200 檔)', len(got.get(day, {})) >= 200,
       f'天={day} 檔數={len(got.get(day, {}))}')
    ok('⑬b 解析出來的是 [今日融資餘額, 次一營業日限額] 這兩欄',
       got.get(day, {}).get('1101') == [1000, 9000], got.get(day, {}).get('1101'))

    # ⑭ 🚨 欄位配錯時,合理性守門要擋下來(⛔ 200 檔門檻擋不住配錯欄)
    def _pl_bad(kind):
        if kind == 'openapi':
            return []
        rows = []
        for i in range(300):
            # 把「限額」欄放成一個比餘額小的數字 = 典型的欄位錯位
            rows.append([str(1101 + i), f'X{i}', '0', '0', '0', '900', '9,000', '1,000',
                         '0', '0', '0', '0'])
        return {'stat': 'OK', 'tables': [{'fields': _REAL_HDR, 'data': rows}]}
    _ur.urlopen = _fake(_pl_bad)
    os.remove(_MP)
    miner.fetch_margin_limit()
    ok('⑭ 🚨 餘額 > 限額(欄位配錯的樣子)→ ⛔ 不可寫檔', not os.path.exists(_MP))

    # ⑮ 表頭指紋對不上(TWSE 又改 schema)→ ⛔ 不可硬猜位置
    def _pl_new(kind):
        if kind == 'openapi':
            return []
        h = _REAL_HDR[:6] + ['某個新欄'] + _REAL_HDR[6:]     # 欄數變 13
        rows = [[str(1101 + i)] + ['1'] * 12 for i in range(300)]
        return {'stat': 'OK', 'tables': [{'fields': h, 'data': rows}]}
    _ur.urlopen = _fake(_pl_new)
    # ⚠️ 每一條都先把檔案清掉再跑 —— 否則上一條若「不該寫卻寫了」,
    #    這一條的 `not exists` 會**繼承**上一條的殘留,變成假失敗(注入驗證時實際踩到)。
    if os.path.exists(_MP): os.remove(_MP)
    miner.fetch_margin_limit()
    ok('⑮ 表頭指紋對不上 → ⛔ 不硬猜位置、不寫檔', not os.path.exists(_MP))
finally:
    _ur.urlopen = _orig_open

print('\n' + ('❌ %d 條失敗' % len(FAIL) if FAIL else '✅ SNAPHIST_PASS'))
sys.exit(1 if FAIL else 0)
