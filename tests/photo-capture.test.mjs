import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function withCaptureApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Capture guard"},
        log:{},
        rooms:[{id:1,d:{name:"Ordered room"}}],
        photos:{},
        skipped:{},
        ui:{"1|notes":true}
      }));
    });
    assert.equal(imported,true);
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

test("a photo batch preserves selection order, renders once and reports once", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      var sources = {
        first:"data:image/jpeg;base64,AQ==",
        second:"data:image/jpeg;base64,Ag==",
        third:"data:image/jpeg;base64,Aw==",
        fourth:"data:image/jpeg;base64,BA=="
      };
      var delays = {first:35,second:1,third:20,fourth:5};
      var started = [];
      var rootMutations = 0;
      var toastMutations = 0;
      var rootObserver = new MutationObserver(function(records){
        rootMutations += records.length;
      });
      var toastObserver = new MutationObserver(function(records){
        toastMutations += records.length;
      });
      rootObserver.observe(document.getElementById("app"),{childList:true});
      toastObserver.observe(document.getElementById("toast"),{childList:true});

      await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"first"},{name:"second"},{name:"third"},{name:"fourth"}],
        function(file,done){
          started.push(file.name);
          setTimeout(function(){
            done(sources[file.name],{width:10,height:10});
          },delays[file.name]);
        }
      );
      await new Promise(function(resolve){ setTimeout(resolve,0); });
      rootObserver.disconnect();
      toastObserver.disconnect();
      await window.__avl.photoStoreIdle();

      return {
        started:started,
        memory:window.__avl.S().photos["1|notes"].slice(),
        durable:JSON.parse(window.__avl.raw()).data.photos["1|notes"],
        rootMutations:rootMutations,
        toastMutations:toastMutations,
        toast:document.getElementById("toast").textContent,
        viewer:!!document.querySelector(".phviewer"),
        thumbnails:document.querySelectorAll('[data-photos="1|notes"] [data-viewph]').length,
        schema:window.__avl.SCHEMA
      };
    });

    assert.deepEqual(result.started,["first","second","third","fourth"]);
    assert.deepEqual(result.memory,[
      "data:image/jpeg;base64,AQ==",
      "data:image/jpeg;base64,Ag==",
      "data:image/jpeg;base64,Aw==",
      "data:image/jpeg;base64,BA=="
    ]);
    assert.deepEqual(result.durable,result.memory);
    assert.equal(result.rootMutations,1,"the survey must render once at batch completion");
    assert.equal(result.toastMutations,1,"one capture batch must produce one summary toast");
    assert.equal(result.toast,"4 photos added.");
    assert.equal(result.viewer,false);
    assert.equal(result.thumbnails,4);
    assert.equal(result.schema,2,"the reversible capture PR must not move the schema");
  });
});

test("capture clears a pending debounced save before the first photo is appended", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      window.__avl.persistSurvey();
      var field = document.querySelector('[data-scope="visit"][data-k="client"]');
      field.value = "Pending field edit";
      field.dispatchEvent(new Event("input",{bubbles:true}));
      window.__midBatchDurableCount = -1;

      await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"first"},{name:"second"}],
        function(file,done){
          if(file.name === "first"){
            setTimeout(function(){
              done("data:image/jpeg;base64,Cg==",{width:10,height:10});
            },10);
            return;
          }
          setTimeout(function(){
            var raw = JSON.parse(window.__avl.raw());
            window.__midBatchDurableCount = (raw.data.photos["1|notes"] || []).length;
            done("data:image/jpeg;base64,Cw==",{width:10,height:10});
          },350);
        }
      );

      return {
        midBatchDurableCount:window.__midBatchDurableCount,
        finalDurableCount:JSON.parse(window.__avl.raw()).data.photos["1|notes"].length
      };
    });

    assert.equal(
      result.midBatchDurableCount,
      0,
      "a field's pending save must not persist a partially processed capture batch"
    );
    assert.equal(result.finalDurableCount,2);
  });
});

test("a partial batch reports the processed and failed counts once", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      var toastMutations = 0;
      var observer = new MutationObserver(function(records){
        toastMutations += records.length;
      });
      observer.observe(document.getElementById("toast"),{childList:true});
      await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"one"},{name:"bad"},{name:"three"},{name:"four"}],
        function(file,done){
          if(file.name === "bad"){
            done(null);
            return;
          }
          done("data:image/jpeg;base64," +
            (file.name === "one" ? "IQ==" : (file.name === "three" ? "Iw==" : "JA==")),
            {width:10,height:10});
        }
      );
      await new Promise(function(resolve){ setTimeout(resolve,0); });
      observer.disconnect();
      return {
        count:window.__avl.S().photos["1|notes"].length,
        toast:document.getElementById("toast").textContent,
        toastMutations:toastMutations,
        viewer:!!document.querySelector(".phviewer")
      };
    });

    assert.equal(result.count,3);
    assert.equal(result.toast,"3 of 4 photos added. 1 could not be processed.");
    assert.equal(result.toastMutations,1);
    assert.equal(result.viewer,false);
  });
});

test("four memory-only photos produce one persistent recovery notice and no viewer", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      window.__avl.persistSurvey();
      var originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value){
        if(key === "avl_survey_v1") throw new DOMException("Quota exceeded","QuotaExceededError");
        return originalSetItem.call(this,key,value);
      };
      var toastMutations = 0;
      var observer = new MutationObserver(function(records){
        toastMutations += records.length;
      });
      observer.observe(document.getElementById("toast"),{childList:true});

      await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"one"},{name:"two"},{name:"three"},{name:"four"}],
        function(file,done){
          var byte = file.name === "one" ? "EQ==" :
            (file.name === "two" ? "Eg==" : (file.name === "three" ? "Ew==" : "FA=="));
          done("data:image/jpeg;base64," + byte,{width:10,height:10});
        }
      );
      await new Promise(function(resolve){ setTimeout(resolve,0); });
      observer.disconnect();

      var notice = document.querySelector('[data-photo-recovery="1|notes"]');
      return {
        memory:window.__avl.S().photos["1|notes"].length,
        durable:(JSON.parse(window.__avl.raw()).data.photos["1|notes"] || []).length,
        noticeCount:document.querySelectorAll('[data-photo-recovery="1|notes"]').length,
        noticeText:notice && notice.textContent,
        saveActions:notice ? notice.querySelectorAll("[data-recoverph]").length : 0,
        dismissActions:notice ? notice.querySelectorAll("[data-dismiss]").length : 0,
        recoveries:window.__avl.photoCaptureRecoveries(),
        viewer:!!document.querySelector(".phviewer"),
        toast:document.getElementById("toast").textContent,
        toastMutations:toastMutations
      };
    });

    assert.equal(result.memory,4);
    assert.equal(result.durable,0);
    assert.equal(result.noticeCount,1);
    assert.match(result.noticeText,/4 photos are available now but could not be added to the survey/i);
    assert.match(result.noticeText,/Save them before leaving this page/i);
    assert.equal(result.saveActions,4);
    assert.equal(result.dismissActions,0);
    assert.deepEqual(result.recoveries,[
      {key:"1|notes",index:0},
      {key:"1|notes",index:1},
      {key:"1|notes",index:2},
      {key:"1|notes",index:3}
    ]);
    assert.equal(result.viewer,false);
    assert.equal(result.toast,"Could not add those photos.");
    assert.equal(result.toastMutations,1);
  });
});
