import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect,test } from '@playwright/test';
import { parseCsv } from './csv';

test('Finance charts preserve both Primus routes and expose measured NAV, yield and flows',async({page},testInfo)=>{
  test.setTimeout(90000);
  await page.goto('/finance');
  await expect(page.getByRole('heading',{name:'U / eU',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'USDT / eUSDT',exact:true})).toBeVisible();
  const apy=page.getByRole('region',{name:'APY · 7D and 30D',exact:true});
  await expect(apy).toBeVisible();
  for(const name of ['TVL · underlying strategy','Total supply · vault shares','NAV / exchange price','Net flows · underlying strategy','Deposits & withdrawals · underlying strategy']){
    await expect(page.getByRole('region',{name,exact:true}).getByRole('img')).toBeVisible();
  }
  await expect(apy.getByRole('button',{name:'7D APY',exact:true})).toHaveAttribute('aria-pressed','true');
  await apy.getByRole('button',{name:'7D APY',exact:true}).click();
  await expect(apy.getByRole('button',{name:'7D APY',exact:true})).toHaveAttribute('aria-pressed','false');
  await apy.getByRole('button',{name:'7D APY',exact:true}).click();
  const inspector=apy.locator('.analytics-inspector-values'),before=await inspector.innerText();
  await apy.getByRole('button',{name:'Previous observation in APY · 7D and 30D',exact:true}).focus();
  await page.keyboard.press('Enter');await expect(inspector).not.toHaveText(before);
  await apy.getByText('Explore chart data',{exact:true}).click();
  await expect(apy.getByRole('table',{name:'Data for APY · 7D and 30D',exact:true})).toBeVisible();
  const [download]=await Promise.all([page.waitForEvent('download'),apy.getByRole('button',{name:'Export chart data for APY · 7D and 30D',exact:true}).click()]);
  const contents=await readFile((await download.path())!,'utf8'),csv=parseCsv(contents);
  expect(csv[0]).toEqual(['time_or_category','7D APY (%)','30D APY (%)']);expect(csv.length).toBeGreaterThan(20);
  const form=page.getByRole('form',{name:'Analytics period',exact:true});
  await form.getByLabel('Period',{exact:true}).selectOption('7d');await form.getByRole('button',{name:'Update dashboard',exact:true}).click();
  await expect(page).toHaveURL(/range=7d/);await expect(form.getByLabel('Period',{exact:true})).toHaveValue('7d');
  const size=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
  expect(size.content).toBeLessThanOrEqual(size.viewport+1);
  const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  expect(scan.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
  await testInfo.attach(`finance-chart-${testInfo.project.name}`,{body:await apy.screenshot(),contentType:'image/png'});
});

test('Network dashboard reconciles request cohorts and exposes accessible time-series analysis',async({page,request},testInfo)=>{
  test.setTimeout(90000);
  let response=await request.get('/api/v1/network/analytics?range=7d&interval=hour');expect(response.status()).toBe(200);
  let body=await response.json();
  await page.goto('/network?range=7d&interval=hour');
  const dashboard=page.locator('.analytics-dashboard');
  if(await dashboard.getAttribute('data-snapshot-id')!==body.snapshotId){response=await request.get('/api/v1/network/analytics?range=7d&interval=hour');body=await response.json();await page.reload();}
  expect(await dashboard.getAttribute('data-snapshot-id')).toBe(body.snapshotId);
  const cohort=body.analytics.requestCohort;
  expect(cohort.requestsWithSubsequentReport).toBe(body.analytics.firstReportLatency.count);
  const coverage=dashboard.locator('.analytics-kpi').filter({has:page.getByText('Requests with a later report',{exact:true})});
  const value=cohort.reportObservedRate===null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(cohort.reportObservedRate*100)+'%';
  await expect(coverage.locator('strong')).toHaveText(value);
  for(const name of ['Requests & reports over time','Cumulative network activity','Request cohort · report coverage','Request → first report latency','Attestor report count per request','Withdrawals & callback failures','Activity by UTC hour']){
    await expect(page.getByRole('region',{name,exact:true})).toBeVisible();
  }
  const latency=page.getByRole('region',{name:'Request → first report latency',exact:true});
  await latency.getByText('Explore chart data',{exact:true}).click();
  await expect(latency.getByRole('table',{name:'Data for Request → first report latency',exact:true})).toBeVisible();
  await expect(dashboard).toContainText('not a native SUCCESS state or a cryptographic proof check');
  const size=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
  expect(size.content).toBeLessThanOrEqual(size.viewport+1);
  const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  expect(scan.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
  await testInfo.attach(`network-chart-${testInfo.project.name}`,{body:await page.getByRole('region',{name:'Requests & reports over time',exact:true}).screenshot(),contentType:'image/png'});
});

test('custom UTC periods survive sharing, saved views and route navigation, and expose missing history',async({page,request})=>{
  test.setTimeout(90000);
  await page.goto('/finance?range=custom&interval=day&from=2026-10-01&to=2026-10-15');
  const form=page.getByRole('form',{name:'Analytics period',exact:true});
  await expect(form.getByLabel('From date · UTC',{exact:true})).toHaveValue('2026-10-01');
  await expect(form.getByLabel('Through date · UTC',{exact:true})).toHaveValue('2026-10-15');
  const dashboard=page.locator('.analytics-dashboard');
  await expect(dashboard.locator('.analytics-coverage-card').filter({hasText:'Deposits / withdrawals / net flows'})).toContainText('Selected period covered');
  const save=dashboard.getByRole('button',{name:/^Save U \/ eU \+ USDT \/ eUSDT analytics/});
  const title=(await save.getAttribute('aria-label'))!.replace(/^Save /,'');
  await save.click();
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{(window as unknown as {copiedDashboard:string}).copiedDashboard=value;}}});});
  await dashboard.getByRole('button',{name:'Copy dashboard link',exact:true}).click();
  const shared=await page.evaluate(()=>(window as unknown as {copiedDashboard:string}).copiedDashboard);
  expect(new URL(shared).searchParams.get('from')).toBe('2026-10-01');
  await page.goto('/workspace');await page.getByRole('link',{name:title,exact:true}).click();
  await expect(page).toHaveURL(/from=2026-10-01/);
  await page.getByRole('link',{name:'View analytics',exact:true}).first().click();
  await expect(page).toHaveURL(/finance\/vaults\/.*from=2026-10-01/);
  await page.getByRole('link',{name:'← Finance overview',exact:true}).click();
  await expect(page).toHaveURL(/to=2026-10-15/);
  await page.goto('/finance?range=custom&from=2026-02-30&to=2026-03-02');
  await expect(page.getByRole('alert').filter({hasText:'Check the analytics dates'})).toBeVisible();
  await expect(page.locator('.analytics-dashboard')).toHaveCount(0);
  await page.goto('/finance?range=custom&from=2030-01-01&to=2030-01-02');
  await expect(page.getByRole('region',{name:'TVL · underlying strategy',exact:true}).getByRole('img')).toHaveCount(0);
  const response=await request.get('/api/v1/network/analytics?range=all');const body=await response.json();
  const from=body.coverage.fromTime.slice(0,10),to=body.coverage.toTime.slice(0,10);
  await page.goto(`/network?range=custom&interval=hour&from=${from}&to=${to}&eventKind=SubmitTask`);
  const activity=page.getByRole('form',{name:'Network activity filters',exact:true});
  await activity.getByRole('button',{name:'Apply filters',exact:true}).click();
  const url=new URL(page.url());expect(url.searchParams.get('from')).toBe(from);expect(url.searchParams.get('to')).toBe(to);
  expect(url.searchParams.get('range')).toBe('custom');expect(url.searchParams.get('eventKind')).toBe('SubmitTask');
  const json=await page.getByRole('link',{name:'View JSON',exact:true}).getAttribute('href');expect(json).not.toContain('range=');expect(json).not.toContain('&from=');
  const customScan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(customScan.violations.map(v=>v.id)).toEqual([]);
  const size=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(size.content).toBeLessThanOrEqual(size.viewport+1);
});
