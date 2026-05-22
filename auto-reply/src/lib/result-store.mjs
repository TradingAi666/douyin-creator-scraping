import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalWorkTitle,
  logReplyFilterDebug,
  normalizeText,
  normalizeUsername,
  repairJsonFieldQuotes
} from "./common.mjs";

function normalizeSelectedWorkHint(rawWork) {
  if (!rawWork || typeof rawWork !== "object" || Array.isArray(rawWork)) {
    return null;
  }

  const publishText = normalizeText(String(rawWork.publishText ?? rawWork.publish_text ?? ""));
  const title =
    canonicalWorkTitle(rawWork.title ?? "") ||
    canonicalWorkTitle(rawWork.shortKey ?? rawWork.short_key ?? "");

  if (!title) {
    return null;
  }

  return {
    title,
    publishText
  };
}

function normalizeReplyCommentsFileEntry(rawEntry, index) {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    throw new Error(`第 ${index + 1} 条评论格式错误: 应为 JSON 对象，实际为 ${typeof rawEntry}`);
  }

  const username = normalizeUsername(String(rawEntry.username ?? ""));
  const commentText = normalizeText(
    String(rawEntry.commentText ?? rawEntry.comment ?? rawEntry.text ?? "")
  );
  const publishText = normalizeText(
    String(rawEntry.publishText ?? rawEntry.publish ?? rawEntry.time ?? "")
  );
  const replyMessage = String(rawEntry.replyMessage ?? "").trim();

  if (!username) {
    throw new Error(`第 ${index + 1} 条评论缺少 username 字段`);
  }

  return {
    id: index + 1,
    username,
    commentText,
    publishText,
    replyMessage
  };
}

function tryRepairJson(raw) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        inString = true;
        result += ch;
      } else {
        const rest = raw.slice(i + 1).trimStart();
        const next = rest[0];
        if (next === ":" || next === "," || next === "}" || next === "]" || next === undefined) {
          inString = false;
          result += ch;
        } else {
          result += '\\"';
        }
      }
    } else {
      result += ch;
    }
  }

  return result;
}

function describeJsonParseError(rawContent, error) {
  const msg = error instanceof Error ? error.message : String(error);
  const posMatch = msg.match(/position\s+(\d+)/i);
  if (!posMatch) return msg;

  const pos = Number(posMatch[1]);
  const before = rawContent.slice(Math.max(0, pos - 40), pos);
  const after = rawContent.slice(pos, pos + 40);
  return `${msg}\n  问题位置附近: ...${before}👉${after}...\n  常见原因: replyMessage 中包含未转义的英文引号 "`;
}

export async function loadReplyCommentsFile(replyCommentsFile) {
  const rawContent = await fs.readFile(replyCommentsFile, "utf8");
  const repairedContent = repairJsonFieldQuotes(rawContent);
  let parsed;

  try {
    parsed = JSON.parse(repairedContent);
  } catch (fieldRepairError) {
    try {
      parsed = JSON.parse(tryRepairJson(rawContent));
      console.warn(`[warn] JSON 文件包含未转义的引号，已自动修复: ${replyCommentsFile}`);
    } catch (_repairError) {
      throw new Error(
        `JSON 解析失败: ${replyCommentsFile}\n  ${describeJsonParseError(rawContent, fieldRepairError)}`
      );
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("reply comments file must be a JSON object with a comments array");
  }

  if (!Array.isArray(parsed.comments)) {
    throw new Error("reply comments file requires a comments array");
  }

  const normalizedEntries = parsed.comments.map((entry, index) =>
    normalizeReplyCommentsFileEntry(entry, index)
  );
  const plans = normalizedEntries.filter((entry) => entry.replyMessage);

  if (plans.length === 0) {
    throw new Error(
      "reply comments file does not contain any comments with replyMessage; please fill comments[].replyMessage first"
    );
  }

  return {
    selectedWork: normalizeSelectedWorkHint(parsed.selectedWork),
    plans,
    totalCount: normalizedEntries.length,
    actionableCount: plans.length
  };
}

function dedupeOutputEntriesByUsernameAndCommentText(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      entries: Array.isArray(entries) ? entries : [],
      removed: 0
    };
  }

  const seen = new Set();
  const dedupedEntries = [];
  let removed = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      dedupedEntries.push(entry);
      continue;
    }

    if (!("username" in entry) || !("commentText" in entry)) {
      dedupedEntries.push(entry);
      continue;
    }

    const key = `${String(entry.username ?? "")}\u0000${String(entry.commentText ?? "")}`;
    if (seen.has(key)) {
      removed += 1;
      continue;
    }

    seen.add(key);
    dedupedEntries.push(entry);
  }

  return {
    entries: dedupedEntries,
    removed
  };
}

export function prepareResultForOutput(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const nextResult = { ...result };
  const dedupeSummary = [];

  if (Array.isArray(nextResult.comments)) {
    const dedupedComments = dedupeOutputEntriesByUsernameAndCommentText(nextResult.comments);
    nextResult.comments = dedupedComments.entries;
    if (typeof nextResult.count === "number") {
      nextResult.count = dedupedComments.entries.length;
    }
    if (dedupedComments.removed > 0) {
      dedupeSummary.push({
        field: "comments",
        removed: dedupedComments.removed,
        remaining: dedupedComments.entries.length
      });
    }
  }

  if (Array.isArray(nextResult.results)) {
    const dedupedResults = dedupeOutputEntriesByUsernameAndCommentText(nextResult.results);
    nextResult.results = dedupedResults.entries;
    if (typeof nextResult.totalProcessed === "number") {
      nextResult.totalProcessed = dedupedResults.entries.length;
    }
    if (typeof nextResult.repliedCount === "number") {
      nextResult.repliedCount = dedupedResults.entries.filter(
        (item) => item?.status === "replied"
      ).length;
    }
    if (typeof nextResult.dryRunCount === "number") {
      nextResult.dryRunCount = dedupedResults.entries.filter(
        (item) => item?.status === "dry_run_typed"
      ).length;
    }
    if (typeof nextResult.skippedCount === "number") {
      nextResult.skippedCount = dedupedResults.entries.filter(
        (item) => typeof item?.status === "string" && item.status.startsWith("skipped_")
      ).length;
    }
    if (typeof nextResult.errorCount === "number") {
      nextResult.errorCount = dedupedResults.entries.filter(
        (item) => item?.status === "error"
      ).length;
    }
    if (dedupedResults.removed > 0) {
      dedupeSummary.push({
        field: "results",
        removed: dedupedResults.removed,
        remaining: dedupedResults.entries.length
      });
    }
  }

  if (Array.isArray(nextResult.unmatchedPlans)) {
    const dedupedUnmatchedPlans = dedupeOutputEntriesByUsernameAndCommentText(
      nextResult.unmatchedPlans
    );
    nextResult.unmatchedPlans = dedupedUnmatchedPlans.entries;
    if (typeof nextResult.unmatchedPlanCount === "number") {
      nextResult.unmatchedPlanCount = dedupedUnmatchedPlans.entries.length;
    }
    if (dedupedUnmatchedPlans.removed > 0) {
      dedupeSummary.push({
        field: "unmatchedPlans",
        removed: dedupedUnmatchedPlans.removed,
        remaining: dedupedUnmatchedPlans.entries.length
      });
    }
  }

  if (dedupeSummary.length > 0) {
    logReplyFilterDebug("deduped final output entries", dedupeSummary);
  }

  return nextResult;
}

export async function emitResult(result, outputPath) {
  const outputResult = prepareResultForOutput(result);
  const payload = JSON.stringify(outputResult, null, 2);

  if (!outputPath) {
    console.log(payload);
    return;
  }

  const absolutePath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${payload}\n`, "utf8");
  console.log(`Wrote result to ${absolutePath}`);
}
