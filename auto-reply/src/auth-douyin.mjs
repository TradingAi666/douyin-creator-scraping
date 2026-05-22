#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  DEFAULT_COMMENT_PAGE_URL,
  DEFAULT_USER_DATA_DIR,
  gotoPage,
  launchPersistentPage,
  parseViewport,
  promptForEnter
} from "./douyin-browser.mjs";
import { toPositiveInteger } from "./lib/common.mjs";

function printHelp() {
  console.log(`
Usage:
  npm run auth -- [options]

Options:
  --url <url>        Login page URL (default: creator comment page)
  --profile <path>   Playwright profile path
  --timeout <ms>     Max wait for initial page navigation (default: 60000)
  --viewport <WxH>   Browser viewport size, e.g. 1440x900 (default: auto-fit screen)
  --help             Print this help
  `);
}

function parseArgs(argv) {
  const args = {
    pageUrl: DEFAULT_COMMENT_PAGE_URL,
    profileDir: DEFAULT_USER_DATA_DIR,
    timeoutMs: 60000,
    viewport: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--url":
        args.pageUrl = argv[index + 1] ?? DEFAULT_COMMENT_PAGE_URL;
        index += 1;
        break;
      case "--profile":
        args.profileDir = path.resolve(argv[index + 1] ?? DEFAULT_USER_DATA_DIR);
        index += 1;
        break;
      case "--timeout":
        args.timeoutMs = toPositiveInteger(argv[index + 1], "--timeout");
        index += 1;
        break;
      case "--viewport":
        args.viewport = parseViewport(argv[index + 1]);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function isCommentPageReady(page) {
  const selectWorkButton = page
    .locator('button:has-text("选择作品"), [role="button"]:has-text("选择作品")')
    .first();

  try {
    await selectWorkButton.waitFor({ state: "visible", timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const { context, page } = await launchPersistentPage({
    userDataDir: args.profileDir,
    viewport: args.viewport
  });

  try {
    await gotoPage(page, args.pageUrl, args.timeoutMs);
    console.log(`已打开登录页：${args.pageUrl}`);
    console.log(`登录信息会保存在：${args.profileDir}`);
    console.log("请在浏览器中手动扫码登录。");
    await promptForEnter("登录完成并能进入创作者评论页后，按 Enter 保存并关闭浏览器");

    await gotoPage(page, args.pageUrl, args.timeoutMs).catch(() => {});
    if (await isCommentPageReady(page)) {
      console.log(
        "登录信息已保存，后续 npm run view、npm run works、npm run comments:export、npm run comments:reply、npm run article:publish 会复用这份鉴权。"
      );
      return;
    }

    console.log(
      "浏览器 profile 已保留，但暂时还没检测到评论页入口。如果后续命令仍提示未登录，请重新运行 npm run auth 完成扫码。"
    );
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
