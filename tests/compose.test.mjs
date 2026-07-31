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

test("real PDF and HTML previews preserve state and revoke every preview URL", async function(){
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
      var original = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = function(url){ window.__composeRevoked.push(url); return original(url); };
    });
    var pdfOpen = await page.evaluate(async function(){
      var first = window.__avl.openComposePreview("pdf");
      var overlap = await window.__avl.openComposePreview("html");
      return {first:await first,overlap:overlap};
    });
    assert.deepEqual(pdfOpen,{first:true,overlap:false});
    assert.equal(await page.locator("[data-compose-preview-overlay] iframe").count(),1);
    var pdfUrls = await page.evaluate(function(){ return window.__avl.composePreviewUrls(); });
    await page.locator("[data-compose-preview-close]").click();
    assert.equal(await surveyStateSnapshot(page),before);
    assert.equal(await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; }),"ready");
    var pdfRevoked = await page.evaluate(function(){ return window.__composeRevoked.slice(); });
    pdfUrls.forEach(function(url){ assert.ok(pdfRevoked.indexOf(url) > -1); });

    assert.equal(await page.evaluate(function(){ return window.__avl.openComposePreview("html"); }),true);
    var htmlUrls = await page.evaluate(function(){ return window.__avl.composePreviewUrls(); });
    await page.locator("[data-compose-preview-close]").click();
    assert.equal(await surveyStateSnapshot(page),before);
    assert.equal(await page.evaluate(function(){ return window.__avl.photoPackageStatus().status; }),"ready");
    var revoked = await page.evaluate(function(){ return window.__composeRevoked.slice(); });
    htmlUrls.forEach(function(url){ assert.ok(revoked.indexOf(url) > -1); });
    assert.equal(await page.evaluate(function(){ return window.__avl.composePreviewUrls().length; }),0);
  });
});
