import path from "node:path";
import { DEFAULT_USER_DATA_DIR } from "./douyin-browser.mjs";
import { toPositiveInteger } from "./lib/common.mjs";

export function createSharedCliArgs() {
  return {
    profileDir: DEFAULT_USER_DATA_DIR,
    timeoutMs: 0,
    headless: false,
    debug: false
  };
}

export function consumeSharedCliArg(args, argv, index) {
  const arg = argv[index];

  switch (arg) {
    case "--profile":
      args.profileDir = path.resolve(argv[index + 1] ?? DEFAULT_USER_DATA_DIR);
      return index + 1;
    case "--timeout":
      args.timeoutMs = toPositiveInteger(argv[index + 1], "--timeout");
      return index + 1;
    case "--headless":
      args.headless = true;
      return index;
    case "--debug":
      args.debug = true;
      return index;
    default:
      return null;
  }
}
