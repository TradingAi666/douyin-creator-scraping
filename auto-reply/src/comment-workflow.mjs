import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
  DEFAULT_COMMENT_PAGE_URL,
  DEFAULT_USER_DATA_DIR,
  launchPersistentPage,
  promptForEnter
} from "./douyin-browser.mjs";
import { getEffectiveTimeout, setReplyFilterDebugEnabled } from "./lib/common.mjs";
import { ensureCommentPageReady, hardRefreshPage } from "./lib/comment-page.mjs";
import {
  captureCommentListFingerprint,
  collectComments,
  waitForCommentListChange
} from "./lib/comment-ops.mjs";
import { replyToComments } from "./lib/reply-flow.mjs";
import { emitResult, loadReplyCommentsFile } from "./lib/result-store.mjs";
import {
  fetchAllWorksWithRetry,
  findTargetWorkWithRetry,
  getSelectedWorkOutput,
  getWorksOutput
} from "./lib/works-panel.mjs";
import {
  getReplyCountMap,
  getUserHistoryMap,
  incrementReplyCount,
  upsertComments
} from "./lib/db-ops.mjs";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 60000;
const DEFAULT_UI_TIMEOUT_MS = 30000;
const DEFAULT_WORKS_TIMEOUT_MS = 45000;
const DEFAULT_WORKS_IDLE_MS = 5000;
const DEFAULT_COMMENTS_TIMEOUT_MS = 300000;
const DEFAULT_COMMENTS_IDLE_MS = 5000;
const DEFAULT_REPLY_TIMEOUT_MS = 30000;
const DEFAULT_REPLY_SETTLE_MS = 1800;
const DEFAULT_REPLY_TYPE_DELAY_MS = 50;
const DEFAULT_REPLY_LIMIT = 20;
const DEFAULT_EXPORT_LIMIT = 5000;
const DEFAULT_REPLY_FLOW_TIMEOUT_MS = 1800000;
const REPLY_FLOW_TIMEOUT_BUFFER_MS = 60000;
const REPLY_FLOW_TIMEOUT_PER_PLAN_MS = 20000;
const MAX_AUTO_REPLY_FLOW_TIMEOUT_MS = 7200000;

export const DEFAULT_WORKS_OUTPUT_PATH = path.resolve("comments-output/list-works.json");
export const DEFAULT_EXPORT_OUTPUT_PATH = path.resolve("comments-output/unreplied-comments.json");
export const DEFAULT_EXPORT_ALL_OUTPUT_PATH = path.resolve("comments-output/all-comments.json");
export const DEFAULT_REPLY_OUTPUT_PATH = path.resolve("comments-output/reply-comments-result.json");

function buildRuntimeBudget(totalTimeoutMs = 0) {
  if (!totalTimeoutMs) {
    return {
      deadline: null,
      maxRuntimeMs: 0
    };
  }

  return {
    deadline: Date.now() + totalTimeoutMs,
    maxRuntimeMs: totalTimeoutMs
  };
}

function resolveReplyFlowTimeout(replyLimit, replyPlanCount) {
  const targetReplyCount = Math.max(
    1,
    Math.min(replyLimit || replyPlanCount || 1, replyPlanCount || replyLimit || 1)
  );

  return Math.min(
    MAX_AUTO_REPLY_FLOW_TIMEOUT_MS,
    Math.max(
      DEFAULT_REPLY_FLOW_TIMEOUT_MS,
      REPLY_FLOW_TIMEOUT_BUFFER_MS + targetReplyCount * REPLY_FLOW_TIMEOUT_PER_PLAN_MS
    )
  );
}

function extractExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(\w+)$/);
    return match ? `.${match[1]}` : ".jpg";
  } catch {
    return ".jpg";
  }
}

async function downloadCommentImages(comments, outputPath) {
  const hasImages = comments.some((c) => c.imageUrls?.length > 0);
  if (!hasImages) return;

  const imageDir = path.resolve(path.dirname(outputPath), "comment-images");
  await fs.promises.mkdir(imageDir, { recursive: true });

  let downloaded = 0;
  let failed = 0;

  for (const comment of comments) {
    if (!comment.imageUrls?.length) continue;
    const savedPaths = [];

    for (let i = 0; i < comment.imageUrls.length; i++) {
      const url = comment.imageUrls[i];
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[image] 下载失败 (HTTP ${response.status}): ${url.slice(0, 100)}…`);
          failed += 1;
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = extractExtFromUrl(url);
        const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
        const safeName = comment.username.replace(/[^\w\u4e00-\u9fff-]/g, "_").slice(0, 20);
        const filename = `${safeName}_${i}_${hash}${ext}`;
        const filePath = path.resolve(imageDir, filename);

        await fs.promises.writeFile(filePath, buffer);
        savedPaths.push(filePath);
        downloaded += 1;
      } catch (err) {
        console.warn(`[image] 下载异常: ${err?.message ?? err}`);
        failed += 1;
      }
    }

    delete comment.imageUrls;
    if (savedPaths.length > 0) {
      comment.imagePaths = savedPaths;
    }
  }

  if (downloaded > 0) {
    console.log(`[image] 已下载 ${downloaded} 张评论图片至 ${imageDir}`);
  }
  if (failed > 0) {
    console.warn(`[image] ${failed} 张图片下载失败`);
  }
}

async function openCommentSession(options = {}) {
  setReplyFilterDebugEnabled(options.debug);

  const runtimeBudget = buildRuntimeBudget(options.timeoutMs || 0);
  const { context, page } = await launchPersistentPage({
    userDataDir: options.profileDir || DEFAULT_USER_DATA_DIR,
    headless: Boolean(options.headless)
  });

  context.setDefaultTimeout(getEffectiveTimeout(runtimeBudget, DEFAULT_UI_TIMEOUT_MS));
  context.setDefaultNavigationTimeout(
    getEffectiveTimeout(runtimeBudget, DEFAULT_NAVIGATION_TIMEOUT_MS)
  );
  page.setDefaultTimeout(getEffectiveTimeout(runtimeBudget, DEFAULT_UI_TIMEOUT_MS));
  page.setDefaultNavigationTimeout(
    getEffectiveTimeout(runtimeBudget, DEFAULT_NAVIGATION_TIMEOUT_MS)
  );

  await ensureCommentPageReady(page, options.pageUrl || DEFAULT_COMMENT_PAGE_URL, {
    ...runtimeBudget,
    navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
    uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
  });

  return {
    context,
    page,
    runtimeBudget
  };
}

async function resolveTargetWork(page, runtimeBudget, workTitle, workPublishText = "") {
  return findTargetWorkWithRetry(page, {
    ...runtimeBudget,
    workTitle,
    workPublishText,
    selectWhenMatched: true,
    timeoutMs: DEFAULT_WORKS_TIMEOUT_MS,
    idleMs: DEFAULT_WORKS_IDLE_MS,
    uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
  });
}

export async function listWorks(options = {}) {
  const outputPath = options.outputPath || DEFAULT_WORKS_OUTPUT_PATH;
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    const works = await fetchAllWorksWithRetry(page, {
      ...runtimeBudget,
      timeoutMs: DEFAULT_WORKS_TIMEOUT_MS,
      idleMs: DEFAULT_WORKS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    await emitResult(
      {
        pageUrl: options.pageUrl || DEFAULT_COMMENT_PAGE_URL,
        count: works.length,
        works: getWorksOutput(works)
      },
      outputPath
    );
  } finally {
    await context.close();
  }
}

export async function exportUnrepliedComments(options = {}) {
  if (!options.workTitle) {
    throw new Error('Missing work title. Usage: npm run comments:export -- "作品短标题"');
  }

  const outputPath = options.outputPath || DEFAULT_EXPORT_OUTPUT_PATH;
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    const targetWork = await resolveTargetWork(
      page,
      runtimeBudget,
      options.workTitle,
      options.workPublishText || ""
    );

    console.log(`已选中作品：${getSelectedWorkOutput(targetWork).title}`);
    const comments = await collectComments(page, {
      ...runtimeBudget,
      limit: options.limit || DEFAULT_EXPORT_LIMIT,
      timeoutMs: DEFAULT_COMMENTS_TIMEOUT_MS,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    const selectedWorkOutput = getSelectedWorkOutput(targetWork) ?? { title: "" };
    const includeHistory = !options.noHistory;

    // 在写入当前批次之前查询历史 & 回复次数，确保数据只含过去记录
    let historyMap = new Map();
    let replyCountMap = new Map();
    try {
      if (includeHistory) {
        historyMap = getUserHistoryMap(comments.map((c) => c.username));
      }
      replyCountMap = getReplyCountMap(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 查询历史/回复次数失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    // 过滤掉已回复过的评论（reply_count >= 1）
    const exportComments = comments.filter((c) => {
      const count = replyCountMap.get(`${c.username}|||${c.commentText}`) ?? 0;
      return count < 1;
    });
    const skipped = comments.length - exportComments.length;
    if (skipped > 0) {
      console.log(`[db] 过滤掉 ${skipped} 条已回复过的评论`);
    }

    await downloadCommentImages(exportComments, outputPath);

    await emitResult(
      {
        selectedWork: selectedWorkOutput,
        count: exportComments.length,
        comments: exportComments.map((comment) => {
          const entry = {
            username: comment.username,
            commentText: comment.commentText,
            replyMessage: ""
          };
          if (comment.imagePaths?.length > 0) {
            entry.imagePaths = comment.imagePaths;
          }
          if (includeHistory) {
            entry.history = historyMap.get(comment.username) ?? [];
          }
          return entry;
        })
      },
      outputPath
    );

    try {
      upsertComments(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText,
          replyMessage: null
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 写入评论失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }
  } finally {
    await context.close();
  }
}

export async function exportAllComments(options = {}) {
  if (!options.workTitle) {
    throw new Error('Missing work title. Usage: npm run comments:export-all -- "作品短标题"');
  }

  const outputPath = options.outputPath || DEFAULT_EXPORT_ALL_OUTPUT_PATH;
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    // 强制刷新（清空 HTTP 缓存，等价于 Ctrl+Shift+R），确保拿到最新评论数据。
    // 必须在选作品之前刷新，刷新后 SPA 状态重置，选作品后不再刷新。
    await hardRefreshPage(page, {
      navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS
    });
    // 刷新后等"选择作品"按钮出现，确认页面已恢复就绪
    await page
      .locator('button:has-text("选择作品"), [role="button"]:has-text("选择作品")')
      .first()
      .waitFor({ state: "visible", timeout: DEFAULT_UI_TIMEOUT_MS });

    // 等页面自动加载默认作品的评论（最多 8 秒），拿到稳定「旧指纹」
    await waitForCommentListChange(page, "", 8000).catch(() => {});
    const preSelectionFingerprint = await captureCommentListFingerprint(page).catch(() => "");

    const targetWork = await resolveTargetWork(
      page,
      runtimeBudget,
      options.workTitle,
      options.workPublishText || ""
    );

    console.log(`已选中作品：${getSelectedWorkOutput(targetWork).title}`);

    // 等评论列表从「旧指纹」切换到目标作品内容
    await waitForCommentListChange(page, preSelectionFingerprint, 10000).catch(() => {});

    const comments = await collectComments(page, {
      ...runtimeBudget,
      filterMode: "all",
      limit: options.limit || DEFAULT_EXPORT_LIMIT,
      timeoutMs: DEFAULT_COMMENTS_TIMEOUT_MS,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    const selectedWorkOutput = getSelectedWorkOutput(targetWork) ?? { title: "" };
    const includeHistory = !options.noHistory;

    // 在写入当前批次之前查询历史 & 回复次数，确保数据只含过去记录
    let historyMap = new Map();
    let replyCountMap = new Map();
    try {
      if (includeHistory) {
        historyMap = getUserHistoryMap(comments.map((c) => c.username));
      }
      replyCountMap = getReplyCountMap(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 查询历史/回复次数失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    // 过滤掉已回复过的评论（reply_count >= 1）
    const exportComments = comments.filter((c) => {
      const count = replyCountMap.get(`${c.username}|||${c.commentText}`) ?? 0;
      return count < 1;
    });
    const skipped = comments.length - exportComments.length;
    if (skipped > 0) {
      console.log(`[db] 过滤掉 ${skipped} 条已回复过的评论`);
    }

    await downloadCommentImages(exportComments, outputPath);

    await emitResult(
      {
        selectedWork: selectedWorkOutput,
        count: exportComments.length,
        comments: exportComments.map((comment) => {
          const entry = {
            username: comment.username,
            commentText: comment.commentText
          };
          if (comment.imagePaths?.length > 0) {
            entry.imagePaths = comment.imagePaths;
          }
          if (includeHistory) {
            entry.history = historyMap.get(comment.username) ?? [];
          }
          return entry;
        })
      },
      outputPath
    );

    try {
      upsertComments(
        selectedWorkOutput.title,
        comments.map((c) => ({
          username: c.username,
          commentText: c.commentText,
          replyMessage: null
        }))
      );
    } catch (dbError) {
      console.warn(`[db] 写入评论失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }
  } finally {
    await context.close();
  }
}

export async function replyComments(options = {}) {
  if (!options.planFile) {
    throw new Error("Missing plan file. Usage: npm run comments:reply -- plan.json");
  }

  const replyCommentsSource = await loadReplyCommentsFile(options.planFile);
  const allReplyPlans = replyCommentsSource.plans ?? [];
  const selectedWorkHint = replyCommentsSource.selectedWork;

  if (!selectedWorkHint?.title) {
    throw new Error("Reply plan file must contain selectedWork.title.");
  }

  // 过滤掉已回复过的评论（reply_count >= 1）
  let replyPlans = allReplyPlans;
  try {
    const replyCountMap = getReplyCountMap(
      selectedWorkHint.title,
      allReplyPlans.map((p) => ({
        username: p.username,
        commentText: p.commentText
      }))
    );
    const skippedByCount = [];
    replyPlans = allReplyPlans.filter((plan) => {
      const count = replyCountMap.get(`${plan.username}|||${plan.commentText}`) ?? 0;
      if (count >= 1) {
        skippedByCount.push({ username: plan.username, replyCount: count });
        return false;
      }
      return true;
    });
    if (skippedByCount.length > 0) {
      console.log(`[db] 跳过 ${skippedByCount.length} 条已回复过的评论`);
    }
  } catch (dbError) {
    console.warn(`[db] 查询回复次数失败（继续使用全部计划）: ${dbError?.message ?? dbError}`);
  }

  const outputPath = options.outputPath || DEFAULT_REPLY_OUTPUT_PATH;
  const replyLimit = options.limit || DEFAULT_REPLY_LIMIT;
  const keepBrowserOpenAfterRun = Boolean(options.keepOpen || options.dryRun) && !options.headless;
  const replyFlowTimeoutMs = resolveReplyFlowTimeout(replyLimit, replyPlans.length);
  const { context, page, runtimeBudget } = await openCommentSession(options);

  try {
    const targetWork = await resolveTargetWork(
      page,
      runtimeBudget,
      selectedWorkHint.title,
      selectedWorkHint.publishText || ""
    );

    console.log(`已选中作品：${getSelectedWorkOutput(targetWork).title}`);
    const replySummary = await replyToComments(page, {
      ...runtimeBudget,
      replyPlans,
      selectedWork: targetWork,
      replyLimit,
      replyDryRun: Boolean(options.dryRun),
      replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
      replySettleMs: DEFAULT_REPLY_SETTLE_MS,
      replyTypeDelayMs: DEFAULT_REPLY_TYPE_DELAY_MS,
      timeoutMs: replyFlowTimeoutMs,
      idleMs: DEFAULT_COMMENTS_IDLE_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    const selectedWorkOutput = getSelectedWorkOutput(targetWork);

    await emitResult(
      {
        fetchedAt: new Date().toISOString(),
        mode: "reply_comments",
        pageUrl: options.pageUrl || DEFAULT_COMMENT_PAGE_URL,
        selectedWork: selectedWorkOutput,
        replyCommentsFile: options.planFile,
        replyDryRun: Boolean(options.dryRun),
        replyLimit,
        ...replySummary
      },
      outputPath
    );

    try {
      const dbRows = replyPlans.map((plan) => ({
        username: plan.username,
        commentText: plan.commentText,
        replyMessage: plan.replyMessage
      }));
      upsertComments(selectedWorkOutput?.title ?? selectedWorkHint.title, dbRows);
    } catch (dbError) {
      console.warn(`[db] 写入回复失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    // 对本次实际成功回复的评论，在数据库中递增 reply_count。
    // 必须用 plan 里的 username/commentText：页面上 fuzzy 匹配到的正文可能与库里（导出 JSON）不完全一致，
    // 若用快照字符串 UPDATE 会 0 行，reply_count 不增，导致同一评论被反复导出、反复回复。
    try {
      const workTitleForDb = selectedWorkOutput?.title ?? selectedWorkHint.title;
      const planById = new Map(replyPlans.map((p) => [p.id, p]));
      const repliedResults = replySummary.results.filter((r) => r.status === "replied");
      let updatedRows = 0;
      let missedRows = 0;
      for (const r of repliedResults) {
        const plan = r.replyPlanId != null ? planById.get(r.replyPlanId) : null;
        const username = plan?.username ?? r.username;
        const commentText = plan?.commentText ?? r.commentText;
        const changes = incrementReplyCount(workTitleForDb, username, commentText);
        if (changes > 0) {
          updatedRows += 1;
        } else {
          missedRows += 1;
        }
      }
      if (updatedRows > 0) {
        console.log(`[db] 已更新 ${updatedRows} 条评论的回复计数`);
      }
      if (missedRows > 0) {
        console.warn(
          `[db] 有 ${missedRows} 条成功回复未在库中匹配到行（reply_count 未增加），请核对作品标题与导出 plan 是否一致`
        );
      }
    } catch (dbError) {
      console.warn(`[db] 更新回复计数失败（不影响主流程）: ${dbError?.message ?? dbError}`);
    }

    if (keepBrowserOpenAfterRun) {
      await promptForEnter("流程已完成，检查浏览器现场后按 Enter 关闭浏览器");
    }
  } finally {
    await context.close();
  }
}
