import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cacheNameFromSource, until } from "./app-test-helpers.mjs";

var TEST_DIR = dirname(fileURLToPath(import.meta.url));
var ROOT = dirname(TEST_DIR);
var require = createRequire(import.meta.url);
var { chromium } = require("playwright");

var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png"
};

function serve(root){
  return new Promise(function(resolve, reject){
    var server = createServer(async function(req, res){
      try {
        var raw = new URL(req.url, "http://127.0.0.1").pathname;
        var rel = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
        var clean = normalize(rel);
        if(clean.indexOf("..") === 0){
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        var file = join(root, clean);
        var info = await stat(file);
        if(info.isDirectory()) file = join(file, "index.html");
        var body = await readFile(file);
        var headers = {
          "Cache-Control": "no-store",
          "Content-Type": TYPES[extname(file)] || "application/octet-stream"
        };
        if(clean === "sw.js") headers["Service-Worker-Allowed"] = "/";
        res.writeHead(200, headers);
        res.end(body);
      } catch(error){
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", function(){
      resolve({
        origin: "http://127.0.0.1:" + server.address().port,
        close: function(){
          return new Promise(function(done){ server.close(done); });
        }
      });
    });
  });
}

test("an update waits for approval and preserves survey data", async function(){
  var fixture = await mkdtemp(join(tmpdir(), "avl-sw-update-"));
  await cp(ROOT, fixture, {
    recursive: true,
    filter: function(source){ return source.indexOf(join(ROOT, ".git")) !== 0; }
  });

  var server = await serve(fixture);
  var executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  var browser = await chromium.launch({headless:true, executablePath:executablePath});

  try {
    var context = await browser.newContext({serviceWorkers:"allow"});
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await until(function(){
      return page.evaluate(async function(){
        var reg = await navigator.serviceWorker.getRegistration();
        return !!(reg && reg.active && navigator.serviceWorker.controller);
      });
    });

    await page.evaluate(function(){
      localStorage.setItem("avl_survey_v1", JSON.stringify({
        visit:{client:"Update survivor"},
        log:{},
        rooms:[{id:1,d:{name:"Preserved room"}}],
        photos:{},
        skipped:{},
        ui:{}
      }));
    });
    await page.reload({waitUntil:"domcontentloaded"});
    assert.equal(
      await page.evaluate(function(){ return window.__avl.S().visit.client; }),
      "Update survivor"
    );
    await page.waitForFunction(function(){
      return window.__avl && window.__avl.swReady === true;
    });

    var swPath = join(fixture, "sw.js");
    var swSource = await readFile(swPath, "utf8");
    var currentCache = cacheNameFromSource(swSource);
    var nextCache = currentCache + "-test-update";
    var nextSource = swSource.replace(
      'var CACHE = "' + currentCache + '"',
      'var CACHE = "' + nextCache + '"'
    );
    assert.notEqual(nextSource, swSource);
    await writeFile(swPath, nextSource);

    await page.evaluate(function(){ window.dispatchEvent(new Event("focus")); });
    await page.locator("#swUpdateNotice").waitFor({state:"visible"});

    var waitingState = await page.evaluate(async function(){
      var reg = await navigator.serviceWorker.getRegistration();
      return {
        waiting: !!reg.waiting,
        client: window.__avl.S().visit.client,
        caches: (await caches.keys()).sort()
      };
    });
    assert.equal(waitingState.waiting, true);
    assert.equal(waitingState.client, "Update survivor");
    assert.deepEqual(waitingState.caches, [currentCache, nextCache].sort());

    await page.getByRole("button", {name:"Later", exact:true}).click();
    await page.locator("#swUpdateNotice").waitFor({state:"detached"});
    assert.equal(
      await page.evaluate(function(){ return window.__avl.S().visit.client; }),
      "Update survivor"
    );

    await page.reload({waitUntil:"domcontentloaded"});
    await page.locator("#swUpdateNotice").waitFor({state:"visible"});
    await Promise.all([
      page.waitForNavigation({waitUntil:"domcontentloaded"}),
      page.getByRole("button", {name:"Update", exact:true}).click()
    ]);
    await page.waitForFunction(function(){
      return window.__avl && window.__avl.S().visit.client === "Update survivor";
    });

    var appliedState = await page.evaluate(async function(){
      var reg = await navigator.serviceWorker.getRegistration();
      return {
        waiting: !!reg.waiting,
        client: window.__avl.S().visit.client,
        room: window.__avl.S().rooms[0].d.name,
        caches: (await caches.keys()).sort()
      };
    });
    assert.equal(appliedState.waiting, false);
    assert.equal(appliedState.client, "Update survivor");
    assert.equal(appliedState.room, "Preserved room");
    assert.deepEqual(appliedState.caches, [nextCache]);

    await context.close();
  } finally {
    await browser.close();
    await server.close();
    await rm(fixture, {recursive:true, force:true});
  }
});
