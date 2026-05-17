-- Douyin Creator Scraping — 完整数据库结构
-- 数据库文件：douyin_stats.db（默认路径，可通过 DOUYIN_DB_PATH 环境变量自定义）
--
-- 两个模块共用同一个数据库：
--   模块1: douyin_hourly.py      → video_stats（每小时抓取的原始数据）
--   模块2: douyin_new_video_tracker.py → video_tracking + video_tracking_meta（预测追踪）

-- ============================================================
-- 模块1: 原始数据表（douyin_hourly.py 写入）
-- ============================================================

CREATE TABLE IF NOT EXISTS video_stats (
    timestamp         DATETIME,   -- 抓取时间
    title             TEXT,       -- 视频标题
    publish_date      TEXT,       -- 发布时间（格式不统一：ISO/中文混用）
    plays             INTEGER,    -- 播放量
    avg_duration_sec  INTEGER,    -- 平均播放时长（秒）
    ctr               REAL,       -- 5s完播率（0-100）
    likes             INTEGER,    -- 点赞
    comments          INTEGER,    -- 评论
    shares            INTEGER,    -- 分享
    favorites         INTEGER,    -- 收藏
    danmaku           INTEGER     -- 弹幕
);

CREATE INDEX IF NOT EXISTS idx_video_stats_title ON video_stats(title);
CREATE INDEX IF NOT EXISTS idx_video_stats_timestamp ON video_stats(timestamp);


-- ============================================================
-- 模块2: 预测追踪表（douyin_new_video_tracker.py 写入）
-- ============================================================

-- 每次检查点快照（每30分钟一行）
CREATE TABLE IF NOT EXISTS video_tracking (
    video_title          TEXT,       -- 视频完整标题
    publish_date         TEXT,       -- 发布时间
    checkpoint_time      TEXT,       -- 检查点时间
    hours_since_publish  REAL,       -- 已发布小时数
    plays                INTEGER,    -- 当前播放量
    likes                INTEGER,    -- 点赞
    comments             INTEGER,    -- 评论
    shares               INTEGER,    -- 分享
    favorites            INTEGER,    -- 收藏
    ctr5s                REAL,       -- 5s完播率 (%)
    avg_duration_sec     REAL,       -- 平均播放时长（秒）
    engagement_rate      REAL,       -- 互动率 = (赞+评+分享)/播放 × 100
    plays_per_hour       REAL,       -- 即时播放速率
    cumulative_growth    INTEGER,    -- 自基线累计增长
    predicted_final_plays INTEGER,   -- 预测最终播放量
    predicted_tier       TEXT,       -- 预测层级：💎10万+ / 🥇5-10万 / 🥈2-5万 / 🥉1-2万 / 📦<1万
    confidence           REAL        -- 置信度 (0.0-1.0)
);

-- 每视频元信息（仅 --init 时写入）
CREATE TABLE IF NOT EXISTS video_tracking_meta (
    video_title      TEXT PRIMARY KEY,  -- 视频标题
    publish_date     TEXT,              -- 发布时间
    tracking_started TEXT,              -- 追踪启动时间
    baseline_plays   INTEGER,          -- 初始播放量（累计增长的基线）
    tracking_active  INTEGER DEFAULT 1  -- 是否活跃追踪中
);

CREATE INDEX IF NOT EXISTS idx_tracking_title ON video_tracking(video_title);
CREATE INDEX IF NOT EXISTS idx_tracking_time ON video_tracking(checkpoint_time);


-- ============================================================
-- 常见查询示例
-- ============================================================

-- 查看所有活跃追踪视频的最新状态：
--   SELECT vt.*
--   FROM video_tracking vt
--   JOIN video_tracking_meta vtm ON vt.video_title = vtm.video_title
--   WHERE vtm.tracking_active = 1
--   GROUP BY vt.video_title
--   ORDER BY MAX(vt.checkpoint_time) DESC;

-- 24h→最终倍率（模型校准）：
--   SELECT vt.video_title,
--          MAX(CASE WHEN vt.hours_since_publish BETWEEN 22 AND 26 THEN vt.plays END) as p24,
--          (SELECT v2.plays FROM video_tracking v2 WHERE v2.video_title = vt.video_title ORDER BY v2.hours_since_publish DESC LIMIT 1) as pfinal
--   FROM video_tracking vt
--   GROUP BY vt.video_title
--   HAVING p24 > 0;
