import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchBrowser,
  serve,
  until
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var execFile = promisify(execFileCallback);
var JPG = "data:image/jpeg;base64," + Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEoooryD9EP//Z",
  "base64"
).toString("base64");

async function withCaptionApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
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

async function installCaptionState(page,captions,includeInline){
  return page.evaluate(async function(config){
    function descriptor(record){
      return {
        id:record.id,
        mime:record.mime,
        bytes:record.bytes,
        width:record.width,
        height:record.height
      };
    }
    var first = await window.AVLPhotoStore.addDataUrl(config.jpg,8,6);
    var second = await window.AVLPhotoStore.addDataUrl(config.jpg,8,6);
    var firstDescriptor = descriptor(first);
    var secondDescriptor = descriptor(second);
    var map = {};
    if(config.captions[0]) map[first.id] = config.captions[0];
    if(config.captions[1]) map[second.id] = config.captions[1];
    var list = [firstDescriptor,secondDescriptor];
    if(config.includeInline) list.push(config.jpg);
    await window.__avl.setDescriptorStateForTest({
      visit:{
        client:"Caption Client",
        site:"Caption Site",
        date:"2026-07-30",
        surveyor:"Jonathan"
      },
      log:{},
      rooms:[{id:1,d:{name:"Caption Room"}}],
      photos:{"1|audio":list},
      captions:map,
      skipped:{},
      ui:{}
    });
    return {
      ids:[first.id,second.id],
      descriptors:[firstDescriptor,secondDescriptor]
    };
  },{jpg:JPG,captions:captions,includeInline:!!includeInline});
}

function parseCsv(text){
  var rows = [];
  var row = [];
  var field = "";
  var quoted = false;
  for(var i=0;i<text.length;i++){
    var character = text.charAt(i);
    if(quoted){
      if(character === '"' && text.charAt(i+1) === '"'){
        field += '"';
        i++;
      } else if(character === '"'){
        quoted = false;
      } else {
        field += character;
      }
    } else if(character === '"'){
      quoted = true;
    } else if(character === ","){
      row.push(field);
      field = "";
    } else if(character === "\r" && text.charAt(i+1) === "\n"){
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += character;
    }
  }
  assert.equal(quoted,false);
  return rows;
}

async function optionalTool(t,command,args){
  try {
    return await execFile(command,args);
  } catch(error){
    if(error && error.code === "ENOENT"){
      t.diagnostic(command + " is not installed locally; CI runs this independent gate");
      return null;
    }
    throw error;
  }
}

test("schema 3 migrates to a strict id-keyed caption map", async function(){
  await withCaptionApp(async function(page){
    var result = await page.evaluate(function(){
      var descriptor = {
        id:"photo-one",
        mime:"image/jpeg",
        bytes:10,
        width:8,
        height:6
      };
      var migrated = window.__avl.migrate({
        app:"avl-survey",
        schema:3,
        data:{
          visit:{},
          log:{},
          rooms:[],
          photos:{"1|audio":[descriptor]},
          skipped:{},
          ui:{},
          meta:{created:"old",updated:"old",app:"1.16.1"}
        }
      });
      function state(captions){
        return {
          visit:{},
          log:{},
          rooms:[],
          photos:{"1|audio":[descriptor]},
          captions:captions,
          skipped:{},
          ui:{},
          meta:{}
        };
      }
      return {
        migrated:migrated,
        array:window.__avl.validate(state([])),
        number:window.__avl.validate(state({"photo-one":7})),
        orphan:window.__avl.validate(state({"not-a-photo":"note"})),
        blank:window.__avl.validate(state({"photo-one":"   "})),
        tooLong:window.__avl.validate(state({"photo-one":new Array(242).join("x")})),
        good:window.__avl.validate(state({"photo-one":"Rack input"})),
        inlineSet:window.__avl.photoCaptions.set(state({}),"data:image/jpeg;base64,AA==","No")
      };
    });
    assert.equal(result.migrated.ok,true);
    assert.equal(result.migrated.from,3);
    assert.deepEqual(result.migrated.data.captions,{});
    assert.equal(result.array.ok,false);
    assert.equal(result.number.ok,false);
    assert.equal(result.orphan.ok,false);
    assert.equal(result.blank.ok,false);
    assert.equal(result.tooLong.ok,false);
    assert.deepEqual(result.good,{ok:true});
    assert.equal(result.inlineSet,false,"legacy inline photos must not gain captions");
  });
});

test("Photos is the only caption editor; identity survives reordering and deletion removes the caption", async function(){
  await withCaptionApp(async function(page){
    var installed = await installCaptionState(page,["First note","Second note"],true);
    var beforeSwitch = await page.evaluate(function(){
      return document.querySelectorAll("[data-photo-caption]").length;
    });
    assert.equal(beforeSwitch,0,"Survey view must not expose caption editing");

    await page.locator('[data-app-view="photos"]').click();
    assert.equal(await page.locator("[data-photo-caption]").count(),2);
    assert.equal(await page.locator("[data-photo-caption]").first().getAttribute("maxlength"),"240");

    var identity = await page.evaluate(function(){
      var list = window.__avl.S().photos["1|audio"];
      list.reverse();
      var manifest = window.__avl.photoManifest();
      var result = manifest.map(function(entry){
        return {
          id:window.__avl.S().photos[entry.key][entry.bucketIndex].id || "inline",
          caption:entry.caption
        };
      });
      list.reverse();
      return result;
    });
    assert.deepEqual(identity,[
      {id:"inline",caption:""},
      {id:installed.ids[1],caption:"Second note"},
      {id:installed.ids[0],caption:"First note"}
    ]);

    await page.locator("[data-photo-caption]").first().fill("  Updated rack input  ");
    await until(async function(){
      return page.evaluate(function(){
        return Object.values(window.__avl.S().captions).indexOf("Updated rack input") > -1;
      });
    });
    assert.equal(
      await page.evaluate(function(){
        return Object.values(window.__avl.S().captions).some(function(value){
          return /^\s|\s$/.test(value);
        });
      }),
      false
    );

    var firstDelete = page.locator('[data-photos="1|audio"] [data-delph="0"]');
    await firstDelete.click();
    await firstDelete.click();
    assert.equal(
      await page.evaluate(function(id){
        return Object.prototype.hasOwnProperty.call(window.__avl.S().captions,id);
      },installed.ids[0]),
      false
    );
    assert.deepEqual(
      await page.evaluate(function(){ return window.__avl.validate(window.__avl.S()); }),
      {ok:true}
    );
  });
});

test("captions round-trip through the package, reports, CSV and CRM without leaking device ids", async function(t){
  await withCaptionApp(async function(page){
    var pdfCaption = "Rack (left) \\\\ feed";
    var hostileCaption = '<script>alert("x")</script>, & \'quoted\'\nSecond line';
    var installed = await installCaptionState(page,[pdfCaption,hostileCaption],false);

    await page.evaluate(function(){ window.__avl.preparePhotoPackage(); });
    await until(async function(){
      return page.evaluate(function(){
        var status = window.__avl.photoPackageStatus();
        return status.status === "ready" || status.status === "error";
      });
    },15000);

    var result = await page.evaluate(async function(config){
      var file = window.__avl.photoPackageFile();
      var bytes = new Uint8Array(await file.arrayBuffer());
      var archive = window.__avl.zipReadStore(bytes);
      var jsonName = archive.root + "/data/survey-export.json";
      var csvName = archive.root + "/data/photo-manifest.csv";
      var htmlName = archive.names.filter(function(name){ return /\.html$/.test(name); })[0];
      var pdfName = archive.names.filter(function(name){ return /\.pdf$/.test(name); })[0];
      var json = new TextDecoder().decode(archive.entries[jsonName].bytes);
      var csvBytes = archive.entries[csvName].bytes;
      var csv = new TextDecoder().decode(csvBytes.subarray(3));
      var html = new TextDecoder().decode(archive.entries[htmlName].bytes);
      var model = window.__avl.buildReportModel();
      var crm = window.__avl.crmNoteText();
      var token = window.__avl.pdfTextToken(config.pdfCaption);
      var fallbackToken = window.__avl.pdfTextToken("Signal \u6f22\u5b57 \ud83d\ude80");
      var oldIds = Object.keys(window.__avl.S().captions);
      var imported = await window.__avl.applyPackageImport(bytes);
      var newIds = Object.keys(window.__avl.S().captions);
      var importedCaptions = newIds.map(function(id){ return window.__avl.S().captions[id]; });
      var captionsByPhoto = window.__avl.S().photos["1|audio"].map(function(entry){
        return window.__avl.S().captions[entry.id] || "";
      });

      function rebuilt(mutator){
        var parsed = window.__avl.zipReadStore(bytes);
        var payload = JSON.parse(new TextDecoder().decode(parsed.entries[jsonName].bytes));
        mutator(payload);
        var entries = parsed.names.map(function(name){
          return {
            name:name,
            bytes:name === jsonName
              ? new TextEncoder().encode(JSON.stringify(payload))
              : parsed.entries[name].bytes
          };
        });
        return window.__avl.zipStore(entries).arrayBuffer().then(function(buffer){
          return new Uint8Array(buffer);
        });
      }

      var calls = 0;
      var originalAdd = window.AVLPhotoStore.addRecord;
      window.AVLPhotoStore.addRecord = function(record){
        calls++;
        return originalAdd.call(window.AVLPhotoStore,record);
      };
      var badNumber = await window.__avl.applyPackageImport(await rebuilt(function(payload){
        payload.data.photos["1|audio"][0].caption = 7;
      }));
      var afterNumberCalls = calls;
      var badObject = await window.__avl.applyPackageImport(await rebuilt(function(payload){
        payload.data.photos["1|audio"][0].caption = {text:"bad"};
      }));
      var afterObjectCalls = calls;
      var legacy = await window.__avl.applyPackageImport(await rebuilt(function(payload){
        payload.schema = 3;
        delete payload.data.captions;
        Object.keys(payload.data.photos).forEach(function(key){
          payload.data.photos[key].forEach(function(item){ delete item.caption; });
        });
      }));
      window.AVLPhotoStore.addRecord = originalAdd;

      return {
        bytes:Array.from(bytes),
        pdf:Array.from(archive.entries[pdfName].bytes),
        json:json,
        csv:csv,
        html:html,
        model:model,
        crm:crm,
        token:token,
        fallbackToken:fallbackToken,
        imported:imported,
        oldIds:oldIds,
        newIds:newIds,
        importedCaptions:importedCaptions,
        captionsByPhoto:captionsByPhoto,
        badNumber:badNumber,
        badObject:badObject,
        afterNumberCalls:afterNumberCalls,
        afterObjectCalls:afterObjectCalls,
        legacy:legacy,
        legacyMessage:document.getElementById("toast").textContent,
        legacyCaptions:window.__avl.S().captions
      };
    },{pdfCaption:pdfCaption});

    assert.equal(result.imported,true);
    assert.equal(result.oldIds.some(function(id){ return result.newIds.indexOf(id) > -1; }),false);
    assert.deepEqual(result.importedCaptions.sort(),[hostileCaption,pdfCaption].sort());
    assert.deepEqual(result.captionsByPhoto,[pdfCaption,hostileCaption]);
    result.oldIds.forEach(function(id){ assert.doesNotMatch(result.json,new RegExp(id)); });
    var packaged = JSON.parse(result.json);
    assert.deepEqual(packaged.data.captions,{});
    assert.deepEqual(
      packaged.data.photos["1|audio"].map(function(item){ return item.caption; }),
      [pdfCaption,hostileCaption]
    );

    assert.equal(result.model.photos[0].caption,pdfCaption);
    assert.equal(result.model.photos[1].caption,hostileCaption);
    assert.match(result.crm,/AUDIO[\s\S]*Photo 001: Rack \(left\) \\\\ feed/);
    assert.match(result.crm,/Photo 002: <script>alert\("x"\)<\/script>, & 'quoted'/);
    assert.equal(result.token,"(Rack \\(left\\) \\\\\\\\ feed)");
    assert.match(result.fallbackToken,/\?\? \?/);

    assert.doesNotMatch(result.html,/<script>alert\("x"\)<\/script>/);
    assert.match(result.html,/&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;, &amp; &#39;quoted&#39;/);
    assert.match(result.html,/data-caption="&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;, &amp; &#39;quoted&#39;/);

    var rows = parseCsv(result.csv);
    assert.equal(rows.length,3);
    assert.equal(rows[0][rows[0].length-1],"caption");
    assert.equal(rows[1][rows[1].length-1],pdfCaption);
    assert.equal(rows[2][rows[2].length-1],hostileCaption);

    assert.equal(result.badNumber,false);
    assert.equal(result.badObject,false);
    assert.equal(result.afterNumberCalls,0);
    assert.equal(result.afterObjectCalls,0);
    assert.equal(result.legacy,true,result.legacyMessage);
    assert.deepEqual(result.legacyCaptions,{});

    await page.setContent(result.html,{waitUntil:"domcontentloaded"});
    assert.equal(await page.locator(".user-caption").nth(1).textContent(),hostileCaption);
    await page.locator(".photo-open").nth(1).click();
    assert.equal(
      await page.locator("#viewer-caption").textContent(),
      "Caption Room · Audio\n" + hostileCaption
    );

    var scratch = await mkdtemp(join(tmpdir(),"preplot-caption-pdf-"));
    try {
      var pdfPath = join(scratch,"caption-report.pdf");
      await writeFile(pdfPath,Buffer.from(result.pdf));
      var qpdf = await optionalTool(t,"qpdf",["--check",pdfPath]);
      if(qpdf) assert.match(qpdf.stdout + qpdf.stderr,/No syntax or stream encoding errors found/);
      var text = await optionalTool(t,"pdftotext",["-layout",pdfPath,"-"]);
      if(text) assert.match(text.stdout,/Rack \(left\) \\\\ feed/);
    } finally {
      await rm(scratch,{recursive:true,force:true});
    }
  });
});

test("editing a caption invalidates an already prepared package", async function(){
  await withCaptionApp(async function(page){
    await installCaptionState(page,["Before",""],false);
    await page.evaluate(function(){ window.__avl.preparePhotoPackage(); });
    await until(async function(){
      return page.evaluate(function(){
        return window.__avl.photoPackageStatus().status === "ready";
      });
    },15000);
    var result = await page.evaluate(function(){
      var entry = window.__avl.S().photos["1|audio"][0];
      window.__avl.setPhotoCaption(entry,"After");
      var downloaded = window.__avl.downloadPreparedPackage();
      return {
        downloaded:downloaded,
        status:window.__avl.photoPackageStatus().status
      };
    });
    assert.equal(result.downloaded,false);
    assert.equal(result.status,"stale");
  });
});
