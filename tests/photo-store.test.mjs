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
  await page.locator('[data-photos="1|notes"] [data-addph]').click();
  var chooser = await chooserPromise;
  await chooser.setFiles({
    name:name,
    mimeType:"image/svg+xml",
    buffer:Buffer.from(svg)
  });
  await page.waitForSelector(".phviewer");
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
      return {
        rejection:rejection,
        count:records.length,
        id:records[0] && records[0].id,
        bytes:records[0] && Array.from(new Uint8Array(await records[0].blob.arrayBuffer()))
      };
    });

    assert.ok(result.rejection, "adding an existing ID must reject");
    assert.equal(result.rejection.name, "ConstraintError");
    assert.equal(result.count, 1);
    assert.equal(typeof result.id, "string");
    assert.deepEqual(result.bytes, [0,1,2,3,4]);
  });
});

test("new captures dual-write exact blobs with stable IDs while schema-v2 reads stay local", async function(){
  await withPhotoStoreApp({}, async function(page){
    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Dual write"},
        log:{},
        rooms:[{id:1,d:{name:"Store guard"}}],
        photos:{},
        skipped:{},
        ui:{"1|notes":true}
      }));
    });
    assert.equal(imported, true);

    await capture(page, "portrait.svg", 40, 60, "purple");
    await page.locator("[data-phv-close]").click();
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

      var statePhotos = window.__avl.S().photos["1|notes"].slice();
      var durable = JSON.parse(window.__avl.raw());
      var readCalls = 0;
      window.AVLPhotoStore.get = function(){
        readCalls++;
        return Promise.reject(new Error("PR A must not read IndexedDB"));
      };
      window.AVLPhotoStore.all = function(){
        readCalls++;
        return Promise.reject(new Error("PR A must not read IndexedDB"));
      };
      window.__avl.openPhotoViewer("1|notes", 0);

      return {
        schema:window.__avl.SCHEMA,
        statePhotos:statePhotos,
        durablePhotos:durable.data.photos["1|notes"],
        records:serial,
        viewerSource:document.querySelector(".phvimage").src,
        readCalls:readCalls,
        storeStatus:window.__avl.photoStoreStatus()
      };
    });

    assert.equal(result.schema, 2, "PR A must not bump the survey schema");
    assert.equal(result.statePhotos.length, 2);
    assert.deepEqual(result.durablePhotos, result.statePhotos, "localStorage must retain both full data URLs");
    result.statePhotos.forEach(function(photo){
      assert.match(photo, /^data:image\/jpeg;base64,/);
    });

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
      var matchingIndex = record.width === 40 ? 0 : 1;
      assert.deepEqual(record.payload, dataUrlBytes(result.statePhotos[matchingIndex]));
    });
    assert.equal(result.viewerSource, result.statePhotos[0]);
    assert.equal(result.readCalls, 0, "viewer and sharing paths must remain on localStorage in PR A");
    assert.deepEqual(result.storeStatus, {pending:0,lastError:""});
  });
});

test("an IndexedDB failure cannot prevent the schema-v2 survey copy from saving", async function(){
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

    var result = await page.evaluate(function(){
      var durable = JSON.parse(window.__avl.raw());
      return {
        memory:window.__avl.S().photos["1|notes"].slice(),
        durable:durable.data.photos["1|notes"].slice(),
        schema:durable.schema,
        viewerSource:document.querySelector(".phvimage").src,
        status:window.__avl.photoStoreStatus(),
        toast:document.getElementById("toast").textContent
      };
    });

    assert.equal(result.schema, 2);
    assert.equal(result.memory.length, 1);
    assert.deepEqual(result.durable, result.memory);
    assert.equal(result.viewerSource, result.memory[0]);
    assert.match(result.status.lastError, /Injected IndexedDB failure/);
    assert.equal(result.status.pending, 0);
    assert.match(result.toast, /Additional photo storage unavailable/i);
  });
});
