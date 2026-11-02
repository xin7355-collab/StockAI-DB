# 🗽 川普發文 → 台股 0050 下一個可交易盤(外部參考評估㊵,2026-09-27;V80.2.1 評估紀錄 53 改用本站自己的存檔)
#  資料:DEEP = trump_deep 分支解開的資料夾(trump_posts_miner.py 存的 CNN 存檔,2022-02 起;⭐ V80.2.1 起用這份)
#        或 POSTS = 外部 repo sstklen/trump-code 的 data/trump_posts_all.json(⛔ 不進本 repo;9/27 那次用的,到 2026-03-25)
#  對到台股:台北時間 13:30 之後的發文 → 隔天;09:00 以前 → 當天;盤中發文剔除(開盤那一刻還沒發生)—— 一律 lib_trump
#  資產:0050 自己的開→收(⛔ 不用加權開盤價,陷阱 #47);另列跳空(買不到的那一段)
#  ⭐ V80.2.1:跳空在除息日用「除息前價 ÷ 參考價」把前收接回(DATA_DIR 有 _div0050.json 才做)、量 0 的日子(2025-06 分割停牌)不算交易日
#  同一台股日只算一次;對照組 = 同期沒有這類發文的交易日
#  OCC_OUT=檔案:寫「就任後(2025-01-20 起)那一類發文的隔天,0050 開盤漲或跌超過 1% 的比例」給 App 🗽 那一格(scripts/embed_trump_occ.mjs 嵌入)
# 跑法:DEEP=<trump_deep 資料夾> DATA_DIR=<含 0050.json 的目錄> [OCC_OUT=occ.json] python3 scripts/trump_post_probe.py
import json, math, os, sys, statistics as st
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib_trump import KW, CLS_ZH, classify, dedup_key, tw_day as _tw_day  # noqa: E402  ⭐ V80.2.1 分類 / 對台股日唯一一份
POSTS = os.environ.get('POSTS'); DEEP = os.environ.get('DEEP'); DD = os.environ.get('DATA_DIR')
if not (POSTS or DEEP) or not DD: sys.exit('需要 DEEP(或 POSTS)與 DATA_DIR')
if DEEP:
    from trump_posts_miner import load_deep  # noqa: E402
    _p, _, _bad = load_deep(DEEP, log=print)
    posts = [{'created_at': p['t'], 'content': p.get('x') or '', 'is_retweet': bool(p.get('rt'))} for p in _p.values()]
    print(f'本站存檔 {len(posts):,} 則({min(p["created_at"] for p in posts)[:10]} ~ {max(p["created_at"] for p in posts)[:10]})')
else:
    P = json.load(open(POSTS))
    posts = P if isinstance(P, list) else P['posts']
K = [r for r in json.load(open(os.path.join(DD, '0050.json')))]
bars = {r['date'].replace('/', '-'): r for r in K if float(r.get('volume') or 0) > 0}   # 量 0 = 停牌,不是交易日
days = sorted(bars)
_OPEN = set(days)
DIVF = {}
_dp = os.path.join(DD, '_div0050.json')
if os.path.exists(_dp):
    for x in ((json.load(open(_dp)).get('d') or {}).get('0050') or {}).get('h') or []:
        if len(x) >= 5 and x[3] and x[4]:
            DIVF[str(x[0])[:10]] = float(x[4]) / float(x[3])          # 參考價 ÷ 除息前價(< 1)
def tw_day(ts): return _tw_day(ts, days, _OPEN)
ev = {k: set() for k in KW}
seen = set()
for p in posts:
    if p.get('is_retweet'): continue
    key = dedup_key(p['created_at'], p.get('content'))
    if key in seen: continue
    seen.add(key)
    cls = classify(p.get('content'))
    if cls:
        d = tw_day(p['created_at'])
        if d:
            for k in cls: ev[k].add(d)
def oc(d): b = bars[d]; return (b['close'] / b['open'] - 1) * 100
_IDX = {d: i for i, d in enumerate(days)}
def gap(d):
    i = _IDX[d]
    if i == 0: return None
    prev = bars[days[i - 1]]['close'] * DIVF.get(d, 1.0)          # 除息日:前收照參考價接回(⛔ 把配息算成跳空)
    return (bars[d]['open'] / prev - 1) * 100
def summ(ds):
    r = [oc(d) for d in ds]; g = [x for x in (gap(d) for d in ds) if x is not None]
    n = len(r); m = st.mean(r); sd = st.pstdev(r)
    return dict(n=n, oc=round(m, 3), win=round(sum(x > 0 for x in r) / n * 100, 1), abs_oc=round(st.mean(abs(x) for x in r), 3),
                gap=round(st.mean(g), 3), abs_gap=round(st.mean(abs(x) for x in g), 3), big=round(sum(abs(x) > 1 for x in g) / len(g) * 100, 1),
                t=round(m / (sd / math.sqrt(n)), 2) if sd else 0)
last = days[-1]
ERAS = [('2022-02~2025-01(沒在任)', '2022-02-14', '2025-01-19'), (f'2025-01-20~{last[:7]}(在任)', '2025-01-20', last)]
for era, lo, hi in ERAS:
    base = [d for d in days if lo <= d <= hi]
    print('\n==', era, '全部交易日', summ(base))
    for k in KW:
        ds = sorted(d for d in ev[k] if lo <= d <= hi)
        if len(ds) >= 10:
            s = summ(ds); rest = [d for d in base if d not in ev[k]]; r = summ(rest)
            print(f'{k:7s}', s, ' vs 沒發文的日子 oc', r['oc'], '差', round(s['oc'] - r['oc'], 3), '・跳超過 1% 的比例', s['big'], 'vs', r['big'])
# 🎲 App 用的發生率:就任後,那一類發文對到的台股日 → 0050 開盤漲或跌超過 1% 的比例 vs 同期全部交易日
OUT = os.environ.get('OCC_OUT')
if OUT:
    lo, hi = '2025-01-20', last
    base = [d for d in days if lo <= d <= hi and gap(d) is not None]
    big = lambda ds: sum(1 for d in ds if abs(gap(d)) > 1)  # noqa: E731
    anyd = set().union(*[ev[k] for k in KW])
    occ = {'from': lo, 'to': hi, 'th': 1.0, 'base': {'n': len(base), 'k': big(base)}, 'cls': {}}
    for k in list(KW) + ['any']:
        ds = sorted(d for d in (anyd if k == 'any' else ev[k]) if lo <= d <= hi and gap(d) is not None)
        occ['cls'][k] = {'n': len(ds), 'k': big(ds), 'zh': CLS_ZH.get(k, '任何一類')}
    Path(OUT).write_text(json.dumps(occ, ensure_ascii=False), encoding='utf-8')
    print('\n🎲 OCC_OUT', json.dumps(occ, ensure_ascii=False))
