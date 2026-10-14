/* Live service smoke test. Requires Playwright browsers and a running local build.
 * PLAYWRIGHT_MODULE can point to an existing Playwright installation.
 * This uses isolated browser storage; it never changes the user's library.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_BASE_URL || 'http://localhost:3101';
const output = process.env.TEST_OUTPUT_DIR || '/tmp/mangareader-browser-results';
const waitForImages = async (page) => page.locator('.source-page img').first().evaluate(img => img.complete && img.naturalWidth > 0) || page.waitForFunction(() => {
  const img=document.querySelector('.source-page img'); return img?.complete && img.naturalWidth>0;
}, {timeout:20000});
(async () => {
 await fs.mkdir(output, {recursive:true});
 for (const [name, type] of [['chromium',chromium],['webkit',webkit]]) {
  const browser = await type.launch({headless:true});
  try {
   const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});
   const page=await context.newPage();
   const errors=[]; page.on('pageerror',e=>errors.push(e.message));
   const overflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true,'horizontal overflow');
   await page.goto(`${base}/discover`);
   await page.getByRole('searchbox',{name:'Search titles'}).fill('One Punch Man');
   await page.getByRole('link',{name:'Open One-Punch Man',exact:true}).waitFor();
   await overflow();
   await page.getByRole('link',{name:'Open One-Punch Man',exact:true}).click();
   await page.getByRole('heading',{name:'One-Punch Man',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('manga-reader:v1')).library).length),0,'opening search card added title');
   await page.getByRole('link',{name:/Read One-Punch Man on VIZ/}).waitFor();
   await page.getByText('Edition verified. No available English chapters on MangaDex.',{exact:false}).waitFor({timeout:20000});
   assert.equal(await page.locator('a[href*="/mangadex/read/"]').count(),0,'unexpected OPM chapters');
   await page.getByRole('button',{name:'Add One-Punch Man to library',exact:true}).click();
   await page.reload();
   await page.getByRole('button',{name:'Remove One-Punch Man from library',exact:true}).waitFor();
   await page.getByText("Edition verified. No available English chapters on MangaDex.",{exact:false}).waitFor({timeout:20000});
   await overflow(); await page.screenshot({path:`${output}/${name}-opm.png`,fullPage:true});
   await page.goto(`${base}/library`);
   await page.getByRole('list',{name:'Library',exact:true}).getByRole('link',{name:/One-Punch Man/}).waitFor();
   await page.goto(`${base}/discover`);
   await page.getByRole('searchbox',{name:'Search titles'}).fill('Give My Regards to Black Jack');
   await page.getByRole('link',{name:'Open Give My Regards to Black Jack',exact:true}).click();
   await page.getByRole('button',{name:'Add Give My Regards to Black Jack to library',exact:true}).click();
   const chapter1=page.locator('a[href*="/mangadex/read/1369226a-5c75-4bbf-b385-d884228a9cfe"]');
   await chapter1.waitFor({timeout:20000});
   assert.equal(await page.locator('.chapters li').count(),127,'chapter pagination');
   await chapter1.click();
   await page.getByRole('button',{name:'Paged',exact:true}).click({timeout:20000});
   await waitForImages(page);
   await page.getByRole('button',{name:'Next page',exact:true}).click();
   await waitForImages(page);
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('manga-reader:v1')).progress['al-31668']?.chapters['1369226a-5c75-4bbf-b385-d884228a9cfe']?.page===1);
   await overflow();
   await page.reload();
   await page.getByText('Page 2 / 60',{exact:true}).waitFor();
   await waitForImages(page);
   await page.screenshot({path:`${output}/${name}-reader.png`,fullPage:true});
   const progressBefore=await page.evaluate(()=>localStorage.getItem('manga-reader:v1'));
   await page.waitForTimeout(700);
   assert.equal(await page.evaluate(()=>localStorage.getItem('manga-reader:v1')),progressBefore,'idle progress writes');
   // Deliberately fail one page request, then let the retry use the live proxy.
   await page.route('**/api/mangadex/page/*/2', route=>route.fulfill({status:502,body:'Injected test failure'}));
   await page.getByRole('button',{name:'Next page',exact:true}).click();
   await page.getByRole('button',{name:'Retry page 3',exact:true}).waitFor();
   await page.unroute('**/api/mangadex/page/*/2');
   await page.getByRole('button',{name:'Retry page 3',exact:true}).click();
   await waitForImages(page);
   await page.getByRole('button',{name:'Scroll',exact:true}).click();
   const scrollPage=page.locator('.source-page[data-page="3"] img');
   await scrollPage.scrollIntoViewIfNeeded();
   await page.waitForFunction(()=>{ const img=document.querySelector('.source-page[data-page="3"] img'); return img?.complete && img.naturalWidth>0; });
   await page.locator('.source-page[data-page="3"]').evaluate(el=>window.scrollTo(0,el.getBoundingClientRect().top+window.scrollY));
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('manga-reader:v1')).progress['al-31668']?.chapters['1369226a-5c75-4bbf-b385-d884228a9cfe']?.page===3);
   await page.reload();
   await page.getByText('Page 4 / 60',{exact:true}).waitFor();
   assert.equal(await page.locator('.source-page[data-page="0"]').count(),0,'scroll resume loaded earlier pages');
   await page.getByRole('button',{name:'Paged',exact:true}).click();
   await page.getByRole('link',{name:'Chapter 2 →',exact:true}).click();
   await page.getByRole('button',{name:'Scroll',exact:true}).waitFor();
   await page.getByRole('link',{name:'← Chapter 1',exact:true}).waitFor();
   await page.getByRole('link',{name:'Chapter 3 →',exact:true}).waitFor();
   // Test last-chapter boundaries with a live feed-derived URL.
   await page.getByRole('link',{name:'← Chapters',exact:true}).click();
   const last=page.locator('.chapters a[href*="/mangadex/read/"]').last();
   await last.click();
   await page.getByRole('button',{name:'Scroll',exact:true}).waitFor();
   await page.getByRole('link',{name:'← Chapter 126',exact:true}).waitFor();
   assert.equal(await page.getByRole('link',{name:/Chapter 128/}).count(),0);
   await page.goto(base);
   await page.getByRole('link',{name:/Give My Regards to Black Jack.*Resume page/}).click();
   await page.getByRole('button',{name:'Scroll',exact:true}).waitFor();
   await page.goto(`${base}/library`);
   const downloadPromise=page.waitForEvent('download');
   await page.getByRole('button',{name:'Export backup',exact:true}).click();
   const download=await downloadPromise;
   const backupPath=`${output}/${name}-backup.json`; await download.saveAs(backupPath);
   const backup=JSON.parse(await fs.readFile(backupPath,'utf8'));
   assert.ok(backup.savedTitles['al-74347']); assert.ok(backup.progress['al-31668']);
   page.once('dialog',dialog=>dialog.accept());
   await page.locator('input[type=file]').setInputFiles(backupPath);
   await page.getByText('Backup restored.',{exact:true}).waitFor();
   await page.reload();
   assert.equal(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('manga-reader:v1')).library).length),2);
   await overflow(); assert.deepEqual(errors,[]);
   console.log(`${name}: PASS live search, edition identity, no auto-add, save/reload, 127 chapters, images, paged and scroll resume, injected failure/retry, first/middle/last navigation, Home resume, backup export/import, mobile overflow, no runtime errors`);
  } finally { await browser.close(); }
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
