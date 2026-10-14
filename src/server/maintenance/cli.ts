import { AppError } from "../../shared/errors.js";
import { closeStore, openStore } from "../storage/database.js";
import { createBackup } from "./backup.js";
import { acquireDataDirLock } from "./lock.js";
import { restoreBackup } from "./restore.js";

const USAGE = [
  "Usage:",
  "  npm run backup  -- --output <path> [--data-dir <path>]",
  "  npm run restore -- --archive <path> --data-dir <path>",
].join("\n");

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AppError("INVALID_INPUT", `Missing value for ${arg}.`, 400);
    }
    flags.set(arg.slice(2), value);
    index += 1;
  }
  return flags;
}

function readDataDir(flags: Map<string, string>): string {
  const value = flags.get("data-dir") ?? process.env.DATA_DIR ?? ".data";
  if (value.trim() === "") {
    throw new AppError("INVALID_INPUT", "A data directory is required.", 400);
  }
  return value;
}

async function runBackup(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const output = flags.get("output");
  if (output === undefined) {
    throw new AppError(
      "INVALID_INPUT",
      `The backup command requires --output.\n${USAGE}`,
      400,
    );
  }
  const dataDir = readDataDir(flags);
  // The CLI owns the data-dir lock for this operation and refuses when a live
  // server already holds it, so it is never a competing live writer.
  const lock = acquireDataDirLock(dataDir);
  try {
    const store = openStore(dataDir);
    try {
      await createBackup(store, output);
    } finally {
      await closeStore(store);
    }
    process.stdout.write(`Backup written to ${output}\n`);
  } finally {
    lock.release();
  }
}

async function runRestore(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const archive = flags.get("archive");
  if (archive === undefined) {
    throw new AppError(
      "INVALID_INPUT",
      `The restore command requires --archive.\n${USAGE}`,
      400,
    );
  }
  const dataDir = readDataDir(flags);
  await restoreBackup(archive, dataDir);
  process.stdout.write(`Restored backup ${archive} into ${dataDir}\n`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case "backup":
      await runBackup(rest);
      return;
    case "restore":
      await runRestore(rest);
      return;
    default:
      throw new AppError("INVALID_INPUT", USAGE, 400);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Maintenance command failed: ${message}\n`);
  process.exitCode = 1;
}
