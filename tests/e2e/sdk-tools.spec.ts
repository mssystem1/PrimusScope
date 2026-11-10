import {readFile} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import {expect,test} from '@playwright/test';
import fixture from '../../apps/web/src/fixtures/negative-attestation.json' with {type:'json'};

test('official SDK inspection is local, rejects the example and exports no private input',async({page},testInfo)=>{
 test.setTimeout(60000);
 const marker='PRIMUSSCOPE_PRIVATE_INPUT_MARKER';let leaked=false;const privatePosts:string[]=[];
 page.on('request',request=>{if(request.url().includes(marker)||(request.postData()??'').includes(marker))leaked=true;if(request.method()==='POST')privatePosts.push(new URL(request.url()).pathname);});
 await page.goto('/developers');await page.getByRole('link',{name:/Local attestation inspector/}).click();
 await expect(page.getByRole('heading',{name:'Local attestation inspector',exact:true})).toBeVisible();
 const input=page.getByLabel('Attestation JSON',{exact:true});
 const privateAtt={...fixture,data:marker,request:{...fixture.request,header:'Authorization: '+marker}};
 await input.fill(JSON.stringify(privateAtt));
 await page.getByText('Compare your application’s expected context',{exact:true}).click();
 await page.getByLabel('Expected recipient',{exact:true}).fill('0x2222222222222222222222222222222222222222');
 await page.getByLabel('Expected exact request URL',{exact:true}).fill('https://private.invalid/?session='+marker);
 await page.getByLabel('Expected exact additionParams',{exact:true}).fill(marker);
 const workerResponse=page.waitForResponse(response=>/\/sdk\/primus-page-verifier-[a-f0-9]+\.js$/.test(new URL(response.url()).pathname));
 await page.getByRole('button',{name:'Run local checks',exact:true}).click();
 const worker=await workerResponse;expect(worker.headers()['content-security-policy']).toContain("connect-src 'none'");
 await expect(page.getByRole('heading',{name:'Check rejected',exact:true})).toBeVisible();
 const results=page.locator('.sdk-checks');await expect(results).toContainText('Recovered signer does not match');
 expect(leaked).toBe(false);expect(privatePosts).toEqual([]);expect(page.url()).not.toContain(marker);
 const[download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export sanitized report',exact:true}).click()]);
 const report=await readFile((await download.path())!,'utf8');expect(report).toContain('@primuslabs/zktls-page-core-sdk');expect(report).not.toContain(marker);expect(report).not.toContain(fixture.recipient);expect(report).not.toContain(fixture.signatures[0]);
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toContain(marker);
 const resultScan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(resultScan.violations.map(item=>({id:item.id,targets:item.nodes.map(node=>node.target)}))).toEqual([]);
 await page.getByRole('button',{name:'Clear private input',exact:true}).click();await expect(input).toHaveValue('');await expect(page.locator('.sdk-checks')).toHaveCount(0);
 await page.reload();await expect(input).toHaveValue('');
 await input.fill(JSON.stringify(privateAtt));await page.getByRole('link',{name:'← Developer tools',exact:true}).click();await page.waitForURL('**/developers');await page.goBack();await page.waitForURL('**/developers/verify');await expect(input).toHaveValue('');
 const sizes=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.viewport+1);
 const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(item=>({id:item.id,targets:item.nodes.map(node=>node.target)}))).toEqual([]);
 await testInfo.attach('local-sdk-inspector-'+testInfo.project.name,{body:await page.screenshot(),contentType:'image/png'});
});

test('unsigned, malformed and unsupported multi-signature inputs remain unsupported',async({page})=>{
 await page.goto('/developers/verify');const input=page.getByLabel('Attestation JSON',{exact:true});
 for(const raw of ['not JSON',JSON.stringify({...fixture,signatures:[]}),JSON.stringify({...fixture,signatures:[fixture.signatures[0],fixture.signatures[0]]})]){
  await input.fill(raw);await page.getByRole('button',{name:'Run local checks',exact:true}).click();await expect(page.getByRole('heading',{name:'Unsupported input',exact:true})).toBeVisible();await expect(page.locator('.sdk-checks')).toContainText('Use a supported Page Core');
 }
 await page.getByRole('button',{name:'Load rejection example',exact:true}).click();await page.getByRole('button',{name:'Run local checks',exact:true}).click();await expect(page.getByRole('heading',{name:'Check rejected',exact:true})).toBeVisible();
 await expect(page.getByText(/Official verifier invoked/)).toBeVisible();
});

test('Developer Studio starts with explicit consent and honest empty diagnostics',async({page})=>{
 await page.goto('/developers/apps');await expect(page.getByRole('heading',{name:'Developer Studio',exact:true})).toBeVisible();
 await expect(page.getByText('No diagnostic projects in this browser.',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Create project',exact:true})).toBeDisabled();
 await page.getByLabel('Project name',{exact:true}).fill('My SDK integration');await expect(page.getByRole('button',{name:'Create project',exact:true})).toBeDisabled();
 await expect(page.getByRole('checkbox',{name:/I agree to send only/})).not.toBeChecked();
 const sizes=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.viewport+1);
 const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(item=>item.id)).toEqual([]);
});
