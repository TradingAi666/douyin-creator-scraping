---
name: douyin-auto-reply
description: |
  Automatically reply to Douyin comments for a specific video. 4-step workflow:
  export unreplied comments → AI generates replies targeting 会员群 → auto-send via browser.
  Replies gently guide users to the creator's paid membership group (专属会员群).
  Use when the user says "回复XX视频的评论" or similar.
tags: [douyin, comments, auto-reply, browser-automation, social-media]
---

# Douyin Auto Reply

## Overview

Fully automated Douyin comment reply system. Exports unreplied comments from the
creator center, generates AI reply messages that guide commenters to the paid
**会员群** (membership group), and sends them via Playwright browser automation.

## Prerequisites

- `~/douyin/douyin-creator-tools/` installed with `npm` dependencies
- Playwright persistent browser profile at `~/douyin/douyin-creator-tools/browser-data/`
  (user must have logged into Douyin via the export script at least once)
- Node.js >= 18

## Quick Start

When the user says "回复XX视频的评论":

```bash
# Step 1: Export unreplied comments for the video
cd ~/douyin/douyin-creator-tools
npm run comments:export -- "视频短标题" --limit 300 --timeout 120000

# Step 2: Read the exported JSON to understand comments
# File: comments-output/unreplied-comments.json
```

After Step 1, you'll have `unreplied-comments.json` with comment data.
Each comment has: `username`, `commentText`, `publishText`.

**IMPORTANT: Filter and deduplicate before generating replies.**

1. Read the DB-replied tracking file to skip already-replied comments:
   The reply script tracks via SQLite DB at `data/douyin-creator.db`, table `comments`.
   Schema: `id, work_title, username, comment_text, reply_message, comment_time, reply_count`.
   Filter out comments where reply_count >= 1 for the **same video** (matched by `work_title`).

2. Check for the presence of `auto-reply-plan.json` from previous runs.
   If it exists, merge new comments into the existing plan.

3. For comments without pre-existing replies, generate AI replies.

## AI Reply Generation Rules

When generating replies, follow these rules:

1. **Tone**: Professional but friendly. Acknowledge the commenter's point.
2. **Structure**: "validate opinion + expand with domain knowledge" then guide to 会员群.
3. **Key phrases to use** (pick one naturally):
   - "会员群里有更详细的..."
   - "会员群整理了从零搭建的全流程"
   - "会员群里拆过这个案例"
   - "具体的方法论会员群里有"
   - "感兴趣可以点主页看会员群加入方式"
4. **What to AVOID**:
   - Generic "主页有更多内容" (too vague, doesn't specify 会员群)
   - Overly sales-y or pushy language
   - Just saying "关注主页" without mentioning 会员群
5. **Length**: Keep under 400 characters (Douyin limit). Natural, not templated.

### Filtering: Skip These Before Generating

Before generating replies, filter out low-value comments:
- **Pure @mentions** (`@xxx` with no other content, length < 30)
- **Too short** (single character, numbers only, `< 5 chars`)
- **Emoji-only** (no meaningful text)
- **Competitor ads** (comments advertising their own services/channels)

### Bulk Generation (100+ Comments)

For videos with 100+ unreplied comments, use `execute_code` with a
**category-based template function** instead of generating each reply individually:

```python
def generate_reply(username, text):
    t = text.strip().lower()
    # Group by topic → pick template → fill specifics
    if any(w in t for w in ['违法', '合规', '律师']):
        return "合规是...会员群里有完整指南。"
    if any(w in t for w in ['找上游', '对接上游']):
        return "上游渠道...群里整理了几个主流对比。"
    # ... more categories ...
    return "默认回复..."  # generic fallback
```

Categories typically include: legal/compliance, upstream/downstream matching,
technical build questions, pricing, timing/FOMO, learning/beginner, competition.
This keeps replies varied while being scalable.

### Example Reply Format

Save as `comments-output/auto-reply-plan.json`:
```json
{
  "selectedWork": {
    "title": "视频标题",
    "publishText": "发布时间"
  },
  "comments": [
    {
      "id": 1,
      "username": "用户A",
      "commentText": "用户的原评论",
      "publishText": "评论时间",
      "replyMessage": "AI生成的回复文案"
    }
  ]
}
```

## Step 3: Send Replies

```bash
cd ~/douyin/douyin-creator-tools

# Chain export + reply for reliability (export activates browser first)
npm run comments:export -- "视频短标题" --limit 5 --timeout 60000 && \
npm run comments:reply -- --limit N --timeout 1800000 comments-output/auto-reply-plan.json
```

The `--limit N` should match the number of plans.

## Step 4: Report Results

After the reply run completes, read `comments-output/reply-comments-result.json`
and report:
- How many were replied
- How many were skipped (already replied before)
- How many are unmatched (not visible on current page)
- Any errors

## Pitfall 1: Old Videos — No Comment Status Filter (2026-05-22)

Old videos (typically >1 month) do NOT have the comment status filter dropdown
("全部评论"/"未回复"/"已回复"). This causes TWO problems:

### Problem A: Reply script crashes

`reply-flow.mjs` line 475 calls `applyUnrepliedCommentsFilter()` without error
handling. When the filter dropdown doesn't exist, the script throws:

```
Timed out waiting for the comment status filter after 30000ms.
Visible comboboxes: ["最新发布"]
```

**Fix (already applied):** Add `.catch(() => {})` on line 475:
```js
await applyUnrepliedCommentsFilter(page, options).catch(() => {});
```

### Problem B: Export capped at 10 comments

`comment-ops.mjs` line 797 hardcodes `OLD_WORK_COLLECT_LIMIT = 10`, overriding
any `--limit` CLI flag. For popular old videos this misses most comments.

**Fix:** Raise `OLD_WORK_COLLECT_LIMIT` to 200 in `comment-ops.mjs`:
```js
const OLD_WORK_COLLECT_LIMIT = 200;
```

### Workflow for old videos with many comments

1. After exporting, check the comment count. If 100+ meaningful comments, use **batch mode**:
   ```bash
   npm run comments:reply -- --limit 30 --timeout 600000 comments-output/auto-reply-plan.json
   ```
   Repeat until `exitReason` becomes `all_reply_plans_resolved`. 30 per batch prevents
   browser memory crashes.
2. If the browser crashes mid-run, clean up the stale lock before retrying:
   ```bash
   pkill -f "douyin-profile" 2>/dev/null
   rm -f ~/douyin/douyin-creator-tools/.playwright/douyin-profile/SingletonLock
   ```

## Pitfall 2: Browser Crash on Large Batches (2026-05-22)

Running `--limit >100` on old videos (~190 comments loaded on page) crashes Chrome
with "Target page/context/browser closed". **Safe batch: 30 per run.**

After crash, Chrome leaves a `SingletonLock` file. Must clean before retry:
```bash
pkill -f "douyin-profile"
rm -f ~/douyin/douyin-creator-tools/.playwright/douyin-profile/SingletonLock
```

## Pitfall 3: Page-1 Turnover — Comments Vanish Between Export and Reply (2026-05-24)

On videos with 500+ comments, page 1 (~86 visible) turns over in **minutes**.
Comments exported and placed in the plan can be gone by the time the reply script
runs — even with the export→reply chain pattern (export was <13 min before reply,
yet all 10 plans came back unmatched).

**Symptoms**: `repliedCount: 0`, `unmatchedPlanCount: N`, `exitReason: "no_more_comments_indicator"`,
elapsed time <30s (script quickly exhausts page and gives up).

### Counter-strategy: Fresh Export → Immediate Reply

When you hit 0 matches, the old plan is stale. Don't keep retrying it:

1. **Run a fresh export** to capture what's on page 1 RIGHT NOW
2. **Filter + generate replies** for the current batch only (ignore the old plan's entries — they'll cycle back on future runs)
3. **Immediately send** without any gap — run `comments:reply` directly (no chained export prefix which adds delay)
4. Success rate: 14/16 (87.5%) with this approach vs 0/10 with stale plans

**Prevention**: For high-traffic videos, use the recurring cron pattern (every 30 min)
instead of one-shot reply runs. Each cron tick catches newly surfaced comments on
page 1. Accept that some plans will remain unmatched — they'll match on a future
tick when the comment cycles back to page 1.

## Title Matching: Try Multiple Partial Keywords

The export script's title matching is substring-based. Short/shared keywords like
"API中转站" may fail while "全面拆解26年" succeeds. If the first keyword fails
(`Error: No work matched title`), try a longer or rarer substring from the title.
Query `video_stats` first to see the exact title, then pick the most unique segment.

## Known Limitations

- **Douyin only returns ~86 recent comments** per page load. Comments beyond this
  are not retrievable via the web interface. There is no traditional pagination.
- **Solution**: Run the reply script regularly (every 30 min). Each run catches
  newly surfaced comments as older ones get pushed down.
- **"未回复" filter may show empty**: After replying to all visible unreplied
  comments, the filter shows "暂无符合条件的评论". The script will attempt to
  switch to "全部评论" and paginate, but Douyin has no next-page controls.
  Just re-run periodically.

## Cron Job Pattern

For ongoing auto-reply, set up a cron job:

```
Schedule: every 30m
Workdir: ~/douyin/douyin-creator-tools
Command: npm run comments:reply -- --limit 10 --timeout 300000 comments-output/auto-reply-plan.json
```

Each run:
1. Skips already-replied comments (via DB tracking)
2. Finds newly visible comments on the current page
3. Replies up to 10 per run
4. Reports results

Stop the cron when all plans are resolved or the video's comment velocity slows.

## File Locations

| File | Purpose |
|---|---|
| `~/douyin/douyin-creator-tools/comments-output/unreplied-comments.json` | Exported unreplied comments |
| `~/douyin/douyin-creator-tools/comments-output/auto-reply-plan.json` | AI-generated reply plans |
| `~/douyin/douyin-creator-tools/comments-output/reply-comments-result.json` | Reply execution results |
| `~/douyin/douyin-creator-tools/data/douyin-creator.db` | SQLite tracking DB (table=`comments`) |
| `~/douyin/douyin-creator-tools/browser-data/` | Playwright persistent profile |
| `references/open-source-integration-plan.md` | How auto-reply was packaged into the public repo |

## Open-Source Repo

The auto-reply tools are now part of [`TradingAi666/TzFilmdouyintool`](https://github.com/TradingAi666/TzFilmdouyintool)
(formerly `douyin-creator-scraping`) as `auto_reply.py` + `auto-reply/` — together with
data scraping and video prediction, forming a complete creator toolkit.

Users can install with:

```bash
git clone https://github.com/TradingAi666/TzFilmdouyintool.git
cd TzFilmdouyintool
python3 auto_reply.py setup    # npm install + playwright install chromium + login
python3 auto_reply.py export "视频标题"   # export comments
python3 auto_reply.py reply "视频标题"    # send replies
```

The Python wrapper calls the Node.js Playwright scripts via subprocess — no rewriting required.

The local working copy is also at `~/douyin/douyin-creator-tools/` for agent-internal use.
