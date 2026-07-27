import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var LEGACY_V1 = JSON.parse(
  await readFile(join(ROOT, "tests", "fixtures", "legacy-v1.json"), "utf8")
);
var PORTABLE_V3 = JSON.parse(
  await readFile(join(ROOT, "tests", "fixtures", "portable-v3.json"), "utf8")
);
var PACKAGE_VERSION = JSON.parse(
  await readFile(join(ROOT, "package.json"), "utf8")
).version;
var PACKAGE_LOCK = JSON.parse(
  await readFile(join(ROOT, "package-lock.json"), "utf8")
);
var MANIFEST = JSON.parse(
  await readFile(join(ROOT, "manifest.webmanifest"), "utf8")
);
var INDEX_SOURCE = await readFile(join(ROOT, "index.html"), "utf8");

test("data migrations, validation, backup, salvage, and storage warnings", async function(){
  var server = await serve(ROOT);
  var browser = await launchBrowser();

  try {
    var context = await browser.newContext({serviceWorkers:"allow"});
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });

    var versions = await page.evaluate(function(){
      return {app:window.__avl.APP_VERSION, schema:window.__avl.SCHEMA};
    });
    assert.deepEqual(versions, {app:PACKAGE_VERSION, schema:3});
    assert.equal(PACKAGE_LOCK.version, PACKAGE_VERSION);
    assert.equal(PACKAGE_LOCK.packages[""].version, PACKAGE_VERSION);

    var branding = await page.evaluate(function(){
      return {
        title:document.title,
        heading:document.querySelector("header h1").textContent.trim(),
        apple:document.querySelector('meta[name="apple-mobile-web-app-title"]').content,
        subtitle:document.getElementById("hdsub")
      };
    });
    assert.equal(MANIFEST.name,MANIFEST.short_name);
    assert.equal(branding.title,MANIFEST.name);
    assert.equal(branding.heading,MANIFEST.name);
    assert.equal(branding.apple,MANIFEST.name);
    assert.equal(branding.subtitle,null,"the old header subtitle must be removed, not emptied");
    assert.match(INDEX_SOURCE,/<h1>AV Pre-Install Site Survey<\/h1>/);
    assert.match(INDEX_SOURCE,/Prepared with Preplot/);

    var migration = await page.evaluate(function(payload){
      return window.__avl.migrate(payload);
    }, LEGACY_V1);
    assert.equal(migration.ok, true);
    assert.equal(migration.from, 1);
    assert.equal(migration.data.meta.migratedFrom, 2);
    assert.equal(migration.data.rooms[0].d.name, "Legacy room");

    var schema2Migration = await page.evaluate(function(){
      return window.__avl.migrate({
        app:"avl-survey",
        schema:2,
        data:{
          visit:{client:"Schema 2 client"},
          log:{},
          rooms:[],
          photos:{},
          skipped:{},
          ui:{},
          meta:{
            created:"2026-07-20T10:00:00.000Z",
            updated:"2026-07-21T11:00:00.000Z",
            app:"1.9.1",
            retained:"keep me"
          }
        }
      });
    });
    assert.equal(schema2Migration.ok,true);
    assert.deepEqual(schema2Migration.data.meta,{
      created:"2026-07-20T10:00:00.000Z",
      updated:"2026-07-21T11:00:00.000Z",
      app:"1.9.1",
      retained:"keep me",
      migratedFrom:2
    });

    var rejectionResults = await page.evaluate(function(){
      return {
        foreign:window.__avl.migrate({hello:"world"}),
        future:window.__avl.migrate({
          app:"avl-survey",
          schema:99,
          data:{visit:{},log:{},rooms:[],photos:{},skipped:{},ui:{}}
        }),
        malformed:window.__avl.migrate({
          app:"avl-survey",
          schema:2,
          data:{visit:{},log:{},rooms:"not-a-list",photos:{},skipped:{},ui:{}}
        })
      };
    });
    assert.equal(rejectionResults.foreign.ok, false);
    assert.match(rejectionResults.foreign.reason, /not an AVL survey export/);
    assert.equal(rejectionResults.future.ok, false);
    assert.match(rejectionResults.future.reason, /newer version/);
    assert.equal(rejectionResults.malformed.ok, false);
    assert.match(rejectionResults.malformed.reason, /rooms is not a list/);

    await page.evaluate(function(payload){
      localStorage.clear();
      window.__avl.setRaw(JSON.stringify(payload));
    }, LEGACY_V1);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){
      return window.__avl && window.__avl.S().visit.client === "Legacy client";
    });
    await page.waitForTimeout(350);

    var persistedMigration = await page.evaluate(function(){
      return JSON.parse(window.__avl.raw());
    });
    assert.equal(persistedMigration.schema, 3);
    assert.equal(persistedMigration.data.visit.client, "Legacy client");

    var rejectedImport = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        app:"avl-survey",
        schema:2,
        data:{visit:{client:"Bad overwrite"},rooms:"broken"}
      }));
    });
    assert.equal(rejectedImport, false);
    assert.equal(
      await page.evaluate(function(){ return window.__avl.S().visit.client; }),
      "Legacy client"
    );

    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Imported client"},
        log:{},
        rooms:[{id:11,d:{name:"Imported room"}}],
        photos:{},
        skipped:{},
        ui:{}
      }));
    });
    assert.equal(imported, true);
    assert.equal(
      await page.evaluate(function(){ return window.__avl.S().visit.client; }),
      "Imported client"
    );

    var portableImported = await page.evaluate(async function(payload){
      var ok = await window.__avl.applyImport(JSON.stringify(payload));
      var photo = window.__avl.S().photos["21|notes"][0];
      var source = await window.__avl.hydratePhotoSource("21|notes",0);
      return {
        ok:ok,
        client:window.__avl.S().visit.client,
        photo:photo,
        bytes:Array.from(new Uint8Array(await source.blob.arrayBuffer()))
      };
    },PORTABLE_V3);
    assert.equal(portableImported.ok,true);
    assert.equal(portableImported.client,"Portable client");
    assert.equal(typeof portableImported.photo.id,"string");
    assert.equal(portableImported.photo.mime,"image/jpeg");
    assert.equal(portableImported.photo.bytes,6);
    assert.equal(portableImported.photo.width,2);
    assert.equal(portableImported.photo.height,2);
    assert.deepEqual(portableImported.bytes,[1,2,3,4,250,251]);

    var backupClient = await page.evaluate(function(){
      return JSON.parse(window.__avl.backupRaw()).data.visit.client;
    });
    assert.equal(backupClient, "Imported client");

    assert.equal(
      await page.evaluate(function(){ return window.__avl.restoreBackup(); }),
      true
    );
    var restored = await page.evaluate(function(){
      return {
        current:window.__avl.S().visit.client,
        undo:JSON.parse(window.__avl.backupRaw()).data.visit.client
      };
    });
    assert.deepEqual(restored, {current:"Imported client", undo:"Portable client"});

    var siteOnlyCountsAsWork = await page.evaluate(function(){
      var state = window.__avl.S();
      state.visit = {site:"Site-only work"};
      state.log = {};
      state.rooms = [];
      state.photos = {};
      state.skipped = {};
      return window.__avl.hasSurveyWork();
    });
    assert.equal(siteOnlyCountsAsWork, true);

    var salvage = await page.evaluate(function(){
      window.__avl.setRaw("{truncated");
      window.__avl.reload();
      var first = window.__avl.storageHTML();
      document.querySelector("[data-toggle]").click();
      var second = window.__avl.storageHTML();
      return {
        saved:window.__avl.salvageRaw(),
        rooms:window.__avl.S().rooms.length,
        first:first,
        second:second,
        dismiss:document.querySelectorAll("[data-salvage-warning] [data-dismiss]").length
      };
    });
    assert.equal(salvage.saved,"{truncated");
    assert.equal(salvage.rooms,0);
    assert.match(salvage.first,/old one has not been deleted/i);
    assert.match(salvage.second,/old one has not been deleted/i);
    assert.equal(salvage.dismiss,0);

    var storageWarning = await page.evaluate(function(){
      localStorage.setItem("test_storage_pad", new Array(1600001).join("x"));
      var html = window.__avl.storageHTML();
      localStorage.removeItem("test_storage_pad");
      return html;
    });
    assert.match(storageWarning, /Over \d+% of the survey storage limit/);

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
