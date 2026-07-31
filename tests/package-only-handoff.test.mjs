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
var RED = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">' +
  '<rect width="900" height="600" fill="red"/></svg>'
);
var BLUE = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">' +
  '<rect width="900" height="600" fill="blue"/></svg>'
);

async function withApp(state,run){
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
    if(state){
      var imported = await page.evaluate(function(value){
        return window.__avl.applyImport(JSON.stringify(value));
      },state);
      assert.equal(imported,true);
    }
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

function photoState(){
  return {
    visit:{client:"Cover client",site:"Cover site",date:"2026-07-30"},
    log:{},
    rooms:[{id:1,d:{name:"Cover room"}}],
    photos:{"log|main":[RED],"1|notes":[BLUE]},
    skipped:{},
    ui:{}
  };
}

function crmState(){
  return {
    visit:{
      client:"Müller & Sons",
      site:"North Campus",
      date:"2026-07-30",
      surveyor:"",
      contact:"",
      itc:"",
      scope:"Replace the room system.\nCoordinate around classes."
    },
    log:{
      access:"issue",
      access_note:"Dock closes at 16:00.",
      elev:"",
      hours:"",
      badge:"",
      storage:"",
      lognote:""
    },
    rooms:[{id:1,d:{
      name:"Boardroom",
      type:"Conference",
      seats:"",
      use:"",
      len:"30",
      wid:"",
      hgt:"",
      wall:["Drywall","Glass"],
      back:"issue",
      back_note:"Add blocking.\nVerify wall depth.",
      lt_time:"",
      lt_sky:"",
      lt_shade:"",
      lt_src:[],
      lux_disp:"210",
      lux_mid:"",
      lux_rear:"",
      lux_preset:"",
      disptype:"Direct-view (LCD / LED)",
      scr_diag:"",
      scr_gain:"",
      flags:"First line\nSecond line"
    }}],
    photos:{},
    skipped:{"1|audio":true},
    ui:{}
  };
}

test("cover selection is loud, deliberate and has no silent first-photo fallback", async function(){
  await withApp(photoState(),async function(page){
    await page.locator('[data-app-view="photos"]').click();
    var initial = await page.evaluate(function(){
      return {
        card:document.querySelector("[data-cover-card]").innerText,
        cover:window.__avl.buildReportModel().cover.coverPhoto,
        badges:document.querySelectorAll(".cover-badge").length
      };
    });
    assert.match(initial.card,/No report cover selected/);
    assert.match(initial.card,/plain cover/);
    assert.equal(initial.cover,null);
    assert.equal(initial.badges,0);

    await page.locator("[data-cover-choose]").click();
    await page.locator('[data-photos="1|notes"] [data-viewph]').click();
    assert.equal(await page.locator("[data-cover-confirm]").isVisible(),true);
    assert.match(await page.locator("[data-cover-card]").innerText(),/002_R01_notes/);
    await page.locator("[data-cover-confirm]").click();

    var selected = await page.evaluate(function(){
      var manifest = window.__avl.photoManifest();
      return {
        stored:window.__avl.S().visit.coverPhotoId,
        expected:window.__avl.S().photos["1|notes"][0],
        cover:window.__avl.buildReportModel(manifest).cover.coverPhoto,
        badges:Array.prototype.map.call(document.querySelectorAll(".cover-badge"),function(node){
          return node.textContent;
        })
      };
    });
    assert.equal(selected.stored,selected.expected);
    assert.equal(selected.cover,1);
    assert.deepEqual(selected.badges,["Cover"]);

    await page.locator("[data-cover-remove]").click();
    assert.equal(await page.evaluate(function(){
      return window.__avl.buildReportModel().cover.coverPhoto;
    }),null);
    assert.match(await page.locator("[data-cover-card]").innerText(),/plain cover/);
  });
});

test("photos and their recovery controls exist only in the Photos tab", async function(){
  await withApp(photoState(),async function(page){
    var survey = await page.evaluate(function(){
      return {
        strips:document.querySelectorAll("[data-photos]").length,
        adds:document.querySelectorAll("[data-addph]").length,
        recoveries:document.querySelectorAll("[data-photo-recovery]").length
      };
    });
    assert.deepEqual(survey,{strips:0,adds:0,recoveries:0});
    await page.locator('[data-app-view="photos"]').click();
    assert.equal(await page.locator("[data-photos]").count() > 0,true);
    assert.equal(await page.locator("[data-addph]").count() > 0,true);
  });
});

test("the complete package is the only outward handoff in the interface", async function(){
  await withApp(crmState(),async function(page){
    var result = await page.evaluate(function(){
      var footer = Array.prototype.map.call(document.querySelectorAll(".foot button"),function(button){
        return button.textContent.trim();
      });
      return {
        footer:footer,
        exportButton:!!document.getElementById("save"),
        pdfButton:!!document.getElementById("pdf"),
        rawButton:!!document.getElementById("raw"),
        exportFunction:typeof window.__avl.exportJSON,
        printFunction:typeof window.__avl.buildPrint,
        restoreLabel:document.getElementById("imp").textContent,
        utility:document.getElementById("imp").closest(".card").innerText
      };
    });
    assert.deepEqual(result.footer,["+ Room","Package"]);
    assert.equal(result.exportButton,false);
    assert.equal(result.pdfButton,false);
    assert.equal(result.rawButton,false);
    assert.equal(result.exportFunction,"undefined");
    assert.equal(result.printFunction,"undefined");
    assert.equal(result.restoreLabel,"Restore from package");
    assert.match(result.utility,/Import a \.zip package or an older \.json backup/);

    await page.locator('[data-app-view="photos"]').click();
    await page.locator("#pkgjump").click();
    assert.equal(await page.evaluate(function(){ return window.__avl.appView(); }),"survey");
    assert.equal(await page.locator("#photopackagewrap").count(),1);
  });
});

test("CRM note walks canonical fields, preserves blanks and ships once at the archive root", async function(){
  await withApp(crmState(),async function(page){
    var before = await surveyStateSnapshot(page);
    var direct = await page.evaluate(function(){
      var text = window.__avl.crmNoteText();
      var dimensions = window.__avl.ROOM_SECTIONS.filter(function(section){
        return section.id === "dims";
      })[0];
      dimensions.fields.push({k:"future_field",l:"Future field",t:"text"});
      window.__avl.S().rooms[0].d.future_field = "Arrived automatically";
      var expanded = window.__avl.crmNoteText();
      dimensions.fields.pop();
      delete window.__avl.S().rooms[0].d.future_field;
      return {
        text:text,
        expanded:expanded,
        lightLabels:window.__avl.LIGHT_FIELDS.map(function(field){ return field.l; })
      };
    });
    assert.equal(direct.text.charCodeAt(0) === 0xFEFF,false,"CRM notes must not carry a BOM");
    assert.doesNotMatch(direct.text,/(^|[^\r])\n/,"every line break must be CRLF");
    assert.match(direct.text,/Client \/ organisation: Müller & Sons/);
    assert.match(direct.text,/Surveyor: \r\n/,"blank fields must remain present");
    assert.match(direct.text,/Scope as understood on arrival: Replace the room system\.\r\n  Coordinate around classes\./);
    assert.match(direct.text,/Delivery \/ dock access OK: ISSUE — Dock closes at 16:00\./);
    assert.match(direct.text,/Wall construction: Drywall, Glass/);
    assert.match(direct.text,/Backing \/ blocking present at display wall: ISSUE — Add blocking\.\r\n  Verify wall depth\./);
    assert.match(direct.text,/At display wall: 210 lux\r\n/,"lux readings must carry their unit");
    assert.match(direct.text,/Mid seating: \r\n/,"an unmeasured lux field must stay blank, not read \"lux\"");
    direct.lightLabels.forEach(function(label){
      assert.match(direct.text,new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + ":"));
    });
    assert.match(direct.text,/AUDIO\r\nNot applicable/);
    assert.doesNotMatch(direct.text,/Ambient noise \(dBA\):/);
    assert.match(direct.expanded,/Future field: Arrived automatically/);
    assert.doesNotMatch(direct.text,/data:image|coverPhotoId|photoFormat/);

    await page.evaluate(function(){ window.__avl.preparePhotoPackage(); });
    await until(async function(){
      return page.evaluate(function(){ return window.__avl.photoPackageStatus().status === "ready"; });
    },20000);
    var archive = await page.evaluate(async function(){
      var file = window.__avl.photoPackageFile();
      var zip = window.__avl.zipReadStore(new Uint8Array(await file.arrayBuffer()));
      var name = zip.root + "/" + zip.root + "-crm-note.txt";
      var notes = zip.names.filter(function(entry){ return /-crm-note\.txt$/.test(entry); });
      return {
        names:notes,
        expected:name,
        text:new TextDecoder("utf-8").decode(zip.entries[name].bytes),
        packageSize:file.size
      };
    });
    assert.deepEqual(archive.names,[archive.expected]);
    assert.equal(archive.text,direct.text);
    assert.doesNotMatch(archive.text,/data:image/);
    assert.ok(archive.text.length < 20000);
    assert.equal(await surveyStateSnapshot(page),before);
  });
});

test("editing any reported field makes an already prepared package stale", async function(){
  await withApp(crmState(),async function(page){
    await page.evaluate(function(){ window.__avl.preparePhotoPackage(); });
    await until(async function(){
      return page.evaluate(function(){ return window.__avl.photoPackageStatus().status === "ready"; });
    },20000);
    var result = await page.evaluate(function(){
      window.__avl.S().rooms[0].d.gen = "Added after preparation";
      var downloaded = window.__avl.downloadPreparedPackage();
      return {
        downloaded:downloaded,
        status:window.__avl.photoPackageStatus().status,
        message:window.__avl.photoPackageStatus().message
      };
    });
    assert.equal(result.downloaded,false);
    assert.equal(result.status,"stale");
    assert.match(result.message,/Survey changed since preparation/);
  });
});
