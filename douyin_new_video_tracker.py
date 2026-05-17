#!/usr/bin/env python3
"""
新视频追踪器 v2 — 入库 + 预测
- 每30分钟采集数据，存入 video_tracking 表
- 基于历史倍率 + 当前CTR/互动率/均时长预测最终播放层级
- 用法: python3 douyin_new_video_tracker.py --init --title "视频标题"
"""

import subprocess
import sys
import sqlite3
import os
from datetime import datetime

DB_PATH = os.environ.get("DOUYIN_DB_PATH", "./douyin_stats.db")
SCRAPE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin_hourly.py")


def get_target_title():
    """从命令行参数获取目标视频标题"""
    for i, arg in enumerate(sys.argv):
        if arg == "--title" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def ensure_tables():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS video_tracking (
            video_title TEXT,
            publish_date TEXT,
            checkpoint_time TEXT,
            hours_since_publish REAL,
            plays INTEGER,
            likes INTEGER,
            comments INTEGER,
            shares INTEGER,
            favorites INTEGER,
            ctr5s REAL,
            avg_duration_sec REAL,
            engagement_rate REAL,
            plays_per_hour REAL,
            cumulative_growth INTEGER,
            predicted_final_plays INTEGER,
            predicted_tier TEXT,
            confidence REAL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS video_tracking_meta (
            video_title TEXT PRIMARY KEY,
            publish_date TEXT,
            tracking_started TEXT,
            baseline_plays INTEGER,
            tracking_active INTEGER DEFAULT 1
        )
    """)
    conn.commit()
    conn.close()


def run_scrape():
    """跑一次完整抓取"""
    print("[tracker] 🚀 开始抓取...", file=sys.stderr)
    try:
        result = subprocess.run(
            [sys.executable, SCRAPE_SCRIPT],
            capture_output=True, text=True, timeout=300,
            env={**os.environ, "DOUYIN_DB_PATH": DB_PATH, "PYTHONUNBUFFERED": "1"}
        )
        ok = result.returncode == 0
        print(f"[tracker] {'✅' if ok else '⚠️'} 抓取{'完成' if ok else '非零退出:'+str(result.returncode)}", file=sys.stderr)
        return ok
    except subprocess.TimeoutExpired:
        print("[tracker] ❌ 抓取超时 (300s)", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[tracker] ❌ 抓取异常: {e}", file=sys.stderr)
        return False


def query_video(title_text):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """SELECT title, publish_date, plays, likes, comments, shares,
           favorites, ctr, avg_duration_sec, timestamp
           FROM video_stats WHERE title LIKE ? ORDER BY timestamp DESC LIMIT 1""",
        (f"%{title_text[:12]}%",)
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "title": row[0], "publish_date": row[1], "plays": row[2],
        "likes": row[3], "comments": row[4], "shares": row[5],
        "favorites": row[6], "ctr5s": row[7], "avg_duration_sec": row[8],
        "scrape_time": row[9],
    }


def get_cohort_data(title_text, hours_since_pub, min_final_plays=5000):
    """从 video_stats 获取所有历史视频在同一时间点的表现，计算同期→最终倍率。"""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("""
        SELECT title, publish_date, MAX(plays) as final_plays
        FROM video_stats
        WHERE title NOT LIKE ?
        GROUP BY title
        HAVING final_plays >= ?
        ORDER BY final_plays DESC
    """, (f"%{title_text[:12]}%", min_final_plays))

    videos = [(r[0], r[1], r[2]) for r in cur.fetchall()]

    ratios = []
    peers = []

    for title, pub_date_str, final_plays in videos:
        try:
            pub_dt = datetime.strptime(pub_date_str, "%Y-%m-%d %H:%M:%S")
        except:
            continue

        cur.execute("""
            SELECT plays, timestamp, ctr, likes, comments, shares, avg_duration_sec
            FROM video_stats WHERE title = ? ORDER BY timestamp
        """, (title,))

        records = []
        for r in cur.fetchall():
            try:
                ts = datetime.strptime(r[1], "%Y-%m-%d %H:%M:%S")
                h = (ts - pub_dt).total_seconds() / 3600
                if h >= 0:
                    records.append((h, r[0], r[2] or 0, r[3] or 0, r[4] or 0, r[5] or 0, r[6] or 0))
            except:
                continue

        if len(records) < 2:
            continue

        tolerance = max(1.0, hours_since_pub * 0.25)
        closest = min(records, key=lambda r: abs(r[0] - hours_since_pub))
        closest_h, closest_plays, closest_ctr, likes, comments, shares, closest_dur = closest

        if closest_plays <= 0 or abs(closest_h - hours_since_pub) > tolerance:
            continue

        ratio = final_plays / closest_plays
        eng_rate = ((likes + comments + shares) / closest_plays * 100) if closest_plays > 0 else 0

        ratios.append(ratio)
        peers.append({
            'title': title,
            'plays_at_hour': closest_plays,
            'final': final_plays,
            'ratio': ratio,
            'ctr': closest_ctr,
            'eng': eng_rate,
            'dur': closest_dur,
            'at_hour': closest_h
        })

    conn.close()

    if not ratios:
        return None, []

    sorted_ratios = sorted(ratios)
    n = len(sorted_ratios)
    median_ratio = sorted_ratios[n // 2] if n % 2 == 1 else (sorted_ratios[n//2-1] + sorted_ratios[n//2]) / 2

    return median_ratio, peers


def predict_final_plays(title_text, current_plays, hours_since_pub, ctr5s, eng_rate, avg_dur):
    """v3 同期对比预测：历史同期倍率 × 三维质量修正（CTR + 互动率 + 均时长）。"""
    cohort_ratio, peers = get_cohort_data(title_text, hours_since_pub)

    peer_ctrs = [p['ctr'] for p in peers if p['ctr'] and p['ctr'] > 0]
    peer_engs = [p['eng'] for p in peers if p['eng'] and p['eng'] > 0]
    peer_durs = [p['dur'] for p in peers if p['dur'] and p['dur'] > 0]

    # CTR排位修正
    if peer_ctrs and len(peer_ctrs) >= 2:
        ctr_pctile = sum(1 for c in peer_ctrs if c < ctr5s) / len(peer_ctrs)
        if ctr_pctile >= 0.8: ctr_mod = 1.25
        elif ctr_pctile >= 0.6: ctr_mod = 1.1
        elif ctr_pctile >= 0.4: ctr_mod = 1.0
        elif ctr_pctile >= 0.2: ctr_mod = 0.85
        else: ctr_mod = 0.65
    else:
        ctr_pctile = None
        if ctr5s >= 50: ctr_mod = 1.15
        elif ctr5s >= 40: ctr_mod = 1.0
        elif ctr5s >= 30: ctr_mod = 0.85
        elif ctr5s >= 20: ctr_mod = 0.7
        else: ctr_mod = 0.5

    # 互动率排位修正
    if peer_engs and len(peer_engs) >= 2:
        eng_pctile = sum(1 for e in peer_engs if e < eng_rate) / len(peer_engs)
        if eng_pctile >= 0.8: eng_mod = 1.25
        elif eng_pctile >= 0.6: eng_mod = 1.1
        elif eng_pctile >= 0.4: eng_mod = 1.0
        elif eng_pctile >= 0.2: eng_mod = 0.85
        else: eng_mod = 0.65
    else:
        eng_pctile = None
        if eng_rate >= 8: eng_mod = 1.2
        elif eng_rate >= 5: eng_mod = 1.1
        elif eng_rate >= 3: eng_mod = 1.0
        elif eng_rate >= 1.5: eng_mod = 0.85
        else: eng_mod = 0.7

    # 均时长排位修正
    if peer_durs and len(peer_durs) >= 2:
        dur_pctile = sum(1 for d in peer_durs if d < avg_dur) / len(peer_durs)
        if dur_pctile >= 0.8: dur_mod = 1.2
        elif dur_pctile >= 0.6: dur_mod = 1.1
        elif dur_pctile >= 0.4: dur_mod = 1.0
        elif dur_pctile >= 0.2: dur_mod = 0.9
        else: dur_mod = 0.75
    else:
        dur_pctile = None
        dur_mod = 1.0

    # 时间置信度
    if hours_since_pub < 2: time_confidence = 0.25
    elif hours_since_pub < 4: time_confidence = 0.4
    elif hours_since_pub < 8: time_confidence = 0.55
    elif hours_since_pub < 12: time_confidence = 0.7
    elif hours_since_pub < 24: time_confidence = 0.8
    else: time_confidence = 0.9

    cohort_bonus = min(0.1, len(peers) * 0.02) if peers else 0
    confidence = min(0.92, time_confidence + cohort_bonus)

    if not cohort_ratio:
        cohort_ratio = 2.7
        confidence = max(0.15, time_confidence - 0.1)
    elif hours_since_pub < 1:
        cohort_ratio = min(cohort_ratio, 5000)
        confidence = min(confidence, 0.25)

    adjusted_ratio = cohort_ratio * ctr_mod * eng_mod * dur_mod
    predicted = int(current_plays * adjusted_ratio)

    if predicted >= 100000: tier = "💎 10万+"
    elif predicted >= 50000: tier = "🥇 5-10万"
    elif predicted >= 20000: tier = "🥈 2-5万"
    elif predicted >= 10000: tier = "🥉 1-2万"
    else: tier = "📦 <1万"

    return predicted, tier, confidence, adjusted_ratio, peers, ctr_pctile, eng_pctile, dur_pctile


def save_checkpoint(video, hours_since_pub, plays_prev, baseline_plays, predicted, tier, confidence):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    eng_rate = ((video['likes'] + video['comments'] + video['shares']) / video['plays'] * 100) if video['plays'] > 0 else 0
    plays_per_hour = ((video['plays'] - plays_prev) / 0.5) if plays_prev > 0 and hours_since_pub > 0.5 else 0
    cumulative_growth = video['plays'] - baseline_plays

    cur.execute("""
        INSERT INTO video_tracking VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        video['title'], video['publish_date'], now, round(hours_since_pub, 2),
        video['plays'], video['likes'], video['comments'], video['shares'],
        video['favorites'], video['ctr5s'], video['avg_duration_sec'],
        round(eng_rate, 2), round(plays_per_hour, 1),
        cumulative_growth, predicted, tier, round(confidence, 2)
    ))

    cur.execute("""
        INSERT OR IGNORE INTO video_tracking_meta VALUES (?, ?, ?, ?, 1)
    """, (video['title'], video['publish_date'], now, plays_prev))

    cur.execute("""
        UPDATE video_tracking_meta SET tracking_active=1 WHERE video_title LIKE ?
    """, (f"%{video['title'][:12]}%",))

    conn.commit()
    conn.close()


def get_last_checkpoint(title):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """SELECT plays, likes, comments, shares, hours_since_publish
           FROM video_tracking WHERE video_title LIKE ?
           ORDER BY checkpoint_time DESC LIMIT 1""",
        (f"%{title[:12]}%",)
    )
    row = cur.fetchone()
    conn.close()
    if row:
        return {"plays": row[0], "likes": row[1], "comments": row[2],
                "shares": row[3], "hours": row[4]}
    return {"plays": 0, "likes": 0, "comments": 0, "shares": 0, "hours": 0}


def get_tracking_meta(title):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "SELECT baseline_plays, tracking_started FROM video_tracking_meta WHERE video_title LIKE ?",
        (f"%{title[:12]}%",)
    )
    row = cur.fetchone()
    conn.close()
    return row


def format_num(n):
    if n >= 10000:
        return f"{n/10000:.1f}万"
    return f"{n:,}"


def format_delta(now, prev):
    d = now - prev
    if d > 0: return f"+{format_num(d)}"
    elif d < 0: return f"-{format_num(abs(d))}"
    return "0"


def main():
    ensure_tables()

    is_init = "--init" in sys.argv
    target_title = get_target_title()

    if not target_title:
        print("❌ 请用 --title 指定目标视频标题")
        print("用法: python3 douyin_new_video_tracker.py --init --title \"视频标题\"")
        sys.exit(1)

    if not run_scrape():
        print("❌ 数据采集失败，请检查 Chrome 是否打开 creator.douyin.com")
        sys.exit(1)

    video = query_video(target_title)
    if not video:
        print(f"❌ 未找到目标视频「{target_title}」")
        sys.exit(1)

    now = datetime.now()
    try:
        pub_dt = datetime.strptime(video['publish_date'], "%Y-%m-%d %H:%M:%S")
    except:
        pub_dt = now
    hours_since_pub = max(0.01, (now - pub_dt).total_seconds() / 3600)

    meta = get_tracking_meta(video['title'])
    last = get_last_checkpoint(video['title'])

    if is_init or not meta:
        baseline_plays = video['plays']
        eng_rate = (video['likes']+video['comments']+video['shares'])/max(1,video['plays'])*100
        predicted, tier, confidence, ratio, peers, ctr_pct, eng_pct, dur_pct = predict_final_plays(
            target_title, video['plays'], hours_since_pub, video['ctr5s'], eng_rate, video['avg_duration_sec'] or 0
        )
        save_checkpoint(video, hours_since_pub, 0, baseline_plays, predicted, tier, confidence)

        print(f"📌 <b>追踪已初始化</b>")
        print(f"🎬 {video['title'][:30]}…")
        print(f"⏱️ 发布 {hours_since_pub:.1f}h")
        print(f"▶️ 初始播放: <b>{format_num(baseline_plays)}</b>")
        print(f"❤️ 初始点赞: {format_num(video['likes'])}")
        print(f"📈 5s完播: {video['ctr5s']:.1f}% | 互动率: {eng_rate:.1f}% | 均时长: {video['avg_duration_sec']}s")
        print(f"")
        print(f"🔮 <b>预测最终</b>：{format_num(predicted)} → <b>{tier}</b>（置信度 {confidence:.0%}）")
        _print_cohort(peers, ctr_pct, eng_pct, dur_pct, hours_since_pub, video['ctr5s'], eng_rate, ratio)
        return

    baseline_plays = meta[0]
    plays_delta = video['plays'] - last['plays']
    cumulative_growth = video['plays'] - baseline_plays

    delta_hours = max(0.01, hours_since_pub - last['hours'])
    hourly_rate = plays_delta / delta_hours if delta_hours > 0 else 0

    eng_rate = (video['likes'] + video['comments'] + video['shares']) / max(1, video['plays']) * 100

    predicted, tier, confidence, ratio, peers, ctr_pct, eng_pct, dur_pct = predict_final_plays(
        target_title, video['plays'], hours_since_pub, video['ctr5s'], eng_rate, video['avg_duration_sec'] or 0
    )

    save_checkpoint(video, hours_since_pub, last['plays'], baseline_plays, predicted, tier, confidence)

    # 预测变化趋势
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "SELECT predicted_final_plays, predicted_tier, confidence FROM video_tracking WHERE video_title LIKE ? ORDER BY checkpoint_time DESC LIMIT 2",
        (f"%{video['title'][:12]}%",)
    )
    prev_preds = cur.fetchall()
    conn.close()

    prev_pred_str = ""
    if len(prev_preds) >= 2:
        prev_p, prev_t, prev_c = prev_preds[1]
        if prev_p != predicted:
            arrow = "📈" if predicted > prev_p else "📉"
            prev_pred_str = f"\n   └ 上次预测: {format_num(prev_p)} ({prev_t}, {prev_c:.0%})"

    if hourly_rate > 500: trend = "🚀 爆发"
    elif hourly_rate > 200: trend = "📈 强劲"
    elif hourly_rate > 50: trend = "📊 正常"
    elif hourly_rate > 10: trend = "🐢 偏慢"
    else: trend = "⚠️ 低迷"

    cur = sqlite3.connect(DB_PATH).cursor()
    cur.execute(
        "SELECT COUNT(*) FROM video_tracking WHERE video_title LIKE ?",
        (f"%{video['title'][:12]}%",)
    )
    checkpoint_count = cur.fetchone()[0]
    cur.connection.close()

    print(f"📊 <b>新视频追踪</b> — {now.strftime('%H:%M')}")
    print(f"🎬 {video['title'][:28]}…")
    print(f"")
    print(f"⏱️ 已发布 <b>{hours_since_pub:.1f}h</b> | 第 {checkpoint_count} 次追踪")
    print(f"")
    print(f"▶️ 当前播放：<b>{format_num(video['plays'])}</b>")
    print(f"   └ 间隔增量：{format_delta(video['plays'], last['plays'])}")
    print(f"   └ 累计增长：+{format_num(cumulative_growth)}（自基线 {format_num(baseline_plays)}）")
    print(f"   └ 当前时速：<b>{hourly_rate:.0f}</b> 播放/h")
    print(f"   └ 趋势：{trend}")
    print(f"")
    print(f"❤️ 点赞：{format_num(video['likes'])} ({format_delta(video['likes'], last['likes'])})  |  "
          f"💬 {format_num(video['comments'])} | 🔁 {format_num(video['shares'])}")
    print(f"📈 5s完播：{video['ctr5s']:.1f}% | 互动率：{eng_rate:.1f}% | 均时长：{video['avg_duration_sec']}s")
    print(f"")
    print(f"🔮 <b>预测最终</b>：{format_num(predicted)} → <b>{tier}</b>（置信度 {confidence:.0%}）{prev_pred_str}")
    print(f"   └ 模型: v3同期对比 ×{ratio:.1f}（{len(peers)}条同期 + CTR/互动/均时长三维修正）")
    _print_cohort(peers, ctr_pct, eng_pct, dur_pct, hours_since_pub, video['ctr5s'], eng_rate, ratio)


def _print_cohort(peers, ctr_pct, eng_pct, dur_pct, hours, ctr5s, eng_rate, ratio):
    if not peers:
        return
    print(f"")
    print(f"📋 <b>同期对比</b>（{hours:.1f}h | {len(peers)} 条参考视频）：")
    sorted_peers = sorted(peers, key=lambda p: p['final'], reverse=True)
    for p in sorted_peers[:5]:
        short = p['title'][:18] + ("…" if len(p['title']) > 18 else "")
        print(f"   {short:20s} {format_num(p['plays_at_hour']):>6s} → {format_num(p['final']):>7s}  ×{p['ratio']:.0f}")
    if len(sorted_peers) > 5:
        print(f"   … 共 {len(sorted_peers)} 条")

    parts = []
    if ctr_pct is not None:
        l = "🟢" if ctr_pct >= 0.6 else ("🟡" if ctr_pct >= 0.4 else "🔴")
        parts.append(f"5s完播 {l} 前{ctr_pct:.0%}")
    if eng_pct is not None:
        l = "🟢" if eng_pct >= 0.6 else ("🟡" if eng_pct >= 0.4 else "🔴")
        parts.append(f"互动率 {l} 前{eng_pct:.0%}")
    if dur_pct is not None:
        l = "🟢" if dur_pct >= 0.6 else ("🟡" if dur_pct >= 0.4 else "🔴")
        parts.append(f"均时长 {l} 前{dur_pct:.0%}")
    if parts:
        print(f"   质量排位：{' | '.join(parts)}")

    raw_ratios = sorted([p['ratio'] for p in peers])
    n = len(raw_ratios)
    raw_median = raw_ratios[n//2] if n % 2 == 1 else (raw_ratios[n//2-1] + raw_ratios[n//2]) / 2
    print(f"   同期倍率中位数: ×{raw_median:.0f}（修正后 ×{ratio:.0f}）")


if __name__ == "__main__":
    main()
