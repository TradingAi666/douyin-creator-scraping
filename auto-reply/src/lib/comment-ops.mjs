import {
  getEffectiveTimeout,
  logReplyFilterDebug,
  normalizeText,
  sanitizeCollectedComment,
  waitForAsyncCondition
} from "./common.mjs";
import { addCommentsFromSnapshot, extractCommentSnapshot } from "./comment-snapshot.mjs";

export async function waitForCommentsArea(page, options) {
  const candidates = [
    page.locator("[comment-item]").first(),
    page.locator('button:has-text("回复"), div:has-text("回复")').first()
  ];
  const timeoutMs = getEffectiveTimeout(options, options.uiTimeoutMs);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        return;
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error(
    `Timed out waiting for the comment area after ${timeoutMs}ms. Try --ui-timeout-ms 60000.`
  );
}

async function markCommentStatusFilter(page) {
  const marked = await page.evaluate(() => {
    const marker = "data-codex-comment-status-filter";
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const knownFilterLabels = new Set(["全部评论", "未回复", "已回复"]);

    for (const element of document.querySelectorAll(`[${marker}]`)) {
      element.removeAttribute(marker);
    }

    const candidates = Array.from(
      document.querySelectorAll('[role="combobox"].douyin-creator-interactive-select')
    ).filter((node) => node instanceof HTMLElement);

    const target =
      candidates.find((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        return knownFilterLabels.has(text);
      }) ??
      candidates.find((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        return text.includes("全部评论") || text.includes("未回复") || text.includes("已回复");
      });

    if (!(target instanceof HTMLElement)) {
      return false;
    }

    target.setAttribute(marker, "true");
    return true;
  });

  return marked ? page.locator('[data-codex-comment-status-filter="true"]').first() : null;
}

async function waitForCommentStatusFilter(page, options) {
  const timeoutMs = getEffectiveTimeout(options, options.uiTimeoutMs);
  const startedAt = Date.now();
  let lastLoggedAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const filterTrigger = await markCommentStatusFilter(page);
    if (filterTrigger) {
      const currentText = normalizeText(await filterTrigger.textContent());
      logReplyFilterDebug("found comment status filter", { text: currentText });
      return filterTrigger;
    }

    if (Date.now() - lastLoggedAt >= 1000) {
      const availableComboboxes = await page.evaluate(() => {
        const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
        return Array.from(document.querySelectorAll('[role="combobox"]'))
          .filter((node) => node instanceof HTMLElement)
          .map((node) => normalize(node.innerText || node.textContent || ""))
          .filter(Boolean)
          .slice(0, 10);
      });
      logReplyFilterDebug("waiting for comment status filter", {
        elapsedMs: Date.now() - startedAt,
        availableComboboxes
      });
      lastLoggedAt = Date.now();
    }

    await page.waitForTimeout(200);
  }

  const availableComboboxes = await page.evaluate(() => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll('[role="combobox"]'))
      .filter((node) => node instanceof HTMLElement)
      .map((node) => normalize(node.innerText || node.textContent || ""))
      .filter(Boolean)
      .slice(0, 10);
  });
  throw new Error(
    `Timed out waiting for the comment status filter after ${timeoutMs}ms. Visible comboboxes: ${JSON.stringify(
      availableComboboxes
    )}. Try --ui-timeout-ms 60000.`
  );
}

export async function captureCommentListFingerprint(page) {
  return page.evaluate(() => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const collectCommentNodes = () => {
      const explicitNodes = Array.from(document.querySelectorAll("[comment-item]")).filter(
        (node) => node instanceof HTMLElement
      );
      if (explicitNodes.length > 0) {
        return explicitNodes;
      }

      return Array.from(document.querySelectorAll("div, section, article")).filter((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const text = normalize(node.innerText || node.textContent || "");
        if (!text || !text.includes("回复")) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width >= 280 && rect.height >= 50 && text.length <= 4000;
      });
    };

    return collectCommentNodes()
      .slice(0, 5)
      .map((node) => normalize((node.innerText || node.textContent || "").slice(0, 160)))
      .filter(Boolean)
      .join("||");
  });
}

export async function waitForCommentListChange(page, previousFingerprint, timeoutMs) {
  return waitForAsyncCondition(
    page,
    timeoutMs,
    async () => (await captureCommentListFingerprint(page)) !== previousFingerprint,
    120
  );
}

export async function getCommentTerminalIndicator(page) {
  return page.evaluate(() => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const terminalIndicators = [
      {
        kind: "no_more_comments_indicator",
        text: "没有更多评论"
      },
      {
        kind: "no_matching_comments_indicator",
        text: "暂无符合条件的评论"
      }
    ];
    const candidates = Array.from(document.querySelectorAll("div, span, p")).filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight + 240 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });

    for (const node of candidates) {
      const text = normalize(node.innerText || node.textContent || "");
      const matchedIndicator = terminalIndicators.find((indicator) =>
        text.includes(indicator.text)
      );

      if (!matchedIndicator) {
        continue;
      }

      // "暂无符合条件的评论" is always a genuine terminal state
      if (matchedIndicator.kind === "no_matching_comments_indicator") {
        return matchedIndicator;
      }

      // "没有更多评论" can appear on an infinite-scroll sentinel element
      // (e.g. class="loading-NTmKHl") that is always visible at the bottom of
      // the current batch. Only treat it as a genuine terminal once:
      //   (a) There are truly no comment items at all (empty list), OR
      //   (b) The marked scroll container has scrollable content AND scrollTop
      //       has actually reached the bottom.
      // Determine whether any comment content is actually rendered.
      // The page may not use [comment-item] attributes, so fall back to
      // detecting "回复" buttons (each root comment has one).
      const hasCommentItems = document.querySelectorAll("[comment-item]").length > 0;
      const hasReplyButtons = Array.from(document.querySelectorAll("button, div, span")).some(
        (n) => (n.textContent || "").trim() === "回复"
      );
      const hasComments = hasCommentItems || hasReplyButtons;

      if (!hasComments) {
        // Page is genuinely empty — no comments at all.
        return matchedIndicator;
      }

      const scrollContainer = document.querySelector('[data-codex-comment-scroll="true"]');
      if (!scrollContainer) {
        // Can't verify scroll position; rely on stall-detection to stop instead.
        continue;
      }

      const scrollableHeight = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      if (scrollableHeight <= 20) {
        // Container has no scrollable room (wrong container or fits in viewport).
        // Can't use scroll position to confirm end; rely on stall-detection.
        continue;
      }

      const atBottom = scrollContainer.scrollTop >= scrollableHeight - 20;
      if (!atBottom) {
        continue;
      }

      return matchedIndicator;
    }

    return null;
  });
}

export async function applyUnrepliedCommentsFilter(page, options) {
  return applyCommentFilter(page, "未回复", options);
}

/**
 * Switch the comment filter to "全部评论" (all comments, including replied).
 * Used as a fallback when "未回复" returns empty but there are more pages.
 */
export async function switchToAllCommentsFilter(page, options) {
  return applyCommentFilter(page, "全部评论", options);
}

/**
 * Generic: switch comment status filter to the given label.
 */
async function applyCommentFilter(page, targetLabel, options) {
  const filterTrigger = await waitForCommentStatusFilter(page, options);

  try {
    await filterTrigger.scrollIntoViewIfNeeded().catch(() => {});
    const currentText = normalizeText(await filterTrigger.textContent());
    logReplyFilterDebug("current comment filter text", currentText);
    if (currentText.includes(targetLabel)) {
      logReplyFilterDebug(`comment filter already set to ${targetLabel}`);
      return {
        applied: true,
        reason: "already_selected"
      };
    }

    const previousFingerprint = await captureCommentListFingerprint(page);
    await filterTrigger.click();

    const optionsLocator = page.locator(".douyin-creator-interactive-select-option");
    await optionsLocator.first().waitFor({
      state: "visible",
      timeout: getEffectiveTimeout(options, options.uiTimeoutMs)
    });

    const optionCount = await optionsLocator.count();
    const optionTexts = [];
    for (let index = 0; index < optionCount; index += 1) {
      optionTexts.push(normalizeText(await optionsLocator.nth(index).textContent()));
    }
    logReplyFilterDebug("comment filter dropdown options", optionTexts);
    const refreshTimeoutMs = Math.min(getEffectiveTimeout(options, options.uiTimeoutMs), 8000);

    for (let index = 0; index < optionCount; index += 1) {
      const option = optionsLocator.nth(index);
      const text = optionTexts[index];
      if (text !== targetLabel) {
        continue;
      }

      const filterSelectedWait = page
        .waitForFunction(
          (target) => {
            const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
            return Array.from(
              document.querySelectorAll('div[role="combobox"].douyin-creator-interactive-select')
            ).some((node) =>
              normalize(node.innerText || node.textContent || "").includes(target)
            );
          },
          targetLabel,
          { timeout: refreshTimeoutMs }
        )
        .then(() => true)
        .catch(() => false);

      const domWait = page
        .waitForFunction(
          (data) => {
            const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
            const filterSelected = Array.from(
              document.querySelectorAll('div[role="combobox"].douyin-creator-interactive-select')
            ).some((node) =>
              normalize(node.innerText || node.textContent || "").includes(data.target)
            );

            if (!filterSelected) {
              return false;
            }

            const currentFingerprint = Array.from(
              (function collectCommentNodes() {
                const explicitNodes = Array.from(
                  document.querySelectorAll("[comment-item]")
                ).filter((node) => node instanceof HTMLElement);
                if (explicitNodes.length > 0) {
                  return explicitNodes;
                }

                const normalizeText = (value = "") => value.replace(/\s+/g, " ").trim();
                return Array.from(document.querySelectorAll("div, section, article")).filter(
                  (node) => {
                    if (!(node instanceof HTMLElement)) {
                      return false;
                    }
                    const text = normalizeText(node.innerText || node.textContent || "");
                    if (!text || !text.includes("回复")) {
                      return false;
                    }
                    const rect = node.getBoundingClientRect();
                    return rect.width >= 280 && rect.height >= 50 && text.length <= 4000;
                  }
                );
              })()
            )
              .filter((node) => node instanceof HTMLElement)
              .slice(0, 5)
              .map((node) => normalize((node.innerText || node.textContent || "").slice(0, 160)))
              .filter(Boolean)
              .join("||");

            return currentFingerprint !== data.fingerprint || currentFingerprint.length === 0;
          },
          { fingerprint: previousFingerprint, target: targetLabel },
          { timeout: refreshTimeoutMs }
        )
        .then(() => true)
        .catch(() => false);

      await option.click();
      const [filterSelected, domUpdated] = await Promise.all([filterSelectedWait, domWait]);
      logReplyFilterDebug(`applied ${targetLabel} filter`, {
        filterSelected,
        domUpdated
      });

      if (!filterSelected) {
        throw new Error(`点击“${targetLabel}”后，下拉框没有成功切换到目标选项。`);
      }

      if (domUpdated) {
        await waitForCommentListChange(page, previousFingerprint, 350).catch(() => {});
      } else {
        await page.waitForTimeout(500);
      }

      return {
        applied: true,
        reason: "selected"
      };
    }

    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(`评论状态过滤下拉框中未找到“${targetLabel}”选项。`);
  } catch (error) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `切换“${targetLabel}”过滤失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function markCommentScrollContainer(page) {
  const marked = await page.evaluate(() => {
    const marker = "data-codex-comment-scroll";
    const elements = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll("main, section, div")
    ];

    for (const element of document.querySelectorAll(`[${marker}]`)) {
      element.removeAttribute(marker);
    }

    let bestElement = null;
    let bestScore = -1;

    for (const element of elements) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const hasScrollableOverflow =
        overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      const scrollableDelta = element.scrollHeight - element.clientHeight;
      const markerCount = Array.from(element.querySelectorAll("button, div, span")).filter(
        (node) => {
          const text = (node.textContent || "").trim();
          return text === "回复" || text.includes("条回复") || text === "收起";
        }
      ).length;

      if (markerCount === 0) {
        continue;
      }

      const score =
        markerCount * 20 +
        (hasScrollableOverflow ? 100 : 0) +
        Math.max(scrollableDelta, 0) / 50 +
        Math.max(element.clientHeight, 0) / 25;

      if (score > bestScore) {
        bestScore = score;
        bestElement = element;
      }
    }

    const target =
      bestElement instanceof HTMLElement
        ? bestElement
        : document.scrollingElement instanceof HTMLElement
          ? document.scrollingElement
          : document.documentElement;

    target.setAttribute(marker, "true");
    return true;
  });

  if (!marked) {
    throw new Error("Failed to locate the comment scroll container.");
  }

  return page.locator('[data-codex-comment-scroll="true"]').first();
}

export async function resetCommentScrollToTop(page, scrollContainer) {
  await scrollContainer
    .evaluate((element) => {
      element.scrollTop = 0;
    })
    .catch(() => {});

  await page
    .evaluate(() => {
      const element =
        document.scrollingElement instanceof HTMLElement
          ? document.scrollingElement
          : document.documentElement;
      element.scrollTop = 0;
    })
    .catch(() => {});

  await page.waitForTimeout(180);
}

export async function advanceCommentScroll(page, scrollContainer, options = {}) {
  const distanceMultiplier =
    Number.isFinite(options.distanceMultiplier) && options.distanceMultiplier > 0
      ? options.distanceMultiplier
      : 0.9;
  const minDistancePx =
    Number.isFinite(options.minDistancePx) && options.minDistancePx > 0
      ? options.minDistancePx
      : 900;
  const wheelDeltaY =
    Number.isFinite(options.wheelDeltaY) && options.wheelDeltaY > 0 ? options.wheelDeltaY : 1400;
  const pageDistanceMultiplier =
    Number.isFinite(options.pageDistanceMultiplier) && options.pageDistanceMultiplier > 0
      ? options.pageDistanceMultiplier
      : distanceMultiplier;
  const pageMinDistancePx =
    Number.isFinite(options.pageMinDistancePx) && options.pageMinDistancePx > 0
      ? options.pageMinDistancePx
      : minDistancePx;

  const containerState = await scrollContainer.evaluate(
    (element, scrollOptions) => {
      const before = element.scrollTop;
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
      const next = Math.min(
        before +
          Math.max(
            element.clientHeight * scrollOptions.distanceMultiplier,
            scrollOptions.minDistancePx
          ),
        maxScrollTop
      );
      element.scrollTop = next;
      return {
        before,
        after: element.scrollTop,
        maxScrollTop,
        strategy: "container"
      };
    },
    {
      distanceMultiplier,
      minDistancePx
    }
  );

  if (containerState.after > containerState.before) {
    return containerState;
  }

  await scrollContainer.scrollIntoViewIfNeeded().catch(() => {});
  await page.mouse.wheel(0, wheelDeltaY);
  await page.waitForTimeout(150);

  const wheelState = await scrollContainer.evaluate((element, before) => {
    return {
      before,
      after: element.scrollTop,
      maxScrollTop: Math.max(element.scrollHeight - element.clientHeight, 0),
      strategy: "wheel"
    };
  }, containerState.after);

  if (
    wheelState.after > wheelState.before ||
    wheelState.maxScrollTop > containerState.maxScrollTop
  ) {
    return wheelState;
  }

  return page.evaluate(
    (scrollOptions) => {
      const element =
        document.scrollingElement instanceof HTMLElement
          ? document.scrollingElement
          : document.documentElement;
      const before = element.scrollTop;
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
      const next = Math.min(
        before +
          Math.max(
            window.innerHeight * scrollOptions.pageDistanceMultiplier,
            scrollOptions.pageMinDistancePx
          ),
        maxScrollTop
      );
      element.scrollTop = next;
      return {
        before,
        after: element.scrollTop,
        maxScrollTop,
        strategy: "page"
      };
    },
    {
      pageDistanceMultiplier,
      pageMinDistancePx
    }
  );
}

/**
 * Try to advance to the next page of comments via pagination controls.
 * The Douyin Creator Center uses paginated comments (not infinite scroll),
 * with page number buttons and next/prev arrows at the bottom of the list.
 *
 * @returns {{ advanced: boolean, pageChanged: boolean, details: object }}
 */
export async function tryAdvancePagination(page, options = {}) {
  const timeoutMs = getEffectiveTimeout(options, options.uiTimeoutMs || 15000);
  const startedAt = Date.now();

  const result = {
    advanced: false,
    pageChanged: false,
    details: { strategy: "none" }
  };

  try {
    // Strategy 1: Look for "下一页" button or next-page arrow icon
    const paginationSelectors = [
      // Douyin creator center pagination: li.semi-page-item with arrow
      'li.semi-page-item:last-child:not(.semi-page-item-active)',
      // Semi Design pagination: next button
      'button:has-text("下一页"), li:has-text("下一页"), span:has-text("下一页")',
      // Arrow icon for next page
      'li.semi-page-item [data-icon="chevron_right"], li.semi-page-item .semi-icon-chevron_right',
      // Generic pagination next arrow
      'ul[class*="pagination"] li:last-child, ul[class*="page"] li:last-child',
    ];

    let clickTarget = null;
    for (const selector of paginationSelectors) {
      const locator = page.locator(selector).first();
      try {
        const visible = await locator.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          const disabled = await locator.evaluate(el => {
            return el.classList.contains('semi-page-item-disabled') ||
                   el.hasAttribute('disabled') ||
                   el.getAttribute('aria-disabled') === 'true';
          }).catch(() => false);

          if (!disabled) {
            clickTarget = locator;
            result.details.strategy = `selector:${selector}`;
            break;
          }
        }
      } catch (e) {
        // selector not found, try next
      }
    }

    // Strategy 2: Find the active page number, click the next one
    if (!clickTarget) {
      try {
        const pageItems = await page.evaluate(() => {
          const items = [];
          const allItems = document.querySelectorAll('li.semi-page-item');
          allItems.forEach((item, idx) => {
            const text = (item.textContent || '').trim();
            const isActive = item.classList.contains('semi-page-item-active');
            const isDisabled = item.classList.contains('semi-page-item-disabled');
            items.push({ idx, text, isActive, isDisabled });
          });
          return items;
        });

        const activeIdx = pageItems.findIndex(p => p.isActive);
        if (activeIdx >= 0 && activeIdx < pageItems.length - 1) {
          const nextItem = pageItems[activeIdx + 1];
          if (!nextItem.isDisabled) {
            clickTarget = page.locator('li.semi-page-item').nth(nextItem.idx);
            result.details.strategy = `page_number:${nextItem.text}`;
          }
        }
      } catch (e) {
        // strategy 2 failed
      }
    }

    // Strategy 3: Any element at the bottom with ">" or arrow
    if (!clickTarget) {
      try {
        const allElements = page.locator('div, button, span, li');
        const count = await allElements.count();
        for (let i = count - 1; i >= Math.max(0, count - 30); i--) {
          const el = allElements.nth(i);
          const text = await el.textContent().catch(() => '');
          const visible = await el.isVisible().catch(() => false);
          if (visible && (text.trim() === '>' || text.trim() === '›' || text.trim() === '»')) {
            const disabled = await el.evaluate(node => {
              return node.hasAttribute('disabled') ||
                     node.getAttribute('aria-disabled') === 'true' ||
                     node.classList.contains('disabled');
            }).catch(() => true);
            if (!disabled) {
              clickTarget = el;
              result.details.strategy = 'arrow_char';
              break;
            }
          }
        }
      } catch (e) {
        // strategy 3 failed
      }
    }

    if (!clickTarget) {
      // Dump bottom-of-page elements for diagnostics
      try {
        const bottomHtml = await page.evaluate(() => {
          const vh = window.innerHeight;
          const elements = [];
          // Find all visible elements in the bottom 40% of the page
          const all = document.querySelectorAll('div, button, span, li, a, ul, nav');
          for (const el of all) {
            const rect = el.getBoundingClientRect();
            if (rect.bottom < vh * 0.6 || rect.top > vh + 200) continue;
            if (rect.width < 10 || rect.height < 5) continue;
            const tag = el.tagName.toLowerCase();
            const cls = (el.className && typeof el.className === 'string')
              ? el.className.slice(0, 60) : '';
            const text = (el.textContent || '').trim().slice(0, 80);
            const id = el.id ? `#${el.id}` : '';
            if (text || cls) {
              elements.push(`${tag}${id}.${cls} text="${text}"`);
            }
            if (elements.length >= 40) break;
          }
          return elements.join('\n');
        });
        result.details.bottomDiagnostics = bottomHtml;
        console.log("[pagination] No click target found. Bottom-of-page diagnostics:\n" + bottomHtml);
      } catch (diagErr) {
        result.details.bottomDiagnostics = `diag error: ${diagErr.message}`;
        console.log("[pagination] Diagnostic error:", diagErr.message);
      }
      return result;
    }

    // Before clicking, capture the current state
    const previousFingerprint = await captureCommentListFingerprint(page).catch(() => '');
    const previousActivePage = await page.evaluate(() => {
      const active = document.querySelector('li.semi-page-item-active, .semi-page-item-active');
      return active ? (active.textContent || '').trim() : '';
    }).catch(() => '');

    // Scroll to the pagination area first
    await clickTarget.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);

    // Click it
    await clickTarget.click({ timeout: 5000 }).catch(() => {});
    result.details.clicked = true;

    // Wait for page change
    const pageChangedPromise = page.waitForFunction(
      (prevPage) => {
        const active = document.querySelector('li.semi-page-item-active, .semi-page-item-active');
        const current = active ? (active.textContent || '').trim() : '';
        return current !== prevPage;
      },
      previousActivePage,
      { timeout: 8000 }
    ).then(() => true).catch(() => false);

    // Also wait for comment list to change
    const listChanged = await waitForCommentListChange(page, previousFingerprint, 6000).catch(() => false);

    const pageChanged = await pageChangedPromise;

    // Give extra time for comments to render
    await page.waitForTimeout(1500);

    result.advanced = true;
    result.pageChanged = pageChanged || listChanged;
    result.details.pageChanged = pageChanged;
    result.details.listChanged = listChanged;
    result.details.previousPage = previousActivePage;

    return result;
  } catch (e) {
    result.details.error = e.message;
    return result;
  }
}

export async function collectComments(page, options) {
  const filterMode = options.filterMode ?? "unreplied";
  if (filterMode === "all") {
    logReplyFilterDebug(
      "entering all-comments collection flow, filter already applied via page reload"
    );
  } else {
    logReplyFilterDebug("entering unreplied collection flow");
    const FILTER_PROBE_TIMEOUT_MS = 5000;
    const filterAvailable = await waitForAsyncCondition(
      page,
      FILTER_PROBE_TIMEOUT_MS,
      async () => Boolean(await markCommentStatusFilter(page)),
      200
    );

    if (filterAvailable) {
      await applyUnrepliedCommentsFilter(page, options);
    } else {
      const OLD_WORK_COLLECT_LIMIT = 200;
      console.log(
        `[comment] 未找到评论状态过滤下拉框（旧作品可能没有此功能），仅采集前 ${OLD_WORK_COLLECT_LIMIT} 条评论`
      );
      logReplyFilterDebug("unreplied filter not available, falling back to current comment list");
      options = { ...options, limit: OLD_WORK_COLLECT_LIMIT };
    }
  }

  await waitForCommentsArea(page, options);

  const scrollContainer = await markCommentScrollContainer(page);
  const commentsBySignature = new Map();
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs);
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let stalledScrollAttempts = 0;
  let paginationAttempts = 0;
  const MAX_COLLECT_PAGINATION_ATTEMPTS = 15;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await extractCommentSnapshot(page);
    const additions = addCommentsFromSnapshot(commentsBySignature, snapshot);
    if (additions > 0) {
      lastProgressAt = Date.now();
    }

    const terminalIndicator = await getCommentTerminalIndicator(page);
    if (terminalIndicator) {
      // Try pagination before giving up, if we haven't hit the limit yet
      if (
        terminalIndicator.kind === "no_more_comments_indicator" &&
        commentsBySignature.size < options.limit &&
        paginationAttempts < MAX_COLLECT_PAGINATION_ATTEMPTS
      ) {
        const paginationResult = await tryAdvancePagination(page, options);
        logReplyFilterDebug("collect: attempted pagination", {
          strategy: paginationResult.details.strategy,
          advanced: paginationResult.advanced,
          pageChanged: paginationResult.pageChanged,
          paginationAttempt: paginationAttempts + 1,
          collectedCount: commentsBySignature.size
        });
        if (paginationResult.advanced && paginationResult.pageChanged) {
          paginationAttempts += 1;
          stalledScrollAttempts = 0;
          lastProgressAt = Date.now();
          continue;
        }
        paginationAttempts += 1;
      }

      logReplyFilterDebug("comment collection reached terminal indicator", terminalIndicator);
      break;
    }

    if (commentsBySignature.size >= options.limit) {
      break;
    }

    const previousFingerprint = await captureCommentListFingerprint(page);
    const scrollState = await advanceCommentScroll(page, scrollContainer);

    await waitForCommentListChange(page, previousFingerprint, 2500);

    const postScrollSnapshot = await extractCommentSnapshot(page);
    const postScrollAdditions = addCommentsFromSnapshot(commentsBySignature, postScrollSnapshot);
    if (postScrollAdditions > 0) {
      lastProgressAt = Date.now();
    }

    const terminalIndicatorAfterScroll = await getCommentTerminalIndicator(page);
    if (terminalIndicatorAfterScroll) {
      // Try pagination before giving up
      if (
        terminalIndicatorAfterScroll.kind === "no_more_comments_indicator" &&
        commentsBySignature.size < options.limit &&
        paginationAttempts < MAX_COLLECT_PAGINATION_ATTEMPTS
      ) {
        const paginationResult = await tryAdvancePagination(page, options);
        logReplyFilterDebug("collect: attempted pagination after scroll", {
          strategy: paginationResult.details.strategy,
          advanced: paginationResult.advanced,
          pageChanged: paginationResult.pageChanged,
          paginationAttempt: paginationAttempts + 1,
          collectedCount: commentsBySignature.size
        });
        if (paginationResult.advanced && paginationResult.pageChanged) {
          paginationAttempts += 1;
          stalledScrollAttempts = 0;
          lastProgressAt = Date.now();
          continue;
        }
        paginationAttempts += 1;
      }

      logReplyFilterDebug(
        "comment collection reached terminal indicator after scrolling",
        terminalIndicatorAfterScroll
      );
      break;
    }

    const scrollMoved = scrollState.after > scrollState.before;
    if (additions > 0 || postScrollAdditions > 0 || scrollMoved) {
      stalledScrollAttempts = 0;
    } else {
      stalledScrollAttempts += 1;
    }

    if (commentsBySignature.size >= options.limit) {
      break;
    }

    if (stalledScrollAttempts >= 6) {
      break;
    }

    const idleElapsedMs = Date.now() - lastProgressAt;
    if (idleElapsedMs >= options.idleMs && stalledScrollAttempts >= 2) {
      break;
    }
  }

  return [...commentsBySignature.values()]
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .slice(0, options.limit)
    .map(sanitizeCollectedComment);
}
