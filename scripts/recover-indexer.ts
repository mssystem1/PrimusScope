import { recoverIndexer } from '../apps/worker/src/recovery-batch';

const secret = process.env.PRIMUSSCOPE_COLLECTOR_SECRET;
const audience = 'https://primus-scope-collector.vercel.app/recovery';
async function authorization() {
  if (secret && secret.length >= 40) return 'Bearer ' + secret;
  const value = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!value || !requestToken) throw new Error('RECOVERY_IDENTITY_NOT_CONFIGURED');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('INVALID_IDENTITY_ENDPOINT');
  url.searchParams.set('audience', audience);
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + requestToken }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('IDENTITY_UNAVAILABLE');
  const token = (await response.json()).value;
  if (typeof token !== 'string' || token.length > 8192) throw new Error('INVALID_IDENTITY');
  return 'Bearer ' + token;
}
const run = process.env.GITHUB_RUN_ID;
const runUrl = run && /^[0-9]+$/.test(run) ? 'https://github.com/mssystem1/PrimusScope/actions/runs/' + run : undefined;
const result = await recoverIndexer({
  async invoke() {
    const response = await fetch('https://primus-scope-collector.vercel.app/api/collect', {
      headers: { Authorization: await authorization(), ...(runUrl ? { 'X-PrimusScope-Recovery-Run': runUrl } : {}) },
      signal: AbortSignal.timeout(295_000),
    });
    return { status: response.status, body: await response.json() };
  },
  report(progress) { console.log(JSON.stringify(progress)); },
});
console.log(JSON.stringify(result));
if (result.outcome !== 'caught_up') process.exitCode = 1;
