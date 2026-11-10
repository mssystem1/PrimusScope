import {expect,test} from '@playwright/test';

test('filters wait for hydration and preserve the first selection on a slow load',async({page})=>{
  test.setTimeout(90000);
  for(const [path,label,value,query] of [['/network','Event type','ReportResult','eventKind'],['/finance','Period','all','range']]){
    let release!:()=>void;
    const scriptsReady=new Promise<void>(resolve=>{release=resolve;});
    const pattern='**/_next/static/**/*.js';
    await page.route(pattern,async route=>{await scriptsReady;await route.continue();});
    try{
      await page.goto(path,{waitUntil:'commit'});
      const control=page.getByLabel(label,{exact:true});
      await expect(control).toBeVisible();await expect(control).toBeDisabled();
      release();await expect(control).toBeEnabled();
      await control.selectOption(value);await expect(control).toHaveValue(value);
      await Promise.all([
        page.waitForURL(url=>url.searchParams.get(query)===value),
        page.getByRole('button',{name:path==='/network'?'Apply filters':'Update dashboard',exact:true}).click(),
      ]);
      await expect(page.getByLabel(label,{exact:true})).toHaveValue(value);
    }finally{release();await page.unroute(pattern);}
  }
});
