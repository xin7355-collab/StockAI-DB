#!/usr/bin/env python3
"""🗓️ 美國三種「排定的日子」的歷史日期(研究用):聯準會開會(排定的,決議日)・CPI 公布日・非農(就業報告)公布日。

為什麼要有這支:使用者 11/17 同意補測「聯準會、CPI、非農」那幾天台股的反應(要存歷史公布日期 = 新資料)。
App 行事曆裡這三種是用規則湊的(CPI = 每月 10~14 日第一個平日、非農 = 第一個星期五)→ 拿來回測會把日子算錯;
歷史日期要拿官方的。⚠️ 沙箱連不到這些網站 → 只能在 GitHub Actions 跑(macro_probe which=us_cal),log 說了算。

來源(只從官方頁面往下一層,⛔ 猜 API 網址;陷阱 #23):
 ① 聯準會 fomccalendars.htm(近幾年)+ fomc_historical_year.htm 列出的每一年那一頁(較早)
 ② 勞工統計局(BLS)歷次新聞稿存檔索引(CPI / Employment Situation):連結檔名裡的日期 = 公布日
 ③ ② 被擋時:聖路易聯準銀行 ALFRED 的 release 頁 —— 只把頁面上真的有的「日期 / 下載」連結列出來,下一輪再接
只讀:⛔ 寫任何分支 / 資料檔;⛔ 用金鑰;⛔ 偽裝瀏覽器(lib_http.Gate 的 UA 寫明是誰);被擋(401 / 403)就停、照實記。
輸出:log 最後一段 `US_CAL|種類|日期,日期…`(每行最多 20 個)→ 人工核對每年次數後存成 research/us_cal.json。

跑法:python3 scripts/us_cal_probe.py [--selftest]
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

FED_CAL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
FED_HIST = 'https://www.federalreserve.gov/monetarypolicy/fomc_historical_year.htm'
BLS_ARCH = {'cpi': 'https://www.bls.gov/bls/news-release/cpi.htm', 'nfp': 'https://www.bls.gov/bls/news-release/empsit.htm'}
BLS_TAG = {'cpi': 'cpi', 'nfp': 'empsit'}
ALFRED = {'cpi': 'https://alfred.stlouisfed.org/release?rid=10', 'nfp': 'https://alfred.stlouisfed.org/release?rid=50'}
FROM_YEAR = 2000

MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
MON3 = {m[:3].lower(): i + 1 for i, m in enumerate(MONTHS)}
MON_RE = '|'.join(MONTHS)


def strip_tags(html):
    t = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', html or '', flags=re.S | re.I)
    t = re.sub(r'<[^>]+>', ' ', t)
    return re.sub(r'\s+', ' ', t.replace('&nbsp;', ' ').replace('&ndash;', '-').replace('–', '-')).strip()


def mon_no(txt):
    """'January' / 'Jan' / 'Apr/May' 的最後一個月份 → 1~12;認不出 → None"""
    parts = [p for p in re.split(r'[/\s]+', (txt or '').strip()) if p]
    for p in reversed(parts):
        k = p[:3].lower()
        if k in MON3:
            return MON3[k]
    return None


def fomc_entry(y, mtxt, dtxt):
    """行事曆那一列 → {'d': 'YYYY-MM-DD'(最後一天 = 決議日), 'raw', 'sched'};日期認不出 → None。
    dtxt 例:'27-28'、'17-18*'、'31-1'(跨月,月份寫 'Jan/Feb')、'3 (unscheduled)'、'22 (notation vote)'"""
    m = mon_no(mtxt)
    head = re.split(r'\(', dtxt or '', maxsplit=1)[0]
    nums = re.findall(r'\d{1,2}', head)
    if not m or not nums:
        return None
    note = (dtxt or '').lower()
    sched = not any(k in note for k in ('unscheduled', 'notation', 'cancel', 'conference call'))
    return {'d': f'{y:04d}-{m:02d}-{int(nums[-1]):02d}', 'raw': f'{mtxt.strip()} {dtxt.strip()}', 'sched': sched}


def parse_fomc_calendar(html):
    """fomccalendars.htm → 每一列一筆(含沒排定的,sched=False)。年份看「2026 FOMC Meetings」那種標題。"""
    out = []
    parts = re.split(r'(\d{4})\s+FOMC Meetings', html or '')
    for k in range(1, len(parts) - 1, 2):
        y, block = int(parts[k]), parts[k + 1]
        for mraw, draw in re.findall(r'fomc-meeting__month[^>]*>(.*?)</div>\s*<div[^>]*fomc-meeting__date[^>]*>(.*?)</div>', block, flags=re.S):
            e = fomc_entry(y, strip_tags(mraw), strip_tags(draw))
            if e:
                out.append(e)
    return out


HIST_RE = re.compile(
    r'\b(' + MON_RE + r')\s+(\d{1,2})(?:\s*-\s*(?:(' + MON_RE + r')\s+)?(\d{1,2}))?\s*,?\s*'
    r'(Meeting|Conference Calls?|\(?[Uu]nscheduled\)?|Notation Votes?)\b')


def parse_fomc_hist(html, year):
    """較早那幾年的頁面:標題長得像「January 29-30 Meeting - 2008」「January 21 Conference Call - 2008」「July 31-August 1 Meeting - 2012」。
    只有寫 Meeting 的算排定的。"""
    out, seen = [], set()
    for m1, d1, m2, d2, kind in HIST_RE.findall(strip_tags(html)):
        mon = MON3[(m2 or m1)[:3].lower()]
        day = int(d2 or d1)
        d = f'{int(year):04d}-{mon:02d}-{day:02d}'
        sched = kind == 'Meeting'
        if (d, sched) in seen:
            continue
        seen.add((d, sched))
        out.append({'d': d, 'raw': f'{m1} {d1}' + (f'-{m2 + " " if m2 else ""}{d2}' if d2 else '') + f' {kind}', 'sched': sched})
    return out


def hist_links(html):
    """fomc_historical_year.htm 裡真的有的每年那一頁 → {年: 相對網址}"""
    return {int(y): h for h, y in re.findall(r'href="([^"]*fomchistorical(\d{4})\.htm)"', html or '')}


def parse_bls_arch(html, tag):
    """BLS 存檔索引的連結檔名 cpi_MMDDYYYY.htm / empsit_MMDDYYYY.htm → 排序後不重複的 'YYYY-MM-DD'"""
    ds = {f'{y}-{m}-{d}' for m, d, y in re.findall(r'archives/' + re.escape(tag) + r'_(\d{2})(\d{2})(\d{4})\.htm', html or '')}
    return sorted(x for x in ds if '1990' <= x[:4] <= '2099' and '01' <= x[5:7] <= '12' and '01' <= x[8:10] <= '31')


def interesting_links(html, words=('date', 'download', 'calendar')):
    hs = re.findall(r'href="([^"]+)"', html or '')
    return sorted({h for h in hs if any(w in h.lower() for w in words)})[:40]


def per_year(dates):
    c = {}
    for d in dates:
        c[d[:4]] = c.get(d[:4], 0) + 1
    return c


def emit(kind, dates):
    ds = sorted(set(dates))
    for i in range(0, len(ds), 20):
        print(f'US_CAL|{kind}|' + ','.join(ds[i:i + 20]))


def selftest():
    fails, n = [], [0]

    def ok(name, cond, got=''):
        n[0] += 1
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(got)[:300]}'))
        if not cond:
            fails.append(name)

    cal = '''<h4><a id="1">2026 FOMC Meetings</a></h4>
      <div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>January</strong></div>
      <div class="fomc-meeting__date col-xs-4">27-28</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>March</strong></div>
      <div class="fomc-meeting__date col-xs-4">17-18*</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>Apr/May</strong></div>
      <div class="fomc-meeting__date">30-1</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>August</strong></div>
      <div class="fomc-meeting__date">22 (notation vote)</div></div>
      <h4><a id="2">2025 FOMC Meetings</a></h4>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>March</strong></div>
      <div class="fomc-meeting__date">3 (unscheduled)</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>Oct/Nov</strong></div>
      <div class="fomc-meeting__date">31-1</div></div>'''
    c = parse_fomc_calendar(cal)
    ok('① 行事曆:決議日 = 最後一天(27-28 → 28)、星號不影響、年份跟著標題走',
       [x['d'] for x in c if x['sched']] == ['2026-01-28', '2026-03-18', '2026-05-01', '2025-11-01'], c)
    ok('①b 跨月(Apr/May 30-1 → 5/1;Oct/Nov 31-1 → 11/1)', c[2]['d'] == '2026-05-01' and c[-1]['d'] == '2025-11-01', c)
    ok('①c 沒排定的 / 書面表決 → sched=False(⛔ 混進排定的)',
       [x['d'] for x in c if not x['sched']] == ['2026-08-22', '2025-03-03'], c)
    ok('①d 決定性對照:取第一天會錯(1/27 ≠ 決議日)', c[0]['d'] != '2026-01-27')
    hist = '''<h5 class="panel-heading">January 21 Conference Call - 2008</h5><h5>January 29-30 Meeting - 2008</h5>
      <p>Statement</p><h5>March 18 Meeting - 2008</h5><h5>October 7 Conference Call - 2008</h5>
      <h5>July 31-August 1 Meeting - 2008</h5><p>Minutes of the meeting released March 11, 2008</p><h5>March 15 (unscheduled) - 2008</h5>'''
    h = parse_fomc_hist(hist, 2008)
    ok('② 較早那幾年:只有寫 Meeting 的算排定的;跨月取後面那個月',
       [x['d'] for x in h if x['sched']] == ['2008-01-30', '2008-03-18', '2008-08-01'], h)
    ok('②b 電話會議 / 沒排定的 → sched=False;內文裡的日期(released March 11)⛔ 算',
       sorted(x['d'] for x in h if not x['sched']) == ['2008-01-21', '2008-03-15', '2008-10-07']
       and not any(x['d'] == '2008-03-11' for x in h), h)
    idx = '<a href="/monetarypolicy/fomchistorical2008.htm">2008</a> <a href="/monetarypolicy/fomchistorical1999.htm">1999</a>'
    ok('③ 每年那一頁的連結從索引頁讀(⛔ 自己拼網址)', hist_links(idx) == {2008: '/monetarypolicy/fomchistorical2008.htm', 1999: '/monetarypolicy/fomchistorical1999.htm'})
    bls = '<a href="/news.release/archives/cpi_02132019.htm">HTML</a><a href="/news.release/archives/cpi_02132019.pdf">PDF</a>' \
          '<a href="/news.release/archives/cpi_01112019.htm">x</a><a href="/news.release/archives/empsit_02012019.htm">y</a>' \
          '<a href="/news.release/archives/cpi_13452019.htm">壞的</a>'
    ok('④ BLS 存檔連結:檔名 MMDDYYYY → 日期、排序、不重複;別的新聞稿不混進來;壞日期丟掉',
       parse_bls_arch(bls, 'cpi') == ['2019-01-11', '2019-02-13'] and parse_bls_arch(bls, 'empsit') == ['2019-02-01'], parse_bls_arch(bls, 'cpi'))
    ok('⑤ 每年次數', per_year(['2019-01-11', '2019-02-13', '2020-01-14']) == {'2019': 2, '2020': 1})
    ok('⑥ 月份:全名 / 縮寫 / 兩個月取後面;亂字 → None', mon_no('January') == 1 and mon_no('Jan/Feb') == 2 and mon_no('September') == 9 and mon_no('xyz') is None)
    print(f'\n{"❌ " + str(len(fails)) + " 條失敗" if fails else "✅ US_CAL_SELFTEST_PASS"}({n[0]} 條)')
    return 1 if fails else 0


def main():
    from lib_http import Gate, page_text
    g = Gate(gaps={'www.federalreserve.gov': 2.0, 'www.bls.gov': 3.0, 'alfred.stlouisfed.org': 2.0}, backoff=(2, 4, 8), timeout=40)
    bad = []

    def fetch(url, label):
        res, why = g.get(url, expect='html')
        if res is None:
            host = url.split('/')[2]
            print(f'❌ {label}:{why}  {url}  擋頁/錯誤頁開頭:{(g.blocked_page.get(host) or g.fail_page.get(host) or "")[:160]}')
            return None
        body = res.content.decode('utf-8', errors='replace')
        t = re.search(r'<title[^>]*>(.*?)</title>', body, flags=re.S | re.I)
        print(f'✅ {label}:{len(body):,} 字元  標題「{strip_tags(t.group(1))[:80] if t else "?"}」  {url}')
        return body

    # ① 聯準會
    fomc = []
    cal = fetch(FED_CAL, '聯準會行事曆(近幾年)')
    if cal:
        c = parse_fomc_calendar(cal)
        fomc += c
        print(f'   解析出 {len(c)} 列(排定 {sum(1 for x in c if x["sched"])});年份 {sorted({x["d"][:4] for x in c})}')
        if not c:
            print('   ⚠️ 一列都沒解析到 → 頁面開頭:', strip_tags(cal)[:400])
            print('   ⚠️ 含 fomc-meeting 的片段:', [s[:200] for s in re.findall(r'.{0,60}fomc-meeting.{0,140}', cal)[:4]])
    idx = fetch(FED_HIST, '聯準會較早年份索引')
    if idx:
        links = hist_links(idx)
        print(f'   索引頁列出 {len(links)} 年:{min(links) if links else "-"} ~ {max(links) if links else "-"}')
        if not links:
            print('   ⚠️ 沒找到每年那一頁的連結 → 含 histor 的連結:', interesting_links(idx, ('histor',)))
        have = {x['d'][:4] for x in fomc}
        for y in sorted(k for k in links if k >= FROM_YEAR and str(k) not in have):
            u = links[y] if links[y].startswith('http') else 'https://www.federalreserve.gov' + links[y]
            body = fetch(u, f'聯準會 {y}')
            if not body:
                bad.append(f'聯準會 {y}')
                continue
            h = parse_fomc_hist(body, y)
            fomc += h
            if sum(1 for x in h if x['sched']) != 8:
                print(f'   ⚠️ {y} 排定的不是 8 次({sum(1 for x in h if x["sched"])})→ 全部:{[x["raw"] for x in h]}')
                if not h:
                    print('      頁面文字開頭:', strip_tags(body)[:500])
    sched = sorted({x['d'] for x in fomc if x['sched']})
    unsched = sorted({x['d'] for x in fomc if not x['sched']})
    print(f'\n聯準會:排定 {len(sched)} 次、沒排定 / 電話會議 {len(unsched)} 次;每年排定次數:{per_year(sched)}')
    print('   沒排定的:', unsched)

    # ② CPI / 非農:BLS 存檔索引;被擋 → 只把 ALFRED 那一頁真的有的連結列出來
    rel = {}
    for k in ('cpi', 'nfp'):
        body = fetch(BLS_ARCH[k], f'BLS 存檔索引({k})')
        ds = parse_bls_arch(body, BLS_TAG[k]) if body else []
        rel[k] = ds
        if ds:
            print(f'   {k}:{len(ds)} 個公布日 {ds[0]} ~ {ds[-1]};每年次數:{per_year([d for d in ds if d[:4] >= str(FROM_YEAR)])}')
        else:
            if body:
                print(f'   ⚠️ {k}:頁面有回、但沒解析到連結 → 含 archives 的連結:', interesting_links(body, ('archives',))[:8], ' 文字開頭:', strip_tags(body)[:300])
            a = fetch(ALFRED[k], f'ALFRED release 頁({k})')
            if a:
                print('   頁面上真的有的「日期 / 下載」連結:', interesting_links(a))
                print('   文字開頭:', strip_tags(a)[:400])
            bad.append(f'{k} 公布日')

    print('\n===US_CAL_BEGIN===')
    emit('fomc', sched)
    emit('fomc_unsched', unsched)
    emit('cpi', [d for d in rel['cpi'] if d[:4] >= str(FROM_YEAR)])
    emit('nfp', [d for d in rel['nfp'] if d[:4] >= str(FROM_YEAR)])
    print('===US_CAL_END===')
    print(json.dumps({'stats': g.stats, 'open': g.open, 'missing': bad}, ensure_ascii=False))
    # 三種都沒拿到 = 沒驗到 → 紅燈;拿到一部分 → 綠燈、缺的寫在 missing(⛔ 默默當成功)
    return 1 if (not sched and not rel['cpi'] and not rel['nfp']) else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
