import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve, surveyStateSnapshot } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var EXACT_BYTES = [0,1,2,127,128,129,250,251,252,253,254,255,10,13,20,40,80,120,160,200];
var EXACT_PHOTO = "data:image/jpeg;base64," + Buffer.from(EXACT_BYTES).toString("base64");

async function withPhotoApp(options, run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
    var page = await context.newPage();
    await page.addInitScript(function(config){
      window.__shareCalls = [];
      window.__canShareCalls = [];
      window.__shareSupported = config.supported;
      Object.defineProperty(navigator, "canShare", {
        configurable:true,
        value:function(data){
          window.__canShareCalls.push({
            data:data,
            file:data.files && data.files[0],
            active:navigator.userActivation ? navigator.userActivation.isActive : null
          });
          return window.__shareSupported;
        }
      });
      Object.defineProperty(navigator, "share", {
        configurable:true,
        value:function(data){
          var call = {
            data:data,
            file:data.files && data.files[0],
            active:navigator.userActivation ? navigator.userActivation.isActive : null
          };
          window.__shareCalls.push(call);
          return new Promise(function(resolve,reject){
            call.resolve = resolve;
            call.reject = reject;
          });
        }
      });
    }, {supported:options.supported !== false});
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    var imported = await page.evaluate(function(photo){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Exact Byte Client",date:"2026-07-25"},
        log:{},
        rooms:[{id:1,d:{name:"Share guard"}}],
        photos:photo ? {"1|notes":[photo]} : {},
        skipped:{},
        ui:{"1|notes":true}
      }));
    }, options.photo === undefined ? EXACT_PHOTO : options.photo);
    assert.equal(imported, true);
    if(options.offline) await context.setOffline(true);
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function openSave(page){
  await page.locator('[data-photos="1|notes"] [data-viewph]').first().click();
  return page.locator("[data-phv-save]");
}

test("Save photo shares the actual byte-exact File synchronously and never claims success", async function(){
  await withPhotoApp({}, async function(page){
    var save = await openSave(page);
    await page.evaluate(function(){
      window.__shareFetchCalls = 0;
      var originalFetch = window.fetch;
      window.fetch = function(){
        window.__shareFetchCalls++;
        return originalFetch.apply(this, arguments);
      };
    });
    var before = await surveyStateSnapshot(page);

    await save.click();
    var shared = await page.evaluate(async function(){
      var can = window.__canShareCalls[0];
      var call = window.__shareCalls[0];
      return {
        canCalls:window.__canShareCalls.length,
        shareCalls:window.__shareCalls.length,
        sameFile:can.file === call.file,
        canActive:can.active,
        shareActive:call.active,
        name:call.file.name,
        type:call.file.type,
        size:call.file.size,
        bytes:Array.from(new Uint8Array(await call.file.arrayBuffer())),
        fetchCalls:window.__shareFetchCalls
      };
    });
    assert.equal(shared.canCalls, 1);
    assert.equal(shared.shareCalls, 1);
    assert.equal(shared.sameFile, true, "canShare must receive the actual File passed to share");
    assert.equal(shared.canActive, true, "File support must be checked in the trusted tap");
    assert.equal(shared.shareActive, true, "share() must remain inside transient user activation");
    assert.equal(shared.name, "avl-survey-exact-byte-client-2026-07-25-1-notes-photo-1.jpg");
    assert.equal(shared.type, "image/jpeg");
    assert.equal(shared.size, EXACT_BYTES.length);
    assert.deepEqual(shared.bytes, EXACT_BYTES);
    assert.equal(shared.fetchCalls, 0, "the data URL must be decoded synchronously without fetch()");
    assert.equal(await surveyStateSnapshot(page), before, "starting a share must not mutate survey state");
    assert.equal(await save.isDisabled(), true, "the in-flight guard must disable repeat taps");
    assert.doesNotMatch(await page.locator(".phviewer").innerText(), /\bSaved\b/i, "in-flight UI must not claim a Photos/Gallery save");

    await page.evaluate(function(){
      document.querySelector("[data-phv-save]").click();
    });
    assert.equal(
      await page.evaluate(function(){ return window.__shareCalls.length; }),
      1,
      "a second tap while pending must not open another share sheet"
    );

    await page.evaluate(function(){ window.__shareCalls[0].resolve(); });
    await page.waitForFunction(function(){
      var button = document.querySelector("[data-phv-save]");
      return button && !button.disabled && button.textContent === "Save photo\u2026";
    });
    var completed = await page.evaluate(function(){
      return {
        viewerText:document.querySelector(".phviewer").textContent
      };
    });
    assert.equal(await surveyStateSnapshot(page), before, "share resolution must not mutate survey state");
    assert.doesNotMatch(completed.viewerText, /\bSaved\b/i, "the browser cannot prove a Photos/Gallery save");
  });
});

test("cancelling clears the in-flight guard, stays calm, and permits retry", async function(){
  await withPhotoApp({}, async function(page){
    var save = await openSave(page);
    var before = await surveyStateSnapshot(page);
    await save.click();
    await page.evaluate(function(){
      window.__shareCalls[0].reject(new DOMException("User cancelled", "AbortError"));
    });
    await page.waitForFunction(function(){
      var button = document.querySelector("[data-phv-save]");
      return button && !button.disabled;
    });

    var cancelled = await page.evaluate(function(){
      return {
        status:document.querySelector(".phvstatus").textContent,
        fallbackHidden:document.querySelector("[data-phv-download]").hidden,
        viewerText:document.querySelector(".phviewer").textContent
      };
    });
    assert.equal(await surveyStateSnapshot(page), before);
    assert.match(cancelled.status, /Share cancelled\. You can try again\./);
    assert.equal(cancelled.fallbackHidden, true, "ordinary cancellation must not be presented as failure");
    assert.doesNotMatch(cancelled.viewerText, /\bSaved\b/i);

    await save.click();
    assert.equal(await page.evaluate(function(){ return window.__shareCalls.length; }), 2);
    await page.evaluate(function(){ window.__shareCalls[1].resolve(); });
  });
});

test("unsupported file sharing reveals a byte-exact download fallback without state changes", async function(){
  await withPhotoApp({supported:false}, async function(page){
    await page.evaluate(function(){
      window.__downloadClick = null;
      window.__downloadFile = null;
      URL.createObjectURL = function(file){
        window.__downloadFile = file;
        return "blob:photo-fallback";
      };
      URL.revokeObjectURL = function(){};
      HTMLAnchorElement.prototype.click = function(){
        window.__downloadClick = {name:this.download, href:this.href};
      };
    });
    var save = await openSave(page);
    var before = await surveyStateSnapshot(page);
    await save.click();

    var unsupported = await page.evaluate(function(){
      return {
        canCalls:window.__canShareCalls.length,
        shareCalls:window.__shareCalls.length,
        fallbackHidden:document.querySelector("[data-phv-download]").hidden,
        status:document.querySelector(".phvstatus").textContent
      };
    });
    assert.equal(unsupported.canCalls, 1);
    assert.equal(unsupported.shareCalls, 0);
    assert.equal(unsupported.fallbackHidden, false);
    assert.match(unsupported.status, /File sharing is not available/i);
    assert.equal(await surveyStateSnapshot(page), before);

    await page.locator("[data-phv-download]").click();
    var downloaded = await page.evaluate(async function(){
      return {
        click:window.__downloadClick,
        type:window.__downloadFile.type,
        size:window.__downloadFile.size,
        bytes:Array.from(new Uint8Array(await window.__downloadFile.arrayBuffer())),
        viewerText:document.querySelector(".phviewer").textContent
      };
    });
    assert.equal(downloaded.click.name, "avl-survey-exact-byte-client-2026-07-25-1-notes-photo-1.jpg");
    assert.equal(downloaded.click.href, "blob:photo-fallback");
    assert.equal(downloaded.type, "image/jpeg");
    assert.equal(downloaded.size, EXACT_BYTES.length);
    assert.deepEqual(downloaded.bytes, EXACT_BYTES);
    assert.equal(await surveyStateSnapshot(page), before);
    assert.doesNotMatch(downloaded.viewerText, /\bSaved\b/i);
  });
});

test("a real share failure clears the guard and exposes the download path", async function(){
  await withPhotoApp({}, async function(page){
    var save = await openSave(page);
    var before = await surveyStateSnapshot(page);
    await save.click();
    await page.evaluate(function(){
      window.__shareCalls[0].reject(new DOMException("Not allowed", "NotAllowedError"));
    });
    await page.waitForFunction(function(){
      return !document.querySelector("[data-phv-download]").hidden;
    });
    var failed = await page.evaluate(function(){
      return {
        enabled:!document.querySelector("[data-phv-save]").disabled,
        status:document.querySelector(".phvstatus").textContent
      };
    });
    assert.equal(failed.enabled, true);
    assert.match(failed.status, /Could not open the share sheet/i);
    assert.equal(await surveyStateSnapshot(page), before);
  });
});

test("Save photo prepares the local File and opens the native share path offline", async function(){
  await withPhotoApp({offline:true}, async function(page){
    var before = await surveyStateSnapshot(page);
    var save = await openSave(page);
    await save.click();
    var offline = await page.evaluate(async function(){
      var file = window.__shareCalls[0].file;
      return {
        calls:window.__shareCalls.length,
        type:file.type,
        bytes:Array.from(new Uint8Array(await file.arrayBuffer()))
      };
    });
    assert.equal(offline.calls, 1);
    assert.equal(offline.type, "image/jpeg");
    assert.deepEqual(offline.bytes, EXACT_BYTES);
    assert.equal(await surveyStateSnapshot(page), before);
    await page.evaluate(function(){ window.__shareCalls[0].resolve(); });
  });
});

test("capture opens the saved survey copy with a large manual Save photo action", async function(){
  await withPhotoApp({photo:null}, async function(page){
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60">' +
      '<rect width="40" height="60" fill="purple"/></svg>';
    var chooserPromise = page.waitForEvent("filechooser");
    await page.locator('[data-photos="1|notes"] [data-addph]').click();
    var chooser = await chooserPromise;
    await chooser.setFiles({
      name:"portrait.svg",
      mimeType:"image/svg+xml",
      buffer:Buffer.from(svg)
    });
    await page.waitForSelector(".phviewer");
    await page.waitForFunction(function(){
      var image = document.querySelector(".phvimage");
      return image && image.complete && image.naturalWidth > 0;
    });

    var captured = await page.evaluate(function(){
      var image = document.querySelector(".phvimage");
      var raw = window.__avl.raw();
      return {
        count:(window.__avl.S().photos["1|notes"] || []).length,
        persisted:raw ? (JSON.parse(raw).data.photos["1|notes"] || []).length : 0,
        stored:(window.__avl.S().photos["1|notes"] || [""])[0].slice(0,23),
        dimensions:[image.naturalWidth,image.naturalHeight],
        notice:document.querySelector(".phvhelp").textContent,
        saveText:document.querySelector("[data-phv-save]").textContent,
        saveWidth:document.querySelector("[data-phv-save]").getBoundingClientRect().width,
        shareCalls:window.__shareCalls.length
      };
    });
    assert.equal(captured.count, 1);
    assert.equal(captured.persisted, 1, "capture must persist before the viewer opens");
    assert.equal(captured.stored, "data:image/jpeg;base64,");
    assert.deepEqual(captured.dimensions, [40,60]);
    assert.match(captured.notice, /Photo added to the survey/i);
    assert.match(captured.notice, /900px/i);
    assert.match(captured.notice, /metadata is removed/i);
    assert.equal(captured.saveText, "Save photo\u2026");
    assert.ok(captured.saveWidth >= 300, "post-capture Save photo must be a prominent phone control");
    assert.equal(captured.shareCalls, 0, "capture cannot open the share sheet without a second user tap");

    await page.locator("[data-phv-save]").click();
    assert.equal(await page.evaluate(function(){ return window.__shareCalls.length; }), 1);
    await page.evaluate(function(){ window.__shareCalls[0].resolve(); });
    await page.waitForFunction(function(){ return !document.querySelector("[data-phv-save]").disabled; });
    await page.locator("[data-phv-close]").click();

    var landscape = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40">' +
      '<rect width="60" height="40" fill="teal"/></svg>';
    var secondChooserPromise = page.waitForEvent("filechooser");
    await page.locator('[data-photos="1|notes"] [data-addph]').click();
    var secondChooser = await secondChooserPromise;
    await secondChooser.setFiles({
      name:"landscape.svg",
      mimeType:"image/svg+xml",
      buffer:Buffer.from(landscape)
    });
    await page.waitForSelector(".phviewer");
    await page.waitForFunction(function(){
      var image = document.querySelector(".phvimage");
      return image && image.complete && image.naturalWidth === 60;
    });
    var repeated = await page.evaluate(function(){
      var image = document.querySelector(".phvimage");
      return {
        count:window.__avl.S().photos["1|notes"].length,
        counter:document.querySelector(".phvtop .phvcount").textContent,
        dimensions:[image.naturalWidth,image.naturalHeight],
        shareCalls:window.__shareCalls.length
      };
    });
    assert.equal(repeated.count, 2);
    assert.equal(repeated.counter, "Photo 2 of 2");
    assert.deepEqual(repeated.dimensions, [60,40]);
    assert.equal(repeated.shareCalls, 1, "the second capture must still wait for an explicit save tap");
  });
});

test("a storage-full capture stays shareable and warns inside the viewer", async function(){
  await withPhotoApp({photo:null}, async function(page){
    await page.waitForTimeout(300);
    await page.evaluate(function(){
      var originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value){
        if(key === "avl_survey_v1") throw new DOMException("Quota exceeded", "QuotaExceededError");
        return originalSetItem.call(this, key, value);
      };
    });

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="50">' +
      '<rect width="30" height="50" fill="orange"/></svg>';
    var chooserPromise = page.waitForEvent("filechooser");
    await page.locator('[data-photos="1|notes"] [data-addph]').click();
    var chooser = await chooserPromise;
    await chooser.setFiles({
      name:"storage-full.svg",
      mimeType:"image/svg+xml",
      buffer:Buffer.from(svg)
    });
    await page.waitForSelector(".phviewer");

    var result = await page.evaluate(function(){
      var durable = JSON.parse(window.__avl.raw());
      return {
        memoryCount:window.__avl.S().photos["1|notes"].length,
        durableCount:(durable.data.photos["1|notes"] || []).length,
        notice:document.querySelector(".phvhelp").textContent,
        saveText:document.querySelector("[data-phv-save]").textContent,
        shareCalls:window.__shareCalls.length
      };
    });
    assert.equal(result.memoryCount, 1, "the image must remain available in this session");
    assert.equal(result.durableCount, 0, "the test must prove storage actually rejected the photo");
    assert.match(result.notice, /survey storage is full/i);
    assert.match(result.notice, /Save a copy and export the survey before closing/i);
    assert.equal(result.saveText, "Save photo\u2026");
    assert.equal(result.shareCalls, 0);

    await page.locator("[data-phv-save]").click();
    assert.equal(
      await page.evaluate(function(){ return window.__shareCalls.length; }),
      1,
      "the in-memory photo must remain shareable after storage failure"
    );
    await page.evaluate(function(){ window.__shareCalls[0].resolve(); });
  });
});
