export async function extractCommentSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-codex-comment-scroll="true"]') || document.body;

    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const metaPattern =
      /(分钟前|小时前|天前|昨天|前天|刚刚|IP属地|发布于|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}|赞)/;
    const replyThreadPattern = /(条回复|收起)/;
    const controlPattern = /^(回复|发送|收起)$/;
    const pureNumberPattern = /^\d+$/;
    const avatarSelector = 'img, [class*="avatar"], [class*="Avatar"]';
    const xBandTolerance = 12;
    const replyIndentMinDelta = 16;

    const splitLines = (value = "") =>
      value
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter(Boolean);

    const normalizeNameLine = (value = "") =>
      normalize(value).replace(/\s+/g, "").replace(/作者$/, "");

    const isNoiseLine = (line) => controlPattern.test(line) || pureNumberPattern.test(line);

    const fullText = (el) => {
      let t = "";
      for (const node of el.childNodes) {
        if (node.nodeType === 3) {
          t += node.textContent || "";
        } else if (node.nodeType === 1) {
          const elem = node;
          if (elem.tagName === "IMG") {
            t += elem.getAttribute("alt") || "";
          } else {
            t += fullText(elem);
          }
        }
      }
      return t;
    };

    const extractImageUrls = (container) => {
      if (!(container instanceof HTMLElement)) return [];
      const imgs = Array.from(
        container.querySelectorAll("img.douyin-creator-interactive-image-img")
      );
      return imgs
        .map((img) => (img.getAttribute("src") || "").trim())
        .filter((src) => src.length > 0 && src.startsWith("http"));
    };

    const parseStructuredEntry = (rawLines, order) => {
      const lines = rawLines.filter((line) => !isNoiseLine(line));
      if (lines.length < 2) {
        return null;
      }

      let cursor = 0;
      let username = normalizeNameLine(lines[cursor]);
      cursor += 1;

      while (cursor < lines.length && lines[cursor] === "作者") {
        cursor += 1;
      }

      if (!username && cursor < lines.length) {
        username = normalizeNameLine(lines[cursor]);
        cursor += 1;
      }

      const commentSegments = [];
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (line === "作者") {
          cursor += 1;
          continue;
        }

        if (replyThreadPattern.test(line)) {
          break;
        }

        if (!metaPattern.test(line)) {
          commentSegments.push(line);
        }
        cursor += 1;
      }

      const commentText = normalize(commentSegments.join(" "));
      if (!username || !commentText) {
        return null;
      }

      const consumedLineCount = cursor;
      const publishText = normalize(
        lines
          .slice(1, consumedLineCount)
          .filter((line) => line !== "作者" && metaPattern.test(line))
          .join(" ")
      );

      return {
        username,
        commentText,
        publishText,
        consumedLineCount,
        order,
        signature: [username, commentText, publishText].map(normalize).join("|")
      };
    };

    const extractStructuredEntryFromBlock = (block, order) => {
      if (!(block instanceof HTMLElement)) {
        return null;
      }

      const textRows = Array.from(new Set(splitLines(block.innerText || ""))).slice(0, 40);
      const publishText =
        textRows.find((line) => metaPattern.test(line) && !controlPattern.test(line)) || "";

      // --- Targeted path: use Douyin's class selectors + fullText() ---
      const commentContentEl = block.querySelector('div[class*="comment-content-text-"]');
      if (commentContentEl) {
        const commentText = normalize(fullText(commentContentEl));

        const usernameEl = block.querySelector('div[class*="username-"]');
        let username = "";
        if (usernameEl) {
          for (const node of usernameEl.childNodes) {
            if (node.nodeType === 3) username += node.textContent || "";
          }
          username = normalizeNameLine(username);
        }

        if (username && commentText) {
          const imageUrls = extractImageUrls(block);
          const entry = {
            username,
            commentText,
            publishText,
            consumedLineCount: 0,
            order,
            signature: [username, commentText, publishText].map(normalize).join("|")
          };
          if (imageUrls.length > 0) entry.imageUrls = imageUrls;
          return { entry };
        }
      }

      // --- Generic fallback: text-line parsing ---
      const candidates = Array.from(block.querySelectorAll("div, span, p"))
        .filter((node) => node instanceof HTMLElement)
        .map((node) => ({
          node,
          text: normalize(node.textContent || "")
        }))
        .filter((item) => item.text)
        .slice(0, 120);
      if (candidates.length === 0) {
        return null;
      }

      const usernameText =
        textRows.find((line) => {
          if (!line || line.length > 40) {
            return false;
          }
          if (
            metaPattern.test(line) ||
            replyThreadPattern.test(line) ||
            controlPattern.test(line)
          ) {
            return false;
          }
          return true;
        }) || "";

      let commentText =
        textRows.find((line) => {
          if (!line || line === usernameText || line === publishText) {
            return false;
          }
          if (
            metaPattern.test(line) ||
            replyThreadPattern.test(line) ||
            controlPattern.test(line)
          ) {
            return false;
          }
          return true;
        }) || "";

      if (!commentText) {
        const stickerImgs = Array.from(block.querySelectorAll("img")).filter((img) => {
          if (img.closest('[class*="avatar" i]')) return false;
          const src = (img.getAttribute("src") || "").toLowerCase();
          if (src.includes("avatar")) return false;
          const rect = img.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.width <= 120 && rect.height <= 120;
        });

        if (stickerImgs.length > 0) {
          const altTexts = stickerImgs
            .map((img) => (img.getAttribute("alt") || "").trim())
            .filter(Boolean);
          commentText = altTexts.length > 0 ? altTexts.join("") : "[表情]";
        }
      }

      const username = normalizeNameLine(usernameText);
      if (!username || !commentText) {
        return null;
      }

      const imageUrls = extractImageUrls(block);
      const entry = {
        username,
        commentText,
        publishText,
        consumedLineCount: 0,
        order,
        signature: [username, commentText, publishText].map(normalize).join("|")
      };
      if (imageUrls.length > 0) entry.imageUrls = imageUrls;
      return { entry };
    };

    for (const marked of root.querySelectorAll("[data-codex-comment-block]")) {
      marked.removeAttribute("data-codex-comment-block");
    }

    const collectBlocks = () => {
      const explicitBlocks = Array.from(root.querySelectorAll("[comment-item]"));
      if (explicitBlocks.length > 0) {
        return explicitBlocks;
      }

      const replyButtons = Array.from(root.querySelectorAll("button, div, span")).filter(
        (node) => normalize(node.textContent || "") === "回复"
      );

      const blocks = [];
      const seen = new Set();

      const findBlock = (node) => {
        let current = node.parentElement;
        while (current && current !== root) {
          if (!(current instanceof HTMLElement)) {
            return null;
          }

          const text = normalize(current.innerText || "");
          const replyButtonCount = Array.from(current.querySelectorAll("button, div, span")).filter(
            (child) => normalize(child.textContent || "") === "回复"
          ).length;
          const avatarCount = current.querySelectorAll(
            'img, [class*="avatar"], [class*="Avatar"]'
          ).length;

          if (
            avatarCount >= 1 &&
            avatarCount <= 12 &&
            replyButtonCount >= 1 &&
            replyButtonCount <= 20 &&
            text.length <= 4000
          ) {
            return current;
          }

          current = current.parentElement;
        }

        return null;
      };

      for (const replyButton of replyButtons) {
        const block = findBlock(replyButton);
        if (!block || seen.has(block)) {
          continue;
        }

        seen.add(block);
        blocks.push(block);
      }

      return blocks;
    };

    const collectViaContentSelectors = () => {
      const contentEls = Array.from(root.querySelectorAll('div[class*="comment-content-text-"]'));
      if (contentEls.length === 0) return null;

      const blocks = [];
      for (let i = 0; i < contentEls.length; i++) {
        const contentEl = contentEls[i];

        let container = contentEl.parentElement;
        for (let j = 0; j < 8 && container && container !== root; j++) {
          if (container.querySelector('div[class*="username-"]')) break;
          container = container.parentElement;
        }
        if (!container) continue;

        const usernameEl = container.querySelector('div[class*="username-"]');
        if (!usernameEl) continue;

        let username = "";
        for (const node of usernameEl.childNodes) {
          if (node.nodeType === 3) username += node.textContent || "";
        }
        username = normalizeNameLine(username);

        const commentText = normalize(fullText(contentEl));
        if (!username || !commentText) continue;

        const containerRows = Array.from(new Set(splitLines(container.innerText || ""))).slice(
          0,
          40
        );
        const publishText =
          containerRows.find((line) => metaPattern.test(line) && !controlPattern.test(line)) || "";

        const rect = contentEl.getBoundingClientRect();
        const signature = [username, commentText, publishText].map(normalize).join("|");

        if (container instanceof HTMLElement) {
          container.setAttribute("data-codex-comment-block", String(i));
        }

        const imageUrls = extractImageUrls(container);
        const entry = {
          username,
          commentText,
          publishText,
          consumedLineCount: 0,
          order: i,
          signature
        };
        if (imageUrls.length > 0) entry.imageUrls = imageUrls;

        blocks.push({
          domIndex: i,
          left: Number.isFinite(rect?.left) ? rect.left : 0,
          top: Number.isFinite(rect?.top) ? rect.top : i,
          entry
        });
      }

      return blocks.length > 0 ? blocks : null;
    };

    const collectViaBlocks = () =>
      collectBlocks()
        .map((block, domIndex) => {
          if (block instanceof HTMLElement) {
            block.setAttribute("data-codex-comment-block", String(domIndex));
          }

          const rawLines = splitLines(block.innerText || "");

          if (rawLines.length === 0) {
            return null;
          }

          const rect = block instanceof HTMLElement ? block.getBoundingClientRect() : null;
          const structuredBlock = extractStructuredEntryFromBlock(block, domIndex);
          if (structuredBlock) {
            return {
              domIndex,
              left: Number.isFinite(rect?.left) ? rect.left : 0,
              top: Number.isFinite(rect?.top) ? rect.top : domIndex,
              entry: structuredBlock.entry
            };
          }

          const mainEntry = parseStructuredEntry(rawLines, domIndex);
          if (!mainEntry) {
            return null;
          }

          return {
            domIndex,
            left: Number.isFinite(rect?.left) ? rect.left : 0,
            top: Number.isFinite(rect?.top) ? rect.top : domIndex,
            entry: mainEntry
          };
        })
        .filter(Boolean);

    const rawBlocks = collectViaContentSelectors() ?? collectViaBlocks();

    const resolveReplyIndentThreshold = (blocks) => {
      const leftPositions = blocks
        .map((block) => block.left)
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);

      if (leftPositions.length === 0) {
        return Number.POSITIVE_INFINITY;
      }

      const bands = [];
      for (const left of leftPositions) {
        const lastBand = bands[bands.length - 1];
        if (!lastBand || Math.abs(left - lastBand.max) > xBandTolerance) {
          bands.push({
            min: left,
            max: left,
            values: [left]
          });
          continue;
        }

        lastBand.max = left;
        lastBand.values.push(left);
      }

      if (bands.length < 2) {
        return Number.POSITIVE_INFINITY;
      }

      const mainBand = bands[0];
      const mainAnchor =
        mainBand.values.reduce((sum, value) => sum + value, 0) / mainBand.values.length;
      const replyBand = bands.find(
        (band, index) => index > 0 && band.min - mainAnchor >= replyIndentMinDelta
      );

      if (!replyBand) {
        return Number.POSITIVE_INFINITY;
      }

      return (mainAnchor + replyBand.min) / 2;
    };

    const replyIndentThreshold = resolveReplyIndentThreshold(rawBlocks);
    const orderedBlocks = rawBlocks
      .slice()
      .sort((left, right) =>
        left.top === right.top ? left.left - right.left : left.top - right.top
      );

    const comments = [];
    let currentMainComment = null;

    const flushCurrentMainComment = () => {
      if (!currentMainComment) {
        return;
      }

      const flushed = {
        domIndex: currentMainComment.domIndex,
        username: currentMainComment.username,
        commentText: currentMainComment.commentText,
        publishText: currentMainComment.publishText,
        signature: currentMainComment.signature,
        order: currentMainComment.order
      };
      if (currentMainComment.imageUrls?.length > 0) {
        flushed.imageUrls = currentMainComment.imageUrls;
      }
      comments.push(flushed);

      currentMainComment = null;
    };

    for (const block of orderedBlocks) {
      const entry = block.entry;
      if (!entry?.signature) {
        continue;
      }

      const isReplyBlock =
        Number.isFinite(replyIndentThreshold) && block.left >= replyIndentThreshold;

      if (!isReplyBlock || !currentMainComment) {
        flushCurrentMainComment();
        currentMainComment = {
          domIndex: block.domIndex,
          username: entry.username,
          commentText: entry.commentText,
          publishText: entry.publishText,
          signature: entry.signature,
          imageUrls: entry.imageUrls,
          order: block.domIndex
        };
        continue;
      }
    }

    flushCurrentMainComment();
    return comments;
  });
}

export function addCommentsFromSnapshot(commentsBySignature, snapshot) {
  let additions = 0;

  for (const comment of snapshot) {
    if (!comment.signature) {
      continue;
    }

    const existingComment = commentsBySignature.get(comment.signature);
    if (!existingComment) {
      commentsBySignature.set(comment.signature, comment);
      additions += 1;
      continue;
    }

    const mergedImageUrls =
      (comment.imageUrls?.length ?? 0) >= (existingComment.imageUrls?.length ?? 0)
        ? comment.imageUrls
        : existingComment.imageUrls;

    commentsBySignature.set(comment.signature, {
      ...existingComment,
      ...comment,
      publishText:
        comment.publishText &&
        comment.publishText.length >= (existingComment.publishText ?? "").length
          ? comment.publishText
          : existingComment.publishText,
      imageUrls: mergedImageUrls,
      order:
        typeof existingComment.order === "number" && typeof comment.order === "number"
          ? Math.min(existingComment.order, comment.order)
          : typeof existingComment.order === "number"
            ? existingComment.order
            : comment.order
    });
  }

  return additions;
}
