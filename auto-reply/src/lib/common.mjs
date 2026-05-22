import { inspect } from "node:util";

export function normalizeText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeUsername(value = "") {
  return normalizeText(value).replace(/\s+/g, "");
}

export function toPositiveInteger(rawValue, flagName) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} expects a positive integer, received: ${rawValue}`);
  }
  return value;
}

export function formatUnixSeconds(rawValue) {
  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }

  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function normalizeLookupText(value = "") {
  return normalizeText(value).toLowerCase();
}

/** 作品标题：去空白后的完整字符串（与导出 JSON 的 title、匹配用 lookup 同源） */
export function canonicalWorkTitle(value = "") {
  return normalizeText(String(value ?? "")).replace(/\s+/g, "");
}

export function normalizeWorkTitle(value = "", maxLength = 15) {
  return canonicalWorkTitle(value).slice(0, maxLength);
}

export function normalizeWorkTitleLookupKey(value = "", maxLength = 15) {
  return normalizeWorkTitle(value, maxLength).toLowerCase();
}

export function getEffectiveTimeout(options, requestedMs) {
  const normalizedRequestedMs = Math.max(1, Number(requestedMs) || 1);
  const deadline = options?.deadline;

  if (!deadline) {
    return normalizedRequestedMs;
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    const totalMs = options?.maxRuntimeMs ? `${options.maxRuntimeMs}ms` : "global budget";
    throw new Error(`Timed out after exhausting the global runtime budget (${totalMs}).`);
  }

  return Math.max(1, Math.min(normalizedRequestedMs, remainingMs));
}

const LOG_STRING_LIMIT = 120;
const LOG_ARRAY_LIMIT = 4;
const LOG_OBJECT_KEY_LIMIT = 8;
const LOG_DEPTH_LIMIT = 3;
let replyFilterDebugEnabled = false;

export function setReplyFilterDebugEnabled(enabled) {
  replyFilterDebugEnabled = Boolean(enabled);
}

function trimLogString(value) {
  const normalized = normalizeText(String(value));
  if (normalized.length <= LOG_STRING_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, LOG_STRING_LIMIT - 3)}...`;
}

function compactLogValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return trimLogString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Error) {
    return trimLogString(value.message || String(value));
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, LOG_ARRAY_LIMIT).map((item) => compactLogValue(item, depth + 1));
    if (value.length > LOG_ARRAY_LIMIT) {
      items.push(`+${value.length - LOG_ARRAY_LIMIT} more`);
    }
    return items;
  }

  if (typeof value === "object") {
    if (depth >= LOG_DEPTH_LIMIT) {
      return "[Object]";
    }

    const entries = Object.entries(value).filter(
      ([, itemValue]) => itemValue !== undefined && itemValue !== null && itemValue !== ""
    );
    const compacted = {};

    entries.slice(0, LOG_OBJECT_KEY_LIMIT).forEach(([key, itemValue]) => {
      compacted[key] = compactLogValue(itemValue, depth + 1);
    });

    if (entries.length > LOG_OBJECT_KEY_LIMIT) {
      compacted.__more = `+${entries.length - LOG_OBJECT_KEY_LIMIT} keys`;
    }

    return compacted;
  }

  return String(value);
}

function formatLogValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return inspect(value, {
    depth: 5,
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    colors: false,
    maxArrayLength: null,
    maxStringLength: LOG_STRING_LIMIT,
    sorted: false
  });
}

export function logReplyFilterDebug(message, details = null) {
  if (!replyFilterDebugEnabled) {
    return;
  }

  if (details === null || details === undefined) {
    console.error(`[reply-filter] ${message}`);
    return;
  }

  const compactedDetails = compactLogValue(details);

  if (
    compactedDetails &&
    typeof compactedDetails === "object" &&
    !Array.isArray(compactedDetails)
  ) {
    const suffix = Object.entries(compactedDetails)
      .map(([key, value]) => `${key}=${formatLogValue(value)}`)
      .join(" ");
    console.error(`[reply-filter] ${message}${suffix ? ` ${suffix}` : ""}`);
    return;
  }

  console.error(`[reply-filter] ${message} ${formatLogValue(compactedDetails)}`);
}

export async function waitForAsyncCondition(page, timeoutMs, predicate, intervalMs = 120) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return true;
    }

    await page.waitForTimeout(intervalMs);
  }

  return predicate();
}

export function summarizeCommentsForLog(comments, limit = 3) {
  return comments.slice(0, limit).map((comment) => ({
    username: comment.username,
    commentText: comment.commentText,
    publishText: comment.publishText
  }));
}

export function sanitizeCollectedComment(comment) {
  const { signature, domIndex, order, ...rest } = comment;

  return rest;
}

const REPAIRABLE_FIELDS_PATTERN =
  /^(\s*"(?:title|subtitle|content|description|replyMessage)"\s*:\s*")(.*)("\s*,?\s*)$/;

/**
 * 逐行扫描 JSON 文本，对 title / subtitle / content / description / replyMessage
 * 字段值内部的英文双引号替换为中文引号 \u201C\u201D，使 JSON.parse 不会因未转义引号而失败。
 * 判断逻辑：行首匹配 `"fieldName": "` 、行尾匹配 `",` 或 `"` ，中间部分的 `"` 即为需要替换的内嵌引号。
 */
export function repairJsonFieldQuotes(rawText) {
  const lines = rawText.split("\n");
  let repaired = false;

  const fixedLines = lines.map((line) => {
    const m = line.match(REPAIRABLE_FIELDS_PATTERN);
    if (!m) return line;

    const prefix = m[1];
    const value = m[2];
    const suffix = m[3];

    if (!value.includes('"')) return line;

    let isOpen = true;
    const fixedValue = value.replace(/"/g, () => {
      const ch = isOpen ? "\u201C" : "\u201D";
      isOpen = !isOpen;
      return ch;
    });

    repaired = true;
    return prefix + fixedValue + suffix;
  });

  if (repaired) {
    console.warn("[warn] JSON 字段值中包含英文双引号，已自动替换为中文引号");
  }

  return fixedLines.join("\n");
}

const zhSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

function segmentWords(text) {
  return Array.from(zhSegmenter.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
}

function findUniqueAmongWords(words, others) {
  const len = words.length;
  for (let span = 1; span <= len; span++) {
    for (let start = 0; start + span <= len; start++) {
      const candidate = words.slice(start, start + span).join("");
      if (others.every((other) => !other.includes(candidate))) {
        return candidate;
      }
    }
  }
  return null;
}

function findUniqueAmongChars(title, others) {
  const chars = Array.from(title);
  const len = chars.length;
  for (let subLen = 1; subLen <= len; subLen++) {
    for (let start = 0; start + subLen <= len; start++) {
      const candidate = chars.slice(start, start + subLen).join("");
      if (others.every((other) => !other.includes(candidate))) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * 为每个标题找到最短的、能唯一区分它和其他所有标题的子片段。
 * 优先按中文分词边界选取（可读性好），找不到再按字符级别兜底。
 * @param {string[]} titles - 标题数组
 * @returns {Array<{title: string, keyword: string, unique: boolean}>}
 *   - title: 原始标题
 *   - keyword: 最短唯一子片段（若标题重复则为完整标题）
 *   - unique: 是否成功找到唯一子片段
 */
export function findDistinctKeywords(titles) {
  const normalized = titles.map((t) => normalizeText(t));

  return normalized.map((title, i) => {
    if (!title) {
      return { title: titles[i], keyword: "", unique: false };
    }

    const hasDuplicate = normalized.some((other, j) => j !== i && other === title);
    if (hasDuplicate) {
      return { title: titles[i], keyword: title, unique: false };
    }

    const others = normalized.filter((_, j) => j !== i);
    const words = segmentWords(title);

    const wordResult = findUniqueAmongWords(words, others);
    if (wordResult) {
      return { title: titles[i], keyword: wordResult, unique: true };
    }

    const charResult = findUniqueAmongChars(title, others);
    if (charResult) {
      return { title: titles[i], keyword: charResult, unique: true };
    }

    return { title: titles[i], keyword: title, unique: false };
  });
}
