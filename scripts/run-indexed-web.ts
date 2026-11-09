/** Start the local indexed web mode without changing managed environment settings. */
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  process.stderr.write('Use run-indexed-web.ts dev or start.\n');
  process.exit(2);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const databasePath = process.env.PRIMUSSCOPE_DB_PATH
  ? resolve(process.env.PRIMUSSCOPE_DB_PATH)
  : join(root, '.local/indexer.sqlite');
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  process.stderr.write('Run this command through npm run dev:indexed or start:indexed.\n');
  process.exit(2);
}

const child = spawn(process.execPath, [npmCli, 'run', command,
  '--workspace', '@primusscope/web', '--', ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PRIMUSSCOPE_DATA_MODE: 'indexed', PRIMUSSCOPE_DB_PATH: databasePath },
});
child.on('error', () => {
  process.stderr.write('The local web process could not be started.\n');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { child.kill(signal); });
}
