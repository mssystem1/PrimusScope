import{expect,test}from'@playwright/test';
test('Blob data remains independent of unavailable read-only Neon history',async({request,baseURL})=>{
 const status=await request.get('/api/v1/status/indexer');expect(status.status()).toBe(200);const s=await status.json();expect(s).toMatchObject({storage:'hosted_blob',collectionMode:'scheduled',intervalMinutes:60,publication:'available'});expect(s.recovery).toBeUndefined();
 const overview=await(await request.get('/api/v1/overview')).json();expect(overview.mode).toBe('indexed_observations');expect(overview.finance.eventCount).toBeGreaterThanOrEqual(0);expect(overview.network.requestCount).toBeGreaterThanOrEqual(0);
 for(const path of ['/api/v1/finance/analytics','/api/v1/network/analytics']){const r=await request.get(path);expect(r.status()).toBe(200);expect(r.headers()['cache-control']).toContain('no-store');}
 const history=await request.get('/api/v1/history/neon/overview');expect([200,503]).toContain(history.status());expect((await request.post('/api/v1/history/neon/overview',{data:{}})).status()).toBe(405);
 const mutation=await request.post('/api/v1/developer/apps',{headers:{Origin:new URL(baseURL!).origin},data:{name:'blocked',origin:'https://example.test',consent:true}});expect(mutation.status()).toBe(503);expect(await mutation.json()).toEqual({code:'HISTORY_READ_ONLY'});
});
