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
var PACKAGE_VERSION = JSON.parse(
  await readFile(join(ROOT, "package.json"), "utf8")
).version;
var PACKAGE_LOCK = JSON.parse(
  await readFile(join(ROOT, "package-lock.json"), "utf8")
);

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
    assert.deepEqual(versions, {app:PACKAGE_VERSION, schema:2});
    assert.equal(PACKAGE_LOCK.version, PACKAGE_VERSION);
    assert.equal(PACKAGE_LOCK.packages[""].version, PACKAGE_VERSION);

    var migration = await page.evaluate(function(payload){
      return window.__avl.migrate(payload);
    }, LEGACY_V1);
    assert.equal(migration.ok, true);
    assert.equal(migration.from, 1);
    assert.equal(migration.data.meta.migratedFrom, 1);
    assert.equal(migration.data.rooms[0].d.name, "Legacy room");

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
    assert.equal(persistedMigration.schema, 2);
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

    var backupClient = await page.evaluate(function(){
      return JSON.parse(window.__avl.backupRaw()).data.visit.client;
    });
    assert.equal(backupClient, "Legacy client");

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
    assert.deepEqual(restored, {current:"Legacy client", undo:"Imported client"});

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
      return {
        saved:window.__avl.salvageRaw(),
        rooms:window.__avl.S().rooms.length
      };
    });
    assert.deepEqual(salvage, {saved:"{truncated", rooms:0});

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
