#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💰 重大訊息內文(說明欄)→ 金額(V82.7.5,評估紀錄 58 第 1 步)

為什麼:使用者 11/28 貼的那個 App 每則消息標「高 / 中」—— 真正在分的是**消息多大**。
本站 2010 年起 91 萬則重大訊息只存了主旨(主旨有金額的只有 3.4%),金額都在內文的說明欄。
這支只做一件事:從說明欄抓「這則公告講的那個金額」。每天(mops_daily)與回補歷史(mops_backfill detail)同一份。

⛔ 明文規則、⛔ AI(禁 AI 算數);規則本身印得出來、測得到:
 ① 找「標籤」,照下面 LABELS 的順序(前面的優先)。同一個標籤可能先出現在題目(「5.交易單位數量、每單位價格及交易總金額:」),
    真正的金額在後面同一項 → 每個出現的位置都往後看 WIN 個字,取**第一個「(幣別)數字 金額單位」**。
 ② 一定要有金額單位(元 / 仟元 / 千元 / 萬元 / 百萬元 / 仟萬元 / 億元)才算 ——「100%股權」「13,050,000股」⛔ 算。
 ③ 幣別:新台幣 / 新臺幣 / NT$ / 台幣 → TWD;人民幣 / RMB → CNY;美金 / 美元 / US$ / USD → USD;日圓 / 日幣 → JPY;歐元 → EUR;
    前後都沒寫 → TWD(公告的金額欄沒寫幣別就是新台幣),並記 cur_note='沒寫幣別'。
 ④ 金額是 0、或那一項寫「不適用」「無」→ 這個標籤當沒有,往下一個標籤找(⛔ 寫 0)。
 ⑤ 一則公告有好幾個金額 → 只取優先序最前面那個標籤抓到的(⛔ 加總、⛔ 取最大)。
輸出:{'amt': 元(float), 'cur': 'TWD'…, 'label': 標籤, 'ev': 金額那句原文(≤120 字,給人核對), 'cur_note': …} 或 None

跑法:python3 scripts/lib_mops_amount.py --selftest
"""
import re
import sys

WIN = 90                     # 標籤後面往後看幾個字
EV_MAX = 120

# 照優先序:這則公告「主要那個金額」的名字(⛔ 照順序;越前面越是那則的主角)
LABELS = (
    '交易總金額', '交易金額',
    '契約總金額', '合約總金額', '契約總價', '合約總價', '契約金額', '合約金額',
    '訂單總金額', '訂單金額', '得標金額', '決標金額', '標案金額',
    '募集總金額', '發行總金額', '募集金額',
    '預定買回之總金額上限', '預定買回股份總金額上限', '買回股份總金額', '買回總金額',
    '總金額', '金額',
)

_CUR = {'新台幣': 'TWD', '新臺幣': 'TWD', 'NT$': 'TWD', 'NTD': 'TWD', '台幣': 'TWD', '臺幣': 'TWD',
        '人民幣': 'CNY', 'RMB': 'CNY', 'CNY': 'CNY',
        '美金': 'USD', '美元': 'USD', 'US$': 'USD', 'USD': 'USD',
        '日圓': 'JPY', '日幣': 'JPY', 'JPY': 'JPY', '歐元': 'EUR', 'EUR': 'EUR'}
_UNIT = {'億元': 1e8, '仟萬元': 1e7, '千萬元': 1e7, '百萬元': 1e6, '萬元': 1e4, '仟元': 1e3, '千元': 1e3, '元': 1.0}
_CUR_RE = '|'.join(re.escape(k) for k in sorted(_CUR, key=len, reverse=True))
_UNIT_RE = '|'.join(re.escape(k) for k in sorted(_UNIT, key=len, reverse=True))
MONEY = re.compile(
    rf'(?P<cur>{_CUR_RE})?\s*[::]?\s*約?\s*'
    rf'(?P<num>\d{{1,3}}(?:,\d{{3}})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*'
    rf'(?P<unit>{_UNIT_RE})(?P<cur2>{_CUR_RE})?')
_NA = re.compile(r'^[\s::]*(?:不適用|無|N/?A)(?:[\s。;;,,]|$)')


def _clean(t):
    return re.sub(r'\s+', ' ', str(t or '')).strip()


def parse_amount(say):
    """說明欄文字 → {'amt','cur','label','ev','cur_note'} 或 None(規則見檔頭)"""
    t = _clean(say)
    if not t:
        return None
    for lab in LABELS:
        start = 0
        while True:
            i = t.find(lab, start)
            if i == -1:
                break
            start = i + len(lab)
            seg = t[start:start + WIN]
            if _NA.match(seg):
                continue
            m = MONEY.search(seg)
            if not m:
                continue
            try:
                amt = float(m.group('num').replace(',', '')) * _UNIT[m.group('unit')]
            except (ValueError, KeyError):
                continue
            if amt <= 0:
                continue
            ck = m.group('cur') or m.group('cur2')
            ev = t[i:start + m.end()]
            return {'amt': amt, 'cur': _CUR[ck] if ck else 'TWD', 'label': lab,
                    'ev': ev[:EV_MAX], 'cur_note': '' if ck else '沒寫幣別'}
    return None


def to_yi(amt):
    """元 → 億元(兩位小數);None → None"""
    return None if amt is None else round(amt / 1e8, 2)


# ───────────────────────── selftest ─────────────────────────
# 真內文(mops_probe detail 模式,run 46080900577,2026-11-27):光寶科 2301 #2、穎漢 4562 #1(節錄,一字沒改)
REAL_LITEON = ('說明 1.事實發生日:自民國115/11/27至民國115/11/27 2.本次新增（減少）投資方式: 透過本公司子公司直接收購大陸地區公司股權取得經營控制權。 '
               '3.董事會通過日期: 民國115年6月12日 4.其他核決日期: 不適用 5.交易單位數量、每單位價格及交易總金額: 取得南京能利芯科技有限公司100%股權； '
               '交易總金額為人民幣8億元，實際交易價款依契約約定調整機制辦理。 6.大陸被投資公司之公司名稱: 南京能利芯科技有限公司 '
               '7.前開大陸被投資公司之實收資本額: 人民幣5,356,068元 8.前開大陸被投資公司本次擬新增資本額: 不適用 '
               '11.前開大陸被投資公司最近年度財務報表權益總額: 人民幣67,172,099.07元 13.迄目前為止，對前開大陸被投資公司之實際投資金額: 人民幣0元')
REAL_YINGHAN = ('說明 1.事實發生日:115/11/27 2.公司名稱:穎漢科技股份有限公司 3.與公司關係(請輸入本公司或子公司):本公司 4.相互持股比例:不適用 '
                '5.發生緣由:(1)本公司115年現金增資發行普通股13,050,000股乙案，業經金 融監督管理委員會115年10月19日金管證發字第1150356313號函申報生效， '
                '並於115年11月5日及11月13日公告本次現金增資認股基準日及增資價格等相關事宜。 6.因應措施:無。')


def selftest():
    fails = []

    def ok(n, c, e=''):
        print(('  ✅ ' if c else '  ❌ ') + n + ('' if c else '  ' + str(e)[:200]))
        if not c:
            fails.append(n)

    r = parse_amount(REAL_LITEON)
    ok('① 真內文(光寶科子公司收購):交易總金額 = 人民幣 8 億元(⛔ 抓成題目後面的「100%股權」)',
       bool(r) and r['amt'] == 8e8 and r['cur'] == 'CNY' and r['label'] == '交易總金額', r)
    ok('① 金額那句原文帶回來給人核對(≤120 字、含「8億元」)', bool(r) and '8億元' in r['ev'] and len(r['ev']) <= EV_MAX, r and r['ev'])
    ok('② 真內文(穎漢暫停現增):沒有金額 → None(⛔「13,050,000股」當成金額)', parse_amount(REAL_YINGHAN) is None, parse_amount(REAL_YINGHAN))
    ok('③ 單位換算:仟元 / 萬元 / 億元 / 元',
       parse_amount('交易總金額:新台幣1,234,567仟元')['amt'] == 1234567e3
       and parse_amount('交易金額:新台幣3,500萬元')['amt'] == 3500e4
       and parse_amount('契約總金額:約新台幣1.64億元')['amt'] == 1.64e8
       and parse_amount('交易總金額:NT$48,070,000元')['amt'] == 48070000)
    ok('④ 幣別:人民幣在後面也認;沒寫 → TWD 並記一筆',
       parse_amount('交易總金額:8億元人民幣')['cur'] == 'CNY'
       and parse_amount('交易總金額:5,000仟元')['cur'] == 'TWD' and parse_amount('交易總金額:5,000仟元')['cur_note'] == '沒寫幣別')
    ok('⑤ 「不適用」/ 0 元 → 這個標籤當沒有,往下一個找(⛔ 寫 0)',
       parse_amount('交易總金額:不適用 契約金額:新台幣2億元')['amt'] == 2e8 and parse_amount('交易總金額:新台幣0元') is None)
    ok('⑥ 優先序:有交易總金額就不看後面的「實際投資金額 人民幣0元」或其他金額(⛔ 加總、⛔ 取最大)',
       parse_amount('實收資本額:人民幣9,999億元 交易總金額:人民幣8億元')['amt'] == 8e8)
    ok('⑦ 庫藏股 / 增資的標籤也認',
       parse_amount('預定買回之總金額上限:新台幣5,123,456,789元')['label'] == '預定買回之總金額上限'
       and parse_amount('募集總金額:新台幣12,170,000仟元')['amt'] == 12170000e3)
    ok('⑧ 億元換算 to_yi:兩位小數', to_yi(1.6449e8) == 1.64 and to_yi(None) is None)
    ok('⑨ 空字串 / None → None', parse_amount('') is None and parse_amount(None) is None)
    print('❌ %d 條沒過' % len(fails) if fails else '✅ MOPS_AMOUNT_SELFTEST_PASS')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    print(__doc__)
