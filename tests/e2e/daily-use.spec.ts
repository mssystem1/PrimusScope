import{readFile}from'node:fs/promises';
import AxeBuilder from'@axe-core/playwright';
import{expect,test}from'@playwright/test';
import{knownTaskPath,knownTask,financeRouteIds}from'./fixtures';
import type{ComparisonGroup}from'@primusscope/data';
import{parseCsv}from'./csv';

test('period comparisons reconcile to the API, export exact amounts and survive saved links',async({page,request},testInfo)=>{
 await page.goto('/finance?range=custom&from=2026-10-01&to=2026-10-07&interval=day');
 const panel=page.getByRole('region',{name:'Shared strategy comparison',exact:true});await expect(panel).toBeVisible();
 await expect(panel.locator('.strategy-period-strip [data-period=prior]')).toContainText('24 Sept 2026 – 30 Sept 2026');
 const response=await(await request.get('/api/v1/finance/analytics?range=custom&from=2026-10-01&to=2026-10-07&interval=day')).json();
 const[download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Export comparison CSV for Shared strategy comparison',exact:true}).click()]);
 const[header,...rows]=parseCsv(await readFile((await download.path())!,'utf8'));const column=(name:string)=>header.indexOf(name);
 const flows=rows.filter(row=>row[column('comparison_basis')]==='period_totals');
 expect(flows).toHaveLength(3);for(const[rowIndex,row]of flows.entries()){const metric=response.comparison.strategyFlows.metrics[rowIndex];expect(row[column('current')]).toBe(metric.current);expect(row[column('absolute_change')]).toBe(metric.delta);expect(row[column('snapshot_id')]).toMatch(/^[a-f0-9]{64}$/);expect(row[column('previous_from_utc')]).toBe('2026-09-24T00:00:00.000Z');}
 await testInfo.attach('period-comparison-'+testInfo.project.name,{body:await panel.screenshot(),contentType:'image/png'});
 const operations=page.getByRole('region',{name:'Primus operations · period comparison',exact:true});
 await expect(operations).toHaveAttribute('data-comparison-status','unavailable');await expect(operations).toContainText('No fully covered history in this period.');
 await expect(operations.locator('.comparison-metric')).toHaveCount(0);await expect(operations.getByRole('button',{name:/Export comparison CSV/})).toHaveCount(0);
 await page.getByRole('button',{name:/^Save U \/ eU \+ USDT \/ eUSDT analytics/}).click();await page.goto('/workspace');
 const saved=page.getByRole('link',{name:/^U \/ eU \+ USDT \/ eUSDT analytics/});await expect(saved).toHaveAttribute('href',/from=2026-10-01/);await saved.click();await expect(panel.getByRole('region',{name:'Capital flows',exact:true}).locator('.comparison-bars')).toHaveCount(3);
 await page.goto('/network?range=all');const network=page.getByRole('region',{name:'Network activity · period comparison',exact:true});await expect(network).toContainText('All available history has no equivalent preceding window.');await expect(network).toHaveAttribute('data-comparison-status','unavailable');
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
});

test('all-history comparisons offer usable periods and show visual flows without empty tables',async({page,request},testInfo)=>{
 const route='/finance/vaults/'+financeRouteIds[0];
 await page.goto(route+'?range=all&interval=hour');
 const panel=page.getByRole('region',{name:'Shared strategy comparison',exact:true});
 await expect(panel).toContainText('All available history has no equivalent preceding window.');
 await expect(panel.locator('.strategy-comparison-row')).toHaveCount(0);await expect(panel.locator('.strategy-period-strip')).toHaveCount(0);
 const controls=panel.getByRole('navigation',{name:'Shared strategy comparison periods',exact:true});
 await expect(controls).toHaveCount(1);await expect(controls.getByRole('link')).toHaveCount(3);
 await expect(panel.getByRole('button',{name:/Export comparison CSV/})).toHaveCount(0);
 for(const[range,label]of [['24h','Compare 24 hours'],['7d','Compare 7 days'],['30d','Compare 30 days']]){
  const href=await controls.getByRole('link',{name:label,exact:true}).getAttribute('href');const url=new URL(href!,'http://localhost');
  expect(url.pathname).toBe(route);expect(url.searchParams.get('range')).toBe(range);expect(url.searchParams.get('interval')).toBe('hour');expect(url.searchParams.has('from')).toBe(false);
 }
 await panel.getByRole('link',{name:'Compare 7 days',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(route+'\\?range=7d&interval=hour$'));
 const flows=panel.getByRole('region',{name:'Capital flows',exact:true});
 await expect(flows.locator('.comparison-bars')).toHaveCount(3);
 await expect(flows.locator('.comparison-bars rect')).toHaveCount(6);await expect(flows).not.toContainText('Unavailable');
 const response=await(await request.get('/api/v1/finance/analytics?range=7d&interval=hour')).json();
 const net=response.comparison.strategyFlows.metrics.find((metric:{key:string})=>metric.key==='netFlows');
 const visual=await flows.locator('[data-metric=netFlows]').locator('.comparison-bars').evaluate(svg=>({zero:Number(svg.querySelector('.comparison-bar-zero')!.getAttribute('x1')),bars:Array.from(svg.querySelectorAll('rect')).map(bar=>({x:Number(bar.getAttribute('x')),width:Number(bar.getAttribute('width'))}))}));
 for(const[value,index]of [[Number(net.previous),0],[Number(net.current),1]]){const bar=visual.bars[index]!;if(value<0)expect(bar.x+bar.width).toBeLessThanOrEqual(visual.zero+0.01);else expect(bar.x).toBeGreaterThanOrEqual(visual.zero-0.01);}
 const scan=await new AxeBuilder({page}).include('.period-comparison').include('.strategy-comparison').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(v=>v.id)).toEqual([]);
 await testInfo.attach('visual-flow-comparison-'+testInfo.project.name,{body:await panel.screenshot(),contentType:'image/png'});
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
 await page.goto('/network?range=all&interval=hour&eventKind=SubmitTask');
 const network=page.getByRole('region',{name:'Network activity · period comparison',exact:true});
 const link=new URL((await network.getByRole('link',{name:'Compare 7 days',exact:true}).getAttribute('href'))!,'http://localhost');
 expect(link.searchParams.get('eventKind')).toBe('SubmitTask');expect(link.searchParams.get('interval')).toBe('hour');
});

test('the shared strategy comparison exports all metrics with their original time basis',async({page,request})=>{
 const query='?range=custom&from=2026-11-01&to=2026-11-07&interval=day';
 await page.goto('/finance'+query);
 const panel=page.getByRole('region',{name:'Shared strategy comparison',exact:true});
 const exportButton=panel.getByRole('button',{name:'Export comparison CSV for Shared strategy comparison',exact:true});
 await expect(page.getByRole('region',{name:/^Shared strategy.*comparison/})).toHaveCount(1);
 await expect(panel.getByRole('navigation')).toHaveCount(1);
 await expect(panel.getByRole('navigation').getByRole('link')).toHaveCount(3);
 await expect(panel.getByRole('button',{name:/Export comparison CSV/})).toHaveCount(1);
 const legend=panel.locator('.strategy-period-strip');
 await expect(legend).toHaveCount(1);
 await expect(legend.locator('[data-period=prior]')).toBeVisible();
 await expect(legend.locator('[data-period=current]')).toBeVisible();
 await expect(panel.locator('.strategy-comparison-row')).toHaveCount(8);

 const body=await(await request.get('/api/v1/finance/analytics'+query)).json();
 const {strategyFlows,strategyValue}=body.comparison as {strategyFlows:ComparisonGroup;strategyValue:ComparisonGroup};
 const groups=[
  {name:'Capital flows',data:strategyFlows,metrics:strategyFlows.metrics,count:3,basis:'period_totals'},
  {name:'Pool value',data:strategyValue,metrics:strategyValue.metrics.filter(metric=>!metric.key.startsWith('apy')),count:3,basis:'end_observations'},
  {name:'Yield',data:strategyValue,metrics:strategyValue.metrics.filter(metric=>metric.key.startsWith('apy')),count:2,basis:'end_observations'},
 ];
 for(const group of groups){
  const section=panel.getByRole('region',{name:group.name,exact:true});
  await expect(section.locator('.strategy-comparison-row')).toHaveCount(group.count);
  for(const metric of group.metrics)await expect(section.locator(`[data-metric="${metric.key}"]`)).toBeVisible();
  if(group.basis==='end_observations')await expect(section.locator('.comparison-bars')).toHaveCount(group.count);
 }

 const [download]=await Promise.all([page.waitForEvent('download'),exportButton.click()]);
 const [header,...rows]=parseCsv(await readFile((await download.path())!,'utf8'));
 const column=(name:string)=>header.indexOf(name);
 expect(rows).toHaveLength(8);
 for(const {name,data,metrics,basis} of groups){
  const groupRows=rows.filter(row=>row[column('metric_group')]===name);
  expect(groupRows).toHaveLength(metrics.length);
  for(const [index,row] of groupRows.entries()){
   const metric=metrics[index]!;
   expect(row[column('metric')]).toBe(metric.label);
   expect(row[column('unit')]).toBe(metric.unit);
   expect(row[column('current')]).toBe(metric.current??'');
   expect(row[column('previous')]).toBe(metric.previous??'');
   expect(row[column('absolute_change')]).toBe(metric.delta??'');
   expect(row[column('percent_change')]).toBe(metric.percentChange===null?'':String(metric.percentChange));
   expect(row[column('comparison_basis')]).toBe(basis);
   expect(row[column('delta_unit')]).toBe(name==='Yield'?'pp':metric.unit);
   expect(row[column('snapshot_id')]).toMatch(/^[a-f0-9]{64}$/);
   for(const period of ['current','previous'] as const){
    expect(row[column(period+'_from_utc')]).toBe(data[period].from);
    expect(row[column(period+'_through_utc')]).toBe(data[period].to);
    expect(row[column(period+'_complete')]).toBe(String(data[period].complete));
    expect(row[column(period+'_measured_at_utc')]).toBe(basis==='end_observations'?data[period].measuredAt:'');
   }
  }
 }

 const details=panel.locator('.strategy-comparison-details');
 await expect(details).toHaveJSProperty('open',false);
 const size=await panel.evaluate(element=>({panelHeight:element.getBoundingClientRect().height,width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
 expect(size.content).toBeLessThanOrEqual(size.width+1);
 if(size.width<=390)expect(size.panelHeight).toBeLessThan(1900);
 await details.locator('summary').click();
 await expect(details).toHaveJSProperty('open',true);
 for(const period of ['previous','current'] as const){
  const measuredAt=strategyValue[period].measuredAt;
  expect(measuredAt).toBeTruthy();
  await expect(details).toContainText(measuredAt!.replace('T',' ').replace(/\.\d{3}Z$/,' UTC'));
 }
 const scan=await new AxeBuilder({page}).include('.period-comparison').include('.strategy-comparison').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(v=>v.id)).toEqual([]);
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
