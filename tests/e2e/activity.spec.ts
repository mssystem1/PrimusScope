import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { parseCsv } from './csv';
import { knownTask } from './fixtures';

test('event filters round-trip through sharing, saved views and matching CSV', async ({ page, request, context }) => {
  test.setTimeout(60000);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  const first = await (await request.get('/api/v1/network/events?eventKind=ReportResult&limit=1')).json();
  const target = first.items[0];
  await page.goto('/network');
  const activity=page.getByRole('region',{name:'Network activity explorer',exact:true});
  await activity.getByLabel('Event type',{exact:true}).selectOption('ReportResult');
  await activity.getByLabel('From block, inclusive',{exact:true}).fill(target.blockNumber);
  await activity.getByLabel('To block, inclusive',{exact:true}).fill(target.blockNumber);
  await activity.getByLabel('Exact task ID, optional',{exact:true}).fill(target.taskId);
  await Promise.all([
    page.waitForURL(url=>url.searchParams.get('eventKind')==='ReportResult'&&url.searchParams.get('taskId')===target.taskId),
    activity.getByRole('button',{name:'Apply filters',exact:true}).click(),
  ]);
  await expect(activity.getByRole('table',{name:'Filtered Network activity',exact:true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('eventKind')).toBe('ReportResult');
  const rows=activity.locator('tbody tr');expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row.getByRole('rowheader')).toHaveText('Attestor report');
  await activity.getByRole('button',{name:'Copy view link',exact:true}).click();
  await expect(activity.getByRole('button',{name:'Copied',exact:true})).toBeVisible();
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  expect(new URL(copied).origin).toBe(new URL(page.url()).origin);
  expect(new URL(copied).searchParams.get('taskId')).toBe(target.taskId);expect(new URL(copied).hash).toBe('#activity');
  await page.route('**/api/v1/exports/metrics.csv?**',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'SNAPSHOT_EXPIRED'})}),{times:1});
  await activity.getByRole('link',{name:'Export matching events',exact:true}).click();
  await expect(activity.getByRole('alert')).toContainText('New observations arrived');
  await activity.getByRole('link',{name:'Refresh matching events',exact:true}).click();
  await expect(activity.getByLabel('Exact task ID, optional',{exact:true})).toHaveValue(target.taskId);
  let exportHref=(await activity.getByRole('link',{name:'Export matching events',exact:true}).getAttribute('href'))!;
  let response=await request.get(exportHref);
  if(response.status()===409){
    expect((await response.json()).code).toBe('SNAPSHOT_EXPIRED');await page.reload();
    exportHref=(await activity.getByRole('link',{name:'Export matching events',exact:true}).getAttribute('href'))!;
    response=await request.get(exportHref);
  }
  expect(response.status()).toBe(200);
  const [download]=await Promise.all([page.waitForEvent('download'),activity.getByRole('link',{name:'Export matching events',exact:true}).click()]);
  expect(download.suggestedFilename()).toBe('primusscope-network-observations.csv');
  expect(await download.failure()).toBeNull();
  const [header,...csvRows]=parseCsv(await response.text());
  const column=(name:string)=>{const index=header.indexOf(name);expect(index).toBeGreaterThanOrEqual(0);return index;};
  expect(csvRows).toHaveLength(await rows.count());
  for(const row of csvRows){expect(row[column('event')]).toBe('ReportResult');expect(row[column('task_id')]).toBe(target.taskId);
    expect(row[column('selection_from_block')]).toBe(target.blockNumber);
    expect(row[column('snapshot_id')]).toBe(new URL(exportHref,page.url()).searchParams.get('snapshotId'));}
  await activity.getByRole('button',{name:/^Save Network activity/}).click();
  await page.goto('/workspace');
  const saved=page.getByRole('link',{name:/^Network activity · Attestor report/});await expect(saved).toBeVisible();
  expect((await saved.getAttribute('href'))).toContain('eventKind=ReportResult');await saved.click();
  await expect(activity.getByLabel('Exact task ID, optional',{exact:true})).toHaveValue(target.taskId);
  await expect(activity.getByLabel('From block, inclusive',{exact:true})).toHaveValue(target.blockNumber);
  await page.reload();await expect(activity.getByLabel('Event type',{exact:true})).toHaveValue('ReportResult');
  await activity.getByRole('link',{name:'Reset filters',exact:true}).click();
  await expect(activity.getByLabel('Event type',{exact:true})).toHaveValue('');
  await expect(activity.getByLabel('Exact task ID, optional',{exact:true})).toHaveValue('');
  await activity.getByRole('button',{name:/^Save Network activity/}).click();
  await page.goto('/workspace');
  await expect(page.getByRole('link',{name:'Network activity · All events',exact:true})).toHaveAttribute('href','/network#activity');
});

test('pagination, changed snapshots and empty or uncovered ranges have recovery paths', async ({ page }) => {
  await page.goto('/network?eventKind=ReportResult&limit=1#activity');
  const activity=page.getByRole('region',{name:'Network activity explorer',exact:true});
  const first=await activity.locator('tbody tr').first().getAttribute('data-event-id');
  const next=(await activity.getByRole('link',{name:'Next activity page',exact:true}).getAttribute('href'))!;
  await activity.getByRole('link',{name:'Next activity page',exact:true}).click();
  await expect(activity.locator('tbody tr').first()).not.toHaveAttribute('data-event-id',first!);
  await expect(activity.getByRole('navigation',{name:'Activity pagination'})).toContainText('Showing 2–2');
  const stale=new URL(next,page.url()); const payload=JSON.parse(Buffer.from(stale.searchParams.get('cursor')!,'base64url').toString());
  payload.snapshotId='a'.repeat(64);stale.searchParams.set('cursor',Buffer.from(JSON.stringify(payload)).toString('base64url'));
  await page.goto(stale.href);await expect(activity.getByRole('heading',{name:'New observations arrived',exact:true})).toBeVisible();
  await activity.getByRole('link',{name:'Restart matching events',exact:true}).click();
  await expect(activity.locator('tbody tr')).toHaveCount(1);expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
  await page.goto(`/network?eventKind=WithdrawBalance&taskId=${knownTask.taskId}#activity`);
  await expect(activity.getByRole('heading',{name:'No matching events in this selection',exact:true})).toBeVisible();
  await expect(activity.getByRole('navigation',{name:'Activity pagination'})).toContainText('Showing 0–0 of 0');
  await page.goto('/network?fromBlock=0#activity');
  await expect(activity.getByRole('alert')).toContainText('within the published Network coverage');
  await activity.getByRole('link',{name:'Use published coverage',exact:true}).click();
  await expect(activity.getByLabel('From block, inclusive',{exact:true})).toHaveValue('');
  await expect(activity.getByRole('table',{name:'Filtered Network activity',exact:true})).toBeVisible();
});

test('chart intervals open an accessible event selection without horizontal overflow', async ({ page },testInfo) => {
  test.setTimeout(60000);
  await page.goto('/network');await page.getByText('View chart data',{exact:true}).click();
  const interval=page.getByRole('link',{name:/Inspect events in blocks/}).nth(7);
  const url=new URL((await interval.getAttribute('href'))!,page.url());
  await interval.click();
  const activity=page.getByRole('region',{name:'Network activity explorer',exact:true});
  await expect(activity.getByLabel('From block, inclusive',{exact:true})).toHaveValue(url.searchParams.get('fromBlock')!);
  await expect(activity.getByLabel('To block, inclusive',{exact:true})).toHaveValue(url.searchParams.get('toBlock')!);
  const sizes=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport+1);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  expect(result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
  await testInfo.attach(`activity-filters-${testInfo.project.name}`,{body:await activity.locator('form').screenshot(),contentType:'image/png'});
});
