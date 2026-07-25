import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function importRoom(page, data){
  var imported = await page.evaluate(function(roomData){
    return window.__avl.applyImport(JSON.stringify({
      visit:{},
      log:{},
      rooms:[{id:1,d:roomData}],
      photos:{},
      skipped:{},
      ui:{"1|light":true}
    }));
  }, data);
  assert.equal(imported, true);
}

async function withApp(setup, run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();

  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    if(setup) await setup(page);
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

test("brightness guidance uses display-wall lux rather than the room maximum", async function(){
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Basis check",
      lux_disp:"100",
      lux_mid:"800",
      lux_rear:"1200",
      disptype:"Direct-view (LCD / LED)"
    });
    var basisText = await page.locator('[data-calc="1"]').innerText();
    assert.match(basisText, /100 lux at display wall/i);
    assert.match(basisText, /350 nits/i);
    assert.doesNotMatch(basisText, /1500 nits/i);
  });
});

test("projection above 300 lux emits the direct-view or shading warning", async function(){
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Projection warning",
      lux_disp:"301",
      disptype:"Projection",
      scr_diag:"100",
      scr_gain:"1"
    });
    var projectionText = await page.locator('[data-calc="1"]').innerText();
    assert.match(projectionText, /too bright for projection/i);
    assert.match(projectionText, /Specify direct-view LED/i);
  });
});

test("an undersized proposed diagonal is flagged against the furthest seat", async function(){
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Sizing warning",
      lux_disp:"100",
      disptype:"Direct-view (LCD / LED)",
      scr_diag:"100",
      far:"30",
      viewtype:"General viewing"
    });
    var sizingText = await page.locator('[data-calc="1"]').innerText();
    assert.match(sizingText, /123″/i);
    assert.match(sizingText, /100″ is undersized for this room/i);
  });
});

test("storage warnings use localStorage rather than origin-wide estimates", async function(){
  await withApp(async function(page){
    await page.addInitScript(function(){
      if(navigator.storage){
        navigator.storage.estimate = function(){
          return Promise.resolve({usage:1, quota:1000000000});
        };
      }
    });
  }, async function(page){
    var storageText = await page.evaluate(function(){
      localStorage.setItem("test_storage_basis", new Array(1600001).join("x"));
      var html = window.__avl.storageHTML();
      localStorage.removeItem("test_storage_basis");
      var wrap = document.createElement("div");
      wrap.innerHTML = html;
      return wrap.textContent;
    });
    assert.match(storageText, /Over \d+% of the survey storage limit/i);
  });
});
