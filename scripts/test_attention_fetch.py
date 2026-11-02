#!/usr/bin/env python3
"""🚨 V80.1.9 處置神器名單(radar_miner.fetch_attention_disposal_status)離線測試。

為什麼要有這支:這支採礦以前沒有任何測試,V80.1.9 一次改了四件事 ——
  ① 上櫃注意股(tpex_trading_warning_information)接上 ② 上市 notice + notetrans 合在一起
  ③ 其他官方名單另放 flags ④ 公告日早於今天的注意名單記回公告那天(⛔ 算成今天)
  外加 🐛 以前 otc_notice 沒有 tried 鍵:全部端點失敗時 `_any_ok` 那行 KeyError。
走正式入口(網路換成假函式、時間固定在 2026-11-02 20:00),每條都有決定性對照。

跑法:python3 scripts/test_attention_fetch.py
"""
import json
import os
import sys
import tempfile
from datetime import datetime as _RealDT

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp())
os.makedirs('data', exist_ok=True)

import radar_miner as rm  # noqa: E402

FAILS = []


def ok(name, cond, got=''):
    print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {str(got)[:300]}'))
    if not cond:
        FAILS.append(name)


class FakeDT(_RealDT):
    @classmethod
    def now(cls, tz=None):
        return _RealDT(2026, 11, 2, 20, 0, 0)


rm.datetime = FakeDT

TW = 'https://openapi.twse.com.tw/v1/'
TP = 'https://www.tpex.org.tw/openapi/v1/'
BASE = {
    TW + 'announcement/notice': [
        {'Number': '1', 'Code': '2330', 'Name': '台積電', 'NumberOfAnnouncement': '1',
         'TradingInfoForAttention': '最近六個營業日累積收盤價漲幅達 32%', 'Date': '1151102', 'ClosingPrice': '1500', 'PE': '25'}],
    TW + 'announcement/notetrans': [
        {'Code': '2603', 'Name': '長榮', 'RecentlyMetAttentionSecuritiesCriteria': 'x'},
        {'Code': '2330', 'Name': '台積電', 'RecentlyMetAttentionSecuritiesCriteria': 'y'}],
    TW + 'announcement/punish': [
        {'Number': '1', 'Date': '1151029', 'Code': '2466', 'Name': '冠西電', 'ReasonsOfDisposition': '連續三次',
         'DispositionPeriod': '115/10/30～115/11/05', 'DispositionMeasures': '第二次處置', 'Detail': '每5分鐘撮合一次'},
        {'Number': '2', 'Date': '1151027', 'Code': '071804', 'Name': '某權證', 'DispositionPeriod': '115/10/28～115/11/03'}],
    TP + 'tpex_trading_warning_information': [
        {'Date': '1151030', 'SecuritiesCompanyCode': '1569', 'CompanyName': '濱川',
         'TradingInformation': '最近六個營業日累積週轉率 86.24%', 'ClosePrice': '92.20', 'PriceEarningRatio': 'N/A'},
        {'Date': '1151102', 'SecuritiesCompanyCode': '6488', 'CompanyName': '環球晶',
         'TradingInformation': '當日週轉率達 21%', 'ClosePrice': '400', 'PriceEarningRatio': '20'},
        {'Date': '1151102', 'SecuritiesCompanyCode': '3324', 'CompanyName': '雙鴻',
         'TradingInformation': '當沖比率 63%', 'ClosePrice': '1330', 'PriceEarningRatio': '30'},
        # V80.1.9 傍晚探針:這份一次給兩個交易日 → 6488 在 10/30 也有一列,而且排在 11/02 那列後面
        {'Date': '1151030', 'SecuritiesCompanyCode': '6488', 'CompanyName': '環球晶',
         'TradingInformation': '舊的那天的理由', 'ClosePrice': '390', 'PriceEarningRatio': '20'}],
    TP + 'tpex_disposal_information': [
        {'Date': '1151030', 'SecuritiesCompanyCode': '3324', 'CompanyName': '雙鴻',
         'DispositionPeriod': '115/10/31~115/11/13', 'DispositionReasons': '連續三次', 'DisposalCondition': '每20分鐘撮合'}],
    TW + 'exchangeReport/TWT85U': [{'Code': '1213', 'Name': '大飲', 'PeriodicCallAuctionTrading': '  '}],
    TW + 'Announcement/BFZFZU_T': [{'Number': '0', 'Code': '', 'Name': '', 'Date': '1151030'}],
    TW + 'exchangeReport/BFI84U': [{'Code': '00400A', 'Name': '主動國泰動能高息', 'StartDate': '1151102',
                                     'EndDate': '1151105', 'Reason': '分配收益'}],
    TW + 'exchangeReport/TWTBAU1': [{'Code': '2330', 'Name': '台積電', 'StartDate': '1151103',
                                      'EndDate': '1151109', 'Reason': '除息'}],
}
CALLS = []


class Resp:
    def __init__(self, code, obj):
        self.status_code, self._obj = code, obj

    def json(self):
        if isinstance(self._obj, Exception):
            raise self._obj
        return self._obj


def make_get(table, fail=()):
    def get(url, headers=None, timeout=None, **kw):
        CALLS.append((url, dict(headers or {})))
        if url in fail or '*' in fail:
            raise ConnectionError('fake down')
        if url not in table:
            return Resp(404, ValueError('not json'))
        return Resp(200, table[url])
    return get


def run(table, fail=()):
    CALLS.clear()
    rm.requests.get = make_get(table, fail)
    rm.fetch_attention_disposal_status()


def load(name):
    with open(os.path.join('data', name), encoding='utf-8') as f:
        return json.load(f)


# ── 第一輪:正常 ──
run(BASE)
st = load('attention_status.json')
S, F, D = st['stocks'], st.get('flags', {}), st['diag']
ok('① 上櫃注意股接上:6488 是官方注意,帶理由與公告日(11/02 那列)',
   S.get('6488', {}).get('status', '').startswith('⚠️') and S['6488'].get('date') == '2026-11-02'
   and '週轉率' in S['6488'].get('reason', ''), S.get('6488'))
ok('①c 名單一次給兩天:只在比較舊那天(10/30)的 1569 ⛔ 算「現在的注意股」',
   '1569' not in S and D['otc_notice'].get('older') == 1, (sorted(S), D['otc_notice']))
ok('①d 同一檔兩天都有、舊那天那列排在後面 → 留最新那天(⛔ 被蓋成 10/30)',
   S.get('6488', {}).get('date') == '2026-11-02' and '舊的' not in S['6488'].get('reason', ''), S.get('6488'))
ok('①b 決定性對照:同一檔又在上櫃處置 → 以處置為準(3324 🚨、20 分盤、出關 11/13)',
   S.get('3324', {}).get('status', '').startswith('🚨') and S['3324'].get('interval') == 20
   and S['3324'].get('end_date') == '2026-11-13', S.get('3324'))
ok('② 上市 notice + notetrans 合在一起(2330 來自 notice、2603 只在 notetrans)',
   '2330' in S and '2603' in S and D['tw_notice']['hit'] == 'notice+notetrans', (sorted(S), D['tw_notice']))
ok('②b 兩個名單都有的那檔以 notice 為準(有當天理由)', '漲幅' in S['2330'].get('reason', ''), S['2330'])
ok('②c 上市處置照舊(2466 5 分盤、出關 11/05)、權證 071804 ⛔ 收',
   S.get('2466', {}).get('interval') == 5 and S['2466'].get('end_date') == '2026-11-05' and '071804' not in S, S.get('2466'))
ok('③ 其他官方名單另放 flags:變更交易 1213、停資停券 00400A(起訖)、暫停先賣後買 2330',
   F.get('1213', [{}])[0].get('k') == 'change_trade'
   and F.get('00400A', [{}])[0].get('from') == '2026-11-02' and F['00400A'][0].get('to') == '2026-11-05'
   and F.get('2330', [{}])[0].get('k') == 'no_dt_sell_first', F)
ok('③b 佔位列(代號空白)⛔ 收:理財節目異常推介 0 檔、flags 不混進 stocks',
   D['flags'].get('tv_pump') == 0 and '1213' not in S and '00400A' not in S, (D['flags'], sorted(S)))
H = load('attention_history.json')['history']
ok('④ 今天的歷史:2330 / 2603 / 6488 注意、3324 / 2466 處置',
   H.get('2026-11-02', {}).get('2330') == '注意' and H['2026-11-02'].get('6488') == '注意'
   and H['2026-11-02'].get('2603') == '注意' and H['2026-11-02'].get('3324') == '處置'
   and H['2026-11-02'].get('2466') == '處置', H.get('2026-11-02'))
ok('④b 公告日 10/30 的上櫃注意 1569 ⛔ 算成今天,記回 10/30',
   '1569' not in H.get('2026-11-02', {}) and H.get('2026-10-30', {}).get('1569') == '注意', H)
ok('⑤ ⛔ 不偽裝瀏覽器:每一次請求的 UA 都寫明 StockAI-DB、沒有 Referer',
   CALLS and all('StockAI-DB' in h.get('User-Agent', '') and 'Referer' not in h for _, h in CALLS),
   [h for _, h in CALLS][:2])

# ── 第二輪:同一天重跑 → 歷史不重複累加 ──
run(BASE)
H2 = load('attention_history.json')['history']
ok('⑥ 同一天重跑:10/30 那天只有原本那幾檔(⛔ 重複加)、今天照樣覆蓋',
   H2.get('2026-10-30') == {'1569': '注意'} and H2.get('2026-11-02') == H.get('2026-11-02'), H2.get('2026-10-30'))

# ── 第三輪:其他官方名單全部抓不到 → 注意 / 處置照寫 ──
run(BASE, fail=tuple(u for u in BASE if 'exchangeReport' in u or 'BFZFZU' in u))
st3 = load('attention_status.json')
ok('⑦ 其他官方名單全掛 → flags 空、diag 記 -1,注意 / 處置照寫(⛔ 被拖垮)',
   st3['flags'] == {} and set(st3['diag']['flags'].values()) == {-1} and '6488' in st3['stocks'], st3['diag']['flags'])

# ── 第四輪:全部端點都連不上 → ⛔ 炸、⛔ 覆蓋昨天的名單 ──
before = open(os.path.join('data', 'attention_status.json'), encoding='utf-8').read()
err = None
try:
    run(BASE, fail=('*',))
except Exception as e:  # noqa: BLE001
    err = e
after = open(os.path.join('data', 'attention_status.json'), encoding='utf-8').read()
ok('⑧ 全部連不上:⛔ 丟例外(以前 otc_notice 沒 tried 鍵 → KeyError)、昨天的名單一個字不動',
   err is None and before == after, err)

# ── 決定性對照:把上櫃注意那行拿掉(回到 V80.1.7)→ ① 一定紅 ──
src = open(os.path.join(ROOT, 'radar_miner.py'), encoding='utf-8').read()
ok('⑨ 決定性對照:採礦程式裡真的有打 tpex_trading_warning_information(拿掉 = 上櫃注意股又變空)',
   src.count('tpex_trading_warning_information') >= 1 and 'otc_attention = {}' not in src)

print(f'\n{"✅ 全過" if not FAILS else "❌ 失敗 " + str(len(FAILS)) + " 條"}(共 15 條)')
sys.exit(1 if FAILS else 0)
