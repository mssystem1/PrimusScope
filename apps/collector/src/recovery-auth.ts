import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';

export const RECOVERY_AUDIENCE = 'https://primus-scope-collector.vercel.app/recovery';
const issuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks'), { timeoutDuration: 2000, cooldownDuration: 60_000 });

function allowed(payload: JWTPayload): boolean {
  return payload.repository === 'mssystem1/PrimusScope' && payload.repository_id === '1450238573'
    && payload.ref === 'refs/heads/main' && payload.sub === 'repo:mssystem1/PrimusScope:ref:refs/heads/main'
    && payload.workflow_ref === 'mssystem1/PrimusScope/.github/workflows/recover-indexer.yml@refs/heads/main'
    && ['workflow_dispatch', 'push'].includes(String(payload.event_name))
    && typeof payload.run_id === 'string' && /^[0-9]+$/.test(payload.run_id);
}

/** Authorize only this repository's main-branch recovery workflow, never a fork/PR. */
export async function verifyRecoveryToken(token: string, trustedKeys: JWTVerifyGetKey = keys): Promise<{ runUrl: string } | null> {
  if (token.length > 8192 || token.split('.').length !== 3) return null;
  try {
    // Filtering claims is only an early rejection. Trust comes from signature verification below.
    if (!allowed(decodeJwt(token))) return null;
    const { payload } = await jwtVerify(token, trustedKeys, { issuer, audience: RECOVERY_AUDIENCE,
      algorithms: ['RS256'], maxTokenAge: '10m', clockTolerance: 10,
      requiredClaims: ['exp', 'iat', 'sub', 'repository', 'repository_id', 'workflow_ref', 'ref', 'event_name', 'run_id'] });
    return allowed(payload) ? { runUrl: 'https://github.com/mssystem1/PrimusScope/actions/runs/' + payload.run_id } : null;
  } catch { return null; }
}
