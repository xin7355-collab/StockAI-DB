# 🗽 川普發文 → 台股 0050 下一個可交易盤(外部參考評估㊵,2026-09-27)
#  資料:外部 repo sstklen/trump-code 的 data/trump_posts_all.json(⛔ 不進本 repo)
#  對到台股:台北時間 13:30 之後的發文 → 隔天;09:00 以前 → 當天;盤中發文剔除(開盤那一刻還沒發生)
#  資產:0050 自己的開→收(⛔ 不用加權開盤價,陷阱 #47);另列跳空(買不到的那一段)
#  同一台股日只算一次;對照組 = 同期沒有這類發文的交易日
# 跑法:POSTS=…/trump_posts_all.json DATA_DIR=<含 0050.json 的目錄> python3 scripts/trump_post_probe.py
import json, re, math, os, sys, statistics as st
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib_trump import KW, classify, dedup_key, tw_day as _tw_day  # noqa: E402  ⭐ V80.2.1 分類 / 對台股日唯一一份
POSTS = os.environ.get('POSTS'); DD = os.environ.get('DATA_DIR')
if not POSTS or not DD: sys.exit('需要 POSTS 與 DATA_DIR')
P=json.load(open(POSTS))
posts=P if isinstance(P,list) else P['posts']
K=[r for r in json.load(open(os.path.join(DD,'0050.json')))]
bars={r['date'].replace('/','-'):r for r in K}
days=sorted(bars)
_OPEN=set(days)
def tw_day(ts): return _tw_day(ts, days, _OPEN)
ev={k:set() for k in KW}
seen=set()
for p in posts:
    if p.get('is_retweet'): continue
    key=dedup_key(p['created_at'], p.get('content'))
    if key in seen: continue
    seen.add(key)
    cls=classify(p.get('content'))
    if cls:
        d=tw_day(p['created_at'])
        if d:
            for k in cls: ev[k].add(d)
def oc(d): b=bars[d]; return (b['close']/b['open']-1)*100
def gap(d):
    i=days.index(d); return (bars[d]['open']/bars[days[i-1]]['close']-1)*100 if i>0 else None
def summ(ds):
    r=[oc(d) for d in ds]; g=[x for x in (gap(d) for d in ds) if x is not None]
    n=len(r); m=st.mean(r); sd=st.pstdev(r)
    return dict(n=n,oc=round(m,3),win=round(sum(x>0 for x in r)/n*100,1),abs_oc=round(st.mean(abs(x) for x in r),3),gap=round(st.mean(g),3),abs_gap=round(st.mean(abs(x) for x in g),3),t=round(m/(sd/math.sqrt(n)),2) if sd else 0)
for era,lo,hi in [('2022-02~2025-01(沒在任)','2022-02-14','2025-01-19'),('2025-01-20~2026-03(在任)','2025-01-20','2026-03-25')]:
    base=[d for d in days if lo<=d<=hi]
    print('\n==',era,'全部交易日',summ(base))
    for k in KW:
        ds=sorted(d for d in ev[k] if lo<=d<=hi)
        if len(ds)>=10:
            s=summ(ds); rest=[d for d in base if d not in ev[k]]; r=summ(rest)
            print(f'{k:7s}',s,' vs 沒發文的日子 oc',r['oc'],'差',round(s['oc']-r['oc'],3))
