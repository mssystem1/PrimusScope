import{expect,test}from'@playwright/test';import AxeBuilder from'@axe-core/playwright';
test('new Blob data and Neon history have independent, clear desktop and phone workflows',async({page},testInfo)=>{
 test.setTimeout(60000);for(const path of ['/','/finance','/network','/workspace','/developers','/sources']){await page.goto(path);await expect(page.getByRole('heading',{level:1})).toBeVisible();await expect(page.getByText('This view could not be loaded',{exact:true})).toHaveCount(0);await expect(page.getByText('Live storage is temporarily unavailable.',{exact:true})).toHaveCount(0);}
 await expect(page.getByText('VERCEL BLOB COLLECTION',{exact:true})).toBeVisible();await expect(page.getByText('Scheduled collection · 1 hour.',{exact:true})).toBeVisible();
 const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
 await testInfo.attach('blob-sources-'+testInfo.project.name,{body:await page.screenshot(),contentType:'image/png'});
 await page.getByRole('link',{name:'Browse Neon history →',exact:true}).click();await expect(page.getByRole('heading',{name:'Neon history',exact:true})).toBeVisible();await expect(page.getByText('This view could not be loaded',{exact:true})).toHaveCount(0);
 const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));expect(sizes.content).toBeLessThanOrEqual(sizes.width+1);
});
