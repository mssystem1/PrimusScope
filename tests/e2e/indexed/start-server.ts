import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { seedFixture } from "./fixture";
import { fixtureDatabasePath, repositoryRoot } from "./paths";

seedFixture();
const require = createRequire(import.meta.url);
const next = require.resolve("next/dist/bin/next", { paths: [resolve(repositoryRoot, "apps/web")] });
const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", "3001"], {
  cwd: resolve(repositoryRoot, "apps/web"),
  stdio: "inherit",
  env: {
    ...process.env,
    PRIMUSSCOPE_DATA_MODE: "indexed",
    PRIMUSSCOPE_DB_PATH: fixtureDatabasePath(),
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 0; });
process.once("exit", () => {
  if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
});
