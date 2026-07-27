import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchBrowser,
  serve,
  surveyStateSnapshot,
  until
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var execFile = promisify(execFileCallback);
var A_BYTES = [1,2,3,4,250,251];
var B_BYTES = [9,8,7,6,5];
var A_DATA = "data:image/jpeg;base64," + Buffer.from(A_BYTES).toString("base64");
var B_DATA = "data:image/png;base64," + Buffer.from(B_BYTES).toString("base64");

function descriptor(id,mime,bytes,width,height){
  return {id:id,mime:mime,bytes:bytes,width:width,height:height};
}
function stateWithPhotos(entries,open){
  return {
    visit:{client:"Descriptor client",site:"Descriptor site",date:"2026-07-27"},
    log:{},
    rooms:[{id:1,d:{name:"Descriptor room"}}],
    photos:{"1|notes":entries},
    skipped:{},
    ui:open ? {"1|notes":true} : {}
  };
}
async function withApp(run){
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
    await page.waitForFunction(function(){
      return !!window.__avl && !!window.AVLPhotoStore;
    });
    await run(page,context);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}
async function addRecord(page,id,mime,bytes,width,height){
  await page.evaluate(async function(input){
    await window.AVLPhotoStore.addRecord({
      id:input.id,
      mime:input.mime,
      blob:new Blob([new Uint8Array(input.bytes)],{type:input.mime}),
      width:input.width,
      height:input.height,
      bytes:input.bytes.length,
      createdAt:"2026-07-27T00:00:00.000Z"
    });
  },{id:id,mime:mime,bytes:bytes,width:width,height:height});
}

test("schema-2 state accepts the photo union and snapshots sixty descriptors by reference", async function(){
  await withApp(async function(page){
    var result = await page.evaluate(async function(){
      var entries = [];
      var ids = [];
      for(var i=0;i<60;i++){
        var id = "fixture-" + i;
        ids.push(id);
        entries.push({id:id,mime:"image/jpeg",bytes:1000+i,width:900,height:675});
      }
      window.AVLPhotoStore.keys = function(){ return Promise.resolve(ids); };
      await window.__avl.setDescriptorStateForTest({
        visit:{client:"Sixty"},
        log:{},
        rooms:[{id:1,d:{name:"Room"}}],
        photos:{"1|notes":entries},
        skipped:{},
        ui:{}
      });
      var valid = window.__avl.validate(window.__avl.S());
      var malformed = JSON.parse(JSON.stringify(window.__avl.S()));
      malformed.photos["1|notes"][0].bytes = "1000";
      var duplicated = JSON.parse(JSON.stringify(window.__avl.S()));
      duplicated.photos["1|notes"][1].id = duplicated.photos["1|notes"][0].id;
      var snap = window.__avl.snapshot();
      var backup = JSON.parse(window.__avl.backupRaw());
      window.__avl.S().visit.client = "Changed after snapshot";
      var restored = window.__avl.restoreBackup();
      return {
        valid:valid,
        malformed:window.__avl.validate(malformed),
        duplicated:window.__avl.validate(duplicated),
        snap:snap,
        schema:backup.schema,
        count:backup.data.photos["1|notes"].length,
        first:backup.data.photos["1|notes"][0],
        rawLength:JSON.stringify(backup).length,
        restored:restored,
        restoredClient:window.__avl.S().visit.client,
        restoredCount:window.__avl.S().photos["1|notes"].length
      };
    });
    assert.deepEqual(result.valid,{ok:true});
    assert.equal(result.malformed.ok,false);
    assert.equal(result.duplicated.ok,false);
    assert.equal(result.snap,true);
    assert.equal(result.schema,2);
    assert.equal(result.count,60);
    assert.deepEqual(result.first,descriptor("fixture-0","image/jpeg",1000,900,675));
    assert.ok(result.rawLength < 20000,"a descriptor backup must not duplicate photo payloads");
    assert.equal(result.restored,true);
    assert.equal(result.restoredClient,"Sixty");
    assert.equal(result.restoredCount,60);
  });
});

test("concurrent thumbnail, viewer and package reads share one IndexedDB request", async function(){
  await withApp(async function(page){
    var first = descriptor("stored-a","image/jpeg",A_BYTES.length,900,675);
    var started = await page.evaluate(async function(input){
      window.__storedReadCalls = 0;
      window.__storedRead = {};
      window.AVLPhotoStore.keys = function(){ return Promise.resolve([input.entry.id]); };
      window.AVLPhotoStore.get = function(){
        window.__storedReadCalls++;
        return new Promise(function(resolve){ window.__storedRead.resolve = resolve; });
      };
      await window.__avl.setDescriptorStateForTest(input.state);
      window.__avl.openPhotoViewer("1|notes",0);
      window.__packageRead = window.__avl.readPhotoSource(window.__avl.photoManifest()[0]);
      return window.__storedReadCalls;
    },{entry:first,state:stateWithPhotos([first],true)});
    assert.equal(started,1);

    await page.evaluate(function(input){
      window.__storedRead.resolve({
        id:"stored-a",
        mime:"image/jpeg",
        blob:new Blob([new Uint8Array(input)],{type:"image/jpeg"}),
        width:900,
        height:675,
        bytes:input.length,
        createdAt:"2026-07-27T00:00:00.000Z"
      });
    },A_BYTES);
    await until(async function(){
      return page.evaluate(function(){
        return /^blob:/.test((document.querySelector(".phvimage") || {}).src || "");
      });
    });
    var result = await page.evaluate(async function(){
      var source = await window.__packageRead;
      var viewer = await fetch(document.querySelector(".phvimage").src);
      var thumb = document.querySelector('img[data-photo-asset="id:stored-a"]');
      return {
        calls:window.__storedReadCalls,
        packageBytes:Array.from(source.bytes),
        viewerBytes:Array.from(new Uint8Array(await viewer.arrayBuffer())),
        thumbReady:!!thumb && /^blob:/.test(thumb.src)
      };
    });
    assert.equal(result.calls,1);
    assert.deepEqual(result.packageBytes,A_BYTES);
    assert.deepEqual(result.viewerBytes,A_BYTES);
    assert.equal(result.thumbReady,true);
  });
});

test("late stored reads cannot paint a replaced thumbnail or viewer photo", async function(){
  await withApp(async function(page){
    var a = descriptor("late-a","image/jpeg",A_BYTES.length,900,675);
    var b = descriptor("current-b","image/png",B_BYTES.length,640,480);
    await page.evaluate(async function(input){
      window.__reads = {};
      window.AVLPhotoStore.keys = function(){ return Promise.resolve(["late-a","current-b"]); };
      window.AVLPhotoStore.get = function(id){
        return new Promise(function(resolve){ window.__reads[id] = resolve; });
      };
      await window.__avl.setDescriptorStateForTest(input.aState);
      window.__lateHydration = window.__avl.hydratePhotoSource("1|notes",0);
      window.__avl.openPhotoViewer("1|notes",0);
      window.__avl.S().photos["1|notes"][0] = input.b;
      var staleThumb = document.querySelector('img[data-photo-index="0"]');
      window.__avl.fillPhotoThumbnail(staleThumb,{
        url:input.aData,
        token:"1|notes|0",
        assetKey:"id:late-a",
        identity:"late-a"
      });
      window.__staleThumbPainted = /^data:/.test(staleThumb.src || "");
      window.__avl.openPhotoViewer("1|notes",0);
    },{aState:stateWithPhotos([a],true),b:b,aData:A_DATA});

    await page.evaluate(function(input){
      window.__reads["current-b"]({
        id:"current-b",mime:"image/png",
        blob:new Blob([new Uint8Array(input)],{type:"image/png"}),
        width:640,height:480,bytes:input.length,createdAt:""
      });
    },B_BYTES);
    await until(async function(){
      return page.evaluate(function(){
        return /^blob:/.test((document.querySelector(".phvimage") || {}).src || "");
      });
    });
    await page.evaluate(function(input){
      window.__reads["late-a"]({
        id:"late-a",mime:"image/jpeg",
        blob:new Blob([new Uint8Array(input)],{type:"image/jpeg"}),
        width:900,height:675,bytes:input.length,createdAt:""
      });
    },A_BYTES);
    var result = await page.evaluate(async function(){
      await new Promise(function(resolve){ setTimeout(resolve,20); });
      var lateOutcome = await window.__lateHydration.then(
        function(){ return "resolved"; },
        function(error){ return error && error.message; }
      );
      var response = await fetch(document.querySelector(".phvimage").src);
      var currentThumb = document.querySelector('img[data-photo-index="0"]');
      return {
        bytes:Array.from(new Uint8Array(await response.arrayBuffer())),
        asset:currentThumb && currentThumb.getAttribute("data-photo-asset"),
        thumbPainted:currentThumb && /^blob:/.test(currentThumb.src || ""),
        directStalePainted:window.__staleThumbPainted,
        lateOutcome:lateOutcome
      };
    });
    assert.deepEqual(result.bytes,B_BYTES);
    assert.equal(result.asset,"id:late-a","the old DOM node keeps its old asset identity until render");
    assert.equal(result.thumbPainted,false,"the late read must not paint the stale thumbnail");
    assert.equal(result.directStalePainted,false,"fillPhotoThumbnail must re-check the live asset identity");
    assert.match(result.lateOutcome,/changed while loading/);
  });
});

test("missing records are explicit and block viewer actions, package preparation and export", async function(){
  await withApp(async function(page){
    var missing = [
      descriptor("missing-a","image/jpeg",4,900,675),
      descriptor("missing-b","image/jpeg",5,900,675)
    ];
    var before = await page.evaluate(async function(state){
      window.AVLPhotoStore.keys = function(){ return Promise.resolve([]); };
      await window.__avl.setDescriptorStateForTest(state);
      return JSON.stringify(window.__avl.S());
    },stateWithPhotos(missing,true));

    await until(async function(){
      return page.locator(".ph.missing").count().then(function(count){ return count === 2; });
    });
    await page.locator("[data-viewph]").first().click();
    await until(async function(){
      return page.locator(".phvstatus").textContent().then(function(text){
        return /not in device storage/.test(text);
      });
    });
    assert.equal(await page.locator("[data-phv-save]").isDisabled(),true);
    assert.equal(await page.locator("[data-phv-download]").isDisabled(),true);
    await page.locator("[data-phv-close]").click();

    var result = await page.evaluate(async function(){
      var packageStarted = window.__avl.preparePhotoPackage();
      var portable = await window.__avl.portableEnvelope().then(
        function(){ return "resolved"; },
        function(error){ return error && error.code; }
      );
      return {
        packageStarted:packageStarted,
        packageStatus:window.__avl.photoPackageStatus(),
        portable:portable,
        storage:window.__avl.storageHTML(),
        state:JSON.stringify(window.__avl.S())
      };
    });
    assert.equal(result.packageStarted,false);
    assert.equal(result.packageStatus.status,"error");
    assert.equal(
      result.packageStatus.message,
      "2 photos are missing from device storage. The package cannot be prepared."
    );
    assert.equal(result.portable,"PHOTO_MISSING");
    assert.match(result.storage,/2 photos missing from device storage/);
    assert.equal(result.state,before);
  });
});

/* Every other missing-record test opens the section and waits for the
   thumbnails, which populates the missing set through the lazy read. That hides
   whether the keys-only sweep does anything. With the section closed nothing
   hydrates, so only the sweep can know -- and without it the panel affirmatively
   claims the photos are in device storage. */
test("the integrity sweep reports missing records before anything hydrates", async function(){
  await withApp(async function(page){
    var reported = await page.evaluate(async function(state){
      window.AVLPhotoStore.keys = function(){ return Promise.resolve([]); };
      await window.__avl.setDescriptorStateForTest(state);
      await window.__avl.refreshPhotoIntegrity();
      return {
        storage:window.__avl.storageHTML().replace(/<[^>]+>/g," ").replace(/\s+/g," "),
        hydrated:document.querySelectorAll("img[src^='blob:']").length,
        missingTiles:document.querySelectorAll(".ph.missing").length
      };
    }, stateWithPhotos([
      descriptor("unhydrated-a","image/jpeg",6,900,675),
      descriptor("unhydrated-b","image/jpeg",5,900,675)
    ], false));

    assert.equal(reported.hydrated,0,"the closed section must not have hydrated");
    assert.equal(reported.missingTiles,0,"no thumbnail was rendered to mark missing");
    assert.match(reported.storage,/2 photos missing from device storage/);
    assert.doesNotMatch(
      reported.storage,
      /[1-9]\d* photos? in device storage/,
      "records that do not exist must never be counted as present"
    );
  });
});

/* No IndexedDB record is deleted anywhere in B2a. That guarantee is what makes
   "restore the backup" mean "restore the photos" after a deletion, and it is
   the reason no reclamation ships in this release. */
test("deleting a photo strands no backup: records survive and restore byte-exactly", async function(){
  await withApp(async function(page){
    await addRecord(page,"kept-a","image/jpeg",A_BYTES,900,675);
    await addRecord(page,"kept-b","image/png",B_BYTES,640,480);

    await page.evaluate(async function(state){
      await window.__avl.setDescriptorStateForTest(state);
      window.__avl.snapshot();
    }, stateWithPhotos([
      descriptor("kept-a","image/jpeg",A_BYTES.length,900,675),
      descriptor("kept-b","image/png",B_BYTES.length,640,480)
    ], true));

    /* delete the first photo through the production two-tap control */
    await page.locator('[data-delph="0"]').click();
    await page.locator('[data-delph="0"]').click();
    await until(async function(){
      return page.evaluate(function(){
        return window.__avl.S().photos["1|notes"].length === 1;
      });
    });

    var afterDelete = await page.evaluate(function(){
      return window.AVLPhotoStore.keys().then(function(ids){ return ids.slice().sort(); });
    });
    assert.deepEqual(afterDelete,["kept-a","kept-b"],
      "deleting a photo must remove only the active reference");

    var restored = await page.evaluate(async function(){
      window.__avl.restoreBackup();
      await window.__avl.refreshPhotoIntegrity();
      var state = window.__avl.S().photos["1|notes"];
      var loaded = await window.__avl.hydratePhotoSource("1|notes",0);
      var buffer = await loaded.blob.arrayBuffer();
      return {
        count:state.length,
        ids:state.map(function(entry){ return entry.id; }),
        firstBytes:Array.prototype.slice.call(new Uint8Array(buffer)),
        storage:window.__avl.storageHTML().replace(/<[^>]+>/g," ").replace(/\s+/g," ")
      };
    });
    assert.equal(restored.count,2,"the backup must restore both photos");
    assert.deepEqual(restored.ids,["kept-a","kept-b"]);
    assert.deepEqual(restored.firstBytes,A_BYTES,
      "restore must return the exact photo bytes, not just the text state");
    assert.doesNotMatch(restored.storage,/missing from device storage/);
  });
});

test("a descriptor-backed package extracts with exact bytes and a portable inline survey", async function(){
  await withApp(async function(page){
    await addRecord(page,"package-a","image/jpeg",A_BYTES,900,675);
    await addRecord(page,"package-b","image/png",B_BYTES,640,480);
    var entries = [
      descriptor("package-a","image/jpeg",A_BYTES.length,900,675),
      descriptor("package-b","image/png",B_BYTES.length,640,480)
    ];
    var before;
    await page.evaluate(async function(state){
      await window.__avl.setDescriptorStateForTest(state);
    },stateWithPhotos(entries,false));
    before = await surveyStateSnapshot(page);
    await page.evaluate(function(){ window.__avl.preparePhotoPackage(); });
    await until(async function(){
      return page.evaluate(function(){
        return window.__avl.photoPackageStatus().status === "ready";
      });
    });
    var result = await page.evaluate(async function(){
      return {
        manifest:window.__avl.photoManifest(),
        archive:Array.from(new Uint8Array(await window.__avl.photoPackageFile().arrayBuffer()))
      };
    });
    assert.equal(await surveyStateSnapshot(page),before);
    var scratch = await mkdtemp(join(tmpdir(),"avl-descriptor-package-"));
    try {
      var archivePath = join(scratch,"package.zip");
      var extracted = join(scratch,"out");
      await writeFile(archivePath,Buffer.from(result.archive));
      await execFile("/usr/bin/unzip",["-qq",archivePath,"-d",extracted]);
      assert.deepEqual(
        Array.from(await readFile(join(extracted,"photos",result.manifest[0].filename))),
        A_BYTES
      );
      assert.deepEqual(
        Array.from(await readFile(join(extracted,"photos",result.manifest[1].filename))),
        B_BYTES
      );
      var portable = JSON.parse(await readFile(join(extracted,"survey-export.json"),"utf8"));
      assert.equal(portable.schema,3);
      assert.equal(portable.photoFormat,"inline");
      assert.deepEqual(
        portable.data.photos["1|notes"].map(function(entry){
          return Array.from(Buffer.from(entry.data.split(",")[1],"base64"));
        }),
        [A_BYTES,B_BYTES]
      );
    } finally {
      await rm(scratch,{recursive:true,force:true});
    }
  });
});

test("portable v3 export is byte-exact, carries no IDs and imports with fresh IDs only in the test lane", async function(){
  await withApp(async function(page){
    await addRecord(page,"original-a","image/jpeg",A_BYTES,900,675);
    var current = descriptor("original-a","image/jpeg",A_BYTES.length,900,675);
    var exported = await page.evaluate(async function(state){
      await window.__avl.setDescriptorStateForTest(state);
      var portable = await window.__avl.portableEnvelope();
      var buttonExport = await window.__avl.exportJSON();
      return {
        portable:portable,
        buttonSchema:buttonExport && buttonExport.schema,
        buttonFormat:buttonExport && buttonExport.photoFormat
      };
    },stateWithPhotos([current,B_DATA],false));
    var portable = exported.portable;

    assert.equal(portable.schema,3);
    assert.equal(portable.photoFormat,"inline");
    assert.equal(exported.buttonSchema,3);
    assert.equal(exported.buttonFormat,"inline");
    assert.deepEqual(
      portable.data.photos["1|notes"].map(function(entry){
        return Array.from(Buffer.from(entry.data.split(",")[1],"base64"));
      }),
      [A_BYTES,B_BYTES]
    );
    portable.data.photos["1|notes"].forEach(function(entry){
      assert.equal("id" in entry,false);
    });
    portable.data.photos["1|notes"][0].id = "incoming-id-must-not-be-trusted";

    var imported = await page.evaluate(async function(payload){
      var ok = await window.__avl.applyPortableDescriptorImportForTest(JSON.stringify(payload));
      var entries = window.__avl.S().photos["1|notes"];
      var reads = [];
      for(var i=0;i<entries.length;i++){
        var source = await window.__avl.hydratePhotoSource("1|notes",i);
        reads.push(Array.from(new Uint8Array(await source.blob.arrayBuffer())));
      }
      return {ok:ok,entries:entries,reads:reads};
    },portable);
    assert.equal(imported.ok,true);
    imported.entries.forEach(function(entry){
      assert.equal(typeof entry.id,"string");
      assert.notEqual(entry.id,"incoming-id-must-not-be-trusted");
    });
    assert.equal(new Set(imported.entries.map(function(entry){ return entry.id; })).size,2);
    assert.deepEqual(imported.reads,[A_BYTES,B_BYTES]);

    var liveInline = await page.evaluate(async function(payload){
      var ok = await window.__avl.applyImport(JSON.stringify(payload));
      return {ok:ok,entries:window.__avl.S().photos["1|notes"]};
    },portable);
    assert.equal(liveInline.ok,true);
    liveInline.entries.forEach(function(entry){ assert.equal(typeof entry,"string"); });
  });
});

test("bare schema-3 descriptors are rejected whole with the portable-export instruction", async function(){
  await withApp(async function(page){
    var before = await surveyStateSnapshot(page);
    var result = await page.evaluate(function(){
      var ok = window.__avl.applyImport(JSON.stringify({
        app:"avl-survey",
        schema:3,
        data:{
          visit:{},log:{},rooms:[],
          photos:{"log|main":[{id:"device-only",mime:"image/jpeg",bytes:4,width:2,height:2}]},
          skipped:{},ui:{}
        }
      }));
      return {ok:ok,toast:document.getElementById("toast").textContent};
    });
    assert.equal(result.ok,false);
    assert.equal(
      result.toast,
      "Not imported: This file lists photos that are stored on the device it came from. Export again from that device."
    );
    assert.equal(await surveyStateSnapshot(page),before);

    var idOnly = await page.evaluate(async function(){
      var ok = await window.__avl.applyImport(JSON.stringify({
        app:"avl-survey",
        schema:3,
        photoFormat:"inline",
        data:{
          visit:{},log:{},rooms:[],
          photos:{"log|main":[{id:"still-device-only",mime:"image/jpeg",bytes:4,width:2,height:2}]},
          skipped:{},ui:{}
        }
      }));
      return {ok:ok,toast:document.getElementById("toast").textContent};
    });
    assert.equal(idOnly.ok,false);
    assert.equal(idOnly.toast,"Not imported: Portable photo data is malformed");
    assert.equal(await surveyStateSnapshot(page),before);

    var disguisedV2 = await page.evaluate(function(){
      var ok = window.__avl.applyImport(JSON.stringify({
        app:"avl-survey",
        schema:2,
        data:{
          visit:{},log:{},rooms:[],
          photos:{"log|main":[{id:"device-only-v2",mime:"image/jpeg",bytes:4,width:2,height:2}]},
          skipped:{},ui:{}
        }
      }));
      return {ok:ok,toast:document.getElementById("toast").textContent};
    });
    assert.equal(disguisedV2.ok,false);
    assert.equal(
      disguisedV2.toast,
      "Not imported: This file lists photos that are stored on the device it came from. Export again from that device."
    );
    assert.equal(await surveyStateSnapshot(page),before);
  });
});
