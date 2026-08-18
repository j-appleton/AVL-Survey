import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchBrowser,
  serve,
  surveyStateSnapshot
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var RED = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='red'/%3E%3C/svg%3E";
var BLUE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='blue'/%3E%3C/svg%3E";

async function withApp(state,run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({serviceWorkers:"block",viewport:{width:1100,height:844}});
    var page = await context.newPage();
    await page.goto(server.origin + "/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    if(state){
      assert.equal(await page.evaluate(function(payload){
        return window.__avl.applyImport(JSON.stringify(payload));
      },state),true);
    }
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

function existingState(overrides){
  var state = {
    visit:{client:"Scope client",site:"Scope site",date:"2026-08-18"},
    log:{},
    rooms:[{id:1,d:{
      name:"Sanctuary",
      type:"Sanctuary / worship",
      noise:"42",
      lightctl:"DMX",
      archlight:true,
      lightcount:"36",
      ctrl:["Touch panel"],
      inv:"Existing rack"
    }}],
    photos:{},
    skipped:{},
    ui:{}
  };
  Object.keys(overrides || {}).forEach(function(key){ state[key] = overrides[key]; });
  return state;
}

test("new rooms start lean while visit scope starts fully included", async function(){
  await withApp(null,async function(page){
    await page.locator("#addroom").click();
    await page.locator('[data-sec="1|id"] [data-k="seats"]').fill("120");
    var initial = await page.evaluate(function(){
      var state = window.__avl.S();
      return {
        visitPressed:Array.prototype.map.call(
          document.querySelectorAll("[data-visit-scope]"),
          function(button){ return button.getAttribute("aria-pressed"); }
        ),
        roomPressed:Array.prototype.map.call(
          document.querySelectorAll('[data-room-scope-panel="1"] [data-room-section]'),
          function(button){ return button.getAttribute("aria-pressed"); }
        ),
        sections:Array.prototype.map.call(
          document.querySelectorAll('[data-room="1"] [data-sec]'),
          function(section){ return section.getAttribute("data-sec"); }
        ),
        skipped:Object.keys(state.skipped).filter(function(key){ return key.indexOf("1|") === 0; }),
        optional:window.__avl.ROOM_SECTIONS.length - 1,
        schema:window.__avl.SCHEMA
      };
    });
    assert.equal(initial.visitPressed.length,8);
    assert.ok(initial.visitPressed.every(function(value){ return value === "true"; }));
    assert.equal(initial.roomPressed.length,initial.optional);
    assert.ok(initial.roomPressed.every(function(value){ return value === "false"; }));
    assert.deepEqual(initial.sections,["1|id"]);
    assert.equal(initial.skipped.length,initial.optional);
    assert.equal(initial.schema,5);
    var leanReport = await page.evaluate(async function(){
      var model = window.__avl.buildReportModel();
      var report = await window.__avl.generatePdfReport();
      return {cards:model.rooms[0].cards.length,title:model.rooms[0].title,stats:model.rooms[0].stats,bytes:report.bytes.length};
    });
    assert.equal(leanReport.cards,0);
    assert.equal(leanReport.title,"Room 1");
    assert.deepEqual(leanReport.stats,[{label:"Seats",value:"120",qualifier:"occupancy",group:"dimensions"}]);
    assert.ok(leanReport.bytes > 500,"a lean room must still produce a valid report");

    await page.locator('[data-app-view="photos"]').click();
    assert.deepEqual(
      await page.locator('[data-photo-room="1"] [data-photo-group]').evaluateAll(function(groups){
        return groups.map(function(group){ return group.getAttribute("data-photo-group"); });
      }),
      ["1|id"]
    );
  });
});

test("visit scope gates room choices without erasing their local selection or answers", async function(){
  await withApp(null,async function(page){
    await page.locator("#addroom").click();
    await page.locator('[data-room-section="audio"][data-room-id="1"]').click();
    await page.locator('[data-sec="1|audio"] [data-k="noise"]').fill("47");
    var before = await surveyStateSnapshot(page);

    await page.locator('[data-visit-scope="audio"]').click();
    var disabled = await page.evaluate(function(){
      return {
        localSkipped:!!window.__avl.S().skipped["1|audio"],
        answer:window.__avl.S().rooms[0].d.noise,
        selector:!!document.querySelector('[data-room-section="audio"]'),
        section:!!document.querySelector('[data-sec="1|audio"]'),
        effective:window.__avl.roomSectionSelected(1,"audio")
      };
    });
    assert.deepEqual(disabled,{localSkipped:false,answer:"47",selector:false,section:false,effective:false});

    await page.locator('[data-visit-scope="audio"]').click();
    var restored = await page.evaluate(function(){
      return {
        pressed:document.querySelector('[data-room-section="audio"]').getAttribute("aria-pressed"),
        answer:document.querySelector('[data-sec="1|audio"] [data-k="noise"]').value,
        effective:window.__avl.roomSectionSelected(1,"audio")
      };
    });
    assert.deepEqual(restored,{pressed:"true",answer:"47",effective:true});
    assert.equal(await surveyStateSnapshot(page),before,"a disable/enable cycle must preserve the room and its answers");
    assert.equal(await page.evaluate(function(){ return !!window.__avl.S().skipped["1|audio"]; }),false);
  });
});

test("inactive photo buckets stay recoverable but leave reports and CRM scope", async function(){
  var scopedState = existingState({
    photos:{"1|id":[RED],"1|audio":[BLUE]},
    skipped:{"1|audio":true}
  });
  scopedState.visit.coverPhotoId = BLUE;
  await withApp(scopedState,async function(page){
    var outputs = await page.evaluate(function(){
      var manifest = window.__avl.photoManifest();
      var report = window.__avl.buildReportModel(manifest);
      return {
        archive:manifest.map(function(entry){ return entry.key; }),
        report:window.__avl.reportPhotoManifest(manifest).map(function(entry){ return entry.key; }),
        model:report.photos.map(function(entry){ return entry.sectionId; }),
        crm:window.__avl.crmNoteText(),
        cover:report.cover.coverPhoto,
        storedCover:window.__avl.S().visit.coverPhotoId
      };
    });
    assert.deepEqual(outputs.archive,["1|id","1|audio"]);
    assert.deepEqual(outputs.report,["1|id"]);
    assert.deepEqual(outputs.model,["id"]);
    assert.doesNotMatch(outputs.crm,/AUDIO|Ambient noise/);
    assert.equal(outputs.cover,null);
    assert.equal(outputs.storedCover,BLUE);

    await page.locator('[data-app-view="photos"]').click();
    assert.match(await page.locator("[data-cover-card]").innerText(),/outside the current scope/);
    var recovery = page.locator('[data-photo-group="1|audio"]');
    assert.equal(await recovery.count(),1);
    assert.equal(await recovery.evaluate(function(node){ return node.classList.contains("out-of-scope"); }),true);
    assert.equal(await recovery.locator("[data-addph],[data-addexisting]").count(),0);
    assert.equal(await recovery.locator("[data-photo-move]").count(),1);
    assert.match(await recovery.innerText(),/Move or delete/);

    await page.locator('[data-app-view="survey"]').click();
    await page.locator('[data-room-section="audio"]').click();
    assert.equal(await page.evaluate(function(expectedCover){
      var model = window.__avl.buildReportModel();
      return window.__avl.S().visit.coverPhotoId === expectedCover && model.cover.coverPhoto === 1;
    },BLUE),true);
  });
});

test("existing surveys stay included, duplication copies local scope, and disciplines stay separate", async function(){
  await withApp(existingState(),async function(page){
    var existing = await page.evaluate(function(){
      var model = window.__avl.buildReportModel(window.__avl.photoManifest());
      return {
        selected:window.__avl.ROOM_SECTIONS.every(function(section){
          return window.__avl.roomSectionSelected(1,section.id);
        }),
        lighting:!!document.querySelector('[data-sec="1|lighting"]'),
        control:!!document.querySelector('[data-sec="1|control"]'),
        existing:!!document.querySelector('[data-sec="1|exist"]'),
        lightingRow:model.rooms[0].rows.some(function(row){
          return row.label === "Lighting \u00b7 Architectural light count" && row.value === "36";
        }),
        cards:model.rooms[0].cards.map(function(card){ return card.header; })
      };
    });
    assert.deepEqual(existing,{
      selected:true,
      lighting:true,
      control:true,
      existing:true,
      lightingRow:true,
      cards:["Existing equipment","Control"]
    });

    var fullProgress = await page.locator("#corechip").innerText();
    await page.locator("[data-visit-scope-clear]").click();
    assert.deepEqual(
      await page.locator('[data-room-scope-panel="1"] [data-room-section]').evaluateAll(function(buttons){
        return buttons.map(function(button){ return button.getAttribute("data-room-section"); });
      }),
      ["dims","notes"]
    );
    assert.equal(await page.evaluate(function(){ return window.__avl.roomSectionSelected(1,"audio"); }),false);
    assert.notEqual(await page.locator("#corechip").innerText(),fullProgress);
    await page.locator("[data-visit-scope-all]").click();
    assert.equal(await page.locator("#corechip").innerText(),fullProgress);
    assert.equal(await page.evaluate(function(){
      return window.__avl.roomSectionSelected(1,"audio") &&
        window.__avl.S().rooms[0].d.noise === "42";
    }),true);

    await page.locator('[data-skip="1|audio"]').click();
    await page.locator('[data-dup="1"]').click();
    var copy = await page.evaluate(function(){
      return {
        audio:window.__avl.roomSectionSelected(2,"audio"),
        lighting:window.__avl.roomSectionSelected(2,"lighting"),
        value:window.__avl.S().rooms[1].d.lightcount,
        skipped:!!window.__avl.S().skipped["2|audio"]
      };
    });
    assert.deepEqual(copy,{audio:false,lighting:true,value:"36",skipped:true});
  });
});

test("the legacy combined equipment skip repairs once without coupling the new sections", async function(){
  await withApp(existingState({skipped:{"1|exist":true}}),async function(page){
    var repaired = await page.evaluate(function(){
      return {
        equipment:window.__avl.roomSectionSelected(1,"exist"),
        control:window.__avl.roomSectionSelected(1,"control"),
        lighting:window.__avl.roomSectionSelected(1,"lighting"),
        marker:window.__avl.S().meta.roomScopeVersion
      };
    });
    assert.deepEqual(repaired,{equipment:false,control:false,lighting:false,marker:2});

    await page.locator('[data-room-section="control"]').click();
    assert.deepEqual(await page.evaluate(function(){
      return {
        equipment:window.__avl.roomSectionSelected(1,"exist"),
        control:window.__avl.roomSectionSelected(1,"control"),
        lighting:window.__avl.roomSectionSelected(1,"lighting")
      };
    }),{equipment:false,control:true,lighting:false});
  });
});
