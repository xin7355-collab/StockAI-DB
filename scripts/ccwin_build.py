#!/usr/bin/env python3
"""📞 V79.8.2 回測引擎 CCWIN(法說會前後幾天先不買)要的清單:{代號: [法說會日期, …]}

   來源 = data/confcall.json 的 hist(公開資訊觀測站法說會一覽表,2021-07 起;也收已經是 {代號: [日期]} 的檔)
   --shuffle N = 🎲 安慰劑:把每一檔的整份日期「配給別的檔」(固定種子 N)
     ⭐ 保留:同一批日期(季節 / 財報旺季照舊)、同一批代號、每一天被擋的檔數
     ⛔ 打斷:這一檔跟「它自己的法說會」的關係 —— 濾網要是因為避開自己的事件才有用,這組就要沒效果

   用法:python3 scripts/ccwin_build.py <confcall.json 或清單> <輸出> [--shuffle N]
         python3 scripts/ccwin_build.py --selftest
"""
import json
import random
import sys


def load_map(j):
    """confcall.json(有 hist)或已經是 {代號: [日期]} → {代號: [日期]};⛔ 認不得就空的"""
    if isinstance(j, dict) and isinstance(j.get('hist'), dict):
        j = j['hist']
    if not isinstance(j, dict):
        return {}
    out = {}
    for k, v in j.items():
        if isinstance(v, list):
            ds = [str(x)[:10] for x in v if x]
            if ds:
                out[str(k)] = ds
    return out


def shuffle_map(m, seed):
    """整份日期配給別的檔(代號照字典序、種子固定 → 每次一樣)"""
    ks = sorted(m)
    vs = [m[k] for k in ks]
    random.Random(seed).shuffle(vs)
    return dict(zip(ks, vs))


def _selftest():
    bad = 0

    def ok(n, c, e=''):
        nonlocal bad
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)))
        if not c:
            bad += 1

    hist = {f'{1000 + i}': [f'2022-0{1 + i % 9}-1{i % 10}', f'2023-0{1 + i % 9}-2{i % 10}'] for i in range(50)}
    j = {'updated': 'x', 'hist': hist}
    m = load_map(j)
    ok('① 從 confcall.json 的 hist 抽出來 == hist', m == hist)
    ok('① b 已經是清單的直接收', load_map(hist) == hist)
    ok('① c 認不得 → 空的', load_map([1, 2]) == {} and load_map({'hist': 3}) == {})
    a = shuffle_map(m, 1)
    ok('② 安慰劑:代號一樣、每一份日期原封不動(只換主人)', sorted(a) == sorted(m) and sorted(map(tuple, a.values())) == sorted(map(tuple, m.values())))
    ok('② b 每一天出現的次數一樣(季節照舊)', sorted(d for v in a.values() for d in v) == sorted(d for v in m.values() for d in v))
    ok('③ 同一個種子 → 一模一樣', shuffle_map(m, 1) == a)
    ok('③ b 換種子 → 不一樣', shuffle_map(m, 2) != a)
    same = sum(1 for k in m if a[k] == m[k])
    ok('④ 配回自己的很少(≤ 5%)', same <= len(m) * 0.05, same)
    print('\n✅ CCWIN_BUILD_SELFTEST_PASS' if not bad else f'\n❌ {bad} 條失敗')
    return 1 if bad else 0


if __name__ == '__main__':
    import argparse
    if '--selftest' in sys.argv:
        sys.exit(_selftest())
    ap = argparse.ArgumentParser(description='CCWIN 法說會清單(+ 安慰劑)')
    ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--shuffle', type=int, default=None)
    a = ap.parse_args()
    m = load_map(json.load(open(a.src, encoding='utf8')))
    if not m:
        print(f'❌ {a.src} 讀不到任何法說會日期 → ⛔ 不寫檔')
        sys.exit(1)
    tag = ''
    if a.shuffle is not None:
        m2 = shuffle_map(m, a.shuffle)
        same = sum(1 for k in m if m2[k] == m[k])
        m = m2
        tag = f'(🎲 安慰劑:日期配給別的檔,種子 {a.shuffle},配回自己的 {same} 檔)'
    with open(a.out, 'w', encoding='utf8') as f:
        json.dump(m, f)
    alld = sorted(d for v in m.values() for d in v)
    print(f'📞 {a.out}:{len(m)} 檔・{len(alld)} 場・{alld[0]} ~ {alld[-1]}{tag}')
