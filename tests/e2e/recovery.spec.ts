import{expect,test}from'@playwright/test';import AxeBuilder from'@axe-core/playwright';import{knownTaskPath}from'./fixtures';
test('a cold production server keeps retained observations readable with both live stores unavailable',async({page,request},testInfo)=>{
 const status=await(await request.get('/api/v1/status/indexer')).json();expect(status).toMatchObject({mode:'recorded_observations',storage:'bundled_snapshot',recovery:{source:'bundled_snapshot',issue:'PRIMARY_STORE_UNAVAILABLE'}});
 const overview=await request.get('/api/v1/overview');expect(overview.status()).toBe(200);expect((await overview.json()).finance.eventCount).toBe(9);
 for(const path of ['/','/finance','/network',knownTaskPath,'/sources']){await page.goto(path);await expect(page.getByText('Live storage is temporarily unavailable.',{exact:true})).toBeVisible();await expect(page.getByText('This view could not be loaded',{exact:true})).toHaveCount(0);}
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
 const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
 await testInfo.attach('cold-storage-recovery-'+testInfo.project.name,{body:await page.screenshot(),contentType:'image/png'});
 await page.goto('/history');await expect(page.getByRole('heading',{name:'Neon history',exact:true})).toBeVisible();await expect(page.getByText(/no data has been removed/)).toBeVisible();await page.getByRole('link',{name:'Return to the current app',exact:true}).click();await expect(page.getByText('This view could not be loaded',{exact:true})).toHaveCount(0);
});
