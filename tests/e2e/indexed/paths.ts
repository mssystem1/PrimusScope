import { execFile } from "node:child_process";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const repositoryRoot = resolve(import.meta.dirname, "../../..");

export function fixtureDatabasePath(): string {
  const filename = process.env.PRIMUSSCOPE_E2E_DB_PATH;
  if (!filename || !isAbsolute(filename)) {
    throw new Error("The indexed E2E database must have an absolute test-only path.");
  }
  const within = relative(resolve(repositoryRoot, ".local/e2e-indexed"), filename);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || extname(filename) !== ".sqlite") {
    throw new Error("Indexed E2E fixtures may only write .sqlite files under .local/e2e-indexed/.");
  }
  return filename;
}

const execute = promisify(execFile);

/** Each mutation is a fresh writer process; the web process only reads SQLite. */
export async function fixtureAction(action: "advance" | "repeat" | "fail" | "recover"): Promise<unknown> {
  fixtureDatabasePath();
  const result = await execute(process.execPath, [
    "--import", "tsx", resolve(import.meta.dirname, "writer.ts"), action,
  ], {
    cwd: repositoryRoot,
    env: process.env,
    timeout: 20_000,
    maxBuffer: 1_048_576,
  });
  return JSON.parse(result.stdout);
}
