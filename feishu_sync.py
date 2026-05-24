#!/usr/bin/env python3
"""抖音数据 → 飞书多维表格 同步脚本 v4
- 表1「视频数据总览」: 全量视频最新快照
- 表2「最新作品追踪」: 活跃追踪视频的时间序列
"""
import sqlite3, time, json, urllib.request, urllib.error
from datetime import datetime

APP_ID = "cli_aa9bc01eab789cc5"
APP_SECRET = "VpUQKLK6w5zzbpIYDs1ThbL54CazDpLB"
BASE_TOKEN = "M2GTb9hzMaRbbOse6V6cpkNcnSW"
TABLE_OVERVIEW = "tblZaykpVltZrmbT"   # 视频数据总览
TABLE_TRACKING = "tblt7b8ZSHRLbmrS"   # 最新作品追踪
TABLE_ACCOUNT  = "tblrVLadypRaI5qU"   # 账号总览（粉丝增长）
DB_PATH = "/Users/zhangxinhan/.hermes/douyin_stats.db"

def api(method, path, data=None):
    token_resp = _token()
    token = token_resp['tenant_access_token']
    url = f"https://open.feishu.cn/open-apis{path}"
    body = json.dumps(data, ensure_ascii=False).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"code": e.code, "msg": str(e)}

_token_cache = None
_token_time = 0

def _token():
    global _token_cache, _token_time
    if _token_cache and time.time() - _token_time < 3600:
        return _token_cache
    data = json.dumps({"app_id": APP_ID, "app_secret": APP_SECRET}).encode()
    req = urllib.request.Request(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=10) as resp:
        _token_cache = json.loads(resp.read().decode())
        _token_time = time.time()
    return _token_cache

def fetch_title_map(table_id, key_field='文本'):
    """返回 {key: record_id}"""
    mapping = {}
    page_token = None
    while True:
        url = f'/bitable/v1/apps/{BASE_TOKEN}/tables/{table_id}/records?page_size=500'
        if page_token:
            url += f'&page_token={page_token}'
        resp = api('GET', url)
        if resp.get('code') != 0:
            break
        for item in resp.get('data', {}).get('items', []):
            f = item['fields']
            t = f.get(key_field, '')
            if t:
                mapping[t] = item['record_id']
        if resp['data'].get('has_more'):
            page_token = resp['data']['page_token']
            time.sleep(0.2)
        else:
            break
    return mapping

def upsert_record(table_id, key, fields, existing_map):
    """Create or update a record, keyed by '文本' field."""
    if key in existing_map:
        rid = existing_map[key]
        resp = api('PUT',
            f'/bitable/v1/apps/{BASE_TOKEN}/tables/{table_id}/records/{rid}',
            {"fields": fields})
        return resp.get('code') == 0, 'update'
    else:
        resp = api('POST',
            f'/bitable/v1/apps/{BASE_TOKEN}/tables/{table_id}/records',
            {"fields": fields})
        if resp.get('code') == 0:
            existing_map[key] = resp['data']['record']['record_id']
        return resp.get('code') == 0, 'create'

def sync_overview():
    """同步「视频数据总览」—— 仅最近 14 天发布的视频，超期自动清理"""
    conn = sqlite3.connect(DB_PATH)
    latest_ts = conn.execute("SELECT MAX(timestamp) FROM video_stats").fetchone()[0]
    rows = conn.execute("""
        SELECT title, publish_date, plays, likes, comments, shares, favorites,
               ctr, finish_rate, avg_duration_sec, profile_visits, follower_gain
        FROM video_stats WHERE timestamp = ?
        AND (status IS NULL OR status NOT IN ('私密', '自见', '未通过', '审核中', '已删除'))
        AND publish_date >= date('now', 'localtime', '-14 days')
    """, (latest_ts,)).fetchall()
    conn.close()

    existing = fetch_title_map(TABLE_OVERVIEW)

    # 清理飞书上标题为空或播放量为 0 的幽灵行
    cleaned_empty = 0
    page_token = None
    while True:
        url = f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_OVERVIEW}/records?page_size=200'
        if page_token:
            url += f'&page_token={page_token}'
        resp = api('GET', url)
        if resp.get('code') != 0:
            break
        for item in resp.get('data', {}).get('items', []):
            f = item['fields']
            if not f.get('文本') or f.get('播放量', 0) == 0:
                rid = item['record_id']
                del_resp = api('DELETE',
                    f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_OVERVIEW}/records/{rid}')
                if del_resp.get('code') == 0:
                    cleaned_empty += 1
                    existing.pop(f.get('文本', ''), None)
                time.sleep(0.06)
        if resp['data'].get('has_more'):
            page_token = resp['data']['page_token']
            time.sleep(0.2)
        else:
            break

    # 当前窗口中有效的标题集合（截断到 80 字符匹配）
    active_titles = {r[0][:80] for r in rows}

    # 清理飞书上超过 14 天的旧行
    cleaned = 0
    for title, rid in list(existing.items()):
        if title not in active_titles:
            resp = api('DELETE',
                f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_OVERVIEW}/records/{rid}')
            if resp.get('code') == 0:
                del existing[title]
                cleaned += 1
            time.sleep(0.06)

    created, updated, failed = 0, 0, 0

    for r in rows:
        title = r[0][:80]
        plays = r[2] or 0
        eng = round(((r[3] or 0) + (r[4] or 0) + (r[5] or 0)) / max(plays, 1) * 100, 1)
        fields = {
            "文本": title, "发布时间": r[1] or "", "播放量": plays,
            "点赞": r[3] or 0, "评论": r[4] or 0, "分享": r[5] or 0,
            "收藏": r[6] or 0, "5s完播率(%)": r[7] or 0,
            "完播率(%)": r[8] or 0, "均时长(s)": r[9] or 0,
            "互动率(%)": eng, "主页访问量": r[10] or 0,
            "粉丝增量": r[11] or 0, "更新时间": latest_ts,
        }
        ok, action = upsert_record(TABLE_OVERVIEW, title, fields, existing)
        if ok:
            if action == 'create': created += 1
            else: updated += 1
        else:
            failed += 1
        time.sleep(0.06)

    print(f"  📊 数据总览: 更新 {updated} | 新增 {created} | 失败 {failed} | 清理旧数据 {cleaned} | 清空行 {cleaned_empty}")

def sync_tracking():
    """同步「最新作品追踪」—— 只保留最新一条，固定 key「最新追踪」"""
    conn = sqlite3.connect(DB_PATH)

    # 找到活跃追踪的视频
    meta = conn.execute("""
        SELECT video_title FROM video_tracking_meta
        WHERE tracking_active = 1 ORDER BY tracking_started DESC LIMIT 1
    """).fetchone()

    if not meta:
        conn.close()
        print("  📡 无活跃追踪视频")
        return

    active_title = meta[0]
    print(f"  🎬 追踪视频: {active_title[:30]}...")

    # 只取最新一条
    r = conn.execute("""
        SELECT video_title, checkpoint_time, hours_since_publish,
               plays, likes, comments, ctr5s, engagement_rate,
               avg_duration_sec, plays_per_hour, cumulative_growth,
               predicted_final_plays, predicted_tier, confidence
        FROM video_tracking
        WHERE video_title = ?
        ORDER BY checkpoint_time DESC LIMIT 1
    """, (active_title,)).fetchone()
    conn.close()

    if not r:
        print("  📡 无追踪记录")
        return

    checkpoint = r[1]
    plays = r[3] or 0
    velocity = r[9] or 0

    # 趋势判断
    if velocity > 10000:
        trend = "🚀 爆发"
    elif velocity > 1000:
        trend = "📈 增长"
    elif velocity > 100:
        trend = "➡️ 平稳"
    else:
        trend = "⚠️ 低迷"

    # 固定 key「最新追踪」—— 每次都覆盖同一行
    FIXED_KEY = "最新追踪"
    fields = {
        "多行文本": FIXED_KEY,
        "检查时间": checkpoint,
        "已发布小时": round(r[2] or 0, 1),
        "播放量": plays,
        "增量": round(velocity, 0),
        "点赞": r[4] or 0,
        "评论": r[5] or 0,
        "5s完播率(%)": r[6] or 0,
        "互动率(%)": r[7] or 0,
        "均时长(s)": r[8] or 0,
        "预测播放": r[11] or 0,
        "预测等级": r[12] or "",
        "置信度(%)": round((r[13] or 0) * 100, 0),
        "趋势": trend,
    }

    existing = fetch_title_map(TABLE_TRACKING, '多行文本')
    
    # 删除旧的追踪行（非「最新追踪」key 的残留行）
    for key, rid in list(existing.items()):
        if key != FIXED_KEY:
            resp = api('DELETE', f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_TRACKING}/records/{rid}')
            if resp.get('code') == 0:
                del existing[key]
            time.sleep(0.06)

    ok, action = upsert_record(TABLE_TRACKING, FIXED_KEY, fields, existing)
    if ok:
        print(f"  📡 作品追踪: {action} ✅")
    else:
        print(f"  📡 作品追踪: 失败 ❌")

def sync_account():
    """同步「账号总览」—— 最近 30 天的粉丝数据"""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT timestamp, total_fans, today_new_fans
        FROM account_stats
        WHERE total_fans > 0
        ORDER BY timestamp DESC LIMIT 48
    """).fetchall()
    conn.close()

    if not rows:
        print("  📊 账号总览: 无数据")
        return

    existing = fetch_title_map(TABLE_ACCOUNT, '多行文本')
    created, updated, failed = 0, 0, 0

    for r in rows:
        ts = r[0]
        fields = {
            "多行文本": ts,
            "总粉丝数": r[1] or 0,
            "今日新增": r[2] or 0,
        }
        ok, action = upsert_record(TABLE_ACCOUNT, ts, fields, existing)
        if ok:
            if action == 'create': created += 1
            else: updated += 1
        else:
            failed += 1
        time.sleep(0.06)

    print(f"  📊 账号总览: 更新 {updated} | 新增 {created} | 失败 {failed}")

def main():
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now_str}] 同步抖音 → 飞书")
    sync_overview()
    sync_tracking()
    sync_account()
    print(f"[{now_str}] 完成")

if __name__ == '__main__':
    main()
