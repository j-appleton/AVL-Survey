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
var JPG = "data:image/jpeg;base64," +
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEoooryD9EP//Z";

async function withApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    await page.goto(server.origin + "/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function installPhotos(page,count){
  return page.evaluate(async function(config){
    var list = [];
    for(var i=0;i<config.count;i++){
      var record = await window.AVLPhotoStore.addDataUrl(config.jpg,8,6);
      list.push({
        id:record.id,mime:record.mime,bytes:record.bytes,
        width:record.width,height:record.height
      });
    }
    await window.__avl.setDescriptorStateForTest({
      visit:{client:"Compose Client",site:"Compose Site",date:"2026-07-31",surveyor:"Jonathan"},
      log:{},rooms:[{id:1,d:{name:"Compose Room"}}],
      photos:{"1|audio":list},captions:{},compose:{summary:"",excluded:{}},
      skipped:{},ui:{},meta:{created:"old",updated:"old",app:"1.18.0"}
    });
    return list;
  },{jpg:JPG,count:count});
}

test("schema 5 repairs orphan composition keys and Compose edits the canonical state", async function(){
  await withApp(async function(page){
    var descriptors = await installPhotos(page,2);
    var migration = await page.evaluate(function(){
      return window.__avl.migrate({app:"avl-survey",schema:4,data:{
        visit:{},log:{},rooms:[],photos:{},captions:{},skipped:{},ui:{},meta:{}
      }});
    });
    assert.equal(migration.ok,true);
    assert.deepEqual(migration.data.compose,{summary:"",excluded:{}});

    var repaired = await page.evaluate(function(id){
      var state = {
        visit:{},log:{},rooms:[],photos:{},
        captions:{orphan:"stranded"},
        compose:{summary:"Useful",excluded:{orphan:true}},
        skipped:{},ui:{},meta:{}
      };
      state.photos.main = [{id:id,mime:"image/jpeg",bytes:1,width:1,height:1}];
      return window.__avl.migrate({app:"avl-survey",schema:5,data:state});
    },descriptors[0].id);
    assert.equal(repaired.ok,true);
    assert.deepEqual(repaired.data.captions,{});
    assert.deepEqual(repaired.data.compose,{summary:"Useful",excluded:{}});

    await page.locator('[data-app-view="compose"]').click();
    assert.equal(await page.locator("[data-compose-view]").count(),1);
    await page.locator("[data-compose-summary]").fill("Decision summary\nSecond line");
    await page.locator("[data-compose-photo]").nth(1).locator("[data-compose-exclude]").click();
    await page.locator("[data-compose-photo]").first().locator("[data-photo-caption]").fill("Rack overview");
    var state = await page.evaluate(function(){ return window.__avl.S(); });
    assert.equal(state.compose.summary,"Decision summary\nSecond line");
    assert.deepEqual(state.compose.excluded,(function(){ var value={}; value[descriptors[1].id]=true; return value; })());
    assert.equal(state.captions[descriptors[0].id],"Rack overview");

    var coverResult = await page.evaluate(function(id){
      window.__avl.S().visit.coverPhotoId = id;
      return window.__avl.setPhotoExcluded(window.__avl.S().photos["1|audio"][0],true);
    },descriptors[0].id);
    assert.equal(coverResult.ok,false);
    assert.equal(await page.evaluate(function(){ return window.__avl.S().visit.coverPhotoId; }),descriptors[0].id);

    await page.locator('[data-app-view="photos"]').click();
    await page.evaluate(function(id){ window.__avl.S().captions[id] = "Delete me"; },descriptors[1].id);
    var secondDelete = page.locator('[data-photo-key="1|audio"][data-photo-index="1"] [data-delph]');
    await secondDelete.click();
    await secondDelete.click();
    var reaped = await page.evaluate(function(id){
      return {
        caption:Object.prototype.hasOwnProperty.call(window.__avl.S().captions,id),
        exclusion:Object.prototype.hasOwnProperty.call(window.__avl.S().compose.excluded,id)
      };
    },descriptors[1].id);
    assert.deepEqual(reaped,{caption:false,exclusion:false});
  });
});

test("exclusions leave manifest and archive whole while filtering both reports", async function(){
  await withApp(async function(page){
    await installPhotos(page,3);
    var result = await page.evaluate(async function(){
      var before = window.__avl.photoManifest().map(function(entry){
        return {ref:entry.ref,filename:entry.filename};
      });
      window.__avl.setPhotoExcluded(window.__avl.S().photos["1|audio"][1],true);
      var after = window.__avl.photoManifest().map(function(entry){
        return {ref:entry.ref,filename:entry.filename};
      });
      var model = window.__avl.buildReportModel();
      var html = window.__avl.buildHtmlReport(model);
      var pdf = await window.__avl.generatePdfReport();
      window.__avl.preparePhotoPackage();
      return {before:before,after:after,model:model,html:html,pdfCards:pdf.layout.photoCards};
    });
    assert.deepEqual(result.after,result.before);
    assert.deepEqual(result.model.photos.map(function(photo){ return photo.ref; }),["001","003"]);
    assert.deepEqual(result.pdfCards.map(function(card){ return card.ref; }),["001","003"]);
    assert.equal((result.html.match(/class="photo-card"/g) || []).length,2);
    assert.doesNotMatch(result.html,new RegExp(result.before[1].filename));

    await until(async function(){
      return (await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; })) === "ready";
    },15000);
    var archive = await page.evaluate(async function(){
      var bytes = new Uint8Array(await window.__avl.photoPackageFile().arrayBuffer());
      var zip = window.__avl.zipReadStore(bytes);
      var csvName = zip.root + "/data/photo-manifest.csv";
      var csv = new TextDecoder().decode(zip.entries[csvName].bytes);
      return {
        photoNames:zip.names.filter(function(name){ return name.indexOf(zip.root + "/photos/") === 0; }),
        csv:csv
      };
    });
    assert.equal(archive.photoNames.length,3);
    assert.match(archive.csv,/excluded\r?\n/);
    assert.match(archive.csv,/,true\r?\n/);

    var zero = await page.evaluate(async function(){
      window.__avl.S().photos["1|audio"].forEach(function(entry){
        window.__avl.setPhotoExcluded(entry,true);
      });
      var pdf = await window.__avl.generatePdfReport();
      return {cards:pdf.layout.photoCards.length,pages:pdf.pages,bytes:pdf.bytes.length};
    });
    assert.equal(zero.cards,0);
    assert.ok(zero.bytes > 0);
    assert.ok(zero.pages.some(function(item){ return item.kind === "cover"; }));
  });
});

test("executive summary is bounded, escaped and keeps the CRM note CRLF-only", async function(){
  await withApp(async function(page){
    var result = await page.evaluate(async function(){
      var hostile = "Decision (A) \\ path\n<script> & \"quoted\" 'single'";
      window.__avl.setComposeSummary(hostile);
      var model = window.__avl.buildReportModel();
      var html = window.__avl.buildHtmlReport(model);
      var pdf = await window.__avl.generatePdfReport();
      var crm = window.__avl.crmNoteText();
      var capped = window.__avl.setComposeSummary(new Array(1602).join("W"));
      var cappedPdf = await window.__avl.generatePdfReport();
      return {hostile:hostile,html:html,crm:crm,pdf:pdf,capped:capped,cappedPdf:cappedPdf};
    });
    assert.match(result.html,/&lt;script&gt; &amp; &quot;quoted&quot; &#39;single&#39;/);
    assert.equal(result.crm.indexOf("\r\n") > -1,true);
    assert.equal(result.crm.replace(/\r\n/g,"").indexOf("\n"),-1);
    assert.match(result.crm,/EXECUTIVE SUMMARY\r\nDecision \(A\) \\ path\r\n  <script>/);
    assert.ok(result.pdf.pages.some(function(pageInfo){ return pageInfo.kind === "summary"; }));
    assert.equal(result.capped.length,1500);
    assert.ok(result.cappedPdf.pages.filter(function(pageInfo){ return pageInfo.kind === "summary"; }).length >= 1);
  });
});

test("package import remaps exclusions to fresh IDs and malformed flags fail before writes", async function(){
  await withApp(async function(page){
    var old = await installPhotos(page,2);
    var built = await page.evaluate(function(){
      window.__avl.setComposeSummary("Imported summary");
      window.__avl.setPhotoExcluded(window.__avl.S().photos["1|audio"][1],true);
      window.__avl.preparePhotoPackage();
      return true;
    });
    assert.equal(built,true);
    await until(async function(){
      return (await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; })) === "ready";
    },15000);
    var result = await page.evaluate(async function(){
      var original = new Uint8Array(await window.__avl.photoPackageFile().arrayBuffer());
      var imported = await window.__avl.applyPackageImport(original);
      var ids = window.__avl.S().photos["1|audio"].map(function(entry){ return entry.id; });
      var excluded = Object.keys(window.__avl.S().compose.excluded);
      var importedSummary = window.__avl.S().compose.summary;

      var zip = window.__avl.zipReadStore(original);
      var jsonName = zip.root + "/data/survey-export.json";
      var payload = JSON.parse(new TextDecoder().decode(zip.entries[jsonName].bytes));
      var legacyPayload = JSON.parse(JSON.stringify(payload));
      legacyPayload.schema = 4;
      delete legacyPayload.data.compose;
      Object.keys(legacyPayload.data.photos).forEach(function(key){
        legacyPayload.data.photos[key].forEach(function(item){ delete item.excluded; });
      });
      var legacyEntries = zip.names.map(function(name){
        return {name:name,bytes:name === jsonName ? new TextEncoder().encode(JSON.stringify(legacyPayload)) : zip.entries[name].bytes};
      });
      var legacyBytes = new Uint8Array(await window.__avl.zipStore(legacyEntries).arrayBuffer());
      var legacy = await window.__avl.applyPackageImport(legacyBytes);
      var legacyCompose = JSON.parse(JSON.stringify(window.__avl.S().compose));
      var legacyMessage = document.getElementById("toast").textContent;

      payload.data.photos["1|audio"][0].excluded = false;
      var entries = zip.names.map(function(name){
        return {name:name,bytes:name === jsonName ? new TextEncoder().encode(JSON.stringify(payload)) : zip.entries[name].bytes};
      });
      var calls = 0;
      var originalAdd = window.AVLPhotoStore.addRecord;
      window.AVLPhotoStore.addRecord = function(record){ calls++; return originalAdd.call(window.AVLPhotoStore,record); };
      var malformedBytes = new Uint8Array(await window.__avl.zipStore(entries).arrayBuffer());
      var malformed = await window.__avl.applyPackageImport(malformedBytes);
      window.AVLPhotoStore.addRecord = originalAdd;
      return {imported:imported,ids:ids,excluded:excluded,summary:importedSummary,
        legacy:legacy,legacyCompose:legacyCompose,legacyMessage:legacyMessage,malformed:malformed,calls:calls};
    });
    assert.equal(result.imported,true);
    old.forEach(function(entry){ assert.equal(result.ids.indexOf(entry.id),-1); });
    assert.equal(result.excluded.length,1);
    assert.equal(result.excluded[0],result.ids[1]);
    assert.equal(result.summary,"Imported summary");
    assert.equal(result.legacy,true,result.legacyMessage);
    assert.deepEqual(result.legacyCompose,{summary:"",excluded:{}});
    assert.equal(result.malformed,false);
    assert.equal(result.calls,0);
  });
});

test("PDF uses a native viewer while HTML locks, closes and restores the app", async function(){
  await withApp(async function(page){
    await installPhotos(page,1);
    await page.locator('[data-app-view="compose"]').click();
    await page.evaluate(function(){ window.__avl.preparePhotoPackage(); });
    await until(async function(){
      return (await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; })) === "ready";
    },15000);
    var before = await surveyStateSnapshot(page);
    await page.evaluate(function(){
      window.__composeRevoked = [];
      window.__composeNativePdf = {opened:0,active:false,url:"",closed:false};
      var original = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = function(url){ window.__composeRevoked.push(url); return original(url); };
      window.open = function(){
        window.__composeNativePdf.opened++;
        window.__composeNativePdf.active = !navigator.userActivation || navigator.userActivation.isActive;
        var preview = {
          closed:false,
          location:{replace:function(url){ window.__composeNativePdf.url = String(url); }},
          close:function(){ preview.closed = true; window.__composeNativePdf.closed = true; }
        };
        return preview;
      };
    });
    await page.locator('[data-compose-preview="pdf"]').click();
    var overlap = await page.evaluate(function(){ return window.__avl.openComposePreview("html"); });
    assert.equal(await overlap,false,"a second preview cannot overlap PDF generation");
    await until(async function(){
      return (await page.evaluate(function(){ return window.__composeNativePdf.url; })).indexOf("blob:") === 0;
    },15000);
    var nativePdf = await page.evaluate(function(){ return window.__composeNativePdf; });
    assert.equal(nativePdf.opened,1);
    assert.equal(nativePdf.active,true,"the native context must open inside the trusted tap");
    assert.equal(await page.locator("[data-compose-preview-overlay]").count(),0,
      "PDF must never be trapped inside the app's iframe overlay");
    var pdfUrls = await page.evaluate(function(){ return window.__avl.composePreviewUrls(); });
    assert.deepEqual(pdfUrls,[],"the native viewer URL must not share the overlay's early-revocation pool");
    await page.evaluate(function(){ window.__avl.closeComposePreview(); });
    assert.equal(await surveyStateSnapshot(page),before);
    assert.equal(await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; }),"ready");
    var pdfRevoked = await page.evaluate(function(){ return window.__composeRevoked.slice(); });
    assert.equal(pdfRevoked.indexOf(nativePdf.url),-1,
      "backgrounding the PWA must not revoke the PDF while the native viewer loads it");
    assert.match(await page.evaluate(function(url){
      return fetch(url).then(function(response){ return response.text(); });
    },nativePdf.url),/^%PDF-1\.4/);

    await page.locator('[data-compose-preview="html"]').click();
    await page.locator("[data-compose-preview-overlay] iframe").waitFor({state:"visible"});
    assert.equal(
      await page.locator("[data-compose-preview-overlay] iframe").getAttribute("sandbox"),
      "allow-scripts",
      "the srcdoc preview must stay isolated without a WebKit-hostile blob document"
    );
    var locked = await page.evaluate(function(){
      return {position:document.body.style.position,overflow:document.body.style.overflow};
    });
    assert.deepEqual(locked,{position:"fixed",overflow:"hidden"},
      "the document behind the preview must not scroll");
    var htmlUrls = await page.evaluate(function(){ return window.__avl.composePreviewUrls(); });
    assert.deepEqual(htmlUrls,[],"srcdoc must not create another revocable preview URL");
    await page.locator("[data-compose-preview-close]").click();
    assert.deepEqual(await page.evaluate(function(){
      return {
        position:document.body.style.position,
        overflow:document.body.style.overflow,
        focused:document.activeElement && document.activeElement.getAttribute("data-compose-preview")
      };
    }),{position:"",overflow:"",focused:"html"});
    assert.equal(await surveyStateSnapshot(page),before);
    assert.equal(await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; }),"ready");
    var revoked = await page.evaluate(function(){ return window.__composeRevoked.slice(); });
    htmlUrls.forEach(function(url){ assert.ok(revoked.indexOf(url) > -1); });
    assert.equal(await page.evaluate(function(){ return window.__avl.composePreviewUrls().length; }),0);
  });
});

test("mobile HTML preview chrome stays inside the device safe area", async function(){
  await withApp(async function(page){
    await page.setViewportSize({width:390,height:844});
    await installPhotos(page,1);
    await page.locator('[data-app-view="compose"]').click();
    await page.locator('[data-compose-preview="html"]').click();
    await page.locator("[data-compose-preview-overlay] iframe").waitFor({state:"visible"});

    var geometry = await page.evaluate(function(){
      var overlay = document.querySelector("[data-compose-preview-overlay]");
      var bar = overlay.querySelector(".compose-preview-bar");
      var title = bar.querySelector("strong");
      var close = overlay.querySelector("[data-compose-preview-close]");
      /* Chromium has no display cutout in this fixture. Override the same
         variables fed by env(safe-area-inset-*) on iOS so the actual geometry
         remains testable instead of merely grepping a stylesheet. */
      overlay.style.setProperty("--preview-safe-top","54px");
      overlay.style.setProperty("--preview-safe-right","18px");
      var titleRect = title.getBoundingClientRect();
      var closeRect = close.getBoundingClientRect();
      return {
        titleRight:titleRect.right,
        closeTop:closeRect.top,
        closeRight:closeRect.right,
        closeLeft:closeRect.left,
        closeHeight:closeRect.height,
        viewportWidth:window.innerWidth
      };
    });
    assert.ok(geometry.closeTop >= 54,
      "the close control must render below the simulated iPhone status area");
    assert.ok(geometry.closeRight <= geometry.viewportWidth - 18,
      "the close control must stay clear of the right safe area");
    assert.ok(geometry.closeHeight >= 44,"the mobile close target must remain tappable");
    assert.ok(geometry.titleRight <= geometry.closeLeft,
      "the preview title must not collide with its close control");
    await page.locator("[data-compose-preview-close]").click();
  });
});

test("a blocked native PDF window falls back to an explicit open or download choice", async function(){
  await withApp(async function(page){
    await installPhotos(page,1);
    await page.locator('[data-app-view="compose"]').click();
    await page.evaluate(function(){ window.open = function(){ return null; }; });
    await page.locator('[data-compose-preview="pdf"]').click();
    await page.locator("[data-compose-preview-overlay]").waitFor({state:"visible"});
    assert.equal(await page.locator("[data-compose-preview-overlay] iframe").count(),0);
    var openLink = page.locator("[data-compose-pdf-open]");
    assert.equal(await openLink.count(),1);
    assert.match(await openLink.getAttribute("href"),/^blob:/);
    assert.equal(await openLink.getAttribute("target"),"_blank");
    var download = page.locator("[data-compose-preview-overlay] a[download]");
    assert.equal(await download.count(),1);
    assert.match(await download.getAttribute("download"),/\.pdf$/);
    await page.locator("[data-compose-preview-close]").click();
  });
});

/* --- guards that shipped without proof ----------------------------------- */

test("an imported package cannot exclude the photo it names as cover", async function(){
  await withApp(async function(page){
    await installPhotos(page,2);
    var result = await page.evaluate(async function(){
      window.__avl.S().visit.coverPhotoId = window.__avl.S().photos["1|audio"][0].id;
      window.__avl.preparePhotoPackage();
      await new Promise(function(resolve){
        var timer = setInterval(function(){
          if(window.__avl.photoPackageStatus().status === "ready"){
            clearInterval(timer);
            resolve();
          }
        },80);
      });
      var bytes = new Uint8Array(await window.__avl.photoPackageFile().arrayBuffer());

      /* A package is untrusted input. Flag the cover photo itself as excluded,
         which the in-app control refuses to do and therefore never produces. */
      var archive = window.__avl.zipReadStore(bytes);
      var jsonName = archive.root + "/data/survey-export.json";
      var payload = JSON.parse(new TextDecoder().decode(archive.entries[jsonName].bytes));
      var coverName = payload.coverPhoto;
      Object.keys(payload.data.photos).forEach(function(key){
        payload.data.photos[key].forEach(function(item){
          if(item.filename === coverName) item.excluded = true;
        });
      });
      var encoded = new TextEncoder().encode(JSON.stringify(payload));
      var entries = archive.names.map(function(name){
        return name === jsonName
          ? {name:name,bytes:encoded}
          : {name:name,bytes:archive.entries[name].bytes};
      });
      var rebuilt = new Uint8Array(await window.__avl.zipStore(entries).arrayBuffer());

      await window.AVLPhotoStore.clear();
      var imported = await window.__avl.applyPackageImport(rebuilt);
      var coverId = window.__avl.S().visit.coverPhotoId;
      var model = window.__avl.buildReportModel();
      return {
        imported:imported,
        coverName:coverName,
        coverId:coverId,
        coverIsExcluded:!!window.__avl.S().compose.excluded[coverId],
        exclusions:Object.keys(window.__avl.S().compose.excluded).length,
        modelCoverIndex:model.cover.coverPhoto,
        modelPhotoCount:model.photos.length
      };
    });
    assert.equal(result.imported,true,"the package is otherwise structurally valid");
    assert.ok(result.coverName,"the fixture must actually name a cover");
    assert.equal(
      result.coverIsExcluded,false,
      "coercion must strip an exclusion that lands on the cover photo"
    );
    assert.equal(result.exclusions,0,"no other exclusion may be invented");
    assert.equal(
      result.modelCoverIndex,0,
      "the cover must still resolve to an image in the filtered report list"
    );
    assert.equal(result.modelPhotoCount,2,"no photo may be dropped from the report");
  });
});

test("preview overlays carry the real report bytes, not stand-in markup", async function(){
  await withApp(async function(page){
    await installPhotos(page,2);
    await page.evaluate(function(){
      window.__avl.setComposeSummary("Only the real builder emits this sentence.");
    });
    await page.locator('[data-app-view="compose"]').click();

    await page.evaluate(function(){
      window.__composePdfUrl = "";
      window.open = function(){
        return {
          closed:false,
          location:{replace:function(url){ window.__composePdfUrl = String(url); }},
          close:function(){}
        };
      };
    });
    var expected = await page.evaluate(async function(){
      var expected = await window.__avl.generatePdfReport();
      return Array.from(expected.bytes);
    });
    await page.locator('[data-compose-preview="pdf"]').click();
    await until(async function(){
      return (await page.evaluate(function(){ return window.__composePdfUrl; })).indexOf("blob:") === 0;
    },15000);
    var pdf = await page.evaluate(async function(){
      var actual = new Uint8Array(await fetch(window.__composePdfUrl).then(function(response){
        return response.arrayBuffer();
      }));
      return {
        head:String.fromCharCode.apply(null,actual.subarray(0,8)),
        bytes:Array.from(actual)
      };
    });
    var same = pdf.bytes.length === expected.length;
    if(same){
      for(var i=0;i<pdf.bytes.length;i++){
        if(pdf.bytes[i] !== expected[i]){ same = false; break; }
      }
    }
    assert.match(pdf.head,/^%PDF-1\.4/,"the native preview must receive a real PDF");
    assert.ok(expected.length > 2000,"the fixture report must be substantial");
    assert.equal(same,true,"the native preview bytes must exactly match generatePdfReport");
    await page.evaluate(function(){ window.__avl.closeComposePreview(); });

    var html = await page.evaluate(async function(){
      var opened = await window.__avl.openComposePreview("html");
      var frame = document.querySelector("[data-compose-preview-overlay] iframe");
      return {opened:opened,text:frame.srcdoc};
    });
    assert.equal(html.opened,true);
    assert.match(html.text,/^<!doctype html>/i,"the preview must be the real report document");
    assert.match(html.text,/Only the real builder emits this sentence\./,
      "the previewed HTML must carry the live executive summary");
    assert.match(html.text,/Compose Client/,"the previewed HTML must carry the live cover data");
    assert.match(html.text,/src="data:image\/jpeg;base64,/,
      "the preview must carry a self-contained photo source");
    assert.doesNotMatch(html.text,/"photos\//,
      "the preview must not depend on archive-relative photo paths");
    await page.locator("[data-compose-preview-close]").click();
  });
});

/* --- guards that shipped without proof ----------------------------------- */

test("the native PDF window is opened inside the trusted tap, before any await", async function(){
  await withApp(async function(page){
    await installPhotos(page,2);
    await page.locator('[data-app-view="compose"]').click();
    var result = await page.evaluate(function(){
      /* click() dispatches synchronously, so anything the handler does before
         its first await still runs while syncPhase is true. A window.open moved
         below an await or a promise continuation records false, which is
         exactly what a real browser refuses to honour. */
      window.__openSyncPhase = true;
      window.__openCalls = [];
      window.open = function(){
        window.__openCalls.push(window.__openSyncPhase === true);
        return null;
      };
      document.querySelector('[data-compose-preview="pdf"]').click();
      window.__openSyncPhase = false;
      return true;
    });
    assert.equal(result,true);
    await page.locator("[data-compose-preview-overlay]").waitFor({state:"visible"});
    var calls = await page.evaluate(function(){ return window.__openCalls.slice(); });
    assert.equal(calls.length,1,"exactly one native context may be requested per tap");
    assert.equal(
      calls[0],true,
      "window.open must run in the same synchronous task as the tap, or iOS blocks it"
    );
    await page.locator("[data-compose-preview-close]").click();
  });
});

test("the popup fallback offers the same PDF bytes through both controls", async function(){
  await withApp(async function(page){
    await installPhotos(page,2);
    await page.evaluate(function(){
      window.__avl.setComposeSummary("Fallback fixture summary.");
    });
    await page.locator('[data-app-view="compose"]').click();
    await page.evaluate(function(){ window.open = function(){ return null; }; });
    await page.locator('[data-compose-preview="pdf"]').click();
    await page.locator("[data-compose-preview-overlay]").waitFor({state:"visible"});

    var result = await page.evaluate(async function(){
      var open = document.querySelector("[data-compose-pdf-open]");
      var download = document.querySelector("[data-compose-preview-overlay] a[download]");
      var expected = await window.__avl.generatePdfReport();
      var actual = new Uint8Array(await fetch(open.getAttribute("href")).then(function(response){
        return response.arrayBuffer();
      }));
      var same = actual.length === expected.bytes.length;
      if(same){
        for(var i=0;i<actual.length;i++){
          if(actual[i] !== expected.bytes[i]){ same = false; break; }
        }
      }
      return {
        sameHref:open.getAttribute("href") === download.getAttribute("href"),
        head:String.fromCharCode.apply(null,actual.subarray(0,8)),
        length:actual.length,
        expectedLength:expected.bytes.length,
        identical:same
      };
    });
    assert.equal(result.sameHref,true,"both controls must point at one document");
    assert.match(result.head,/^%PDF-1\.4/);
    assert.ok(result.expectedLength > 2000,"the fixture report must be substantial");
    assert.equal(
      result.identical,true,
      "the fallback must serve exactly what generatePdfReport produced for this tap"
    );
    await page.locator("[data-compose-preview-close]").click();
  });
});
