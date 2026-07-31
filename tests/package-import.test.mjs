import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchBrowser,
  serve,
  surveyStateSnapshot,
  until
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var JPG_BYTES = Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEoooryD9EP//Z",
  "base64"
));
var PNG_BYTES = Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAFElEQVR4nGM0j7/EgA0wYRWlkwQA058BdOXICOYAAAAASUVORK5CYII=",
  "base64"
));
var JPG = "data:image/jpeg;base64," + Buffer.from(JPG_BYTES).toString("base64");
var PNG = "data:image/png;base64," + Buffer.from(PNG_BYTES).toString("base64");

function portableState(){
  return {
    app:"avl-survey",
    schema:3,
    photoFormat:"inline",
    data:{
      visit:{
        client:"Package recovery",
        site:"Main Campus",
        date:"2026-07-30"
      },
      log:{lognote:"Use loading door C."},
      rooms:[{id:1,d:{name:"Ballroom",lux_disp:"210"}}],
      photos:{
        "log|main":[{
          mime:"image/jpeg",width:8,height:6,bytes:JPG_BYTES.length,data:JPG
        }],
        "1|light":[{
          mime:"image/png",width:8,height:6,bytes:PNG_BYTES.length,data:PNG,cover:true
        }]
      },
      skipped:{},
      ui:{},
      meta:{created:"2026-07-30T12:00:00.000Z"}
    }
  };
}

async function withApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl && !!window.AVLPhotoStore; });
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function buildPackage(page){
  var imported = await page.evaluate(async function(payload){
    await window.AVLPhotoStore.clear();
    return window.__avl.applyImport(JSON.stringify(payload));
  },portableState());
  assert.equal(imported,true);
  var source = await page.evaluate(function(){
    var manifest = window.__avl.photoManifest();
    return {
      ids:manifest.map(function(entry){
        return window.__avl.S().photos[entry.key][entry.bucketIndex].id;
      }),
      filenames:manifest.map(function(entry){ return entry.filename; }),
      coverId:window.__avl.S().visit.coverPhotoId
    };
  });
  assert.equal(await page.evaluate(function(){ return window.__avl.preparePhotoPackage(); }),true);
  await until(async function(){
    return page.evaluate(function(){
      return window.__avl.photoPackageStatus().status === "ready";
    });
  });
  var bytes = await page.evaluate(async function(){
    return Array.from(new Uint8Array(
      await window.__avl.photoPackageFile().arrayBuffer()
    ));
  });
  return {bytes:bytes,source:source};
}

async function packageEnvelope(page,bytes){
  return page.evaluate(function(input){
    var archive = window.__avl.zipReadStore(new Uint8Array(input));
    var entry = archive.entries[archive.root + "/data/survey-export.json"];
    return JSON.parse(new TextDecoder().decode(entry.bytes));
  },bytes);
}

test("the complete ZIP restores exact photos with fresh IDs and a filename-mapped cover", async function(){
  await withApp(async function(page){
    var built = await buildPackage(page);
    var envelope = await packageEnvelope(page,built.bytes);
    assert.equal(
      envelope.coverPhoto,
      built.source.filenames[1],
      "the outward cover reference must be the human-stable filename"
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(envelope.data.visit,"coverPhotoId"),
      false,
      "device-local descriptor IDs must not leak into the package"
    );

    await page.evaluate(async function(){
      await window.AVLPhotoStore.clear();
      window.__avl.applyImport(JSON.stringify({
        visit:{client:"Survey that must be backed up"},
        log:{},
        rooms:[{id:7,d:{name:"Existing work"}}],
        photos:{},
        skipped:{},
        ui:{}
      }));
    });
    await page.locator("#jsonin").setInputFiles({
      name:"preplot-package.zip",
      mimeType:"application/zip",
      buffer:Buffer.from(built.bytes)
    });
    await until(async function(){
      return page.evaluate(function(){
        return window.__avl.S().visit.client === "Package recovery";
      });
    });
    var restored = await page.evaluate(async function(){
      var manifest = window.__avl.photoManifest();
      var bytes = [];
      for(var i=0;i<manifest.length;i++){
        var source = await window.__avl.hydratePhotoSource(
          manifest[i].key,manifest[i].bucketIndex
        );
        bytes.push(Array.from(new Uint8Array(await source.blob.arrayBuffer())));
      }
      var entries = manifest.map(function(item){
        return window.__avl.S().photos[item.key][item.bucketIndex];
      });
      return {
        accept:document.getElementById("jsonin").getAttribute("accept"),
        filenames:manifest.map(function(item){ return item.filename; }),
        ids:entries.map(function(item){ return item.id; }),
        coverId:window.__avl.S().visit.coverPhotoId,
        bytes:bytes,
        backupClient:JSON.parse(window.__avl.backupRaw()).data.visit.client
      };
    });
    assert.match(restored.accept,/application\/zip/);
    assert.deepEqual(restored.filenames,built.source.filenames);
    assert.deepEqual(restored.bytes,[JPG_BYTES,PNG_BYTES]);
    assert.equal(new Set(restored.ids).size,2);
    restored.ids.forEach(function(id){
      assert.equal(built.source.ids.includes(id),false,"incoming IDs must never be reused");
    });
    assert.equal(restored.coverId,restored.ids[1]);
    assert.equal(restored.backupClient,"Survey that must be backed up");
  });
});

test("a v1.14 package without coverPhoto imports with no selected cover", async function(){
  await withApp(async function(page){
    var built = await buildPackage(page);
    var legacy = await page.evaluate(async function(input){
      var archive = window.__avl.zipReadStore(new Uint8Array(input));
      var jsonName = archive.root + "/data/survey-export.json";
      var payload = JSON.parse(new TextDecoder().decode(archive.entries[jsonName].bytes));
      delete payload.coverPhoto;
      payload.data.visit.coverPhotoId = "old-device-only-id";
      var entries = archive.names.map(function(name){
        return {
          name:name,
          bytes:name === jsonName
            ? new TextEncoder().encode(JSON.stringify(payload))
            : archive.entries[name].bytes
        };
      });
      return Array.from(new Uint8Array(await window.__avl.zipStore(entries).arrayBuffer()));
    },built.bytes);
    var result = await page.evaluate(async function(input){
      await window.AVLPhotoStore.clear();
      var ok = await window.__avl.applyPackageImport(new Uint8Array(input));
      return {
        ok:ok,
        cover:window.__avl.S().visit.coverPhotoId,
        count:window.__avl.photoManifest().length
      };
    },legacy);
    assert.deepEqual(result,{ok:true,cover:"",count:2});
  });
});

test("ZIP structure guards reject unsafe, duplicate, multi-root and unsupported entries", async function(){
  await withApp(async function(page){
    var results = await page.evaluate(async function(){
      async function make(names){
        var blob = window.__avl.zipStore(names.map(function(name,index){
          return {name:name,bytes:new Uint8Array([index+1])};
        }));
        return new Uint8Array(await blob.arrayBuffer());
      }
      function read(bytes){
        try {
          window.__avl.zipReadStore(bytes);
          return "";
        } catch(error){
          return error.message;
        }
      }
      var duplicate = await make(["root/a.txt","root/a.txt"]);
      var traversal = await make(["root/../a.txt"]);
      var roots = await make(["root/a.txt","other/b.txt"]);
      var unsupported = await make(["root/a.txt"]);
      /* Writer layout: method is local +8 and central +10. */
      unsupported[8] = 8;
      var centralAt = 30 + "root/a.txt".length + 1;
      unsupported[centralAt+10] = 8;
      var mismatch = await make(["root/a.txt"]);
      mismatch[14] ^= 1;
      var corrupt = await make(["root/a.txt"]);
      corrupt[30 + "root/a.txt".length] ^= 1;
      return {
        duplicate:read(duplicate),
        traversal:read(traversal),
        roots:read(roots),
        unsupported:read(unsupported),
        mismatch:read(mismatch),
        corrupt:read(corrupt)
      };
    });
    assert.match(results.duplicate,/duplicate path/i);
    assert.match(results.traversal,/unsafe path/i);
    assert.match(results.roots,/one top-level folder/i);
    assert.match(results.unsupported,/store-only/i);
    assert.match(results.mismatch,/disagrees/i);
    assert.match(results.corrupt,/CRC/i);
  });
});

test("failed package preflight writes no photos and leaves survey and backup untouched", async function(){
  await withApp(async function(page){
    var built = await buildPackage(page);
    var broken = await page.evaluate(async function(input){
      var archive = window.__avl.zipReadStore(new Uint8Array(input));
      var lastPhoto = archive.names.filter(function(name){
        return name.indexOf("/photos/") > -1;
      }).slice(-1)[0];
      var entries = archive.names.filter(function(name){
        return name !== lastPhoto;
      }).map(function(name){
        return {name:name,bytes:archive.entries[name].bytes};
      });
      return Array.from(new Uint8Array(await window.__avl.zipStore(entries).arrayBuffer()));
    },built.bytes);
    await page.evaluate(async function(){
      await window.AVLPhotoStore.clear();
      window.__avl.applyImport(JSON.stringify({
        visit:{client:"Untouched current survey"},
        log:{},
        rooms:[{id:2,d:{name:"Current room"}}],
        photos:{},
        skipped:{},
        ui:{}
      }));
      window.__packageImportAddCalls = 0;
      var realAdd = window.AVLPhotoStore.addRecord;
      window.AVLPhotoStore.addRecord = function(record){
        window.__packageImportAddCalls++;
        return realAdd(record);
      };
    });
    var before = await surveyStateSnapshot(page);
    var backupBefore = await page.evaluate(function(){ return window.__avl.backupRaw(); });
    var result = await page.evaluate(async function(input){
      var ok = await window.__avl.applyPackageImport(new Uint8Array(input));
      return {
        ok:ok,
        calls:window.__packageImportAddCalls,
        backup:window.__avl.backupRaw(),
        records:(await window.AVLPhotoStore.all()).length
      };
    },broken);
    assert.equal(result.ok,false);
    assert.equal(result.calls,0,"preflight must finish before the first storage write");
    assert.equal(result.records,0);
    assert.equal(result.backup,backupBefore,"an invalid package must not replace the backup");
    assert.equal(await surveyStateSnapshot(page),before);
  });
});

test("a mid-import IndexedDB failure leaves current state intact and records its orphan", async function(){
  await withApp(async function(page){
    var built = await buildPackage(page);
    await page.evaluate(async function(){
      await window.AVLPhotoStore.clear();
      window.__avl.applyImport(JSON.stringify({
        visit:{client:"Keep this survey"},
        log:{},
        rooms:[{id:9,d:{name:"Do not overwrite"}}],
        photos:{},
        skipped:{},
        ui:{}
      }));
      var realAdd = window.AVLPhotoStore.addRecord;
      var calls = 0;
      window.AVLPhotoStore.addRecord = function(record){
        calls++;
        if(calls === 2) return Promise.reject(new Error("injected storage failure"));
        return realAdd(record);
      };
    });
    var before = await surveyStateSnapshot(page);
    var result = await page.evaluate(async function(input){
      var ok = await window.__avl.applyPackageImport(new Uint8Array(input));
      var records = await window.AVLPhotoStore.all();
      return {
        ok:ok,
        client:window.__avl.S().visit.client,
        records:records.map(function(record){ return record.id; }),
        orphans:window.__avl.orphanedPhotoIds()
      };
    },built.bytes);
    assert.equal(result.ok,false);
    assert.equal(result.client,"Keep this survey");
    assert.equal(await surveyStateSnapshot(page),before);
    assert.equal(result.records.length,1);
    assert.deepEqual(result.orphans,result.records);
  });
});
