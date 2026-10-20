import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = path.join(root,"test-results");
await mkdir(results,{recursive:true});
const profile = await mkdtemp(path.join(root,".tools","tour-test-"));
const ext = path.join(root,"extension");
const context = await chromium.launchPersistentContext(profile,{channel:"chromium",headless:true,
  viewport:{width:1280,height:900},args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
const votes = [], errors = [], modes = new Map();
let page;
try {
  await context.exposeBinding("fixtureVote", (_, id, trusted) => votes.push({id,trusted}));
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/server\/(\d+)\/votes$/);
    if(url.origin !== "https://wargm.ru" || !match) return route.abort();
    const id=match[1], mode=modes.get(id)||"vote";
    const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Локальная проверка WARGM</title>
    <style>body{font:16px system-ui;background:#151722;color:white;padding:40px}.card{width:330px;background:#24283d;padding:24px;border-radius:12px}button{padding:12px;width:100%;background:#4939c9;color:white;border:0;border-radius:10px}.card-footer{margin-top:20px}</style>
    <div class="card"><div class="card-header"><h3 class="head">Голосование</h3></div><div class="card-body">Голоса помогают серверу подняться выше в рейтинге.</div><div class="card-footer"></div></div>
    <div class="card"><div class="card-header"><h3 class="head">Про голоса</h3></div><div class="card-footer"><button>15ч. 60м.</button></div></div>
    <script>
    const id=${JSON.stringify(id)}, mode=${JSON.stringify(mode)};
    const footer=document.querySelector('.card-footer');
    if(mode==='cooldown'||sessionStorage.getItem('voted'+id)) { footer.innerHTML='<button class="btn" disabled>15ч. 60м.</button>'; }
    else if(mode==='login') { footer.innerHTML='<a data-send="/auth">Авторизация</a>'; }
    else { footer.innerHTML='<button class="btn voting" disabled>АКТИВАЦИЯ</button>'; const btn=footer.querySelector('button');
      setTimeout(()=>{btn.disabled=false;btn.textContent='ГОЛОСОВАТЬ';btn.setAttribute('data-send','/server/vote')},1000);
      btn.addEventListener('click',async event=>{await window.fixtureVote(id,event.isTrusted);if(mode==='error'){const p=document.createElement('p');p.textContent='Ошибка. Повторите позже.';footer.append(p);return;}sessionStorage.setItem('voted'+id,'1');location.reload();});
    }
    </script></html>`;
    await route.fulfill({contentType:"text/html",body:html});
  });
  let [worker]=context.serviceWorkers();
  if(!worker) worker=await context.waitForEvent("serviceworker");
  const extensionId=new URL(worker.url()).host;
  page=await context.newPage();
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(()=>document.getElementById('mainCount').textContent.includes('15 серверов'));
  assert.match(await page.locator('#stalkerCount').textContent(),/4 серверов/);
  await page.locator('body').screenshot({path:path.join(results,'04-popup.png')});
  const state=()=>worker.evaluate(async()=> (await chrome.storage.local.get('twinkleState')).twinkleState);
  const command=message=>worker.evaluate(message=>chrome.runtime.sendMessage(message),message);
  const nextPage=context.waitForEvent('page');
  await page.locator('#stalker').click();
  let votePage=await nextPage;
  await votePage.waitForURL('https://wargm.ru/server/80996/votes');
  await votePage.locator('#twinkle-vote-guide').waitFor();
  await votePage.getByRole('button',{name:'ГОЛОСОВАТЬ',exact:true}).waitFor();
  await votePage.waitForFunction(()=>document.querySelector('#twinkle-vote-guide').shadowRoot.textContent.includes('Нажмите «ГОЛОСОВАТЬ»'));
  assert.equal(votes.length,0);
  assert.equal((await state()).tour.index,0);
  await votePage.screenshot({path:path.join(results,'05-vote-guide.png')});
  await votePage.getByRole('button',{name:'ГОЛОСОВАТЬ',exact:true}).click();
  await votePage.waitForURL('https://wargm.ru/server/81003/votes');
  assert.equal((await state()).tour.confirmed,1);
  assert.deepEqual(votes,[{id:'80996',trusted:true}]);
  assert.ok((await state()).servers.find(s=>s.id==='80996').lastVoteAt);
  await votePage.getByRole('button',{name:'ГОЛОСОВАТЬ',exact:true}).waitFor();
  await votePage.waitForFunction(()=>document.querySelector('#twinkle-vote-guide').shadowRoot.textContent.includes('Нажмите «ГОЛОСОВАТЬ»'));
  modes.set('81301','cooldown');
  await votePage.evaluate(()=>document.querySelector('.voting').click());
  await votePage.waitForURL('https://wargm.ru/server/81302/votes');
  assert.equal((await state()).tour.confirmed,1);
  assert.equal((await state()).tour.skipped,2);
  assert.equal((await state()).servers.find(s=>s.id==='81003').lastVoteAt,null);
  assert.equal((await state()).servers.find(s=>s.id==='81301').lastVoteAt,null);
  await votePage.getByRole('button',{name:'ГОЛОСОВАТЬ',exact:true}).waitFor();
  await votePage.waitForFunction(()=>document.querySelector('#twinkle-vote-guide').shadowRoot.textContent.includes('Нажмите «ГОЛОСОВАТЬ»'));
  await votePage.getByRole('button',{name:'ГОЛОСОВАТЬ',exact:true}).click();
  await votePage.waitForURL(`chrome-extension://${extensionId}/index.html#tour-finished`);
  await votePage.waitForFunction(()=>document.getElementById('tourStatus').textContent.includes('Готово'));
  assert.equal((await state()).tour.confirmed,2);
  assert.equal((await state()).tour.active,false);
  assert.equal((await state()).servers.filter(s=>s.lastVoteAt).length,2);
  await votePage.screenshot({path:path.join(results,'06-tour-complete.png'),fullPage:true});
  modes.set('71046','error');
  const newPage=context.waitForEvent('page');
  await votePage.locator('#mainStart').click();
  votePage=await newPage;
  await votePage.waitForURL('https://wargm.ru/server/71046/votes');
  await votePage.getByRole('button',{name:'ГОЛОСОВАТЬ',exact:true}).waitFor();
  await votePage.waitForFunction(()=>document.querySelector('#twinkle-vote-guide').shadowRoot.textContent.includes('Нажмите «ГОЛОСОВАТЬ»'));
  await votePage.getByRole('button',{name:'ГОЛОСОВАТЬ',exact:true}).click();
  await votePage.getByText('Ошибка. Повторите позже.').waitFor();
  await votePage.waitForFunction(()=>document.querySelector('#twinkle-vote-guide').shadowRoot.textContent.includes('Ждём обновления'));
  assert.equal((await state()).tour.index,0);
  assert.equal((await state()).servers.find(s=>s.id==='71046').lastVoteAt,null);
  await votePage.getByRole('button',{name:'Пропустить',exact:true}).click();
  await votePage.waitForURL('https://wargm.ru/server/71261/votes');
  await votePage.getByRole('button',{name:'Остановить',exact:true}).click();
  await votePage.waitForFunction(()=>document.querySelector('#twinkle-vote-guide').shadowRoot.textContent.includes('Проход остановлен'));
  assert.equal((await state()).tour.active,false);
  assert.equal((await state()).tour.confirmed,0);
  await votePage.goto(`chrome-extension://${extensionId}/index.html`);
  await votePage.locator('#mainStart').waitFor();
  await votePage.setViewportSize({width:390,height:844});
  assert.ok(await votePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await votePage.screenshot({path:path.join(results,'07-tour-narrow.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const report={passed:['Popup has 15 + 4 project buttons','No click is sent by extension','Trusted user click plus refreshed cooldown records result and advances in same tab','Synthetic click does not record a new vote','Already-voted server is skipped','Only voting card timer counts','Group completion returns to dashboard','Error does not advance or record vote','Skip and stop controls work','390px layout has no horizontal overflow'],notRun:['Live authenticated WARGM vote','Real CAPTCHA flow','Windows notifications']};
  await writeFile(path.join(results,'tour-browser-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  for(const p of context.pages()) { if(!p.isClosed()) await p.screenshot({path:path.join(results,`tour-failure-${context.pages().indexOf(p)}.png`),fullPage:true}).catch(()=>{}); }
  throw error;
} finally { await context.close(); }
