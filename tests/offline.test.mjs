import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, readCacheName, serve, until } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("the installed app reloads offline with survey data intact", async function(){
  var server = await serve(ROOT);
  var browser = await launchBrowser();

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

    assert.equal(
      await page.evaluate(function(){
        return window.__avl.applyImport(JSON.stringify({
          visit:{client:"Offline survivor"},
          log:{},
          rooms:[{id:1,d:{name:"Cached room"}}],
          photos:{},
          skipped:{},
          ui:{}
        }));
      }),
      true
    );
    await until(function(){
      return page.evaluate(function(){
        var raw = window.__avl.raw();
        if(!raw) return false;
        try {
          return JSON.parse(raw).data.visit.client === "Offline survivor";
        } catch(error){
          return false;
        }
      });
    });

    var cached = await page.evaluate(async function(){
      return (await caches.keys()).sort();
    });
    assert.deepEqual(cached, [await readCacheName(ROOT)]);

    await context.setOffline(true);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){
      return window.__avl && window.__avl.S().visit.client === "Offline survivor";
    });

    var state = await page.evaluate(function(){
      return {
        client:window.__avl.S().visit.client,
        room:window.__avl.S().rooms[0].d.name
      };
    });
    assert.deepEqual(state, {client:"Offline survivor", room:"Cached room"});

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
