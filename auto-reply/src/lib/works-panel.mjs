import {
  canonicalWorkTitle,
  getEffectiveTimeout,
  logReplyFilterDebug,
  normalizeLookupText,
  normalizeWorkTitleLookupKey,
  waitForAsyncCondition
} from "./common.mjs";

async function openWorksSideSheet(page, options) {
  const sideSheet = page.locator(".douyin-creator-interactive-sidesheet-body").first();

  if (await sideSheet.isVisible().catch(() => false)) {
    return sideSheet;
  }

  const trigger = page
    .locator('button:has-text("选择作品"), [role="button"]:has-text("选择作品")')
    .first();

  // Retry up to 3 times with increasing delays (handles intermittent page load issues)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await trigger.click({ timeout: getEffectiveTimeout(options, options.uiTimeoutMs) });
      await sideSheet.waitFor({
        state: "visible",
        timeout: getEffectiveTimeout(options, options.uiTimeoutMs)
      });
      return sideSheet;
    } catch (e) {
      if (attempt < 3) {
        console.log(`Sidesheet retry ${attempt}/3: ${e.message?.slice(0,60)}`);
        await new Promise(r => setTimeout(r, 3000));
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
}

async function inspectWorksInSideSheet(sideSheet) {
  return sideSheet.evaluate((root) => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const splitLines = (value = "") =>
      value
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter(Boolean);

    const getLines = (node) => splitLines(node.innerText || node.textContent || "");

    const isCandidate = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const lines = getLines(node);
      if (lines.length < 2 || lines.length > 8) {
        return false;
      }

      const publishLines = lines.filter((line) => line.includes("发布于"));
      if (publishLines.length !== 1) {
        return false;
      }

      const nonPublishLines = lines.filter((line) => !line.includes("发布于"));
      if (nonPublishLines.length < 1) {
        return false;
      }

      const text = normalize(node.innerText || node.textContent || "");
      if (!text || text.length > 200) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 24) {
        return false;
      }

      return true;
    };

    for (const marked of root.querySelectorAll("[data-codex-work-card]")) {
      marked.removeAttribute("data-codex-work-card");
    }

    const rawCandidates = Array.from(root.querySelectorAll("*")).filter(isCandidate);
    const candidates = rawCandidates.filter((candidate) => {
      return !rawCandidates.some((other) => other !== candidate && candidate.contains(other));
    });

    return candidates.map((node, index) => {
      node.setAttribute("data-codex-work-card", String(index));

      const lines = getLines(node);
      const publishText = lines.find((line) => line.includes("发布于")) || "";
      const rawTitle =
        lines.find((line) => line && !line.includes("发布于")) || `作品-${index + 1}`;
      const fullCompact = normalize(rawTitle).replace(/\s+/g, "") || "";
      const title = fullCompact || `作品${index + 1}`;
      const titleKey = (fullCompact.slice(0, 15) || title).toLowerCase();
      node.setAttribute("data-codex-work-title-key", titleKey);
      node.setAttribute("data-codex-work-publish-key", normalize(publishText).toLowerCase());

      return {
        index,
        title,
        publishText
      };
    });
  });
}

async function extractWorksFromSideSheet(sideSheet) {
  const rawWorks = await inspectWorksInSideSheet(sideSheet);
  const works = rawWorks.map((work) => ({
    ...work,
    title: canonicalWorkTitle(work.title) || work.title
  }));

  const seen = new Set();
  return works.filter((work) => {
    const signature = `${work.title}|${work.publishText}`;
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

function getWorksFingerprint(works) {
  return works.map((work) => `${work.title}|${work.publishText}`).join("\n");
}

function summarizeWorksPreview(works, limit = 4) {
  return works.slice(0, limit).map((work) => ({
    title: work.title,
    publishText: work.publishText
  }));
}

function countPartialTitleMatches(works, workTitle) {
  const normalizedTitle = normalizeWorkTitleLookupKey(workTitle);
  return works.filter((work) => normalizeWorkTitleLookupKey(work.title).includes(normalizedTitle))
    .length;
}

async function waitForWorksProgress(page, sideSheet, previousState, timeoutMs) {
  await waitForAsyncCondition(
    page,
    timeoutMs,
    async () => {
      const works = await extractWorksFromSideSheet(sideSheet);
      const domCount = works.length;
      const fingerprint = getWorksFingerprint(works);
      return domCount !== previousState.domCount || fingerprint !== previousState.fingerprint;
    },
    150
  );
}

async function inspectTargetWorkSelection(sideSheet, targetWork) {
  return sideSheet.evaluate((element, work) => {
    const normalize = (value = "") => value.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizeWorkTitleForMatch = (value = "") =>
      value.replace(/\s+/g, "").trim().slice(0, 15).toLowerCase();
    const targetTitle = normalizeWorkTitleForMatch(work.title || "");
    const targetPublish = normalize(work.publishText);
    const targetIndex = Number.isFinite(work.index) ? String(work.index) : "";

    for (const child of Array.from(element.querySelectorAll("[data-codex-target-work]"))) {
      if (child instanceof HTMLElement) {
        child.removeAttribute("data-codex-target-work");
      }
    }

    const cards = Array.from(element.querySelectorAll("[data-codex-work-card]")).filter(
      (child) => child instanceof HTMLElement
    );
    const exactIndexMatches = targetIndex
      ? cards.filter((child) => child.getAttribute("data-codex-work-card") === targetIndex)
      : [];
    const exactTitleMatches = cards.filter((child) => {
      return child.getAttribute("data-codex-work-title-key") === targetTitle;
    });
    const publishCompatibleMatches = exactTitleMatches.filter((child) => {
      const publishKey = child.getAttribute("data-codex-work-publish-key") || "";
      if (!targetPublish) {
        return true;
      }
      return (
        publishKey === targetPublish ||
        publishKey.includes(targetPublish) ||
        targetPublish.includes(publishKey)
      );
    });

    const finalMatches =
      exactIndexMatches.length === 1
        ? exactIndexMatches
        : publishCompatibleMatches.length > 0
          ? publishCompatibleMatches
          : exactTitleMatches;

    if (finalMatches.length === 1) {
      finalMatches[0].setAttribute("data-codex-target-work", "true");
      return {
        status: "found",
        cardCount: cards.length,
        exactIndexMatchCount: exactIndexMatches.length,
        exactTitleMatchCount: exactTitleMatches.length,
        publishCompatibleMatchCount: publishCompatibleMatches.length,
        matchedBy: exactIndexMatches.length === 1 ? "index" : "title"
      };
    }

    if (finalMatches.length > 1) {
      return {
        status: "ambiguous",
        count: finalMatches.length,
        cardCount: cards.length,
        exactIndexMatchCount: exactIndexMatches.length,
        exactTitleMatchCount: exactTitleMatches.length,
        publishCompatibleMatchCount: publishCompatibleMatches.length
      };
    }

    return {
      status: "not_found",
      cardCount: cards.length,
      exactIndexMatchCount: exactIndexMatches.length,
      exactTitleMatchCount: exactTitleMatches.length,
      publishCompatibleMatchCount: publishCompatibleMatches.length
    };
  }, targetWork);
}

async function clickMarkedTargetWork(page, sideSheet, options, startedAt, selectionState) {
  logReplyFilterDebug("work selection found card", {
    elapsedMs: Date.now() - startedAt,
    selectionState
  });

  const workCard = sideSheet.locator('[data-codex-target-work="true"]').first();
  await workCard.scrollIntoViewIfNeeded();
  const clickStartedAt = Date.now();
  await workCard.click();
  const fastReadyTimeoutMs = Math.min(getEffectiveTimeout(options, options.uiTimeoutMs), 2500);
  const postClickSignal = await Promise.race([
    sideSheet
      .waitFor({ state: "hidden", timeout: fastReadyTimeoutMs })
      .then(() => "side_sheet_hidden")
      .catch(() => null),
    page
      .locator('[role="combobox"].douyin-creator-interactive-select')
      .first()
      .waitFor({ state: "visible", timeout: fastReadyTimeoutMs })
      .then(() => "comment_filter_visible")
      .catch(() => null),
    page
      .locator("[comment-item]")
      .first()
      .waitFor({ state: "visible", timeout: fastReadyTimeoutMs })
      .then(() => "comment_item_visible")
      .catch(() => null),
    page
      .locator('button:has-text("回复"), div:has-text("回复")')
      .first()
      .waitFor({ state: "visible", timeout: fastReadyTimeoutMs })
      .then(() => "reply_button_visible")
      .catch(() => null),
    page.waitForTimeout(300).then(() => "300ms_fallback")
  ]);

  logReplyFilterDebug("work selection click completed", {
    elapsedMs: Date.now() - startedAt,
    clickWaitMs: Date.now() - clickStartedAt,
    postClickSignal
  });
}

async function selectTargetWorkFromCurrentScan(page, sideSheet, targetWork, options, startedAt) {
  logReplyFilterDebug("work selection started", {
    targetWork,
    selectionMode: "inline"
  });

  const selectionState = await inspectTargetWorkSelection(sideSheet, targetWork);

  if (selectionState.status === "found") {
    await clickMarkedTargetWork(page, sideSheet, options, startedAt, selectionState);
    return true;
  }

  if (selectionState.status === "ambiguous") {
    logReplyFilterDebug("work selection ambiguous", {
      elapsedMs: Date.now() - startedAt,
      selectionState,
      targetWork,
      selectionMode: "inline"
    });
    throw new Error(
      `Multiple visible works matched title "${targetWork.title}". Please refine the work title or provide selectedWork.publishText for disambiguation.`
    );
  }

  logReplyFilterDebug("work selection inline fallback", {
    elapsedMs: Date.now() - startedAt,
    selectionState,
    targetWork
  });
  return false;
}

async function fetchAllWorks(page, options) {
  const sideSheet = await openWorksSideSheet(page, options);
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs);
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let previousDomCount = -1;
  let previousFingerprint = "";
  let latestDomWorks = [];

  while (Date.now() - startedAt < timeoutMs) {
    latestDomWorks = await extractWorksFromSideSheet(sideSheet);
    const domCount = latestDomWorks.length;
    const fingerprint = getWorksFingerprint(latestDomWorks);
    const hasSignal = domCount > 0;
    const changed = domCount !== previousDomCount || fingerprint !== previousFingerprint;

    if (changed) {
      lastProgressAt = Date.now();
    }

    if (hasSignal && Date.now() - lastProgressAt >= options.idleMs) {
      break;
    }

    previousDomCount = domCount;
    previousFingerprint = fingerprint;

    await sideSheet.evaluate((element, hasSignalNow) => {
      if (!hasSignalNow) {
        element.scrollTop = 0;
        return;
      }

      element.scrollTop += Math.max(element.clientHeight * 1.5, 1200);
    }, hasSignal);
    await waitForWorksProgress(
      page,
      sideSheet,
      {
        domCount,
        fingerprint
      },
      hasSignal ? 1500 : 800
    );
  }

  const domFallbackWorks =
    latestDomWorks.length > 0 ? latestDomWorks : await extractWorksFromSideSheet(sideSheet);
  if (domFallbackWorks.length > 0) {
    return domFallbackWorks;
  }

  throw new Error(
    `Timed out waiting for works list after ${options.timeoutMs}ms. Try --works-timeout-ms 90000 or check login/network state.`
  );
}

function findVisibleTargetWork(works, workTitle, workPublishText = "") {
  if (!workTitle) {
    return {
      matchedWork: null,
      matchMode: "",
      partialTitleMatchCount: 0
    };
  }

  const normalizedTitle = normalizeWorkTitleLookupKey(workTitle);
  const exactTitleMatches = works.filter(
    (work) => normalizeWorkTitleLookupKey(work.title) === normalizedTitle
  );
  const partialTitleMatches = works.filter((work) =>
    normalizeWorkTitleLookupKey(work.title).includes(normalizedTitle)
  );

  if (exactTitleMatches.length === 1) {
    return {
      matchedWork: exactTitleMatches[0],
      matchMode: "exact",
      partialTitleMatchCount: partialTitleMatches.length
    };
  }

  if (exactTitleMatches.length > 1 && workPublishText) {
    const normalizedPublishText = normalizeLookupText(workPublishText);
    const publishMatchedWork =
      exactTitleMatches.find((work) => {
        const publishText = normalizeLookupText(work.publishText);
        return (
          publishText === normalizedPublishText ||
          publishText.includes(normalizedPublishText) ||
          normalizedPublishText.includes(publishText)
        );
      }) ?? null;

    if (publishMatchedWork) {
      return {
        matchedWork: publishMatchedWork,
        matchMode: "exact_publish_text",
        partialTitleMatchCount: partialTitleMatches.length
      };
    }
  }

  if (partialTitleMatches.length === 1) {
    return {
      matchedWork: partialTitleMatches[0],
      matchMode: "partial",
      partialTitleMatchCount: 1
    };
  }

  return {
    matchedWork: null,
    matchMode: "",
    partialTitleMatchCount: partialTitleMatches.length
  };
}

function hasWorkIdentity(work) {
  return Boolean(work.title);
}

function ensureSelectableWork(targetWork) {
  if (!hasWorkIdentity(targetWork)) {
    throw new Error("The selected work is missing title, cannot continue.");
  }
}

export function getWorksOutput(works) {
  return works.map((work) => ({
    title: canonicalWorkTitle(work.title) || String(work.title ?? ""),
    publishText: work.publishText
  }));
}

export function getSelectedWorkOutput(work) {
  if (!work) {
    return null;
  }

  return {
    title: canonicalWorkTitle(work.title) || String(work.title ?? ""),
    publishText: work.publishText
  };
}

export async function fetchAllWorksWithRetry(page, options) {
  try {
    return await fetchAllWorks(page, options);
  } catch (error) {
    const sideSheet = await openWorksSideSheet(page, options);
    await sideSheet.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    return fetchAllWorks(page, options);
  }
}

async function findTargetWork(page, options) {
  const sideSheet = await openWorksSideSheet(page, options);
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs);
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let previousDomCount = -1;
  let previousFingerprint = "";
  let latestDomWorks = [];

  logReplyFilterDebug("work target scan started", {
    workTitle: options.workTitle,
    workPublishText: options.workPublishText || null
  });

  while (Date.now() - startedAt < timeoutMs) {
    latestDomWorks = await extractWorksFromSideSheet(sideSheet);
    const domCount = latestDomWorks.length;
    const fingerprint = getWorksFingerprint(latestDomWorks);
    const hasSignal = domCount > 0;
    const changed = domCount !== previousDomCount || fingerprint !== previousFingerprint;

    if (changed) {
      lastProgressAt = Date.now();
    }

    const visibleTargetMatch = findVisibleTargetWork(
      latestDomWorks,
      options.workTitle,
      options.workPublishText
    );
    const targetWork = visibleTargetMatch.matchedWork;

    if (targetWork) {
      logReplyFilterDebug("work target scan matched", {
        elapsedMs: Date.now() - startedAt,
        domCount,
        matchMode: visibleTargetMatch.matchMode,
        partialTitleMatchCount: visibleTargetMatch.partialTitleMatchCount,
        matchedWork: targetWork
      });
      if (options.selectWhenMatched) {
        const selectedInline = await selectTargetWorkFromCurrentScan(
          page,
          sideSheet,
          targetWork,
          options,
          startedAt
        );
        if (!selectedInline) {
          await selectWorkFromSideSheet(page, targetWork, options);
        }
      }
      return targetWork;
    }

    previousDomCount = domCount;
    previousFingerprint = fingerprint;

    if (hasSignal && Date.now() - lastProgressAt >= options.idleMs) {
      logReplyFilterDebug("work target scan stopped at idle window", {
        elapsedMs: Date.now() - startedAt,
        domCount,
        partialTitleMatchCount: countPartialTitleMatches(latestDomWorks, options.workTitle)
      });
      break;
    }

    await sideSheet.evaluate((element, hasSignalNow) => {
      if (!hasSignalNow) {
        element.scrollTop = 0;
        return;
      }

      element.scrollTop += Math.max(element.clientHeight * 1.5, 1200);
    }, hasSignal);
    await waitForWorksProgress(
      page,
      sideSheet,
      {
        domCount,
        fingerprint
      },
      hasSignal ? 1500 : 800
    );
  }

  const fallbackTargetWork = pickTargetWork(
    latestDomWorks,
    options.workTitle,
    options.workPublishText
  );

  if (options.selectWhenMatched) {
    const selectedInline = await selectTargetWorkFromCurrentScan(
      page,
      sideSheet,
      fallbackTargetWork,
      options,
      startedAt
    );
    if (!selectedInline) {
      await selectWorkFromSideSheet(page, fallbackTargetWork, options);
    }
  }

  return fallbackTargetWork;
}

export async function findTargetWorkWithRetry(page, options) {
  try {
    return await findTargetWork(page, options);
  } catch (error) {
    const sideSheet = await openWorksSideSheet(page, options);
    await sideSheet.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    return findTargetWork(page, options);
  }
}

function pickTargetWork(works, workTitle, workPublishText = "") {
  if (!workTitle) {
    return null;
  }

  const normalizedTitle = normalizeWorkTitleLookupKey(workTitle);
  const exactMatches = works.filter(
    (work) => normalizeWorkTitleLookupKey(work.title) === normalizedTitle
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1 && workPublishText) {
    const normalizedPublishText = normalizeLookupText(workPublishText);
    const publishMatched = exactMatches.filter((work) => {
      const publishText = normalizeLookupText(work.publishText);
      return (
        publishText === normalizedPublishText ||
        publishText.includes(normalizedPublishText) ||
        normalizedPublishText.includes(publishText)
      );
    });

    if (publishMatched.length === 1) {
      return publishMatched[0];
    }

    if (publishMatched.length > 1) {
      throw new Error(
        `Title and publishText still matched multiple works. Matches: ${publishMatched
          .map((work) => `${work.title} (${work.publishText})`)
          .join(", ")}`
      );
    }
  }

  const partialMatches = works.filter((work) =>
    normalizeWorkTitleLookupKey(work.title).includes(normalizedTitle)
  );

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  if (partialMatches.length > 1) {
    throw new Error(
      `Title matched multiple works, please refine the work title. Matches: ${partialMatches
        .map((work) => `${work.title} (${work.publishText})`)
        .join(", ")}`
    );
  }

  throw new Error(`No work matched title: ${workTitle}`);
}

export async function selectWorkFromSideSheet(page, targetWork, options) {
  ensureSelectableWork(targetWork);
  const sideSheet = await openWorksSideSheet(page, options);
  const timeoutMs = getEffectiveTimeout(options, options.timeoutMs);
  const startedAt = Date.now();
  let lastSelectionLogSignature = "";

  logReplyFilterDebug("work selection started", {
    targetWork
  });

  while (Date.now() - startedAt < timeoutMs) {
    await inspectWorksInSideSheet(sideSheet);
    const selectionState = await inspectTargetWorkSelection(sideSheet, targetWork);

    if (selectionState.status === "found") {
      await clickMarkedTargetWork(page, sideSheet, options, startedAt, selectionState);
      return;
    }

    if (selectionState.status === "ambiguous") {
      logReplyFilterDebug("work selection ambiguous", {
        elapsedMs: Date.now() - startedAt,
        selectionState,
        targetWork
      });
      throw new Error(
        `Multiple visible works matched title "${targetWork.title}". Please refine the work title or provide selectedWork.publishText for disambiguation.`
      );
    }

    const selectionLogSignature = JSON.stringify(selectionState);
    if (selectionLogSignature !== lastSelectionLogSignature) {
      logReplyFilterDebug("work selection scanning", {
        elapsedMs: Date.now() - startedAt,
        selectionState,
        targetWork
      });
      lastSelectionLogSignature = selectionLogSignature;
    }

    const scrollState = await sideSheet.evaluate((element) => {
      const before = element.scrollTop;
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
      const next = Math.min(before + Math.max(element.clientHeight * 0.9, 900), maxScrollTop);
      element.scrollTop = next;
      return {
        before,
        after: element.scrollTop,
        maxScrollTop
      };
    });

    if (scrollState.after === scrollState.before || scrollState.after >= scrollState.maxScrollTop) {
      logReplyFilterDebug("work selection reached side sheet bottom", {
        elapsedMs: Date.now() - startedAt,
        selectionState,
        scrollState,
        targetWork
      });
      break;
    }

    await page.waitForTimeout(800);
  }

  throw new Error(`Failed to find the target work card in the side sheet: ${targetWork.title}`);
}
