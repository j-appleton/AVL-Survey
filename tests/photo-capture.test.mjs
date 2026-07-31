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

      var memory = JSON.parse(JSON.stringify(window.__avl.S().photos["1|notes"]));
      var records = await window.AVLPhotoStore.all();
      var recordBytes = {};
      for(var i=0;i<records.length;i++){
        recordBytes[records[i].id] =
          Array.from(new Uint8Array(await records[i].blob.arrayBuffer()));
      }
      return {
        started:started,
        memory:memory,
        durable:JSON.parse(window.__avl.raw()).data.photos["1|notes"],
        storedBytes:memory.map(function(entry){ return recordBytes[entry.id]; }),
        rootMutations:rootMutations,
        toastMutations:toastMutations,
        toast:document.getElementById("toast").textContent,
        viewer:!!document.querySelector(".phviewer"),
        thumbnails:document.querySelectorAll('[data-photos="1|notes"] [data-viewph]').length,
        schema:window.__avl.SCHEMA
      };
    });

    assert.deepEqual(result.started,["first","second","third","fourth"]);
    assert.equal(result.memory.length,4);
    result.memory.forEach(function(entry){
      assert.deepEqual(Object.keys(entry).sort(),["bytes","height","id","mime","width"]);
      assert.equal(entry.mime,"image/jpeg");
      assert.equal(entry.bytes,1);
      assert.equal(entry.width,10);
      assert.equal(entry.height,10);
    });
    assert.equal(new Set(result.memory.map(function(entry){ return entry.id; })).size,4);
    assert.deepEqual(result.storedBytes,[[1],[2],[3],[4]]);
    assert.deepEqual(result.durable,result.memory);
    assert.equal(result.rootMutations,1,"the survey must render once at batch completion");
    assert.equal(result.toastMutations,1,"one capture batch must produce one summary toast");
    assert.equal(result.toast,"4 photos added.");
    assert.equal(result.viewer,false);
    assert.equal(result.thumbnails,0,"capture must not put photo controls back in the Survey view");
    assert.equal(result.schema,3);
  });
});

/* Selection order is only useful if it reaches the artefacts a client sees.
   The manifest is what names files in the ZIP and numbers photos in the PDF,
   and it derives from array position -- so this holds today by construction.
   Construction is exactly what a later refactor changes. */
test("selection order reaches photoManifest, not just the survey array", async function(){
  await withCaptureApp(async function(page){
    var manifest = await page.evaluate(async function(){
      var sources = {
        first:"data:image/jpeg;base64,AQ==",
        second:"data:image/jpeg;base64,AgM=",
        third:"data:image/jpeg;base64,BAUG"
      };
      /* the first file compresses slowest, so completion order is reversed */
      var delays = {first:40,second:15,third:1};
      await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"first"},{name:"second"},{name:"third"}],
        function(file,done){
          setTimeout(function(){ done(sources[file.name],{width:10,height:10}); },delays[file.name]);
        }
      );
      return window.__avl.photoManifest().map(function(entry){
        return {ref:entry.ref, filename:entry.filename, bytes:entry.bytes};
      });
    });
    assert.deepEqual(manifest.map(function(e){ return e.ref; }),["001","002","003"]);
    assert.deepEqual(
      manifest.map(function(e){ return e.filename; }),
      ["001_R01_notes.jpg","002_R01_notes.jpg","003_R01_notes.jpg"]
    );
    /* one byte, two bytes, three bytes -- proves which source landed where */
    assert.deepEqual(manifest.map(function(e){ return e.bytes; }),[1,2,3]);
  });
});

/* The notice is derived from state on every render, which is what makes it
   outlive a wholesale innerHTML rebuild. Nothing proved that it does. */
test("the recovery notice is rebuilt by later renders and cannot be dismissed", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      window.__avl.setRaw("not-json-so-persist-cannot-succeed");
      window.AVLPhotoStore.addDataUrl = function(){
        return Promise.reject(new Error("force inline recovery"));
      };
      var realSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(){ throw new Error("quota"); };
      try {
        await window.__avl.processPhotoBatchForTest(
          "1|notes",
          [{name:"a"},{name:"b"}],
          function(file,done){ done("data:image/jpeg;base64,AQ==",{width:10,height:10}); }
        );
      } finally {
        Storage.prototype.setItem = realSet;
      }
      window.__avl.switchAppView("photos");
      var first = document.querySelectorAll("[data-photo-recovery]").length;
      var firstActions = document.querySelectorAll("[data-recoverph]").length;

      /* remove it the way an impatient tap or a stray script would */
      Array.prototype.forEach.call(
        document.querySelectorAll("[data-photo-recovery]"),
        function(node){ if(node.parentNode) node.parentNode.removeChild(node); }
      );
      var afterRemoval = document.querySelectorAll("[data-photo-recovery]").length;

      /* any unrelated render must bring it back in the Photos view */
      window.__avl.switchAppView("survey");
      document.querySelector('[data-skip="1|dims"]').click();
      window.__avl.switchAppView("photos");
      return {
        first:first,
        firstActions:firstActions,
        afterRemoval:afterRemoval,
        afterRender:document.querySelectorAll("[data-photo-recovery]").length,
        afterRenderActions:document.querySelectorAll("[data-recoverph]").length
      };
    });
    assert.equal(result.first,1,"one notice for the batch");
    assert.equal(result.firstActions,2,"one Save action per in-memory photo");
    assert.equal(result.afterRemoval,0,"precondition: the node was removed");
    assert.equal(result.afterRender,1,"a later render must rebuild it");
    assert.equal(result.afterRenderActions,2,"and rebuild every Save action");
  });
});

/* Recovery entries are coordinates into a live array. Deleting an earlier photo
   shifts every later index, and a stale coordinate would offer to save the
   wrong image -- or an image the surveyor already has safely. */
test("recovery coordinates follow deletions and never attach to another photo", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      window.AVLPhotoStore.addDataUrl = function(){
        return Promise.reject(new Error("force inline recovery"));
      };
      var realSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(){ throw new Error("quota"); };
      try {
        await window.__avl.processPhotoBatchForTest(
          "1|notes",
          [{name:"a"},{name:"b"},{name:"c"}],
          function(file,done){
            var map = {
              a:"data:image/jpeg;base64,AQ==",
              b:"data:image/jpeg;base64,Ag==",
              c:"data:image/jpeg;base64,Aw=="
            };
            done(map[file.name],{width:10,height:10});
          }
        );
      } finally {
        Storage.prototype.setItem = realSet;
      }
      window.__avl.switchAppView("photos");
      function labels(){
        return Array.prototype.map.call(
          document.querySelectorAll("[data-recoverph]"),
          function(node){ return node.getAttribute("data-photo-index"); }
        );
      }
      var before = labels();
      /* delete the first photo through the production two-tap control */
      var del = document.querySelector('[data-delph="0"]');
      del.click(); del.click();
      var after = labels();
      return {
        before:before,
        after:after,
        remaining:window.__avl.S().photos["1|notes"],
        actions:after.length
      };
    });
    assert.deepEqual(result.before,["0","1","2"]);
    assert.deepEqual(result.remaining,
      ["data:image/jpeg;base64,Ag==","data:image/jpeg;base64,Aw=="]);
    assert.equal(result.actions,2,"the deleted photo drops its Save action");
    assert.deepEqual(result.after,["0","1"],
      "surviving coordinates must follow the shift, not point at the old slots");
  });
});

test("a field save cannot persist a descriptor before storage readback verifies it", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      window.__avl.persistSurvey();
      var realAdd = window.AVLPhotoStore.addDataUrl;
      var pendingRecord = null;
      var releaseRead = null;
      window.AVLPhotoStore.addDataUrl = function(data,width,height){
        return realAdd(data,width,height).then(function(record){
          pendingRecord = record;
          return record;
        });
      };
      window.AVLPhotoStore.get = function(){
        return new Promise(function(resolve){ releaseRead = resolve; });
      };

      var flight = window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"first"}],
        function(file,done){
          done("data:image/jpeg;base64,Cg==",{width:10,height:10});
        }
      );
      while(!releaseRead){
        await new Promise(function(resolve){ setTimeout(resolve,0); });
      }

      var tentative = window.__avl.S().photos["1|notes"][0];
      var field = document.querySelector('[data-scope="visit"][data-k="client"]');
      field.value = "Edit during verification";
      field.dispatchEvent(new Event("input",{bubbles:true}));
      await new Promise(function(resolve){ setTimeout(resolve,350); });
      var during = JSON.parse(window.__avl.raw());

      releaseRead(pendingRecord);
      await flight;
      var after = JSON.parse(window.__avl.raw());
      return {
        tentativeIsDescriptor:window.__avl.isPhotoDescriptor(tentative),
        duringCount:(during.data.photos["1|notes"] || []).length,
        duringClient:during.data.visit.client,
        finalCount:after.data.photos["1|notes"].length,
        finalClient:after.data.visit.client
      };
    });

    assert.equal(result.tentativeIsDescriptor,true,"the test must reach the critical descriptor window");
    assert.equal(result.duringCount,0,
      "a field's pending save must not persist an unverified descriptor");
    assert.notEqual(result.duringClient,"Edit during verification",
      "the suppressed save must still be pending during verification");
    assert.equal(result.finalCount,1);
    assert.equal(result.finalClient,"Edit during verification",
      "the batch-end persistence must include suppressed field edits");
  });
});

test("a hung compressor times out and cannot leave autosave disabled", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      window.__avl.persistSurvey();
      window.__avl.setPhotoCompressTimeoutForTest(40);
      window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"never-finishes"}],
        function(){}
      );
      await new Promise(function(resolve){ setTimeout(resolve,100); });
      var afterTimeout = window.__avl.photoStoreStatus();

      var field = document.querySelector('[data-scope="visit"][data-k="client"]');
      field.value = "Autosave survived";
      field.dispatchEvent(new Event("input",{bubbles:true}));
      await new Promise(function(resolve){ setTimeout(resolve,350); });
      return {
        status:afterTimeout,
        durableClient:JSON.parse(window.__avl.raw()).data.visit.client,
        toast:document.getElementById("toast").textContent
      };
    });

    assert.equal(result.status.pending,0,
      "the timed-out file must leave no permanently pending capture");
    assert.equal(result.durableClient,"Autosave survived",
      "field autosave must resume after the timeout");
    assert.equal(result.toast,"Could not add that photo.");
  });
});

test("a rejected batch cannot poison the shared capture flight", async function(){
  await withCaptureApp(async function(page){
    var result = await page.evaluate(async function(){
      var bar = document.getElementById("bar");
      var parent = bar.parentNode;
      var nextSibling = bar.nextSibling;
      parent.removeChild(bar);
      var firstRejected = false;
      try {
        await window.__avl.processPhotoBatchForTest(
          "1|notes",
          [{name:"first"}],
          function(file,done){
            done("data:image/jpeg;base64,AQ==",{width:10,height:10});
          }
        );
      } catch(error){
        firstRejected = true;
      }
      var idleResolved = true;
      try { await window.__avl.photoCaptureIdle(); }
      catch(error){ idleResolved = false; }
      parent.insertBefore(bar,nextSibling);

      var second = await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"second"}],
        function(file,done){
          done("data:image/jpeg;base64,Ag==",{width:10,height:10});
        }
      );
      await window.__avl.photoCaptureIdle();
      return {
        firstRejected:firstRejected,
        idleResolved:idleResolved,
        second:second,
        count:window.__avl.S().photos["1|notes"].length,
        pending:window.__avl.photoStoreStatus().pending
      };
    });

    assert.equal(result.firstRejected,true,"the test must force the first batch to reject");
    assert.equal(result.idleResolved,true,
      "the shared flight itself must absorb the rejection before another capture starts");
    assert.equal(result.second.added,1,
      "the next batch must run instead of inheriting the previous rejection");
    assert.equal(result.count,2);
    assert.equal(result.pending,0);
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
      window.AVLPhotoStore.addDataUrl = function(){
        return Promise.reject(new Error("force inline recovery"));
      };
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

      window.__avl.switchAppView("photos");
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
    assert.match(result.noticeText,/4 photos could not be added to the survey/i);
    assert.match(result.noticeText,/4 are available only until this page closes/i);
    assert.match(result.noticeText,/Prepare the visit package or save them before leaving this page/i);
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
