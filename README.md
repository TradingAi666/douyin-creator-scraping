# 抖音创作者中心数据抓取 (Douyin Creator Center Scraper)

自动从抖音创作者中心导出视频数据，支持 macOS 后台定时运行（launchd）。

## 它能做什么

- 自动打开 Chrome 中已登录的 `creator.douyin.com`
- 切换到「投稿列表」→ 点击「导出数据」→ 下载 `作品列表.xlsx`
- 解析 Excel，存入 SQLite 数据库
- 通过 Telegram Bot 推送数据报告
- 每小时自动运行，完全无人值守

## 为什么值得看

这个项目沉淀了几个**踩坑踩出来的硬核经验**，对做 macOS 自动化的开发者有通用价值：

| 坑 | 发现 |
|---|---|
| **macOS TCC 沙箱** | launchd 进程无法访问 `~/Downloads`，但通过 `osascript do shell script` 可以绕过——链条：`launchd Python → osascript → bash → mv` |
| **Chrome 后台 Tab 下载拦截** | `osascript` 注入的 `click()` 不算 user gesture，后台 tab 静默吞下载。必须 `activate` + `set active tab index` + `set index of w to 1` |
| **AppleScript 中 Unicode 静默失败** | `\u5bfc\u51fa` 在 AppleScript 执行 JS 时直接废掉，必须用 `charCodeAt()` 逐字比对 |
| **Garfish 微前端 DOM 隔离** | 字节跳动的 Garfish 框架让 `document.body.innerText` 只返回导航栏，真实内容在动态沙箱里 |
| **launchd 不设 HOME** | `os.path.expanduser("~")` 在 launchd 下返回错误路径，必须在 plist 显式注入 `EnvironmentVariables` |

## 快速开始

### 前置条件

- macOS + Google Chrome
- 已在 Chrome 中登录 [creator.douyin.com](https://creator.douyin.com)
- Chrome 菜单栏 → 显示 → 开发者 → **允许 Apple 事件中的 JavaScript**

### 安装

```bash
# 安装依赖
pip install openpyxl

# 克隆
git clone https://github.com/YOUR_USERNAME/douyin-creator-scraping.git
cd douyin-creator-scraping
```

### 运行一次

```bash
python3 douyin_hourly.py
```

### 设为定时任务

```bash
# 编辑 plist 中的路径和用户名
# 将 /Users/YOUR_USERNAME 替换为你的实际路径
cp com.hermes.douyin-tracker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hermes.douyin-tracker.plist
```

## 文件说明

| 文件 | 用途 |
|---|---|
| `douyin_hourly.py` | 核心抓取脚本：AppleScript 自动化 Chrome → 下载 Excel → 解析入库 |
| `SKILL.md` | AI Agent 操作手册（Hermes Skill 格式，含所有踩坑记录） |
| `com.hermes.douyin-tracker.plist` | launchd 配置文件（如需定时运行） |

## 数据 Schema

```sql
CREATE TABLE video_stats (
    timestamp DATETIME,
    title TEXT,
    publish_date TEXT,
    plays INTEGER,
    avg_duration_sec INTEGER,
    ctr REAL,          -- 5s完播率
    likes INTEGER,
    comments INTEGER,
    shares INTEGER,
    favorites INTEGER,
    danmaku INTEGER
);
```

## 注意事项

- 抓取会抢占 Chrome 焦点（约 30 秒），建议用 launchd 在空闲时段跑
- 每次运行覆盖最新数据，历史快照会保留在 SQLite 中
- 需要 Telegram 推送？在 `~/.hermes/.env` 中设置 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_HOME_CHANNEL`
- 导出按钮出现在「投稿列表」tab 下，脚本自动切换

## License

MIT
