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
var GREEN_BYTES = Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAkGBggGBQkIBwgKCQkKDRYODQwMDRoTFBAWHxwhIB8cHh4jJzIqIyUvJR4eKzssLzM1ODg4ISo9QTw2QTI3ODX/2wBDAQkKCg0LDRkODhk1JB4kNTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTX/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBKKKK8g+IP/9k=",
  "base64"
));
var BLUE_BYTES = Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAkGBggGBQkIBwgKCQkKDRYODQwMDRoTFBAWHxwhIB8cHh4jJzIqIyUvJR4eKzssLzM1ODg4ISo9QTw2QTI3ODX/2wBDAQkKCg0LDRkODhk1JB4kNTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTX/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAIRAxEAPwDmKKKK/RDwz//Z",
  "base64"
));

function packageState(){
  return {
    visit:{
      client:"exact package client",
      site:"Main Campus",
      date:"2026-07-26"
    },
    log:{},
    rooms:[
      {id:1,d:{name:'He said "go", then left,\nInc.'}},
      {id:2,d:{name:"Second Room"}}
    ],
    photos:{
      "2|notes":[JPG],
      "1|audio":[PNG],
      "log|main":[JPG,PNG]
    },
    skipped:{},
    ui:{}
  };
}

async function withPackageApp(options, run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:options.offline ? "allow" : "block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
    var page = await context.newPage();
    await page.addInitScript(function(config){
      window.__packageCanCalls = [];
      window.__packageShareCalls = [];
      window.__packageShareSupported = config.supported;
      /* Queued from inside canShare, which the app calls synchronously in the
         tap. It can only run once that handler returns, so if the count has
         moved by the time share() is reached, a microtask checkpoint passed in
         between and the call has left the user's original task -- which is what
         costs iOS Safari its transient activation. This catches an async hop
         hidden inside a helper, where inspecting one function's source cannot. */
      window.__packageMicrotasks = 0;
      Object.defineProperty(navigator, "canShare", {
        configurable:true,
        value:function(data){
          window.__packageCanCalls.push({
            file:data.files && data.files[0],
            microtasks:window.__packageMicrotasks,
            active:navigator.userActivation ? navigator.userActivation.isActive : null
          });
          Promise.resolve().then(function(){ window.__packageMicrotasks++; });
          return window.__packageShareSupported;
        }
      });
      Object.defineProperty(navigator, "share", {
        configurable:true,
        value:function(data){
          var call = {
            file:data.files && data.files[0],
            microtasks:window.__packageMicrotasks,
            active:navigator.userActivation ? navigator.userActivation.isActive : null
          };
          window.__packageShareCalls.push(call);
          return new Promise(function(resolve,reject){
            call.resolve = resolve;
            call.reject = reject;
          });
        }
      });
    }, {supported:options.supported !== false});
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    var imported = await page.evaluate(function(state){
      return window.__avl.applyImport(JSON.stringify(state));
    }, options.state || packageState());
    assert.equal(imported, true);
    if(options.offline){
      await until(async function(){
        return page.evaluate(function(){ return window.__avl.swReady; });
      });
      await context.setOffline(true);
    }
    await run(page,context,server.origin);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function prepare(page){
  await page.locator("#pkgprepare").click();
  await until(async function(){
    return page.evaluate(function(){
      var status = window.__avl.photoPackageStatus();
      return status.status === "ready" || status.status === "stale" || status.status === "error";
    });
  });
  var status = await page.evaluate(function(){ return window.__avl.photoPackageStatus(); });
  assert.equal(status.status, "ready", status.message);
  return status;
}

async function packageBytes(page){
  return Buffer.from(await page.evaluate(async function(){
    var file = window.__avl.photoPackageFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }));
}

function parseCsv(text){
  var rows = [];
  var row = [];
  var field = "";
  var quoted = false;
  for(var i=0;i<text.length;i++){
    var char = text.charAt(i);
    if(quoted){
      if(char === '"' && text.charAt(i+1) === '"'){
        field += '"';
        i++;
      } else if(char === '"'){
        quoted = false;
      } else {
        field += char;
      }
    } else if(char === '"'){
      quoted = true;
    } else if(char === ","){
      row.push(field);
      field = "";
    } else if(char === "\r" && text.charAt(i+1) === "\n"){
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += char;
    }
  }
  assert.equal(quoted, false, "CSV must close quoted fields");
  assert.equal(field, "");
  assert.deepEqual(row, []);
  return rows;
}

test("prepared ZIP extracts independently with canonical names, byte-exact photos, export and RFC CSV", async function(){
  await withPackageApp({}, async function(page,context,origin){
    var before = await surveyStateSnapshot(page);
    var status = await prepare(page);
    assert.equal(status.total, 4);
    assert.equal(status.filename, "PrePlot-Exact-Package-Client-2026-07-26-package.zip");
    assert.equal(await surveyStateSnapshot(page), before, "preparation must not mutate survey state");

    var manifest = await page.evaluate(function(){ return window.__avl.photoManifest(); });
    var bytes = await packageBytes(page);
    var root = "PrePlot-Exact-Package-Client-2026-07-26";
    var scratch = await mkdtemp(join(tmpdir(),"avl-photo-package-"));
    try {
      var archivePath = join(scratch,"package.zip");
      var extracted = join(scratch,"extracted");
      await writeFile(archivePath,bytes);
      await execFile("/usr/bin/unzip",["-t",archivePath]);
      var listing = await execFile("/usr/bin/unzip",["-Z1",archivePath]);
      var paths = listing.stdout.trim().split("\n");
      assert.deepEqual(paths,[
        root + "/photos/" + manifest[0].filename,
        root + "/photos/" + manifest[1].filename,
        root + "/photos/" + manifest[2].filename,
        root + "/photos/" + manifest[3].filename,
        root + "/PrePlot-Exact-Package-Client-2026-07-26.pdf",
        root + "/" + root + ".html",
        root + "/" + root + "-crm-note.txt",
        root + "/data/survey-export.json",
        root + "/data/photo-manifest.csv"
      ]);
      await execFile("/usr/bin/unzip",["-qq",archivePath,"-d",extracted]);
      var expectedPhotoBytes = [JPG_BYTES,PNG_BYTES,PNG_BYTES,JPG_BYTES];
      for(var i=0;i<manifest.length;i++){
        var extractedPhoto = await readFile(join(extracted,root,"photos",manifest[i].filename));
        assert.deepEqual(
          Array.from(extractedPhoto),
          expectedPhotoBytes[i],
          "extracted bytes must match source for " + manifest[i].ref
        );
      }

      var exported = JSON.parse(
        await readFile(join(extracted,root,"data","survey-export.json"),"utf8")
      );
      assert.equal(exported.app, "avl-survey");
      assert.equal(exported.schema, 5);
      assert.equal(exported.photoFormat, "archive");
      assert.equal(exported.pathBase, "archive-root");
      assert.deepEqual(
        Object.keys(exported.data.photos),
        Object.keys(packageState().photos)
      );
      assert.doesNotMatch(
        JSON.stringify(exported),
        /data:image\//,
        "the ZIP JSON must not duplicate packaged photo bytes as base64"
      );
      manifest.forEach(function(entry){
        var archived = exported.data.photos[entry.key][entry.bucketIndex];
        assert.deepEqual(
          archived,
          {
            ref:entry.ref,
            filename:entry.filename,
            path:"photos/" + entry.filename,
            mime:entry.mime,
            bytes:entry.bytes,
            width:0,
            height:0
          }
        );
        assert.equal(
          root + "/" + archived.path,
          paths[manifest.indexOf(entry)],
          "archive JSON photo paths stay root-relative while ZIP entries carry the folder prefix"
        );
      });
      /* Rejecting it is correct. Telling the surveyor the photos are on the
         originating device is not: they are in photos/ in the folder just
         unzipped. The two rejections describe different situations and must
         not share one message. */
      var archiveRejection = await page.evaluate(async function(payload){
        var ok = window.__avl.applyImport(JSON.stringify(payload));
        await new Promise(function(r){ setTimeout(r,60); });
        return {ok:String(ok), message:document.getElementById("toast").textContent};
      },exported);
      var deviceOnlyRejection = await page.evaluate(async function(){
        var ok = window.__avl.applyImport(JSON.stringify({
          app:"avl-survey", schema:3, appVersion:"1.10.1",
          data:{visit:{},log:{},rooms:[],
                photos:{"log|main":[{id:"elsewhere-1",mime:"image/jpeg",bytes:4,width:9,height:9}]},
                skipped:{},ui:{},meta:{}}
        }));
        await new Promise(function(r){ setTimeout(r,60); });
        return {ok:String(ok), message:document.getElementById("toast").textContent};
      });

      assert.equal(archiveRejection.ok,"false",
        "the compact archive JSON must not masquerade as a standalone portable export"
      );
      assert.equal(deviceOnlyRejection.ok,"false");
      assert.notEqual(
        archiveRejection.message, deviceOnlyRejection.message,
        "an archive export and a device-only export are different problems and need different advice"
      );
      assert.doesNotMatch(
        archiveRejection.message, /from that device/i,
        "the archive's photos are beside the file, not on the originating device"
      );
      assert.equal(await surveyStateSnapshot(page),before);

      var csvBytes = await readFile(
        join(extracted,root,"data","photo-manifest.csv")
      );
      assert.deepEqual(Array.from(csvBytes.subarray(0,3)),[0xEF,0xBB,0xBF]);
      var csvText = csvBytes.subarray(3).toString("utf8");
      assert.equal(csvText.endsWith("\r\n"),true);
      var rows = parseCsv(csvText);
      assert.deepEqual(rows[0],[
        "ref","filename","key","bucketIndex","roomLabel",
        "roomName","sectionId","sectionLabel","mime","caption","excluded"
      ]);
      assert.deepEqual(
        rows.slice(1),
        manifest.map(function(entry){
          return [
            entry.ref,entry.filename,entry.key,String(entry.bucketIndex),
            entry.roomLabel,entry.roomName,entry.sectionId,entry.sectionLabel,entry.mime,
            entry.caption,""
          ];
        })
      );
      assert.match(csvText,/"He said ""go"", then left,\nInc\."/);
    } finally {
      await rm(scratch,{recursive:true,force:true});
    }
  });
});

test("captured selection order reaches independently extracted ZIP photo order", async function(){
  var state = {
    visit:{client:"Capture order",site:"ZIP guard",date:"2026-07-28"},
    log:{},
    rooms:[{id:1,d:{name:"Ordered capture"}}],
    photos:{},
    skipped:{},
    ui:{"1|notes":true}
  };
  await withPackageApp({state:state}, async function(page){
    var sources = {
      first:"data:image/jpeg;base64," + Buffer.from(JPG_BYTES).toString("base64"),
      second:"data:image/jpeg;base64," + Buffer.from(GREEN_BYTES).toString("base64"),
      third:"data:image/png;base64," + Buffer.from(PNG_BYTES).toString("base64")
    };
    await page.evaluate(async function(input){
      var delays = {first:40,second:15,third:1};
      await window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"first"},{name:"second"},{name:"third"}],
        function(file,done){
          setTimeout(function(){
            done(input[file.name],{width:10,height:10});
          },delays[file.name]);
        }
      );
    },sources);
    await prepare(page);
    var manifest = await page.evaluate(function(){ return window.__avl.photoManifest(); });
    var root = "PrePlot-Capture-Order-2026-07-28";
    var bytes = await packageBytes(page);
    var scratch = await mkdtemp(join(tmpdir(),"avl-capture-order-"));
    try {
      var archivePath = join(scratch,"package.zip");
      var extracted = join(scratch,"extracted");
      await writeFile(archivePath,bytes);
      var listing = await execFile("/usr/bin/unzip",["-Z1",archivePath]);
      assert.deepEqual(listing.stdout.trim().split("\n").slice(0,3),[
        root + "/photos/001_R01_notes.jpg",
        root + "/photos/002_R01_notes.jpg",
        root + "/photos/003_R01_notes.png"
      ]);
      assert.deepEqual(
        manifest.map(function(entry){ return entry.filename; }),
        ["001_R01_notes.jpg","002_R01_notes.jpg","003_R01_notes.png"]
      );
      await execFile("/usr/bin/unzip",["-qq",archivePath,"-d",extracted]);
      for(var i=0;i<manifest.length;i++){
        var extractedPhoto = await readFile(
          join(extracted,root,"photos",manifest[i].filename)
        );
        assert.deepEqual(Array.from(extractedPhoto),[JPG_BYTES,GREEN_BYTES,PNG_BYTES][i]);
      }
    } finally {
      await rm(scratch,{recursive:true,force:true});
    }
  });
});

test("package photo reads cross the resident Blob accessor without changing survey state", async function(){
  await withPackageApp({}, async function(page){
    var before = await surveyStateSnapshot(page);
    var result = await page.evaluate(async function(){
      var entry = window.__avl.photoManifest()[0];
      var original = Blob.prototype.arrayBuffer;
      var calls = 0;
      Blob.prototype.arrayBuffer = function(){
        calls++;
        return original.call(this);
      };
      try {
        var source = await window.__avl.readPhotoSource(entry);
        return {
          calls:calls,
          mime:source.mime,
          bytes:Array.from(source.bytes),
          identity:source.identity,
          stored:window.__avl.S().photos[entry.key][entry.bucketIndex]
        };
      } finally {
        Blob.prototype.arrayBuffer = original;
      }
    });
    assert.equal(result.calls,1,"readPhotoSource must consume the Blob returned by the photo accessor");
    assert.equal(result.mime,"image/jpeg");
    assert.deepEqual(result.bytes,JPG_BYTES);
    assert.equal(result.identity,result.stored,"inline stale identity remains the complete data URL");
    assert.equal(await surveyStateSnapshot(page),before);
  });
});

test("Share package uses the actual prepared File synchronously, blocks overlap and permits cancel retry", async function(){
  await withPackageApp({}, async function(page){
    await prepare(page);
    var before = await surveyStateSnapshot(page);
    await page.locator("#pkgshare").click();
    var first = await page.evaluate(function(){
      var shareSource = String(window.__avl.sharePreparedPackage)
        .replace(/\/\*[\s\S]*?\*\//g,"");
      return {
        canCalls:window.__packageCanCalls.length,
        shareCalls:window.__packageShareCalls.length,
        sameFile:window.__packageCanCalls[0].file === window.__packageShareCalls[0].file,
        canActive:window.__packageCanCalls[0].active,
        shareActive:window.__packageShareCalls[0].active,
        canMicrotasks:window.__packageCanCalls[0].microtasks,
        shareMicrotasks:window.__packageShareCalls[0].microtasks,
        samePrepared:window.__packageShareCalls[0].file === window.__avl.photoPackageFile(),
        type:window.__packageShareCalls[0].file.type,
        name:window.__packageShareCalls[0].file.name,
        text:document.querySelector("#photopackagewrap").textContent,
        preShareSource:shareSource.slice(0,shareSource.indexOf("result = navigator.share(shareData)"))
      };
    });
    assert.equal(first.canCalls,1);
    assert.equal(first.shareCalls,1);
    assert.equal(first.sameFile,true,"canShare must receive the exact File passed to share");
    assert.equal(first.canActive,true);
    assert.equal(first.shareActive,true,"share must remain in the trusted tap");
    assert.equal(
      first.shareMicrotasks,first.canMicrotasks,
      "no microtask checkpoint may pass between canShare and navigator.share"
    );
    assert.equal(first.samePrepared,true);
    assert.equal(first.type,"application/zip");
    assert.match(first.name,/-package\.zip$/);
    assert.match(first.text,/Opening share sheet/);
    assert.doesNotMatch(first.text,/\b(Saved|Uploaded|Backed up|Complete|Success|Sent)\b/i);
    assert.doesNotMatch(
      first.preShareSource,
      /readPhotoSource|\.then\s*\(|\bPromise\b|\bawait\s+/,
      "the trusted tap must not schedule or await photo reads before navigator.share"
    );
    assert.equal(await surveyStateSnapshot(page),before);

    await page.evaluate(function(){ window.__avl.sharePreparedPackage(); });
    assert.equal(
      await page.evaluate(function(){ return window.__packageShareCalls.length; }),
      1,
      "a pending share must reject overlap"
    );
    await page.evaluate(function(){
      window.__packageShareCalls[0].reject(new DOMException("cancel","AbortError"));
    });
    await until(async function(){
      return page.evaluate(function(){
        var status = window.__avl.photoPackageStatus();
        return !status.inFlight && /Share cancelled/.test(status.message);
      });
    });
    assert.equal(await surveyStateSnapshot(page),before);
    assert.match(await page.locator("#photopackagewrap").innerText(),/Share cancelled\. The package is still ready\./);

    await page.locator("#pkgshare").click();
    assert.equal(await page.evaluate(function(){ return window.__packageShareCalls.length; }),2);
    await page.evaluate(function(){ window.__packageShareCalls[1].resolve(); });
    await until(async function(){
      return page.evaluate(function(){
        return /Share sheet closed/.test(window.__avl.photoPackageStatus().message);
      });
    });
    var closed = await page.locator("#photopackagewrap").innerText();
    assert.match(closed,/Confirm the package appears in Google Drive before leaving the site/);
    assert.doesNotMatch(closed,/\b(Saved|Uploaded|Backed up|Complete|Success|Sent)\b/i);
    assert.equal(await surveyStateSnapshot(page),before);
  });
});

test("unsupported sharing keeps the byte-identical package available for download without state changes", async function(){
  await withPackageApp({supported:false}, async function(page){
    await page.evaluate(function(){
      window.__packageDownload = null;
      window.__packageDownloadFile = null;
      window.__packageRevoked = [];
      URL.createObjectURL = function(file){
        window.__packageDownloadFile = file;
        return "blob:prepared-package";
      };
      URL.revokeObjectURL = function(url){ window.__packageRevoked.push(url); };
      HTMLAnchorElement.prototype.click = function(){
        window.__packageDownload = {name:this.download,href:this.href};
      };
    });
    await prepare(page);
    var expected = await packageBytes(page);
    var before = await surveyStateSnapshot(page);
    assert.equal(await page.locator("#pkgdownload").isVisible(),true,"download is visible before a share failure");

    await page.locator("#pkgshare").click();
    assert.equal(await page.evaluate(function(){ return window.__packageShareCalls.length; }),0);
    assert.match(await page.locator("#photopackagewrap").innerText(),/cannot share the package\. Download it instead/);
    await page.locator("#pkgdownload").click();
    var downloaded = await page.evaluate(async function(){
      return {
        click:window.__packageDownload,
        same:window.__packageDownloadFile === window.__avl.photoPackageFile(),
        bytes:Array.from(new Uint8Array(await window.__packageDownloadFile.arrayBuffer())),
        text:document.querySelector("#photopackagewrap").textContent
      };
    });
    assert.equal(downloaded.click.href,"blob:prepared-package");
    assert.match(downloaded.click.name,/-package\.zip$/);
    assert.equal(downloaded.same,true);
    assert.deepEqual(downloaded.bytes,Array.from(expected));
    assert.match(downloaded.text,/Download started \u2014 confirm the ZIP appears in Files before leaving/);
    assert.equal(await surveyStateSnapshot(page),before);
  });
});

test("same-length replacement and identity changes make a package neither shareable nor downloadable", async function(){
  await withPackageApp({}, async function(page){
    await page.evaluate(function(){
      window.__packageRevoked = [];
      URL.createObjectURL = function(){ return "blob:prepared-package"; };
      URL.revokeObjectURL = function(url){ window.__packageRevoked.push(url); };
      HTMLAnchorElement.prototype.click = function(){};
    });
    await prepare(page);
    await page.locator("#pkgdownload").click();
    var original = await page.evaluate(function(){ return window.__avl.S().photos["log|main"][0]; });
    assert.ok(original.length > 64);
    await page.evaluate(function(source){
      var middle = Math.floor(source.length / 2);
      var replacement = source.slice(0,middle) +
        (source.charAt(middle) === "A" ? "B" : "A") +
        source.slice(middle + 1);
      if(replacement.slice(0,32) !== source.slice(0,32) ||
         replacement.slice(-32) !== source.slice(-32) ||
         replacement.length !== source.length){
        throw new Error("fixture did not preserve the weak fingerprint");
      }
      window.__avl.S().photos["log|main"][0] = replacement;
    },original);
    await page.evaluate(function(){ window.__avl.sharePreparedPackage(); });
    var stale = await page.evaluate(function(){
      return {
        status:window.__avl.photoPackageStatus(),
        shareCalls:window.__packageShareCalls.length,
        canCalls:window.__packageCanCalls.length,
        revoked:window.__packageRevoked.slice(),
        text:document.querySelector("#photopackagewrap").textContent,
        shareDisabled:document.querySelector("#photopackagewrap .pkgtools .pri").disabled,
        downloadDisabled:document.querySelector("#photopackagewrap .pkgtools .ghost").disabled,
        downloadResult:window.__avl.downloadPreparedPackage()
      };
    });
    assert.equal(stale.status.status,"stale");
    assert.equal(stale.status.size,0);
    assert.equal(stale.shareCalls,0);
    assert.equal(stale.canCalls,0);
    assert.deepEqual(stale.revoked,["blob:prepared-package"]);
    assert.match(stale.text,/Survey changed since preparation\. Prepare again\./);
    assert.equal(stale.shareDisabled,true);
    assert.equal(stale.downloadDisabled,true);
    assert.equal(stale.downloadResult,false);
  });

  var changes = [
    function(){ window.__avl.S().visit.client = "New client"; },
    function(){ window.__avl.S().visit.site = "New site"; },
    function(){ window.__avl.S().visit.date = "2026-08-01"; },
    function(){ window.__avl.S().rooms[0].d.name = "Renamed room"; }
  ];
  for(var i=0;i<changes.length;i++){
    await withPackageApp({}, async function(page){
      await prepare(page);
      await page.evaluate(changes[i]);
      assert.equal(
        await page.evaluate(function(){ return window.__avl.sharePreparedPackage(); }),
        false
      );
      assert.equal(
        await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; }),
        "stale"
      );
      assert.equal(await page.evaluate(function(){ return window.__packageShareCalls.length; }),0);
    });
  }
});

/* Typing calls setV and updateProgress but never render(), so the package block
   keeps both buttons enabled while its identity has already moved. Every other
   stale test reaches the stale state through share() first, which replaces the
   package object and makes the download guard unreachable. */
test("a package that is still marked ready but no longer current cannot be downloaded", async function(){
  await withPackageApp({}, async function(page){
    await page.evaluate(function(){
      window.__packageRevoked = [];
      window.__packageAnchorClicks = [];
      URL.createObjectURL = function(){ return "blob:ready-but-stale"; };
      URL.revokeObjectURL = function(url){ window.__packageRevoked.push(url); };
      HTMLAnchorElement.prototype.click = function(){
        window.__packageAnchorClicks.push(this.download);
      };
    });
    await prepare(page);

    /* one legitimate download first, so an object URL exists to be revoked */
    await page.locator("#pkgdownload").click();
    assert.equal(
      (await page.evaluate(function(){ return window.__packageAnchorClicks.slice(); })).length,
      1
    );

    var edited = await page.evaluate(function(){
      var field = document.querySelector('[data-scope="visit"][data-k="client"]');
      field.value = "Renamed mid-visit";
      field.dispatchEvent(new Event("input",{bubbles:true}));
      return {
        client:window.__avl.S().visit.client,
        status:window.__avl.photoPackageStatus().status,
        downloadDisabled:document.querySelector("#photopackagewrap .pkgtools .ghost").disabled
      };
    });
    assert.equal(edited.client,"Renamed mid-visit");
    assert.equal(edited.status,"ready","typing must not re-render the package block");
    assert.equal(edited.downloadDisabled,false,"the stale package is still tappable");

    var result = await page.evaluate(function(){
      return {
        returned:window.__avl.downloadPreparedPackage(),
        status:window.__avl.photoPackageStatus().status,
        clicks:window.__packageAnchorClicks.slice(),
        revoked:window.__packageRevoked.slice(),
        text:document.querySelector("#photopackagewrap").textContent
      };
    });
    assert.equal(result.returned,false,"download must refuse a package that is no longer current");
    assert.equal(result.clicks.length,1,"no second download anchor may be clicked");
    assert.equal(result.status,"stale");
    assert.deepEqual(result.revoked,["blob:ready-but-stale"]);
    assert.match(result.text,/Survey changed since preparation\. Prepare again\./);
  });
});

test("identity moving after photo reads is discarded by the post-preparation re-check", async function(){
  var photos = [];
  for(var i=0;i<40;i++) photos.push(JPG);
  var state = packageState();
  state.photos = {"log|main":photos};
  await withPackageApp({state:state}, async function(page){
    assert.equal(
      await page.evaluate(function(){
        var source = String(window.__avl.preparePhotoPackage);
        return (source.match(/!photoPackageIsCurrent\(pkg\)/g) || []).length;
      }),
      3,
      "preparation must re-check identity after renditions, portable HTML work and final assembly"
    );
    var before = await surveyStateSnapshot(page);
    await page.evaluate(function(){
      var realSetTimeout = window.setTimeout;
      window.__packageFinishQueued = false;
      window.__releasePackageFinish = null;
      window.setTimeout = function(fn,delay){
        if(fn && fn.name === "finishPreparation"){
          window.__packageFinishQueued = true;
          window.__releasePackageFinish = function(){ realSetTimeout(fn,0); };
          return 0;
        }
        return realSetTimeout.apply(window,arguments);
      };
    });
    await page.locator("#pkgprepare").click();
    await until(async function(){
      return page.evaluate(function(){
        return window.__packageFinishQueued;
      });
    });
    await page.evaluate(function(){
      window.__avl.S().visit.client = "Changed during final assembly";
      window.__releasePackageFinish();
    });
    await until(async function(){
      return page.evaluate(function(){
        return window.__avl.photoPackageStatus().status === "stale";
      });
    });
    assert.equal(await page.evaluate(function(){ return window.__avl.photoPackageFile(); }),null);
    assert.equal(await page.evaluate(function(){ return window.__packageShareCalls.length; }),0);
    assert.notEqual(
      await surveyStateSnapshot(page),
      before,
      "the test mutation must be real even though package preparation never mutates state"
    );
  });
});

test("photo package preparation and trusted share remain available offline", async function(){
  await withPackageApp({offline:true}, async function(page){
    var before = await surveyStateSnapshot(page);
    await prepare(page);
    await page.locator("#pkgshare").click();
    assert.equal(await page.evaluate(function(){ return window.__packageShareCalls.length; }),1);
    assert.equal(await page.evaluate(function(){ return window.__packageShareCalls[0].active; }),true);
    assert.equal(await surveyStateSnapshot(page),before);
    await page.evaluate(function(){ window.__packageShareCalls[0].resolve(); });
  });
});
