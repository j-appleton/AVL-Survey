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
var JPG = "data:image/jpeg;base64,AQID";
var PNG = "data:image/png;base64,BAUG";

async function withApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function importState(page, state){
  var imported = await page.evaluate(function(payload){
    return window.__avl.applyImport(JSON.stringify(payload));
  }, state);
  assert.equal(imported, true);
}

test("photo manifest follows canonical order and never drops unknown buckets", async function(){
  await withApp(async function(page){
    await importState(page, {
      visit:{site:"Ordering site"},
      log:{},
      rooms:[
        {id:1,d:{name:"First room"}},
        {id:3,d:{name:"Second room"}},
        {id:7,d:{name:"Third room"}}
      ],
      /* Deliberately opposite the required consuming order. */
      photos:{
        garbage:[JPG],
        "9|walk:entrance":[JPG],
        "7|walk:entrance":[JPG],
        "3|notes":[JPG],
        "3|walk:exit":[JPG],
        "1|walk:z":[JPG],
        "1|disp":[JPG],
        "1|id":[JPG],
        "log|main":[JPG,JPG]
      },
      skipped:{},
      ui:{}
    });

    var result = await page.evaluate(function(){
      return {
        count:window.__avl.photoCount(),
        manifest:window.__avl.photoManifest()
      };
    });

    assert.equal(result.manifest.length, result.count);
    assert.deepEqual(
      result.manifest.map(function(entry){ return entry.key; }),
      [
        "log|main","log|main",
        "1|id","1|disp","3|notes",
        "1|walk:z","3|walk:exit","7|walk:entrance",
        "9|walk:entrance","garbage"
      ]
    );
    assert.deepEqual(
      result.manifest.map(function(entry){ return entry.filename; }),
      [
        "001_SITE_logistics.jpg",
        "002_SITE_logistics.jpg",
        "003_R01_room.jpg",
        "004_R01_display.jpg",
        "005_R02_notes.jpg",
        "006_R01_walk-z.jpg",
        "007_R02_walk-exit.jpg",
        "008_R03_walk-entrance.jpg",
        "009_SITE_walk-entrance.jpg",
        "010_SITE_garbage.jpg"
      ]
    );
    assert.deepEqual(
      result.manifest.map(function(entry){ return entry.roomLabel; }),
      ["SITE","SITE","R01","R01","R02","R01","R02","R03","SITE","SITE"]
    );
    assert.deepEqual(
      result.manifest.map(function(entry){ return entry.bucketIndex; }),
      [0,1,0,0,0,0,0,0,0,0]
    );
    assert.equal(result.manifest[8].roomId, "9");
    assert.equal(result.manifest[9].roomId, null);
  });
});

test("photo manifest uses MIME extensions and frozen section labels without mutating state", async function(){
  await withApp(async function(page){
    await importState(page, {
      visit:{},
      log:{},
      rooms:[{id:1,d:{name:"Boardroom"}}],
      photos:{"1|disp":[PNG]},
      skipped:{},
      ui:{}
    });
    var before = await surveyStateSnapshot(page);
    var result = await page.evaluate(function(){
      var displaySection = window.__avl.ROOM_SECTIONS.filter(function(section){
        return section.id === "disp";
      })[0];
      var originalTitle = displaySection.title;
      displaySection.title = "Screens and client-facing visuals";
      try {
        return window.__avl.photoManifest();
      } finally {
        displaySection.title = originalTitle;
      }
    });
    var after = await surveyStateSnapshot(page);

    assert.equal(after, before);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      ref:"001",
      filename:"001_R01_display.png",
      key:"1|disp",
      bucketIndex:0,
      roomId:1,
      roomLabel:"R01",
      roomName:"Boardroom",
      sectionId:"disp",
      sectionLabel:"Display",
      mime:"image/png",
      sourceLength:PNG.length
    });
  });
});

test("declared photo section slugs stay complete, distinct and stable", async function(){
  await withApp(async function(page){
    var sectionIds = [
      "id","dims","light","disp","audio","power","net","path","exist","notes"
    ];
    var photos = {"log|main":[JPG]};
    sectionIds.forEach(function(id){ photos["1|" + id] = [JPG]; });
    await importState(page, {
      visit:{},
      log:{},
      rooms:[{id:1,d:{name:"Mapped room"}}],
      photos:photos,
      skipped:{},
      ui:{}
    });

    var filenames = await page.evaluate(function(){
      return window.__avl.photoManifest().map(function(entry){
        return entry.filename;
      });
    });
    var slugs = filenames.map(function(filename){
      return filename
        .replace(/^\d+_[^_]+_/,"")
        .replace(/\.[^.]+$/,"");
    });

    assert.deepEqual(slugs, [
      "logistics",
      "room",
      "dimensions",
      "ambient-light",
      "display",
      "audio",
      "power",
      "network",
      "pathways",
      "existing-equipment",
      "notes"
    ]);
    assert.equal(new Set(slugs).size, slugs.length);
    assert.equal(new Set(filenames).size, filenames.length);
  });
});

test("empty buckets add nothing and references expand beyond three digits", async function(){
  await withApp(async function(page){
    await importState(page, {
      visit:{},
      log:{},
      rooms:[],
      photos:{"log|main":[]},
      skipped:{},
      ui:{}
    });
    assert.deepEqual(
      await page.evaluate(function(){ return window.__avl.photoManifest(); }),
      []
    );

    var sources = new Array(1000).fill(JPG);
    await importState(page, {
      visit:{},
      log:{},
      rooms:[],
      photos:{"log|main":sources},
      skipped:{},
      ui:{}
    });
    var refs = await page.evaluate(function(){
      var manifest = window.__avl.photoManifest();
      return {
        count:manifest.length,
        penultimate:manifest[998].ref,
        last:manifest[999].ref,
        lastFilename:manifest[999].filename
      };
    });
    assert.deepEqual(refs, {
      count:1000,
      penultimate:"999",
      last:"1000",
      lastFilename:"1000_SITE_logistics.jpg"
    });
  });
});
