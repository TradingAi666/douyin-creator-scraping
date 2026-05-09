# 抖音创作者数据抓取 🎬

> 每小时自动从抖音创作者后台导出数据，零 API Key，纯 AppleScript 硬刚 Chrome。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS-lightgrey)]()

## 为什么会有这个项目

我是抖音 AI/科技区的创作者。每天想看视频数据，就得手动打开 `creator.douyin.com` → 切「投稿列表」→ 点「导出数据」→ 下载 Excel → 自己分析。烦。

于是写了个脚本，让 AppleScript 操控 Chrome 自动化这套流程。结果发现——**这事比想象中恶心一百倍**。

## 踩坑笔记 🕳️

过程中踩了五个大坑，每个都卡了我好几天。全写进 `SKILL.md` 了，当反面教材看也行：

| # | 坑 | 一句话 | 谁可能遇到 |
|---|---|---|---|
| 1 | **TCC 沙箱** | launchd 进程读不了 `~/Downloads`，哪怕加了 Full Disk Access 也没用 | macOS 上跑定时任务的 |
| 2 | **Chrome 后台 tab 静默吞下载** | AppleScript 注入的 `click()` 不算 user gesture，下载直接被 Chrome 拦截 | 做浏览器自动化的 |
| 3 | **AppleScript 里 Unicode 转义全废** | `\u5bfc\u51fa` 写进 AppleScript 静默失败，必须用 `charCodeAt()` | 处理中文 UI 的 |
| 4 | **Garfish 微前端 DOM 隔离** | 字节的 Garfish 框架让 `body.innerText` 只返回 460 个字符的导航栏 | 逆向字节系产品的 |
| 5 | **launchd 不设 HOME** | `os.path.expanduser("~")` 在后台返回错误路径 | 写 macOS launchd 的 |

### 怎么绕过的？

- **TCC 沙箱**：`launchd Python → osascript → do shell script → bash → mv`，利用 osascript 继承 GUI session 的 TCC 上下文
- **后台 Tab 下载**：三行 AppleScript：`activate` + `set active tab index` + `set index of w to 1`，强制把 Chrome 拉到前台
- **Unicode 匹配**：放弃 `\u`，用 `"导出数据".charCodeAt(0) === 23548` 硬匹配

## 它能做什么

```
抖音创作者中心 (creator.douyin.com)
    │
    │ AppleScript 操控 Chrome
    ▼
[切换「投稿列表」tab]
    │
    │ 点击「导出数据」
    ▼
[下载 作品列表.xlsx]
    │
    │ openpyxl 解析
    ▼
[SQLite 数据库]
    │
    │ 可选：Telegram Bot 推送
    ▼
📊 每次运行都有最新的 100 条视频数据
```

- ✅ 抓取全部视频的播放/点赞/评论/分享/收藏/完播率/CTR
- ✅ 历史快照保留，可追踪增长
- ✅ launchd 每小时自动跑，完全无人值守
- ✅ 纯净 — 零 API Key，不需要任何第三方服务

## 5 分钟上手

### 前置条件

- 🍎 macOS
- 🌐 Google Chrome
- 🔑 已登录 [creator.douyin.com](https://creator.douyin.com)
- ⚙️ Chrome 菜单 → **显示** → **开发者** → 勾选 ✅ **允许 Apple 事件中的 JavaScript**

### 安装

```bash
# 1. 装依赖
pip install openpyxl

# 2. 克隆
git clone https://github.com/TradingAi666/douyin-creator-scraping.git
cd douyin-creator-scraping
```

### 跑一次试试

```bash
python3 douyin_hourly.py
```

第一次跑，macOS 可能会弹窗问「允许 Terminal 控制 Google Chrome」→ 点**好**。

### 设为定时任务

```bash
# 编辑 plist，把 YOUR_USERNAME 换成你的 macOS 用户名
# 然后：
cp com.hermes.douyin-tracker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hermes.douyin-tracker.plist
```

搞定。以后每小时自动跑一次。

### 配合 Hermes Agent 用

```bash
# 把 SKILL.md 放到 Hermes skills 目录
mkdir -p ~/.hermes/skills/douyin
cp SKILL.md ~/.hermes/skills/douyin/douyin-creator-scraping.md
```

然后跟 Hermes 说一句：

> @Hermes 拉取抖音数据

Agent 会自动按 SKILL.md 里的流程操作。

### 想推送到 Telegram？

在 `~/.hermes/.env` 里加两行：

```
TELEGRAM_BOT_TOKEN=你的Bot Token
TELEGRAM_HOME_CHANNEL=你的Chat ID
```

## 文件清单

| 文件 | 说明 |
|---|---|
| `douyin_hourly.py` | 🔧 核心脚本（~500 行 Python + 内嵌 AppleScript） |
| `SKILL.md` | 📖 AI Agent 操作手册（含全部踩坑记录和正确的做法） |
| `com.hermes.douyin-tracker.plist` | ⚙️ launchd 配置模板 |
| `README.md` | 📄 你正在看的东西 |

## 数据库结构

```sql
CREATE TABLE video_stats (
    timestamp         DATETIME,   -- 抓取时间
    title             TEXT,       -- 视频标题
    publish_date      TEXT,       -- 发布时间
    plays             INTEGER,    -- 播放量
    avg_duration_sec  INTEGER,    -- 平均播放时长(秒)
    ctr               REAL,       -- 5s完播率
    likes             INTEGER,    -- 点赞
    comments          INTEGER,    -- 评论
    shares            INTEGER,    -- 分享
    favorites         INTEGER,    -- 收藏
    danmaku           INTEGER     -- 弹幕(如果有)
);
```

## 注意事项

- 🔴 抓取时会抢占 Chrome 焦点约 30 秒（硬伤，除非改用 CDP）
- 🟡 抖音创作者中心的 DOM 结构偶尔变动，如果抓取失败，可能是 Garfish 容器 ID 变了（SKILL.md 里有调试方法）
- 🟢 运行频率建议 ≥ 1 小时一次，太频繁可能触发风控
- 🟢 抖音后台最多导出最新的 ~100 条视频，旧视频的历史数据从快照中恢复

## License

MIT — 随便用，欢迎 PR。

---

⭐ 如果对你也有用，给个 Star？有什么问题直接开 Issue，或者群里找我。
