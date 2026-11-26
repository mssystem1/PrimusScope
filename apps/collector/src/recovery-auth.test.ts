import { beforeAll, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { RECOVERY_AUDIENCE, verifyRecoveryToken } from './recovery-auth';

let privateKey: KeyLike, keys: ReturnType<typeof createLocalJWKSet>;
const claims = { repository: 'mssystem1/PrimusScope', repository_id: '1450238573', ref: 'refs/heads/main',
  workflow_ref: 'mssystem1/PrimusScope/.github/workflows/recover-indexer.yml@refs/heads/main', event_name: 'push', run_id: '12345' };
beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'trusted', alg: 'RS256' }] });
});
function signed(overrides = {}, audience = RECOVERY_AUDIENCE, expired = false) {
  return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'trusted' })
    .setIssuer('https://token.actions.githubusercontent.com').setAudience(audience)
    .setSubject('repo:mssystem1/PrimusScope:ref:refs/heads/main')
    .setIssuedAt().setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 60 : '5m').sign(privateKey);
}

it('accepts a signed, short-lived main-branch recovery identity and derives its run URL', async () => {
  expect(await verifyRecoveryToken(await signed(), keys)).toEqual({ runUrl: 'https://github.com/mssystem1/PrimusScope/actions/runs/12345' });
});
it('rejects forks, PRs, other workflows, repository IDs, expired tokens and different audiences', async () => {
  for (const override of [{ repository: 'attacker/PrimusScope' }, { repository_id: '9999' },
    { ref: 'refs/pull/1/merge' }, { workflow_ref: 'mssystem1/PrimusScope/.github/workflows/ci.yml@refs/heads/main' },
    { event_name: 'pull_request' }, { run_id: 'https://private.invalid' }]) {
    expect(await verifyRecoveryToken(await signed(override), keys)).toBeNull();
  }
  expect(await verifyRecoveryToken(await signed({}, 'different-service'), keys)).toBeNull();
  expect(await verifyRecoveryToken(await signed({}, RECOVERY_AUDIENCE, true), keys)).toBeNull();
});
it('rejects tampered payloads, untrusted signing keys and HMAC algorithm confusion', async () => {
  const token = await signed(), parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()); payload.run_id = '67890';
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  expect(await verifyRecoveryToken(parts.join('.'), keys)).toBeNull();
  const attacker = await generateKeyPair('RS256');
  const fake = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'trusted' })
    .setIssuer('https://token.actions.githubusercontent.com').setAudience(RECOVERY_AUDIENCE)
    .setSubject('repo:mssystem1/PrimusScope:ref:refs/heads/main').setIssuedAt().setExpirationTime('5m').sign(attacker.privateKey);
  expect(await verifyRecoveryToken(fake, keys)).toBeNull();
  const hmac = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://token.actions.githubusercontent.com').setAudience(RECOVERY_AUDIENCE)
    .setSubject('repo:mssystem1/PrimusScope:ref:refs/heads/main').setIssuedAt().setExpirationTime('5m').sign(new Uint8Array(32));
  expect(await verifyRecoveryToken(hmac, keys)).toBeNull();
});
