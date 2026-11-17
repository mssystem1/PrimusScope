import{readFile}from'node:fs/promises';import{test,expect}from'@playwright/test';
test.use({trace:'off',screenshot:'off'});
test.afterEach(async({page})=>{await page.goto('about:blank');});
test('official Core reference passes locally while legacy and tampered input stay rejected',async({page})=>{
 const att=JSON.parse(await readFile('.local/sdk-reference/attestation.json','utf8'));let leaked=false;
 page.on('request',r=>{const text=r.url()+(r.postData()??'');if(text.includes(att.signatures[0])||text.includes(att.additionParams))leaked=true;});
 await page.goto('/developers/verify');const input=page.getByLabel('Attestation JSON',{exact:true});await expect(page.getByLabel('Verification SDK')).toHaveValue('core');await input.fill(JSON.stringify(att));
 const loaded=page.waitForResponse(r=>/\/sdk\/primus-core-verifier-[a-f0-9]+\.js$/.test(new URL(r.url()).pathname));await page.getByRole('button',{name:'Run local checks',exact:true}).click();expect((await loaded).headers()['content-security-policy']).toContain("connect-src 'none'");
 await expect(page.getByRole('heading',{name:'SDK signer matched',exact:true})).toBeVisible();expect(leaked).toBe(false);
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export sanitized report',exact:true}).click()]);const report=await readFile((await download.path())!,'utf8');expect(report.includes(att.signatures[0])||report.includes(att.additionParams)).toBe(false);expect(JSON.parse(report).sdk.version).toBe('0.3.9');
 await page.getByLabel('Verification SDK').selectOption('page');await page.getByRole('button',{name:'Run local checks',exact:true}).click();await expect(page.getByRole('heading',{name:'Check rejected',exact:true})).toBeVisible();
 await page.getByLabel('Verification SDK').selectOption('core');await input.fill(JSON.stringify({...att,data:att.data+'tampered'}));await page.getByRole('button',{name:'Run local checks',exact:true}).click();await expect(page.getByRole('heading',{name:'Check rejected',exact:true})).toBeVisible();expect(leaked).toBe(false);
 await page.getByRole('button',{name:'Clear private input',exact:true}).click();await expect(input).toHaveValue('');
});
