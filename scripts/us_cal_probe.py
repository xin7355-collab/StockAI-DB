#!/usr/bin/env python3
"""🗓️ 美國三種「排定的日子」的歷史日期(研究用):聯準會開會(排定的,決議日)・CPI 公布日・非農(就業報告)公布日。

為什麼要有這支:使用者 11/17 同意補測「聯準會、CPI、非農」那幾天台股的反應(要存歷史公布日期 = 新資料)。
App 行事曆裡這三種是用規則湊的(CPI = 每月 10~14 日第一個平日、非農 = 第一個星期五)→ 拿來回測會把日子算錯;
歷史日期要拿官方的。⚠️ 沙箱連不到這些網站 → 只能在 GitHub Actions 跑(macro_probe which=us_cal),log 說了算。

來源(只從官方頁面往下一層,⛔ 猜 API 網址;陷阱 #23):
 ① 聯準會 fomccalendars.htm(近幾年)+ fomc_historical_year.htm 列出的每一年那一頁(較早)
 ② 聖路易聯準銀行 ALFRED 的 release 頁(CPI rid=10、Employment Situation rid=50)上真的有的「下載公布日」連結
    (第一輪試過勞工統計局 BLS 的存檔索引:回 403 Access Denied、不給自動程式抓 → ⛔ 再試、⛔ 換 UA)
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


MON_TOK = r'[A-Z][a-z]{2,8}\.?'
HIST_RE = re.compile(
    r'(?<![A-Za-z])(' + MON_TOK + r'(?:\s*/\s*' + MON_TOK + r')?)\s+(\d{1,2})(?:\s*-\s*(?:(' + MON_TOK + r')\s+)?(\d{1,2}))?\s*,?\s*'
    r'(Meeting|Conference Calls?|\(?[Uu]nscheduled\)?|Notation Votes?)\b')


def parse_fomc_hist(html, year):
    """較早那幾年的頁面:標題長得像「January 29-30 Meeting - 2008」「January 21 Conference Call - 2008」
    「July 31-August 1 Meeting - 2012」;2017 / 2018 的跨月寫法不一樣(第一輪實跑漏了 3 次)→ 月份那一段放寬、交給 mon_no。
    只有寫 Meeting 的算排定的。"""
    out, seen = [], set()
    for m1, d1, m2, d2, kind in HIST_RE.findall(strip_tags(html)):
        mon = mon_no(m2) if m2 else mon_no(m1)
        if not mon or mon_no(m1) is None:
            continue
        day = int(d2 or d1)
        d = f'{int(year):04d}-{mon:02d}-{day:02d}'
        sched = kind == 'Meeting'
        if (d, sched) in seen:
            continue
        seen.add((d, sched))
        out.append({'d': d, 'raw': f'{m1} {d1}' + (f'-{m2 + " " if m2 else ""}{d2}' if d2 else '') + f' {kind}', 'sched': sched})
    return out


def merge_two_day(dates):
    """排定的兩筆剛好差一天(2003-09-15 / 09-16:前一天是另外加開的一場,聲明在後一天)→ 只留後面那天。"""
    ds = sorted(set(dates))
    drop = set()
    for a, b in zip(ds, ds[1:]):
        from datetime import date
        if (date.fromisoformat(b) - date.fromisoformat(a)).days == 1:
            drop.add(a)
    return [d for d in ds if d not in drop]


def parse_dates_txt(text):
    """ALFRED「下載公布日」那個檔 → 裡面所有 YYYY-MM-DD(排序、不重複)。格式第一次看,先寬鬆抓、每年次數由人核對。"""
    return sorted({d for d in re.findall(r'(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)', text or '') if '1900' <= d[:4] <= '2099'})


def hist_links(html):
    """fomc_historical_year.htm 裡真的有的每年那一頁 → {年: 相對網址}"""
    return {int(y): h for h, y in re.findall(r'href="([^"]*fomchistorical(\d{4})\.htm)"', html or '')}


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
    h2 = parse_fomc_hist('<h5>Jan/Feb 31-1 Meeting - 2017</h5><h5>October/November 31-1 Meeting - 2017</h5><h5>March 14-15 Meeting - 2017</h5>'
                         '<p>Chairman 12 Meeting notes</p><h5>Oct./Nov. 30-1 Meeting - 2017</h5>', 2017)
    ok('②c 跨月的另一種寫法(Jan/Feb 31-1、October/November 31-1、Oct./Nov. 30-1)→ 取後面那個月;不是月份的字(Chairman 12 Meeting)⛔ 算',
       [x['d'] for x in h2] == ['2017-02-01', '2017-11-01', '2017-03-15'], h2)
    ok('②d 排定的兩筆差一天(2003-09-15 / 16)→ 只留後面那天;差兩天以上照留',
       merge_two_day(['2003-09-15', '2003-09-16', '2003-10-28', '2003-10-30']) == ['2003-09-16', '2003-10-28', '2003-10-30'])
    ok('②e 下載檔:抓出所有 YYYY-MM-DD、排序不重複;長數字裡的不算',
       parse_dates_txt('Release Dates\n2020-01-14\n2020-01-14 x\n2019-12-11\n120200-01-145') == ['2019-12-11', '2020-01-14'], parse_dates_txt('2020-01-14'))
    idx = '<a href="/monetarypolicy/fomchistorical2008.htm">2008</a> <a href="/monetarypolicy/fomchistorical1999.htm">1999</a>'
    ok('③ 每年那一頁的連結從索引頁讀(⛔ 自己拼網址)', hist_links(idx) == {2008: '/monetarypolicy/fomchistorical2008.htm', 1999: '/monetarypolicy/fomchistorical1999.htm'})
    ok('⑤ 每年次數', per_year(['2019-01-11', '2019-02-13', '2020-01-14']) == {'2019': 2, '2020': 1})
    ok('⑥ 月份:全名 / 縮寫 / 兩個月取後面;亂字 → None', mon_no('January') == 1 and mon_no('Jan/Feb') == 2 and mon_no('September') == 9 and mon_no('xyz') is None)
    print(f'\n{"❌ " + str(len(fails)) + " 條失敗" if fails else "✅ US_CAL_SELFTEST_PASS"}({n[0]} 條)')
    return 1 if fails else 0


def main():
    from lib_http import Gate, page_text
    g = Gate(gaps={'www.federalreserve.gov': 2.0, 'alfred.stlouisfed.org': 2.0}, backoff=(2, 4, 8), timeout=40)
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
                print('      標題原文:', re.findall(r'[A-Za-z./ ]{0,24}\d{1,2}[^A-Za-z]{0,6}[A-Za-z. ]{0,12}\d{0,2}\s*,?\s*Meeting\s*-\s*\d{4}', strip_tags(body))[:14])
                if not h:
                    print('      頁面文字開頭:', strip_tags(body)[:500])
    sched = merge_two_day([x['d'] for x in fomc if x['sched']])
    print('   2026 / 2027 原文:', [x['raw'] for x in fomc if x['d'][:4] in ('2026', '2027')])
    unsched = sorted({x['d'] for x in fomc if not x['sched']})
    print(f'\n聯準會:排定 {len(sched)} 次、沒排定 / 電話會議 {len(unsched)} 次;每年排定次數:{per_year(sched)}')
    print('   沒排定的:', unsched)

    # ② CPI / 非農:BLS 存檔索引第一輪實跑回 403(Access Denied:不給自動程式抓)→ ⛔ 再試、⛔ 換 UA。
    #    改走 ALFRED release 頁上真的有的「下載公布日」連結(第一輪 log 印出來的 /release/downloaddates?rid=…);頁面上沒有那個連結就不抓
    rel = {}
    for k in ('cpi', 'nfp'):
        rel[k] = []
        a = fetch(ALFRED[k], f'ALFRED release 頁({k})')
        if not a:
            bad.append(f'{k} 公布日')
            continue
        link = next((h for h in interesting_links(a) if 'downloaddates' in h), None)
        if not link:
            print('   ⚠️ 頁面上沒有下載公布日的連結 → 有的連結:', interesting_links(a))
            bad.append(f'{k} 公布日')
            continue
        u = link if link.startswith('http') else 'https://alfred.stlouisfed.org' + link
        res, why = g.get(u, expect='txt')
        if res is None:
            print(f'❌ ALFRED 下載公布日({k}):{why}  {u}')
            bad.append(f'{k} 公布日')
            continue
        raw = res.content
        ctype = (getattr(res, 'headers', {}) or {}).get('Content-Type', '?')
        txt = raw.decode('utf-8', errors='replace')
        ds = parse_dates_txt(txt)
        rel[k] = ds
        print(f'✅ ALFRED 下載公布日({k}):{len(raw):,} bytes  Content-Type {ctype}  {u}')
        print('   開頭 300 字:', repr(txt[:300]))
        print('   結尾 120 字:', repr(txt[-120:]))
        print(f'   {len(ds)} 個日期 {ds[0] if ds else "-"} ~ {ds[-1] if ds else "-"};{FROM_YEAR} 起每年次數:{per_year([d for d in ds if d[:4] >= str(FROM_YEAR)])}')
        if not ds:
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
