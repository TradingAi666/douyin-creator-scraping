import { promptForEnter } from "../douyin-browser.mjs";
import { getEffectiveTimeout } from "./common.mjs";

/**
 * Hard-refresh the current page by first clearing the browser HTTP cache via CDP
 * (equivalent to Ctrl+Shift+R) and then reloading.  Falls back to a normal
 * reload if the CDP session cannot be established.
 */
export async function hardRefreshPage(page, options = {}) {
  const navigationTimeoutMs = getEffectiveTimeout(options, options.navigationTimeoutMs ?? 60000);
  try {
    const cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send("Network.clearBrowserCache");
    await cdpSession.detach();
  } catch {
    // CDP not available — fall through to normal reload
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
}

export async function ensureCommentPageReady(page, pageUrl, options) {
  const navigationTimeoutMs = getEffectiveTimeout(options, options.navigationTimeoutMs);
  const uiTimeoutMs = getEffectiveTimeout(options, options.uiTimeoutMs);
  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs
  });

  const selectWorkButton = page
    .locator('button:has-text("选择作品"), [role="button"]:has-text("选择作品")')
    .first();

  try {
    await selectWorkButton.waitFor({ state: "visible", timeout: uiTimeoutMs });
    return;
  } catch (error) {
    console.log("未检测到创作者评论页入口，自动重试中...");
  }

  // Auto-retry: reload and wait again (up to 3 times, no interactive prompt)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const retryNavMs = getEffectiveTimeout(options, options.navigationTimeoutMs);
    const retryUiMs = getEffectiveTimeout(options, options.uiTimeoutMs);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: retryNavMs });
    try {
      await selectWorkButton.waitFor({ state: "visible", timeout: retryUiMs });
      console.log(`重试 ${attempt} 次后成功进入评论页`);
      return;
    } catch (e) {
      console.log(`重试 ${attempt}/3 失败，继续...`);
    }
  }
  throw new Error("无法进入创作者评论页，请确认已登录 creator.douyin.com");
}
