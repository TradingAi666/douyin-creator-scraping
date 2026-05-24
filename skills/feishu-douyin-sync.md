---
name: feishu-douyin-sync
description: "抖音数据同步到飞书多维表格：全量数据总览 + 最新作品追踪 + 粉丝数据，含过滤、字段映射、排错指南。"
version: 1.3.0
platforms: [macos]
---

# 飞书抖音数据同步

## 概述

每次 `douyin_hourly.py` 抓取抖音数据后，自动同步到飞书多维表格：
- **表1「视频数据总览」**：仅最近 **14 天**发布的视频（仅公开视频），超期自动从飞书清理
- **表2「最新作品追踪」**：**单行模式** — 固定 key `"最新追踪"`，每次同步原地覆盖。旧行自动删除。仪表盘只需指向这一行。
- **表3「账号总览」**：粉丝增长时间序列（每次抓取的 total_fans + today_new_fans）

## 关键文件

| 文件 | 用途 |
|---|---|
| `~/.hermes/scripts/feishu_sync.py` | 核心同步脚本（三表：总览+追踪+账号） |
| `~/.hermes/scripts/douyin_hourly.py` | 抓取后调 feishu_sync，带 `fcntl` 并发锁 |
| `~/.hermes/scripts/douyin_new_video_tracker.py` | 追踪 checkpoint 后调 feishu_sync |
| `~/.hermes/scripts/douyin_silent_run.py` | hourly cronjob wrapper（→ douyin_hourly.py） |
| `~/.hermes/scripts/douyin_tracker_cron.py` | 30min cronjob wrapper（→ douyin_new_video_tracker.py） |
| `references/cronjob-fire-and-forget.md` | fire-and-forget cronjob 模式详解 + 并发锁 |

## 飞书表结构

### Base
- URL: `https://ocnxddexrh6x.feishu.cn/base/M2GTb9hzMaRbbOse6V6cpkNcnSW`
- Token: `M2GTb9hzMaRbbOse6V6cpkNcnSW`

### 表1：视频数据总览 (`tblZaykpVltZrmbT`)
字段：文本(标题key), 发布时间, 播放量, 点赞, 评论, 分享, 收藏, 5s完播率(%), 完播率(%), 均时长(s), 互动率(%), 主页访问量, 粉丝增量, 更新时间

### 表2：最新作品追踪 (`tblt7b8ZSHRLbmrS`)
字段：多行文本(固定key="最新追踪"), 检查时间, 已发布小时, 播放量, 增量(时速), 点赞, 评论, 5s完播率(%), 互动率(%), 均时长(s), 预测播放, 预测等级, 置信度(%), 趋势

**设计**：单行模式 — 固定 key `"最新追踪"`。每次 `sync_tracking()` 先 DELETE 所有旧行，再 UPSERT 一行。飞书仪表盘指到这一行，数据自动刷新，无需手动清表。

### 表3：账号总览 (`tblrVLadypRaI5qU`)
字段：多行文本(时间key), 总粉丝数, 今日新增

注意：表3 首列 key 字段名是「多行文本」不是「文本」。

## API 凭证

```python
APP_ID = "cli_aa9bc01eab789cc5"
APP_SECRET = "VpUQKLK6w5zzbpIYDs1ThbL54CazDpLB"
BASE_TOKEN = "M2GTb9hzMaRbbOse6V6cpkNcnSW"
TABLE_OVERVIEW = "tblZaykpVltZrmbT"
TABLE_TRACKING = "tblt7b8ZSHRLbmrS"
TABLE_ACCOUNT  = "tblrVLadypRaI5qU"
```

Token 获取：`POST /open-apis/auth/v3/tenant_access_token/internal`，缓存 3600 秒。

## 权限

用户设为 `full_access`（通过 Drive API）：
```python
POST /open-apis/drive/v1/permissions/{BASE_TOKEN}/members?type=bitable
{"member_type": "openid", "member_id": "ou_53172d97e2bc03e6ad6d1490e05f9b94", "perm": "full_access"}
```

App 权限（飞书开发者后台）：`bitable:app`, `drive:drive:readonly`

## DB Schema

```
video_stats: timestamp, title, publish_date, plays, avg_duration_sec, 
             ctr, finish_rate, likes, comments, shares, favorites, 
             danmaku, status, profile_visits, follower_gain

account_stats: timestamp, total_fans, today_new_fans

video_tracking: video_title, publish_date, checkpoint_time, hours_since_publish,
                plays, likes, comments, shares, favorites, ctr5s, avg_duration_sec,
                engagement_rate, plays_per_hour, cumulative_growth,
                predicted_final_plays, predicted_tier, confidence

video_tracking_meta: video_title, publish_date, tracking_started, 
                     baseline_plays, tracking_active
```

### 新增字段（2026-05-23）
- `profile_visits` (INTEGER)：每条视频带来的主页访问量（Excel 列：主页访问量）
- `follower_gain` (INTEGER)：每条视频带来的粉丝增量（Excel 列：粉丝增量）
- `account_stats` 表：每次抓取的总粉丝数和今日新增

### status 字段值
- `公开` — 同步到飞书
- `自见`, `私密`, `未通过`, `审核中`, `已删除` — 过滤掉

## 关键修复记录

### 1. 同步超时 (2026-05-23)
- **问题**：102 条视频逐条 API 调用，120s 超时
- **修复**：douyin_hourly.py 和 tracker 中 feishu_sync 调用 timeout → 300s

### 2. 私密视频过滤 (2026-05-23)
- **问题**：DB 没存 `status` 字段，65 条自见视频也同步到飞书
- **修复**：
  1. `douyin_hourly.py` 的 `save_to_db()` 加 `status TEXT` 列 + INSERT 写 status
  2. `feishu_sync.py` 的 SQL 加 `AND (status IS NULL OR status NOT IN (...))`
  3. 飞书手动删 49 条私密残留

### 3. 追踪增量错误 (2026-05-23)
- **问题**：基线存成 0 → 增量 = 播放量；时速硬编码 /0.5
- **修复**：
  1. `save_checkpoint()` meta INSERT 存 `baseline_plays` 而非 `plays_prev`
  2. 时速用实际时间差 `(plays - prev_plays) / delta_hours`
  3. DB 中 `UPDATE video_tracking_meta SET baseline_plays = 129`

### 4. 「增量」字段含义 (2026-05-23)
- **问题**：飞书「增量」映射到 `cumulative_growth`（累计增长），用户要的是时速
- **修复**：`"增量": round(velocity, 0)` → 显示 plays_per_hour

### 9. 14天过滤 + SQLite UTC 时区陷阱 + 空行清理 (2026-05-24)

- **需求**：飞书总览表只保留最近 14 天的视频，旧数据远程无意义
- **SQL filter**：`publish_date >= date('now', 'localtime', '-14 days')`
- **⚠️ 关键陷阱**：`date('now')` 返回 **UTC 日期**，不是本地时间。中国 UTC+8，凌晨 0-8 点期间 `date('now')` 实际是**前一天**，导致 14 天 filter 变成 15 天。**必须用 `date('now', 'localtime', '-14 days')`**
- **自动清理**：同步前遍历飞书上所有记录，不在当前 14 天窗口内的 DELETE
- **幽灵行清理**：同步前扫一遍飞书，`文本` 为空或 `播放量`=0 的行全部 DELETE（这类行的 key 是空字符串，`fetch_title_map` 会跳过，无法通过 title-matching 清理）
- **诊断方法**：`fetch_title_map` 只返回非空 key 的记录 → 空标题行不可见 → 需要单独 API 遍历清理
- **效果**：总览表从 20 行（10 有效 + 10 幽灵）精简到 8 行（14 天内活跃视频）

### 11. 粉丝「今日新增」始终为 0 + AppleScript 导航超时 (2026-05-24)

- **现象**：飞书账号总览表 `today_new_fans` 始终为 0，即使总粉丝在涨（48100→48900）
- **根因 A**：Douyin 首页 `document.body.innerText` 中没有「今日新增粉丝」字段——页面只显示总粉丝（4.89万）和 7 天净增（1.18万），**不存在单日新增文案**。JS 搜 `charCode(26032, 22686)` →「新增」永远找不到 → today_new=0
- **根因 B**：`scrape_total_followers()` 用 AppleScript 导航到 `creator-micro/home`，但嵌套循环遍历所有 Chrome 窗口标签页无 `exit repeat`，在标签页多时超 20s 超时
- **修复 A**：`save_account_stats()` 不再信 JS 返回的 `today_new`，改用 DB 差值计算：
  - 今日有历史记录 → `current_fans - 今日首次抓取的总粉丝`
  - 今日无记录（凌晨首次抓取）→ `current_fans - 昨天最后一次总粉丝`
- **修复 B**：去掉 AppleScript 导航——粉丝数在创作者中心**所有页面**的侧边栏都可见，直接从当前页面 JS 提取即可。`scrape_total_followers()` 从 ~48 行缩减到 ~30 行
- **效果**：12:07 抓取显示 48,900 总粉丝，今日新增 +400（正确），飞书账号表首条记录 `todayNew=400`

### 10. 并发锁僵死 — 双重根因 (2026-05-24)

**现象**：`douyin_hourly.py` 连续多个小时报「已有抓取进程在运行，跳过本次」，但 `ps aux | grep douyin` 无任何进程。

**根因 A — fcntl flock 通过子进程泄漏**：
- `douyin_hourly.py` 在 `main()` 中用 `fcntl.flock(lock_fd, LOCK_EX|LOCK_NB)` 获取文件锁
- 然后 `subprocess.run(['python3', 'feishu_sync.py'])` 启动子进程
- **默认 `close_fds=False`**：子进程继承父进程所有文件描述符，包括 `lock_fd`
- `flock()` 锁绑定在 **文件描述**（open file description）上，不是文件描述符上
- 父进程的 `finally` 关闭了 `lock_fd`，但子进程仍持有同一文件描述的引用 → **锁不释放**
- 如果 `feishu_sync.py` 运行 300s 超时或被 kill，锁才被内核回收
- **修复**：所有调用 `feishu_sync.py` 的 `subprocess.run()` 都加 `close_fds=True`
  - `douyin_hourly.py` line ~705
  - `douyin_new_video_tracker.py` lines ~494 和 ~593（共两处）

**根因 B — 进程异常退出未释放锁**：
- 空锁文件（0 bytes），进程 crash 后锁残留
- **修复**：`rm -f ~/.hermes/.douyin_scrape.lock` 手动清理；`finally` 块保底释放
- **问题**：手动运行 `douyin_hourly.py` 和 cronjob 同时触发，两个进程抢 Chrome，导致 cronjob 的导出按钮迟迟不出现（30s 超时）
- **修复**：`douyin_hourly.py` 的 `main()` 加 `fcntl.flock` 文件锁（`~/.hermes/.douyin_scrape.lock`），第二个进程检测到锁直接跳过并 Telegram 通知「跳过本次抓取」
- **锁位置**：`main()` 开头，`try...finally` 确保异常退出也释放锁
- **需求**：每次抓取同时提取创作者中心首页的粉丝总量
- **实现**：`douyin_hourly.py` 新增 `scrape_total_followers()` 和 `save_account_stats()`
  - AppleScript 导航到 `creator.douyin.com/creator-micro/home`
  - JS 提取粉丝数（见下方编码陷阱）
  - 存入 `account_stats` 表（timestamp, total_fans, today_new_fans）
  - 抓取后自动回到内容页
- **数据**：总粉丝 48,100（4.81万），精确到百位

### 7. AppleScript JS 中文编码陷阱 ⚠️ 关键
- **问题**：Python 写入 JS 文件时，中文字符（`粉丝`、`万`、`新增`）编码与浏览器 DOM 不一致，导致 `indexOf('粉丝')` 返回 -1，`match(/万/)` 返回 null
- **现象**：debug 输出明明有 `粉丝 4.81万`，但 JS 完全匹配不到
- **根因**：Python `open().write()` 和 Chrome AppleScript `read POSIX file` 之间的字符编码路径不一致
- **解决方案**：JS 文件中的中文一律不使用字面量，改用以下两种方式之一：
  1. **charCode 扫描**：`body.charCodeAt(i) === 31881 && body.charCodeAt(i+1) === 19997` → 粉丝
  2. **Unicode 转义**：regex 中用 `\u4e07` 代替 `万`，字符串中用 `'\u4e07'`
  - charCode 对照表：
    - 粉=31881, 丝=19997, 万=0x4E07(19975), 新=26032, 增=22686, 关注=20851/27880
  - **这条规则适用于所有通过 Python→文件→AppleScript→Chrome 路径执行的 JS 代码**
  - 详见 `references/applescript-js-encoding-pitfall.md`
- **问题**：追踪器用 `--no-scrape` 读 DB 缓存数据（可能 40 分钟前），播放量偏差 1,464，时速偏差 5×
- **用户反馈**："怎么会用旧数据啊" — 追踪必须从网页抓最新数据
- **修复**：
  1. Cron 追踪去掉 `--no-scrape`：`python3 douyin_video_tracker.py`（无 flag）
  2. 手动追踪时也**不带** `--no-scrape`：先跑 `douyin_hourly.py` 抓取，再跑 tracker
  3. `--no-scrape` 仅用于特殊场景（刚抓完立即追踪、调试）

## Cron 配置

| 任务 | Cron | 模式 | 脚本 |
|---|---|---|---|
| 每小时抓取 | `every 60m` | `no_agent=True` | `douyin_silent_run.py` → `douyin_hourly.py` |
| 每30分钟追踪 | `every 30m` | `no_agent=True` | `douyin_tracker_cron.py` → `douyin_new_video_tracker.py` |

> **原则**：
> - 两个 cronjob 都用 `no_agent=True` 直接跑脚本，不经过 LLM，避免超时。
> - `douyin_hourly.py` 内置 feishu_sync（timeout=300s）+ 粉丝抓取。
> - `douyin_new_video_tracker.py` 内置 feishu_sync（timeout=300s）。
> - 追踪器每次都抓最新网页数据，不读 DB 缓存。

## 数据修复步骤（飞书脏数据清理）

```python
# 1. 删飞书私密记录：GET 全部 → 匹配 DB private_titles → DELETE
# 2. 删飞书追踪脏数据：GET 全部 → 匹配 plays=129 → DELETE  
# 3. 修 DB baseline：UPDATE video_tracking_meta SET baseline_plays=129
# 4. 修 DB growth：UPDATE video_tracking SET cumulative_growth=plays-129
# 5. 跑 python3 feishu_sync.py 重新同步
```

## 故障排查

| 症状 | 检查 |
|---|---|
| 同步超时 | token 是否过期？API 是否限流？timeout ≥ 300s？ |
| 数据不对 | DB status 字段？baseline_plays 是否为 0？ |
| 飞书没更新 | `fetch_title_map` key_field 是否匹配？（总览用"文本"，追踪/账号用"多行文本"） |
| 新字段不显示 | 飞书不会自动建列！需先 `POST /bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE}/fields` 建列，再 sync |
| 追踪数据偏小/偏旧 | **是否误用了 --no-scrape？** 追踪必须从网页抓新数据 |
| JS 匹配不到中文 | **是否在 JS 文件中用了中文字面量？** 必须用 charCode/\\u 转义 |
| 导出按钮超时 | **并发冲突** — 是否有另一个 douyin_hourly 在跑？检查 `~/.hermes/.douyin_scrape.lock` |
| 连续多轮「跳过本次抓取」但无进程 | **锁文件僵死** — `ps aux | grep douyin` 无进程但 lock 文件存在 → `rm -f ~/.hermes/.douyin_scrape.lock` |
| 14天过滤不对（多1天或少1天） | `date('now')` 是 UTC，中国时区用 `date('now', 'localtime', '-14 days')` |
| 飞书总览有空行/幽灵行 | `fetch_title_map` 跳过空 title → 空行不可见。跑一次手动清理或等下次 sync_overview 自动清 |
| 仪表盘显示多行 | 追踪表是否残留旧行？手动跑一次 feishu_sync 即可清掉 |
| 今日新增始终为 0 但总粉丝在涨 | Douyin 首页无单日新增字段。改为 DB 差值计算（见修复记录 #11）。手动跑一次 `douyin_hourly.py` 验证 |

## 关键设计约束

- **追踪表单行模式**：固定 key `"最新追踪"`，每次 sync 先 DELETE 旧行再 UPSERT。仪表盘始终只有一行。
- **总览表 14 天窗口 + 自动清理**：仅保留最近 14 天发布的视频。超期视频 + 空标题/0 播放的幽灵行自动 DELETE。SQL filter 用 `date('now', 'localtime', '-14 days')`（见修复记录 #9）。
- **账号总览追加模式**：每个时间戳一行，保留历史粉丝增长曲线。
- **字段名依赖**：key 用 `文本`（总览）和 `多行文本`（追踪/账号）。飞书字段名变更会破坏脚本。
- **API 限流**：upsert/delete 间 0.06s 延迟，无显式限流。大批量同步需节制。
- **Tracker 超时级联**：tracker 先存 checkpoint 到 DB，再调 feishu_sync。sync 超时不影响 DB 数据——下次 tracker 会同步。
- **并发锁**：`douyin_hourly.py` 用 `fcntl.flock` 防多进程抢 Chrome。手动跑和 cronjob 冲突时后来者跳过。
- **表 ID 变更**：飞书表删了重建需更新 TABLE_OVERVIEW/TABLE_TRACKING/TABLE_ACCOUNT。base_token 稳定不变。
