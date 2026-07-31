import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function withPhotoStoreApp(options, run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
    var page = await context.newPage();
    if(options && options.init) await page.addInitScript(options.init);
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){
      return !!window.__avl && !!window.AVLPhotoStore;
    });
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function capture(page, name, width, height, color){
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
    '" height="' + height + '"><rect width="' + width + '" height="' + height +
    '" fill="' + color + '"/></svg>';
  var chooserPromise = page.waitForEvent("filechooser");
  await page.evaluate(function(){ window.__avl.switchAppView("photos"); });
  await page.locator('[data-photos="1|notes"] [data-addph]').click();
  var chooser = await chooserPromise;
  await chooser.setFiles({
    name:name,
    mimeType:"image/svg+xml",
    buffer:Buffer.from(svg)
  });
  await page.evaluate(function(){ return window.__avl.photoCaptureIdle(); });
  await page.evaluate(function(){ return window.__avl.photoStoreIdle(); });
}

function dataUrlBytes(dataUrl){
  return Array.from(Buffer.from(String(dataUrl).split(",")[1], "base64"));
}

test("photo IDs use UUIDs with a timestamp-counter fallback and conservative syntax", async function(){
  var source = await readFile(join(ROOT, "photo-store.js"), "utf8");
  var worker = await readFile(join(ROOT, "sw.js"), "utf8");
  assert.doesNotMatch(source, /Math\.random/, "photo IDs must never depend on Math.random()");
  assert.doesNotMatch(source, /=>|\bconst\b|\blet\b|\?\./, "the phone runtime must stay ES5-conservative");
  assert.match(worker, /"\.\/photo-store\.js"/, "the new runtime module must be available offline");

  await withPhotoStoreApp({}, async function(page){
    var ids = await page.evaluate(function(){
      return [window.AVLPhotoStore.createId(), window.AVLPhotoStore.createId()];
    });
    assert.notEqual(ids[0], ids[1]);
    assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(ids[1], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  await withPhotoStoreApp({
    init:function(){
      Date.now = function(){ return 1700000000000; };
      try {
        Object.defineProperty(window.crypto, "randomUUID", {
          configurable:true,
          value:undefined
        });
      } catch(error){}
    }
  }, async function(page){
    var fallback = await page.evaluate(function(){
      return [window.AVLPhotoStore.createId(), window.AVLPhotoStore.createId()];
    });
    assert.deepEqual(fallback, [
      "avl-" + (1700000000000).toString(36) + "-1",
      "avl-" + (1700000000000).toString(36) + "-2"
    ]);
  });
});

test("the photo store rejects duplicate IDs instead of overwriting a record", async function(){
  await withPhotoStoreApp({}, async function(page){
    var result = await page.evaluate(async function(){
      var first = window.AVLPhotoStore.recordFromDataUrl(
        "data:image/jpeg;base64,AAECAwQ=",
        5,
        7
      );
      await window.AVLPhotoStore.addRecord(first);

      var rejection = null;
      try {
        await window.AVLPhotoStore.addRecord(first);
      } catch(error){
        rejection = {
          name:error && error.name,
          message:error && error.message
        };
      }

      var records = await window.AVLPhotoStore.all();
      var keys = await window.AVLPhotoStore.keys();
      return {
        rejection:rejection,
        count:records.length,
        id:records[0] && records[0].id,
        bytes:records[0] && Array.from(new Uint8Array(await records[0].blob.arrayBuffer())),
        keys:keys
      };
    });

    assert.ok(result.rejection, "adding an existing ID must reject");
    assert.equal(result.rejection.name, "ConstraintError");
    assert.equal(result.count, 1);
    assert.equal(typeof result.id, "string");
    assert.deepEqual(result.bytes, [0,1,2,3,4]);
    assert.deepEqual(result.keys,[result.id]);
  });
});

test("a multi-photo store transaction is all-or-nothing", async function(){
  await withPhotoStoreApp({
    init:function(){
      try {
        Object.defineProperty(window.crypto,"randomUUID",{
          configurable:true,
          value:function(){ return "same-id-for-atomic-batch"; }
        });
      } catch(error){}
    }
  }, async function(page){
    var result = await page.evaluate(async function(){
      var rejection = null;
      try {
        await window.AVLPhotoStore.addDataUrls([
          {data:"data:image/jpeg;base64,AQ==",width:1,height:1},
          {data:"data:image/jpeg;base64,Ag==",width:1,height:1}
        ]);
      } catch(error){
        rejection = {name:error && error.name,message:error && error.message};
      }
      return {
        rejection:rejection,
        count:(await window.AVLPhotoStore.all()).length
      };
    });
    assert.ok(result.rejection,"a duplicate inside the batch must reject");
    assert.equal(result.count,0,"the failed transaction must not leave a partial batch");
  });
});

test("new captures persist authoritative descriptors built from exact stored records", async function(){
  await withPhotoStoreApp({}, async function(page){
    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Authoritative capture"},
        log:{},
        rooms:[{id:1,d:{name:"Store guard"}}],
        photos:{},
        skipped:{},
        ui:{"1|notes":true}
      }));
    });
    assert.equal(imported, true);

    await capture(page, "portrait.svg", 40, 60, "purple");
    await capture(page, "landscape.svg", 70, 30, "teal");

    var result = await page.evaluate(async function(){
      var records = await window.AVLPhotoStore.all();
      var serial = [];
      for(var i=0;i<records.length;i++){
        serial.push({
          keys:Object.keys(records[i]).sort(),
          id:records[i].id,
          mime:records[i].mime,
          width:records[i].width,
          height:records[i].height,
          bytes:records[i].bytes,
          blobSize:records[i].blob.size,
          blobType:records[i].blob.type,
          createdAt:records[i].createdAt,
          payload:Array.from(new Uint8Array(await records[i].blob.arrayBuffer()))
        });
      }

      var statePhotos = JSON.parse(JSON.stringify(window.__avl.S().photos["1|notes"]));
      var durable = JSON.parse(window.__avl.raw());
      var readCalls = 0;
      window.AVLPhotoStore.get = function(){
        readCalls++;
        return Promise.reject(new Error("resident capture should not need another IndexedDB read"));
      };
      window.AVLPhotoStore.all = function(){
        readCalls++;
        return Promise.reject(new Error("viewer must not list the store"));
      };
      window.__avl.openPhotoViewer("1|notes", 0);
      await window.__avl.hydratePhotoSource("1|notes",0);
      await new Promise(function(resolve){ setTimeout(resolve,0); });
      var viewerResponse = await fetch(document.querySelector(".phvimage").src);

      return {
        schema:window.__avl.SCHEMA,
        statePhotos:statePhotos,
        durablePhotos:durable.data.photos["1|notes"],
        records:serial,
        viewerSource:document.querySelector(".phvimage").src,
        viewerBytes:Array.from(new Uint8Array(await viewerResponse.arrayBuffer())),
        readCalls:readCalls,
        storeStatus:window.__avl.photoStoreStatus()
      };
    });

    assert.equal(result.schema, 5);
    assert.equal(result.statePhotos.length, 2);
    assert.deepEqual(result.durablePhotos, result.statePhotos,
      "localStorage must persist only the descriptors returned by the photo store");

    assert.equal(result.records.length, 2);
    assert.equal(new Set(result.records.map(function(record){ return record.id; })).size, 2);
    assert.deepEqual(
      result.records.map(function(record){ return [record.width,record.height]; }).sort(),
      [[40,60],[70,30]]
    );
    result.records.forEach(function(record){
      assert.deepEqual(record.keys, ["blob","bytes","createdAt","height","id","mime","width"]);
      assert.equal(record.mime, "image/jpeg");
      assert.equal(record.blobType, "image/jpeg");
      assert.equal(record.bytes, record.blobSize);
      assert.ok(Date.parse(record.createdAt) > 0);
      var descriptor = result.statePhotos.filter(function(entry){
        return entry.id === record.id;
      })[0];
      assert.ok(descriptor,"every stored record must have one survey descriptor");
      assert.deepEqual(descriptor,{
        id:record.id,
        mime:record.mime,
        bytes:record.bytes,
        width:record.width,
        height:record.height
      });
    });
    assert.match(result.viewerSource, /^blob:/);
    var firstRecord = result.records.filter(function(record){
      return record.id === result.statePhotos[0].id;
    })[0];
    assert.deepEqual(result.viewerBytes,firstRecord.payload);
    assert.equal(result.readCalls, 0, "capture verification must leave the current photo resident");
    assert.deepEqual(result.storeStatus, {pending:0,lastError:"",kind:"",orphaned:[]});
  });
});

test("an IndexedDB add failure falls back inline and creates no orphan record", async function(){
  await withPhotoStoreApp({}, async function(page){
    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Failure isolation"},
        log:{},
        rooms:[{id:1,d:{name:"Fallback guard"}}],
        photos:{},
        skipped:{},
        ui:{"1|notes":true}
      }));
    });
    assert.equal(imported, true);

    await page.evaluate(function(){
      window.AVLPhotoStore.addDataUrl = function(){
        return Promise.reject(new Error("Injected IndexedDB failure"));
      };
    });
    await capture(page, "fallback.svg", 32, 48, "orange");

    var result = await page.evaluate(async function(){
      var durable = JSON.parse(window.__avl.raw());
      var records = await window.AVLPhotoStore.all();
      window.__avl.openPhotoViewer("1|notes",0);
      await window.__avl.hydratePhotoSource("1|notes",0);
      await new Promise(function(resolve){ setTimeout(resolve,0); });
      var viewerResponse = await fetch(document.querySelector(".phvimage").src);
      var storageHost = document.createElement("div");
      storageHost.innerHTML = window.__avl.storageHTML();
      var storageWarning = storageHost.querySelector("[data-photo-store-warning]");
      return {
        memory:window.__avl.S().photos["1|notes"].slice(),
        durable:durable.data.photos["1|notes"].slice(),
        records:records.length,
        schema:durable.schema,
        viewerSource:document.querySelector(".phvimage").src,
        viewerBytes:Array.from(new Uint8Array(await viewerResponse.arrayBuffer())),
        status:window.__avl.photoStoreStatus(),
        toast:document.getElementById("toast").textContent,
        storageWarning:storageWarning ? storageWarning.textContent : ""
      };
    });

    assert.equal(result.schema, 5);
    assert.equal(result.memory.length, 1);
    assert.deepEqual(result.durable, result.memory);
    assert.equal(result.records,0,"a rejected add must leave no orphan in device storage");
    assert.match(result.viewerSource, /^blob:/);
    assert.deepEqual(result.viewerBytes, dataUrlBytes(result.memory[0]));
    assert.match(result.status.lastError, /Injected IndexedDB failure/);
    assert.equal(result.status.kind,"add");
    assert.equal(result.status.pending, 0);
    assert.deepEqual(result.status.orphaned,[]);
    assert.equal(
      result.toast,
      "Photo added. 1 is stored in the survey file rather than device storage.",
      "the batch outcome must remain the only capture toast"
    );
    assert.match(result.storageWarning,/Device photo storage failed for part of a capture/i);
    assert.match(result.storageWarning,/Prepare the visit package after the visit/i);
  });
});

test("capture descriptors take MIME, bytes and dimensions from the returned record", async function(){
  await withPhotoStoreApp({}, async function(page){
    await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Record shape"},
        log:{},
        rooms:[{id:1,d:{name:"Record source"}}],
        photos:{},
        skipped:{},
        ui:{"1|notes":true}
      }));
    });

    var result = await page.evaluate(async function(){
      window.AVLPhotoStore.addDataUrl = function(){
        var record = {
          id:"record-is-authority",
          mime:"image/png",
          blob:new Blob([new Uint8Array([9,8,7])],{type:"image/png"}),
          width:777,
          height:333,
          bytes:3,
          createdAt:"2026-07-28T00:00:00.000Z"
        };
        return window.AVLPhotoStore.addRecord(record);
      };
      await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"compressor-metadata"}],
        function(file,done){
          done("data:image/jpeg;base64,AQ==",{width:10,height:20});
        }
      );
      var descriptor = window.__avl.S().photos["1|notes"][0];
      var source = await window.__avl.hydratePhotoSource("1|notes",0);
      return {
        descriptor:descriptor,
        bytes:Array.from(new Uint8Array(await source.blob.arrayBuffer())),
        filename:window.__avl.photoManifest()[0].filename
      };
    });

    assert.deepEqual(result.descriptor,{
      id:"record-is-authority",
      mime:"image/png",
      bytes:3,
      width:777,
      height:333
    });
    assert.deepEqual(result.bytes,[9,8,7]);
    assert.equal(result.filename,"001_R01_notes.png");
  });
});

test("failed readback leaves one orphan, falls back inline and degrades the rest of the batch", async function(){
  await withPhotoStoreApp({}, async function(page){
    await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Verify failure"},
        log:{},
        rooms:[{id:1,d:{name:"Readback guard"}}],
        photos:{},
        skipped:{},
        ui:{"1|notes":true}
      }));
    });

    var result = await page.evaluate(async function(){
      var realAdd = window.AVLPhotoStore.addDataUrl;
      var realGet = window.AVLPhotoStore.get;
      var addCalls = 0;
      window.AVLPhotoStore.addDataUrl = function(data,width,height){
        addCalls++;
        return realAdd(data,width,height);
      };
      window.AVLPhotoStore.get = function(id){
        return realGet(id).then(function(record){
          record.blob = new Blob([new Uint8Array([9,9])],{type:record.mime});
          return record;
        });
      };
      var batch = await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"first"},{name:"second"}],
        function(file,done){
          done(
            file.name === "first"
              ? "data:image/jpeg;base64,AQ=="
              : "data:image/jpeg;base64,Ag==",
            {width:10,height:10}
          );
        }
      );
      var records = await window.AVLPhotoStore.all();
      return {
        batch:batch,
        addCalls:addCalls,
        memory:window.__avl.S().photos["1|notes"].slice(),
        durable:JSON.parse(window.__avl.raw()).data.photos["1|notes"],
        records:records.length,
        recordId:records[0] && records[0].id,
        status:window.__avl.photoStoreStatus(),
        toast:document.getElementById("toast").textContent
      };
    });

    assert.equal(result.addCalls,1,"the batch must stop trusting storage after failed verification");
    assert.equal(result.records,1,"the failed record remains as the one allowed orphan");
    assert.deepEqual(result.status.orphaned,[result.recordId],
      "the orphan ID must remain available for future reclamation");
    assert.deepEqual(result.status.orphaned,await page.evaluate(function(){
      return window.__avl.orphanedPhotoIds();
    }));
    assert.equal(result.batch.orphans,1);
    assert.equal(result.batch.inlineFallbacks,2);
    assert.deepEqual(result.memory,[
      "data:image/jpeg;base64,AQ==",
      "data:image/jpeg;base64,Ag=="
    ]);
    assert.deepEqual(result.durable,result.memory);
    assert.equal(result.status.kind,"verify");
    assert.match(result.toast,/2 photos added/);
    assert.match(result.toast,/2 are stored in the survey file rather than device storage/);
  });
});

test("a blocked photo-store open rejects clearly and boot degrades instead of stalling", async function(){
  await withPhotoStoreApp({
    init:function(){
      localStorage.setItem("avl_survey_v1",JSON.stringify({
        app:"avl-survey",
        schema:3,
        data:{
          visit:{client:"Blocked open"},
          log:{},
          rooms:[{id:1,d:{name:"Stored room"}}],
          photos:{
            "1|notes":[{
              id:"blocked-photo",
              mime:"image/jpeg",
              bytes:3,
              width:10,
              height:10
            }]
          },
          skipped:{},
          ui:{"1|notes":true},
          meta:{created:"2026-07-27T00:00:00.000Z",updated:"2026-07-27T00:00:00.000Z"}
        }
      }));
      Object.defineProperty(window.indexedDB,"open",{
        configurable:true,
        value:function(){
          var request = {};
          window.setTimeout(function(){
            if(request.onblocked) request.onblocked();
          },0);
          return request;
        }
      });
    }
  },async function(page){
    await page.waitForFunction(function(){
      var wrap = document.getElementById("storagewrap");
      return !!window.__avl && !!wrap &&
        /Photo storage could not be checked/.test(wrap.textContent);
    });
    var result = await page.evaluate(async function(){
      var message = "";
      try { await window.AVLPhotoStore.keys(); }
      catch(error){ message = error && error.message; }
      return {
        message:message,
        appReady:!!window.__avl,
        client:window.__avl.S().visit.client,
        storage:document.getElementById("storagewrap").textContent
      };
    });
    assert.equal(result.message,"Photo storage is blocked by another open app or tab");
    assert.equal(result.appReady,true);
    assert.equal(result.client,"Blocked open");
    assert.match(result.storage,/Photo storage could not be checked/);
  });
});

test("a photo-store open that never settles times out and leaves the app usable", async function(){
  await withPhotoStoreApp({
    init:function(){
      localStorage.setItem("avl_survey_v1",JSON.stringify({
        app:"avl-survey",
        schema:3,
        data:{
          visit:{client:"Timed open"},
          log:{},
          rooms:[{id:1,d:{name:"Stored room"}}],
          photos:{
            "1|notes":[{
              id:"timed-photo",
              mime:"image/jpeg",
              bytes:3,
              width:10,
              height:10
            }]
          },
          skipped:{},
          ui:{"1|notes":true},
          meta:{created:"2026-07-27T00:00:00.000Z",updated:"2026-07-27T00:00:00.000Z"}
        }
      }));
      var realSetTimeout = window.setTimeout;
      window.setTimeout = function(fn,delay){
        return realSetTimeout(fn,delay === 5000 ? 25 : delay);
      };
      Object.defineProperty(window.indexedDB,"open",{
        configurable:true,
        value:function(){ return {}; }
      });
    }
  },async function(page){
    await page.waitForFunction(function(){
      var wrap = document.getElementById("storagewrap");
      return !!window.__avl && !!wrap &&
        /Photo storage could not be checked/.test(wrap.textContent);
    });
    var result = await page.evaluate(async function(){
      var message = "";
      try { await window.AVLPhotoStore.keys(); }
      catch(error){ message = error && error.message; }
      return {
        message:message,
        client:window.__avl.S().visit.client,
        addRoomAvailable:!!document.getElementById("addroom")
      };
    });
    assert.equal(result.message,"Opening photo storage timed out");
    assert.equal(result.client,"Timed open");
    assert.equal(result.addRoomAvailable,true);
  });
});
