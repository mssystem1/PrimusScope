import{readFile}from'node:fs/promises';
import AxeBuilder from'@axe-core/playwright';
import{expect,test}from'@playwright/test';
import{knownTaskPath,knownTask,financeRouteIds}from'./fixtures';
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
 const operations=page.getByRole('region',{name:'Primus operations · period comparison',exact:true});
 await expect(operations).toHaveAttribute('data-comparison-status','unavailable');await expect(operations).toContainText('No fully covered history in this period.');
 await expect(operations.locator('.comparison-metric')).toHaveCount(0);await expect(operations.getByRole('button',{name:/Export comparison CSV/})).toHaveCount(0);
 await page.getByRole('button',{name:/^Save U \/ eU \+ USDT \/ eUSDT analytics/}).click();await page.goto('/workspace');
 const saved=page.getByRole('link',{name:/^U \/ eU \+ USDT \/ eUSDT analytics/});await expect(saved).toHaveAttribute('href',/from=2026-10-01/);await saved.click();await expect(panel).toHaveAttribute('data-comparison-status','available');
 await page.goto('/network?range=all');const network=page.getByRole('region',{name:'Network activity · period comparison',exact:true});await expect(network).toContainText('All available history has no equivalent preceding window.');await expect(network).toHaveAttribute('data-comparison-status','unavailable');
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
});

test('all-history comparisons offer usable periods and show visual flows without empty tables',async({page,request},testInfo)=>{
 const route='/finance/vaults/'+financeRouteIds[0];
 await page.goto(route+'?range=all&interval=hour');
 const panel=page.getByRole('region',{name:'Shared strategy · period comparison',exact:true});
 await expect(panel).toContainText('Net flow shows capital entering or leaving the shared pool.');
 await expect(panel).toContainText('All available history has no equivalent preceding window.');
 await expect(panel.locator('.comparison-metric')).toHaveCount(0);await expect(panel.locator('.comparison-periods')).toHaveCount(0);
 await expect(panel.getByRole('button',{name:/Export comparison CSV/})).toHaveCount(0);
 for(const[range,label]of [['24h','Compare 24 hours'],['7d','Compare 7 days'],['30d','Compare 30 days']]){
  const href=await panel.getByRole('link',{name:label,exact:true}).getAttribute('href');const url=new URL(href!,'http://localhost');
  expect(url.pathname).toBe(route);expect(url.searchParams.get('range')).toBe(range);expect(url.searchParams.get('interval')).toBe('hour');expect(url.searchParams.has('from')).toBe(false);
 }
 await panel.getByRole('link',{name:'Compare 7 days',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(route+'\\?range=7d&interval=hour$'));
 await expect(panel).toHaveAttribute('data-comparison-status','available');await expect(panel.locator('.comparison-bars')).toHaveCount(3);
 await expect(panel.locator('.comparison-bars rect')).toHaveCount(6);await expect(panel.locator('.comparison-metrics')).not.toContainText('Unavailable');
 const response=await(await request.get('/api/v1/finance/analytics?range=7d&interval=hour')).json();
 const net=response.comparison.strategyFlows.metrics.find((metric:{key:string})=>metric.key==='netFlows');
 const visual=await panel.locator('.comparison-metric').filter({has:page.getByRole('heading',{name:'Net flow USDu',exact:true})}).locator('.comparison-bars').evaluate(svg=>({zero:Number(svg.querySelector('.comparison-bar-zero')!.getAttribute('x1')),bars:Array.from(svg.querySelectorAll('rect')).map(bar=>({x:Number(bar.getAttribute('x')),width:Number(bar.getAttribute('width'))}))}));
 for(const[value,index]of [[Number(net.current),0],[Number(net.previous),1]]){const bar=visual.bars[index]!;if(value<0)expect(bar.x+bar.width).toBeLessThanOrEqual(visual.zero+0.01);else expect(bar.x).toBeGreaterThanOrEqual(visual.zero-0.01);}
 const scan=await new AxeBuilder({page}).include('.period-comparison').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(v=>v.id)).toEqual([]);
 await testInfo.attach('visual-flow-comparison-'+testInfo.project.name,{body:await panel.screenshot(),contentType:'image/png'});
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
 await page.goto('/network?range=all&interval=hour&eventKind=SubmitTask');
 const network=page.getByRole('region',{name:'Network activity · period comparison',exact:true});
 const link=new URL((await network.getByRole('link',{name:'Compare 7 days',exact:true}).getAttribute('href'))!,'http://localhost');
 expect(link.searchParams.get('eventKind')).toBe('SubmitTask');expect(link.searchParams.get('interval')).toBe('hour');
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
