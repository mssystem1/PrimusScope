export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ status: 'ready', recoveryIdentity: 'github-oidc-v1',
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null }, { headers: { 'Cache-Control': 'no-store' } });
}
