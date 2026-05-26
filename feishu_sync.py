#!/usr/bin/env python3
"""抖音数据 → 飞书多维表格 同步脚本 v5
- v5: 秘钥移至 .env，代码中不再硬编码
- 表1「视频数据总览」: 全量视频最新快照
- 表2「最新作品追踪」: 活跃追踪视频的时间序列
"""
import sqlite3, time, json, urllib.request, urllib.error, os
from datetime import datetime

ENV_PATH = os.path.expanduser("~/.hermes/.env")

def _load_env_var(key):
    try:
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except:
        pass
    return None

APP_ID = _load_env_var("FEISHU_APP_ID") or "cli_aa9bc01eab789cc5"
APP_SECRET = _load_env_var("FEISHU_APP_SECRET") or "YOUR_SECRET"
BASE_TOKEN = _load_env_var("FEISHU_BASE_TOKEN") or "YOUR_TOKEN"
TABLE_OVERVIEW = _load_env_var("FEISHU_TABLE_OVERVIEW") or "tblZaykpVltZrmbT"
TABLE_TRACKING = _load_env_var("FEISHU_TABLE_TRACKING") or "tblt7b8ZSHRLbmrS"
TABLE_ACCOUNT  = _load_env_var("FEISHU_TABLE_ACCOUNT") or "tblrVLadypRaI5qU"
DB_PATH = os.path.expanduser("~/.hermes/douyin_stats.db")

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

    # 去重：删除标题重复的记录（保留播放量最高的）
    deduped = 0
    page_token = None
    title_groups = {}
    while True:
        url = f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_OVERVIEW}/records?page_size=200'
        if page_token:
            url += f'&page_token={page_token}'
        resp = api('GET', url)
        if resp.get('code') != 0:
            break
        for item in resp.get('data', {}).get('items', []):
            t = item['fields'].get('文本', '')
            if t:
                title_groups.setdefault(t, []).append(
                    (item['record_id'], item['fields'].get('播放量', 0)))
        if resp['data'].get('has_more'):
            page_token = resp['data']['page_token']
            time.sleep(0.2)
        else:
            break
    for t, records in title_groups.items():
        if len(records) > 1:
            records.sort(key=lambda x: x[1], reverse=True)  # highest plays first
            for rid, _ in records[1:]:  # delete all but first
                api('DELETE', f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_OVERVIEW}/records/{rid}')
                deduped += 1
                time.sleep(0.06)
    if deduped:
        print(f"  🧹 去重: {deduped} 条")

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

    # 获取追踪表中每个视频的最新实时增速
    conn2 = sqlite3.connect(DB_PATH)
    tracking_speeds = {}
    try:
        for row in conn2.execute("""
            SELECT video_title, plays_per_hour
            FROM video_tracking
            WHERE (video_title, checkpoint_time) IN (
                SELECT video_title, MAX(checkpoint_time)
                FROM video_tracking GROUP BY video_title
            )
            AND checkpoint_time >= datetime('now', 'localtime', '-2 hours')
        """):
            tracking_speeds[row[0][:80]] = row[1]
    except:
        pass

    # 对未追踪的视频，用最近两次抓取快照的增量计算增速
    delta_speeds = {}
    try:
        prev_ts = conn2.execute(
            "SELECT DISTINCT timestamp FROM video_stats ORDER BY timestamp DESC LIMIT 2"
        ).fetchall()
        if len(prev_ts) == 2:
            t2, t1 = prev_ts[0][0], prev_ts[1][0]
            hours_gap = (datetime.strptime(t2, "%Y-%m-%d %H:%M:%S") -
                        datetime.strptime(t1, "%Y-%m-%d %H:%M:%S")).total_seconds() / 3600
            if hours_gap > 0.01:
                for row in conn2.execute("""
                    SELECT a.title, (a.plays - b.plays) / ?
                    FROM video_stats a JOIN video_stats b
                    ON a.title = b.title
                    WHERE a.timestamp = ? AND b.timestamp = ?
                    AND (a.status IS NULL OR a.status NOT IN ('私密','自见','未通过','审核中','已删除'))
                """, (hours_gap, t2, t1)):
                    if row[1] > 0:
                        delta_speeds[row[0][:80]] = round(row[1], 1)
    except:
        pass
    conn2.close()


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

        # 每小时增速: 追踪实时 > 快照增量 > 终生平均
        plays_per_hour = 0
        if title in tracking_speeds and tracking_speeds[title] > 0:
            plays_per_hour = round(tracking_speeds[title], 1)
        elif title in delta_speeds and delta_speeds[title] > 0:
            plays_per_hour = delta_speeds[title]
        elif r[1]:
            try:
                pub_dt = datetime.strptime(r[1], "%Y-%m-%d %H:%M:%S")
                hours = (datetime.now() - pub_dt).total_seconds() / 3600
                if hours > 0.1:
                    plays_per_hour = round(plays / hours, 1)
            except:
                pass

        fields = {
            "文本": title, "发布时间": r[1] or "", "播放量": plays,
            "点赞": r[3] or 0, "评论": r[4] or 0, "分享": r[5] or 0,
            "收藏": r[6] or 0, "5s完播率(%)": r[7] or 0,
            "完播率(%)": r[8] or 0, "均时长(s)": r[9] or 0,
            "互动率(%)": eng, "主页访问量": r[10] or 0,
            "粉丝增量": r[11] or 0, "更新时间": latest_ts,
            "均速/小时": plays_per_hour,
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
    """同步「账号总览」—— 清空全表后插入最新一条"""

    # 清理飞书上所有旧行，只保留最新一条
    cleaned = 0
    page_token = None
    while True:
        url = f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_ACCOUNT}/records?page_size=200'
        if page_token:
            url += f'&page_token={page_token}'
        resp = api('GET', url)
        if resp.get('code') != 0:
            break
        for item in resp.get('data', {}).get('items', []):
            rid = item['record_id']
            del_resp = api('DELETE',
                f'/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_ACCOUNT}/records/{rid}')
            if del_resp.get('code') == 0:
                cleaned += 1
            time.sleep(0.06)
        if resp['data'].get('has_more'):
            page_token = resp['data']['page_token']
            time.sleep(0.2)
        else:
            break

    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT timestamp, total_fans, today_new_fans
        FROM account_stats
        WHERE total_fans > 0
        ORDER BY timestamp DESC LIMIT 1
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

    print(f"  📊 账号总览: 更新 {updated} | 新增 {created} | 失败 {failed} | 清理旧数据 {cleaned}")

def main():
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now_str}] 同步抖音 → 飞书")
    sync_overview()
    sync_tracking()
    sync_account()
    print(f"[{now_str}] 完成")

if __name__ == '__main__':
    main()
