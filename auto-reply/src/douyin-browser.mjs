import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";

export const DEFAULT_COMMENT_PAGE_URL =
  "https://creator.douyin.com/creator-micro/interactive/comment";
export const DEFAULT_USER_DATA_DIR = path.resolve(".playwright/douyin-profile");

const DEFAULT_VIEWPORT = null;

export async function promptForEnter(message) {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    await terminal.question(`${message}\n`);
  } finally {
    terminal.close();
  }
}

export function parseViewport(value) {
  if (!value || value === "auto") return null;
  const match = String(value).match(/^(\d+)[xX×](\d+)$/);
  if (!match)
    throw new Error(`Invalid viewport format: "${value}" (expected WIDTHxHEIGHT, e.g. 1440x900)`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function launchPersistentPage(options = {}) {
  const {
    userDataDir = DEFAULT_USER_DATA_DIR,
    headless = false,
    viewport = DEFAULT_VIEWPORT,
    alwaysNewPage = false
  } = options;

  const launchOptions = { headless };
  if (viewport) {
    launchOptions.viewport = viewport;
  } else {
    launchOptions.viewport = null;
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  const page = alwaysNewPage
    ? await context.newPage()
    : (context.pages()[0] ?? (await context.newPage()));

  await page.bringToFront().catch(() => {});

  return { context, page };
}

export async function gotoPage(page, pageUrl, navigationTimeoutMs = 60000) {
  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs
  });
  await page.bringToFront().catch(() => {});
}
