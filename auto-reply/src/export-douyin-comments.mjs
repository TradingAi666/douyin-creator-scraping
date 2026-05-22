#!/usr/bin/env node

import process from "node:process";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";
import { DEFAULT_EXPORT_OUTPUT_PATH, exportUnrepliedComments } from "./comment-workflow.mjs";
import { normalizeText, toPositiveInteger } from "./lib/common.mjs";

function printHelp() {
  console.log(`
Usage:
  npm run comments:export -- "作品短标题"
  npm run comments:export -- [options] "作品短标题"

Options:
  --limit <n>        Max exported comments (default: 200)
  --out <path>       Output JSON path (default: comments-output/unreplied-comments.json)
  --no-history       Skip exporting user history
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
    workTitle: "",
    limit: 200,
    noHistory: false,
    outputPath: DEFAULT_EXPORT_OUTPUT_PATH
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
      case "--out":
        args.outputPath = argv[index + 1] ?? DEFAULT_EXPORT_OUTPUT_PATH;
        index += 1;
        break;
      case "--no-history":
        args.noHistory = true;
        break;
      default:
        if (!arg.startsWith("-") && !args.workTitle) {
          args.workTitle = normalizeText(arg);
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

  if (!args.workTitle) {
    throw new Error('Missing work title. Usage: npm run comments:export -- "作品短标题"');
  }

  await exportUnrepliedComments(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
