import {
  getEffectiveTimeout,
  logReplyFilterDebug,
  normalizeText,
  normalizeUsername,
  summarizeCommentsForLog
} from "./common.mjs";
import {
  advanceCommentScroll,
  applyUnrepliedCommentsFilter,
  captureCommentListFingerprint,
  getCommentTerminalIndicator,
  markCommentScrollContainer,
  resetCommentScrollToTop,
  switchToAllCommentsFilter,
  tryAdvancePagination,
  waitForCommentListChange,
  waitForCommentsArea
} from "./comment-ops.mjs";
import { extractCommentSnapshot } from "./comment-snapshot.mjs";

/** 与平台常见限制一致：按 Unicode 码点计数字符（汉字、标点、字母、空格各计 1），超出则截断 */
const MAX_REPLY_MESSAGE_CHARS = 400;

function truncateReplyMessage(text) {
  const s = text == null ? "" : String(text);
  const codePoints = [...s];
  if (codePoints.length <= MAX_REPLY_MESSAGE_CHARS) {
    return { text: s, truncated: false };
  }
  return {
    text: codePoints.slice(0, MAX_REPLY_MESSAGE_CHARS).join(""),
    truncated: true
  };
}

function buildVisibleUsernameCounts(snapshot, processedSignatures) {
  const counts = new Map();

  for (const comment of snapshot) {
    if (!comment?.signature || processedSignatures.has(comment.signature)) {
      continue;
    }

    const username = normalizeUsername(comment.username).toLowerCase();
    if (!username) {
      continue;
    }

    counts.set(username, (counts.get(username) || 0) + 1);
  }

  return counts;
}

function countRemainingPlansForUsername(replyPlans, processedPlanIds, username) {
  let count = 0;

  for (const plan of replyPlans) {
    if (processedPlanIds.has(plan.id)) {
      continue;
    }

    if (normalizeUsername(plan.username).toLowerCase() !== username) {
      continue;
    }

    count += 1;
  }

  return count;
}

function commentTextsMatch(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function matchReplyPlan(comment, replyPlans, processedPlanIds, visibleUsernameCounts) {
  if (!Array.isArray(replyPlans) || replyPlans.length === 0) {
    return null;
  }

  const commentUsername = normalizeUsername(comment.username).toLowerCase();
  const remainingPlanCount = countRemainingPlansForUsername(
    replyPlans,
    processedPlanIds,
    commentUsername
  );
  const visibleCommentCount = visibleUsernameCounts.get(commentUsername) || 0;
  const requireCommentMatch = remainingPlanCount > 1 || visibleCommentCount > 1;

  for (const plan of replyPlans) {
    if (processedPlanIds.has(plan.id)) {
      continue;
    }

    if (!plan.username) {
      continue;
    }

    if (normalizeUsername(plan.username).toLowerCase() !== commentUsername) {
      continue;
    }

    if (requireCommentMatch && !commentTextsMatch(plan.commentText, comment.commentText)) {
      continue;
    }

    return {
      plan,
      matchMode: requireCommentMatch ? "username_comment" : "username_only",
      remainingPlanCount,
      visibleCommentCount
    };
  }

  return null;
}

function getNextReplyTarget(snapshot, options, processedSignatures, processedPlanIds) {
  if (!Array.isArray(options.replyPlans) || options.replyPlans.length === 0) {
    return null;
  }

  const visibleUsernameCounts = buildVisibleUsernameCounts(snapshot, processedSignatures);

  for (const comment of snapshot) {
    if (!comment.signature || processedSignatures.has(comment.signature)) {
      continue;
    }

    const matchedPlan = matchReplyPlan(
      comment,
      options.replyPlans,
      processedPlanIds,
      visibleUsernameCounts
    );
    if (!matchedPlan) {
      continue;
    }

    return {
      comment,
      plan: matchedPlan.plan,
      replyMessage: matchedPlan.plan.replyMessage,
      matchMode: matchedPlan.matchMode,
      remainingPlanCount: matchedPlan.remainingPlanCount,
      visibleCommentCount: matchedPlan.visibleCommentCount
    };
  }

  return null;
}

async function inspectCommentActions(commentLocator) {
  return commentLocator.evaluate((root) => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();

    for (const marked of root.querySelectorAll("[data-codex-toggle-action]")) {
      marked.removeAttribute("data-codex-toggle-action");
    }

    for (const marked of root.querySelectorAll("[data-codex-reply-action]")) {
      marked.removeAttribute("data-codex-reply-action");
    }

    const candidates = Array.from(root.querySelectorAll("button, div, span"));
    const toggleCandidate = candidates.find((node) => {
      const text = normalize(node.textContent || "");
      return (text.includes("条回复") || text === "收起") && text.length <= 20;
    });
    const replyCandidate = candidates.find((node) => normalize(node.textContent || "") === "回复");
    const editableValues = Array.from(root.querySelectorAll('[contenteditable="true"]'))
      .map((node) => normalize(node.textContent || ""))
      .filter(Boolean)
      .slice(0, 2);
    const rootText = normalize(root.innerText || "");

    if (toggleCandidate instanceof HTMLElement) {
      toggleCandidate.setAttribute("data-codex-toggle-action", "true");
    }

    if (replyCandidate instanceof HTMLElement) {
      replyCandidate.setAttribute("data-codex-reply-action", "true");
    }

    return {
      hasToggle: toggleCandidate instanceof HTMLElement,
      toggleText: normalize(toggleCandidate?.textContent || ""),
      hasReplyButton: replyCandidate instanceof HTMLElement,
      openInputCount: root.querySelectorAll('[contenteditable="true"]').length,
      editableValues,
      textPreview: rootText.slice(0, 240)
    };
  });
}

async function waitForReplySendReady(page, commentLocator, timeoutMs, options = null) {
  const effectiveTimeoutMs = getEffectiveTimeout(options, timeoutMs);
  const startedAt = Date.now();

  while (Date.now() - startedAt < effectiveTimeoutMs) {
    const ready = await commentLocator.evaluate((root) => {
      const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
      const sendCandidate = Array.from(root.querySelectorAll("button, div, span")).find(
        (node) => normalize(node.textContent || "") === "发送"
      );

      if (!(sendCandidate instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(sendCandidate);
      const isButton = sendCandidate instanceof HTMLButtonElement;
      const disabled =
        (isButton && sendCandidate.disabled) ||
        sendCandidate.getAttribute("disabled") !== null ||
        sendCandidate.getAttribute("aria-disabled") === "true";

      return !disabled && style.pointerEvents !== "none" && style.visibility !== "hidden";
    });

    if (ready) {
      return;
    }

    await page.waitForTimeout(120);
  }

  throw new Error(`Timed out waiting for the send button after ${effectiveTimeoutMs}ms.`);
}

function isResolvedReplyStatus(status) {
  return status === "replied" || status === "dry_run_typed";
}

async function safeReplyToComment(page, commentLocator, comment, options) {
  const { text: replyText, truncated: replyMessageTruncated } = truncateReplyMessage(
    options.replyMessage ?? ""
  );
  if (replyMessageTruncated) {
    logReplyFilterDebug("reply message truncated to max length", {
      maxChars: MAX_REPLY_MESSAGE_CHARS,
      originalCodePointCount: [...String(options.replyMessage ?? "")].length
    });
  }

  const result = {
    username: comment.username,
    commentText: comment.commentText,
    publishText: comment.publishText,
    status: "pending",
    appliedReplyMessage: replyText,
    replyMessageTruncated
  };
  let stage = "start";

  try {
    logReplyFilterDebug("processing reply target", {
      username: comment.username,
      commentText: comment.commentText,
      publishText: comment.publishText
    });

    let actionState = await inspectCommentActions(commentLocator);
    logReplyFilterDebug("initial comment action state", {
      username: comment.username,
      commentText: comment.commentText,
      actionState
    });

    if (actionState.hasToggle && actionState.toggleText.includes("条回复")) {
      stage = "expand_replies";
      const toggleButton = commentLocator.locator('[data-codex-toggle-action="true"]').first();
      await toggleButton.click();
      await page.waitForTimeout(Math.min(1000, options.replySettleMs));
      actionState = await inspectCommentActions(commentLocator);
      logReplyFilterDebug("action state after expanding replies", {
        username: comment.username,
        commentText: comment.commentText,
        actionState
      });
    }

    if (!actionState.hasReplyButton) {
      return {
        ...result,
        status: "skipped_no_reply_button"
      };
    }

    const replyButton = commentLocator.locator('[data-codex-reply-action="true"]').first();
    stage = "click_reply_button";
    await replyButton.click();

    const inputBox = commentLocator.locator('div[contenteditable="true"]').last();
    stage = "wait_input_box";
    await inputBox.waitFor({
      state: "visible",
      timeout: getEffectiveTimeout(options, options.replyTimeoutMs)
    });
    stage = "type_reply";
    await inputBox.click();
    await inputBox.type(replyText, {
      delay: options.replyTypeDelayMs
    });

    if (options.replyDryRun) {
      stage = "settle_after_type";
      await page.waitForTimeout(Math.min(500, options.replySettleMs));
      logReplyFilterDebug("dry-run typed reply message", {
        username: comment.username,
        commentText: comment.commentText
      });

      return {
        ...result,
        status: "dry_run_typed"
      };
    }

    stage = "wait_send_button";
    await waitForReplySendReady(page, commentLocator, options.replyTimeoutMs, options);

    const sendButton = commentLocator.getByText("发送", { exact: true }).first();
    stage = "click_send_button";
    await sendButton.click();
    await page.waitForTimeout(1000);
    logReplyFilterDebug("clicked send button", {
      username: comment.username,
      commentText: comment.commentText
    });

    logReplyFilterDebug("reply treated as successful immediately after clicking send", {
      username: comment.username,
      commentText: comment.commentText
    });
    return {
      ...result,
      status: "replied"
    };
  } catch (error) {
    logReplyFilterDebug("reply failed", {
      username: comment.username,
      commentText: comment.commentText,
      stage,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ...result,
      status: "error",
      errorStage: stage,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function aggressivelyAdvanceCommentScroll(
  page,
  scrollContainer,
  options,
  processedSignatures,
  processedPlanIds
) {
  const attempts = [];
  let previousFingerprint = await captureCommentListFingerprint(page);
  let latestSnapshot = [];
  let foundUnprocessed = false;

  for (let index = 0; index < 10; index += 1) {
    const state = await advanceCommentScroll(page, scrollContainer, {
      distanceMultiplier: 2.2,
      minDistancePx: 2200,
      wheelDeltaY: 2600,
      pageDistanceMultiplier: 1.8,
      pageMinDistancePx: 1800
    });
    const listChangeWait = waitForCommentListChange(page, previousFingerprint, 1000);
    await page.waitForTimeout(1000);
    const listChanged = await listChangeWait;
    attempts.push({
      ...state,
      listChanged
    });

    latestSnapshot = await extractCommentSnapshot(page);
    foundUnprocessed = Boolean(
      getNextReplyTarget(latestSnapshot, options, processedSignatures, processedPlanIds)
    );
    previousFingerprint = await captureCommentListFingerprint(page);

    if (foundUnprocessed) {
      break;
    }
  }

  const fallbackState = {
    before: 0,
    after: 0,
    maxScrollTop: 0,
    strategy: "none",
    listChanged: false
  };
  const lastAttempt = attempts[attempts.length - 1] ?? fallbackState;
  const trailingAttempts = attempts.slice(-2);

  return {
    ...lastAttempt,
    attempts: attempts.length,
    anyMovement: attempts.some((attempt) => attempt.after > attempt.before),
    anyListChange: attempts.some((attempt) => attempt.listChanged),
    foundUnprocessed,
    latestSnapshot,
    reachedBottom:
      attempts.length > 0 &&
      lastAttempt.after >= lastAttempt.maxScrollTop &&
      trailingAttempts.every(
        (attempt) => attempt.after >= attempt.maxScrollTop || attempt.after === attempt.before
      )
  };
}

/**
 * Try to advance to the next page of comments, switching filters if needed.
 * When "未回复" shows empty, pagination controls may be hidden.
 * Fall back to switching to "全部评论", paginating, then switching back.
 */
async function tryAdvancePageForReply(page, options, remainingCount) {
  // First try direct pagination (pagination might be visible even with empty list)
  let result = await tryAdvancePagination(page, options);
  if (result.advanced && result.pageChanged) {
    logReplyFilterDebug("direct pagination succeeded", result.details);
    return true;
  }

  if (remainingCount <= 0) return false;

  // Switch to "全部评论" to expose pagination controls
  logReplyFilterDebug("switching to all-comments filter for pagination");
  await switchToAllCommentsFilter(page, options).catch(() => {});

  // Wait for the comment list to reload with all comments
  await page.waitForTimeout(1000);

  // Try pagination again
  result = await tryAdvancePagination(page, options);
  logReplyFilterDebug("pagination attempt from all-comments view", result.details);

  if (result.advanced && result.pageChanged) {
    // Successfully moved to next page. Switch back to "未回复".
    logReplyFilterDebug("pagination succeeded, switching back to unreplied filter");
    await applyUnrepliedCommentsFilter(page, options).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }

  // If pagination still failed, switch back to "未回复" anyway
  await applyUnrepliedCommentsFilter(page, options).catch(() => {});
  await page.waitForTimeout(500);
  return false;
}

export async function replyToComments(page, options) {
  await applyUnrepliedCommentsFilter(page, options).catch(() => {});
  await waitForCommentsArea(page, options);

  const scrollContainer = await markCommentScrollContainer(page);
  await resetCommentScrollToTop(page, scrollContainer);
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs);
  const startedAt = Date.now();
  const processedSignatures = new Set();
  const processedPlanIds = new Set();
  const results = [];
  let repliedCount = 0;
  let actedCount = 0;
  let lastProgressAt = startedAt;
  let loggedNoMatchSnapshot = false;
  let stalledScrollAttempts = 0;
  let bottomSearchBursts = 0;
  let paginationAttempts = 0;
  const MAX_PAGINATION_ATTEMPTS = 10;
  let exitReason = "";
  let exitDetails = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (Array.isArray(options.replyPlans) && processedPlanIds.size >= options.replyPlans.length) {
      exitReason = "all_reply_plans_resolved";
      exitDetails = {
        processedPlanCount: processedPlanIds.size
      };
      logReplyFilterDebug("reply flow completed: all reply plans resolved");
      break;
    }

    const snapshot = await extractCommentSnapshot(page);
    const nextTarget = getNextReplyTarget(snapshot, options, processedSignatures, processedPlanIds);

    if (nextTarget) {
      const {
        comment: nextComment,
        plan,
        replyMessage,
        matchMode,
        remainingPlanCount,
        visibleCommentCount
      } = nextTarget;
      logReplyFilterDebug("matched reply target", {
        username: nextComment.username,
        commentText: nextComment.commentText,
        publishText: nextComment.publishText,
        replyPlanId: plan?.id ?? null,
        matchMode,
        remainingPlanCount,
        visibleCommentCount
      });

      const commentLocator = page
        .locator(`[data-codex-comment-block="${nextComment.domIndex}"]`)
        .first();
      const replyResult = await safeReplyToComment(page, commentLocator, nextComment, {
        ...options,
        replyMessage
      });

      results.push({
        ...replyResult,
        replyPlanId: plan?.id ?? null,
        requestedReplyMessage: replyMessage
      });
      if (isResolvedReplyStatus(replyResult.status)) {
        processedSignatures.add(nextComment.signature);
        if (plan) {
          processedPlanIds.add(plan.id);
        }
        actedCount += 1;
        lastProgressAt = Date.now();
        loggedNoMatchSnapshot = false;
        stalledScrollAttempts = 0;
        bottomSearchBursts = 0;
      }

      if (replyResult.status === "replied") {
        repliedCount += 1;
      }

      if (actedCount >= options.replyLimit) {
        exitReason = options.replyDryRun ? "dry_run_limit_reached" : "reply_limit_reached";
        exitDetails = {
          replyLimit: options.replyLimit,
          actedCount,
          repliedCount
        };
        logReplyFilterDebug("reply flow completed: reached action limit", {
          replyLimit: options.replyLimit,
          actedCount,
          repliedCount
        });
        break;
      }

      if (!isResolvedReplyStatus(replyResult.status)) {
        await page.waitForTimeout(600);
      }

      continue;
    }

    if (!loggedNoMatchSnapshot) {
      const remainingPlans = options.replyPlans
        .filter((plan) => !processedPlanIds.has(plan.id))
        .slice(0, 5)
        .map((plan) => ({
          id: plan.id,
          username: plan.username,
          commentText: plan.commentText,
          publishText: plan.publishText,
          replyMessage: plan.replyMessage
        }));
      logReplyFilterDebug("no visible comment matched current reply plans", {
        visibleComments: summarizeCommentsForLog(snapshot, 5),
        remainingPlans
      });
      loggedNoMatchSnapshot = true;
    }

    const terminalIndicator = await getCommentTerminalIndicator(page);
    if (terminalIndicator) {
      const remainingCount = Array.isArray(options.replyPlans)
        ? options.replyPlans.filter((plan) => !processedPlanIds.has(plan.id)).length
        : 0;

      // Try pagination for both "no more comments" and "no matching comments"
      const shouldTryPagination =
        (terminalIndicator.kind === "no_more_comments_indicator" ||
         terminalIndicator.kind === "no_matching_comments_indicator") &&
        remainingCount > 0 &&
        paginationAttempts < MAX_PAGINATION_ATTEMPTS;

      if (shouldTryPagination) {
        const advanced = await tryAdvancePageForReply(page, options, remainingCount);
        logReplyFilterDebug("attempted pagination on terminal indicator", {
          kind: terminalIndicator.kind,
          paginationAttempt: paginationAttempts + 1,
          remainingCount,
          advanced
        });
        if (advanced) {
          paginationAttempts += 1;
          lastProgressAt = Date.now();
          loggedNoMatchSnapshot = false;
          stalledScrollAttempts = 0;
          bottomSearchBursts = 0;
          continue;
        }
        paginationAttempts += 1;
      }

      exitReason = terminalIndicator.kind;
      exitDetails = {
        terminalIndicator,
        remainingPlanCount: remainingCount,
        paginationAttempts
      };
      logReplyFilterDebug("reply flow completed: reached terminal indicator", exitDetails);
      break;
    }

    const scrollState = await aggressivelyAdvanceCommentScroll(
      page,
      scrollContainer,
      options,
      processedSignatures,
      processedPlanIds
    );
    logReplyFilterDebug("aggressive downward scan after missing reply target", {
      attempts: scrollState.attempts,
      strategy: scrollState.strategy,
      anyMovement: scrollState.anyMovement,
      anyListChange: scrollState.anyListChange,
      foundUnprocessed: scrollState.foundUnprocessed,
      reachedBottom: scrollState.reachedBottom
    });

    const nextSnapshot = Array.isArray(scrollState.latestSnapshot)
      ? scrollState.latestSnapshot
      : [];
    const hasUnprocessed = scrollState.foundUnprocessed;
    const hasVisibleComments = nextSnapshot.length > 0;
    const scrollMoved = scrollState.anyMovement;
    const reachedBottom = scrollState.reachedBottom;

    const terminalIndicatorAfterScroll = await getCommentTerminalIndicator(page);
    if (!hasUnprocessed && terminalIndicatorAfterScroll) {
      const remainingCount = Array.isArray(options.replyPlans)
        ? options.replyPlans.filter((plan) => !processedPlanIds.has(plan.id)).length
        : 0;

      // Try pagination for both kinds of terminal indicators
      const shouldTryPagination =
        (terminalIndicatorAfterScroll.kind === "no_more_comments_indicator" ||
         terminalIndicatorAfterScroll.kind === "no_matching_comments_indicator") &&
        remainingCount > 0 &&
        paginationAttempts < MAX_PAGINATION_ATTEMPTS;

      if (shouldTryPagination) {
        const advanced = await tryAdvancePageForReply(page, options, remainingCount);
        logReplyFilterDebug("attempted pagination after scroll", {
          kind: terminalIndicatorAfterScroll.kind,
          paginationAttempt: paginationAttempts + 1,
          remainingCount,
          advanced
        });
        if (advanced) {
          paginationAttempts += 1;
          lastProgressAt = Date.now();
          loggedNoMatchSnapshot = false;
          stalledScrollAttempts = 0;
          bottomSearchBursts = 0;
          continue;
        }
        paginationAttempts += 1;
      }

      exitReason = terminalIndicatorAfterScroll.kind;
      exitDetails = {
        terminalIndicator: terminalIndicatorAfterScroll,
        remainingPlanCount: remainingCount,
        scrollMoved,
        anyListChange: scrollState.anyListChange,
        paginationAttempts
      };
      logReplyFilterDebug(
        "reply flow completed: reached terminal indicator after scrolling",
        exitDetails
      );
      break;
    }

    if (hasUnprocessed) {
      lastProgressAt = Date.now();
      loggedNoMatchSnapshot = false;
      stalledScrollAttempts = 0;
      bottomSearchBursts = 0;
      continue;
    }

    if (scrollMoved || scrollState.anyListChange) {
      stalledScrollAttempts = 0;
    } else {
      stalledScrollAttempts += 1;
    }

    if (reachedBottom) {
      bottomSearchBursts += 1;
    } else {
      bottomSearchBursts = 0;
    }

    if (!hasVisibleComments && !scrollMoved && !scrollState.anyListChange) {
      exitReason = "no_comments_visible_after_scroll";
      exitDetails = {
        hasVisibleComments,
        scrollMoved,
        anyListChange: scrollState.anyListChange
      };
      logReplyFilterDebug("reply flow completed: no comments visible after scroll");
      break;
    }

    if (reachedBottom && !hasUnprocessed && bottomSearchBursts >= 2) {
      // Before giving up, try pagination if there are remaining plans
      const remainingCount = Array.isArray(options.replyPlans)
        ? options.replyPlans.filter((plan) => !processedPlanIds.has(plan.id)).length
        : 0;

      if (remainingCount > 0 && paginationAttempts < MAX_PAGINATION_ATTEMPTS) {
        const advanced = await tryAdvancePageForReply(page, options, remainingCount);
        logReplyFilterDebug("attempted pagination at bottom-search exit point", {
          paginationAttempt: paginationAttempts + 1,
          remainingCount,
          advanced
        });
        if (advanced) {
          paginationAttempts += 1;
          lastProgressAt = Date.now();
          loggedNoMatchSnapshot = false;
          stalledScrollAttempts = 0;
          bottomSearchBursts = 0;
          continue;
        }
        paginationAttempts += 1;
      }

      exitReason = "reached_bottom_repeatedly_without_match";
      exitDetails = {
        bottomSearchBursts,
        paginationAttempts
      };
      logReplyFilterDebug(
        "reply flow completed: reached bottom repeatedly with no matching plans",
        {
          bottomSearchBursts,
          paginationAttempts
        }
      );
      break;
    }

    if (stalledScrollAttempts >= 8) {
      exitReason = "stalled_scroll_attempts";
      exitDetails = {
        stalledScrollAttempts
      };
      logReplyFilterDebug("reply flow stopped after repeated stalled scroll attempts", {
        stalledScrollAttempts
      });
      break;
    }

    if (Date.now() - lastProgressAt >= options.idleMs * 2 && stalledScrollAttempts >= 4) {
      exitReason = "idle_window_without_new_matches";
      exitDetails = {
        idleMs: options.idleMs * 2,
        stalledScrollAttempts
      };
      logReplyFilterDebug("reply flow stopped after idle window without new matches", {
        stalledScrollAttempts
      });
      break;
    }
  }

  if (!exitReason) {
    exitReason =
      Date.now() - startedAt >= timeoutMs ? "reply_flow_total_timeout" : "reply_flow_finished";
    exitDetails = {
      timeoutMs,
      elapsedMs: Date.now() - startedAt
    };
  }

  const skippedCount = results.filter((item) => item.status.startsWith("skipped_")).length;
  const dryRunCount = results.filter((item) => item.status === "dry_run_typed").length;
  const errorCount = results.filter((item) => item.status === "error").length;
  const unmatchedPlans = Array.isArray(options.replyPlans)
    ? options.replyPlans
        .filter((plan) => !processedPlanIds.has(plan.id))
        .map((plan) => ({
          id: plan.id,
          username: plan.username,
          commentText: plan.commentText,
          publishText: plan.publishText,
          replyMessage: plan.replyMessage
        }))
    : [];
  const elapsedMs = Date.now() - startedAt;

  logReplyFilterDebug("reply flow finished", {
    exitReason,
    exitDetails,
    elapsedMs,
    repliedCount,
    actedCount,
    totalProcessed: results.length,
    matchedPlanCount: processedPlanIds.size,
    unmatchedPlanCount: unmatchedPlans.length
  });

  return {
    replyDryRun: Boolean(options.replyDryRun),
    exitReason,
    exitDetails,
    elapsedMs,
    configuredTimeoutMs: timeoutMs,
    configuredIdleMs: options.idleMs,
    configuredReplyTimeoutMs: options.replyTimeoutMs,
    configuredReplySettleMs: options.replySettleMs,
    repliedCount,
    actedCount,
    dryRunCount,
    skippedCount,
    errorCount,
    totalProcessed: results.length,
    matchedPlanCount: processedPlanIds.size,
    unmatchedPlanCount: unmatchedPlans.length,
    unmatchedPlans,
    results
  };
}
