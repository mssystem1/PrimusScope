import{readFile}from'node:fs/promises';
import AxeBuilder from'@axe-core/playwright';
import{expect,test}from'@playwright/test';
import{knownTaskPath,knownTask}from'./fixtures';
import{parseCsv}from'./csv';

test('period comparisons reconcile to the API, export exact amounts and survive saved links',async({page,request},testInfo)=>{
 await page.goto('/finance?range=custom&from=2026-10-01&to=2026-10-07&interval=day');
 const panel=page.getByRole('region',{name:'Shared strategy · period comparison',exact:true});await expect(panel).toHaveAttribute('data-comparison-status','available');
 await expect(panel).toContainText('2026-09-24');await expect(panel).toContainText('2026-09-30');
 const response=await(await request.get('/api/v1/finance/analytics?range=custom&from=2026-10-01&to=2026-10-07&interval=day')).json();
 const[download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Export comparison CSV for Shared strategy · period comparison',exact:true}).click()]);
 const[header,...rows]=parseCsv(await readFile((await download.path())!,'utf8'));const column=(name:string)=>header.indexOf(name);
 expect(rows).toHaveLength(3);for(const[rowIndex,row]of rows.entries()){const metric=response.comparison.strategyFlows.metrics[rowIndex];expect(row[column('current')]).toBe(metric.current);expect(row[column('absolute_change')]).toBe(metric.delta);expect(row[column('snapshot_id')]).toMatch(/^[a-f0-9]{64}$/);expect(row[column('previous_from_utc')]).toBe('2026-09-24T00:00:00.000Z');}
 await testInfo.attach('period-comparison-'+testInfo.project.name,{body:await panel.screenshot(),contentType:'image/png'});
 await expect(page.getByRole('region',{name:'Primus operations · period comparison',exact:true})).toHaveAttribute('data-comparison-status','unavailable');
 await page.getByRole('button',{name:/^Save U \/ eU \+ USDT \/ eUSDT analytics/}).click();await page.goto('/workspace');
 const saved=page.getByRole('link',{name:/^U \/ eU \+ USDT \/ eUSDT analytics/});await expect(saved).toHaveAttribute('href',/from=2026-10-01/);await saved.click();await expect(panel).toHaveAttribute('data-comparison-status','available');
 await page.goto('/network?range=all');const network=page.getByRole('region',{name:'Network activity · period comparison',exact:true});await expect(network).toContainText('All available history has no equivalent preceding window.');await expect(network).toHaveAttribute('data-comparison-status','unavailable');
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
});

test('saved-object changes persist until reviewed, handle failed checks and clear with the watchlist',async({page,request},testInfo)=>{
 const href=knownTaskPath,id=`task:8453:${knownTask.contractAddress}:${knownTask.taskId}`,item={id,title:'Tracked public task',href,domain:'network',savedAt:new Date().toISOString()};
 const result=await(await request.post('/api/v1/workspace/check',{data:{items:[{id,href}]}})).json();const prior={...result.items[0],state:'Earlier observed sample',contentHash:'0'.repeat(64)};
 await page.addInitScript(({item,prior})=>{if(!localStorage.getItem('daily-use-test-seeded')){localStorage.setItem('primusscope.public-workspace.v1',JSON.stringify([item]));localStorage.setItem('primusscope.public-changes.v1',JSON.stringify({[item.id]:{reviewedAt:'2026-11-01T00:00:00.000Z',observation:prior}}));localStorage.setItem('daily-use-test-seeded','1');}},{item,prior});
 await page.goto('/workspace');const changes=page.getByRole('region',{name:'Saved public object changes',exact:true});await expect(changes.getByText('Public observations changed',{exact:true})).toBeVisible();await expect(changes).toContainText('Earlier observed sample');
 await testInfo.attach('saved-changes-'+testInfo.project.name,{body:await changes.screenshot(),contentType:'image/png'});
 await page.reload();await expect(changes.getByText('Public observations changed',{exact:true})).toBeVisible();
 await page.route('**/api/v1/workspace/check',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'STORE_UNAVAILABLE'}})}),{times:1});
 await changes.getByRole('button',{name:'Check saved objects',exact:true}).click();await expect(changes.getByRole('status')).toContainText('review baselines were kept');await expect(changes.getByText('Public observations changed',{exact:true})).toBeVisible();
 await changes.getByRole('button',{name:'Check saved objects',exact:true}).click();await expect(changes.getByRole('button',{name:'Mark as reviewed',exact:true})).toBeEnabled();await changes.getByRole('button',{name:'Mark as reviewed',exact:true}).click();await expect(changes.getByText('No observed object changes',{exact:true})).toBeVisible();
 await page.goto('/');await expect(page.getByRole('heading',{name:'What changed in your saved objects',exact:true})).toBeVisible();await page.goto('/workspace');
 const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
 await page.getByRole('button',{name:'Clear saved items',exact:true}).click();await expect(page.getByRole('heading',{name:'Your next visit starts here.',exact:true})).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('primusscope.public-changes.v1'))).toBeNull();
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
});
