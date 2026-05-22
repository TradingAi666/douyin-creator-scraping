#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";
import { DEFAULT_REPLY_OUTPUT_PATH, replyComments } from "./comment-workflow.mjs";
import { toPositiveInteger } from "./lib/common.mjs";

function printHelp() {
  console.log(`
Usage:
  npm run comments:reply -- plan.json
  npm run comments:reply -- [options] plan.json

Options:
  --limit <n>        Max replies in one run (default: 20)
  --dry-run          Type reply text without clicking send
  --keep-open        Keep browser open after completion
  --out <path>       Output JSON path (default: comments-output/reply-comments-result.json)
  --profile <path>   Playwright profile path
  --timeout <ms>     Max total runtime
  --headless         Run Chromium in headless mode
  --debug            Print debug logs
  --help             Print this help
  `);
}

function parseArgs(argv) {
  const args = {
    ...createSharedCliArgs(),
    planFile: "",
    limit: 20,
    dryRun: false,
    keepOpen: false,
    outputPath: DEFAULT_REPLY_OUTPUT_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextIndex = consumeSharedCliArg(args, argv, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--limit":
        args.limit = toPositiveInteger(argv[index + 1], "--limit");
        index += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--keep-open":
        args.keepOpen = true;
        break;
      case "--out":
        args.outputPath = argv[index + 1] ?? DEFAULT_REPLY_OUTPUT_PATH;
        index += 1;
        break;
      default:
        if (!arg.startsWith("-") && !args.planFile) {
          args.planFile = path.resolve(arg);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.planFile) {
    throw new Error("Missing plan file. Usage: npm run comments:reply -- plan.json");
  }

  await replyComments(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
