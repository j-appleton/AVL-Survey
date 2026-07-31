import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve, surveyStateSnapshot } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function withStorageApp(config, run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
    var page = await context.newPage();
    await page.addInitScript(function(options){
      window.__storagePersistCalls = {persisted:0,persist:0};
      var storage = {
        estimate:function(){
          return Promise.resolve({usage:64,quota:1000000000});
        }
      };

      if(options.persisted !== "missing"){
        storage.persisted = function(){
          window.__storagePersistCalls.persisted++;
          if(options.persisted === "throw") throw new Error("persisted synchronous failure");
          if(options.persisted === "reject") return Promise.reject(new Error("persisted asynchronous failure"));
          if(options.persisted === "sequence"){
            return Promise.resolve(window.__storagePersistCalls.persisted > 1);
          }
          return Promise.resolve(options.persisted === "true");
        };
      }

      if(options.persist !== "missing"){
        storage.persist = function(){
          window.__storagePersistCalls.persist++;
          if(options.persist === "throw") throw new Error("persist synchronous failure");
          if(options.persist === "reject") return Promise.reject(new Error("persist asynchronous failure"));
          if(options.persist === "pending"){
            return new Promise(function(resolve){
              window.__resolveStoragePersist = resolve;
            });
          }
          return Promise.resolve(options.persist === "true");
        };
      }

      Object.defineProperty(navigator, "storage", {
        configurable:true,
        value:storage
      });
    }, config);
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; }, null, {timeout:3000});
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function settledResult(page){
  await page.waitForFunction(function(){
    return window.__avl.storagePersistStatus().state !== "checking";
  }, null, {timeout:3000});
  return page.evaluate(function(){
    var status = window.__avl.storagePersistStatus();
    var nodes = Array.prototype.slice.call(
      document.querySelectorAll("#storagewrap .hint, #storagewrap .flag")
    );
    var line = nodes.filter(function(node){
      return node.textContent.indexOf("Storage retention:") > -1;
    })[0];
    return {
      status:status,
      calls:window.__storagePersistCalls,
      text:line ? line.textContent : "",
      className:line ? line.className : ""
    };
  });
}

function assertNoSafetyClaim(text){
  assert.doesNotMatch(
    text,
    /\b(safe|backed up|permanent|secure|protected)\b/i,
    "retention status must not imply backup or permanence"
  );
}

test("storage retention reports granted and denied results without assuming success", async function(){
  await withStorageApp({persisted:"true",persist:"true"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"granted",requested:false});
    assert.deepEqual(result.calls, {persisted:1,persist:0});
    assert.match(result.text, /browser has agreed to keep this data/i);
    assert.match(result.text, /Prepare the visit package after every visit/i);
    assert.equal(result.className, "hint");
    assertNoSafetyClaim(result.text);
  });

  await withStorageApp({persisted:"false",persist:"true"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"granted",requested:true});
    assert.deepEqual(result.calls, {persisted:1,persist:1});
    assert.match(result.text, /browser has agreed to keep this data/i);
    assertNoSafetyClaim(result.text);
  });

  await withStorageApp({persisted:"false",persist:"false"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"denied",requested:true});
    assert.deepEqual(result.calls, {persisted:1,persist:1});
    assert.match(result.text, /not guaranteed/i);
    assert.match(result.text, /browser may clear this/i);
    assert.equal(result.className, "flag");
    assertNoSafetyClaim(result.text);
  });
});

test("missing APIs, synchronous throws, and rejected promises settle honestly", async function(){
  await withStorageApp({persisted:"missing",persist:"missing"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"unavailable",requested:false});
    assert.deepEqual(result.calls, {persisted:0,persist:0});
    assert.match(result.text, /not reportable/i);
    assert.equal(result.className, "hint");
    assertNoSafetyClaim(result.text);
  });

  await withStorageApp({persisted:"missing",persist:"false"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"denied",requested:true});
    assert.deepEqual(result.calls, {persisted:0,persist:1});
  });

  await withStorageApp({persisted:"throw",persist:"true"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"unknown",requested:false});
    assert.deepEqual(result.calls, {persisted:1,persist:0});
    assert.match(result.text, /could not be checked/i);
    assert.equal(result.className, "flag");
    assertNoSafetyClaim(result.text);
  });

  await withStorageApp({persisted:"reject",persist:"true"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"unknown",requested:false});
    assert.deepEqual(result.calls, {persisted:1,persist:0});
  });

  await withStorageApp({persisted:"false",persist:"throw"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"unknown",requested:true});
    assert.deepEqual(result.calls, {persisted:1,persist:1});
  });

  await withStorageApp({persisted:"false",persist:"reject"}, async function(page){
    var result = await settledResult(page);
    assert.deepEqual(result.status, {state:"unknown",requested:true});
    assert.deepEqual(result.calls, {persisted:1,persist:1});
  });
});

test("a pending persistence request never appears granted and does not mutate the survey", async function(){
  await withStorageApp({persisted:"false",persist:"pending"}, async function(page){
    await page.waitForFunction(function(){
      return window.__storagePersistCalls.persist === 1;
    });
    var before = await surveyStateSnapshot(page);
    var pending = await page.evaluate(function(){
      return {
        status:window.__avl.storagePersistStatus(),
        text:document.getElementById("storagewrap").textContent,
        calls:window.__storagePersistCalls
      };
    });
    assert.deepEqual(pending.status, {state:"checking",requested:true});
    assert.deepEqual(pending.calls, {persisted:1,persist:1});
    assert.match(pending.text, /Storage retention: checking/i);
    assert.doesNotMatch(pending.text, /agreed to keep/i);

    await page.evaluate(function(){ window.__resolveStoragePersist(false); });
    var denied = await settledResult(page);
    assert.deepEqual(denied.status, {state:"denied",requested:true});
    assert.equal(await surveyStateSnapshot(page), before);
  });
});

test("a denied session re-queries on refocus but never requests persistence twice", async function(){
  await withStorageApp({persisted:"false",persist:"false"}, async function(page){
    var denied = await settledResult(page);
    assert.deepEqual(denied.status, {state:"denied",requested:true});
    assert.deepEqual(denied.calls, {persisted:1,persist:1});

    await page.evaluate(function(){
      Object.defineProperty(document, "visibilityState", {
        configurable:true,
        get:function(){ return "visible"; }
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(function(){
      return window.__storagePersistCalls.persisted === 2;
    });
    assert.deepEqual(
      await page.evaluate(function(){
        return {
          status:window.__avl.storagePersistStatus(),
          calls:window.__storagePersistCalls
        };
      }),
      {
        status:{state:"denied",requested:true},
        calls:{persisted:2,persist:1}
      },
      "a denied re-query must not become a second persistence request"
    );
  });

  await withStorageApp({persisted:"sequence",persist:"false"}, async function(page){
    var denied = await settledResult(page);
    assert.deepEqual(denied.status, {state:"denied",requested:true});
    assert.deepEqual(denied.calls, {persisted:1,persist:1});
    var before = await surveyStateSnapshot(page);

    await page.evaluate(function(){
      Object.defineProperty(document, "visibilityState", {
        configurable:true,
        get:function(){ return "visible"; }
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(function(){
      return window.__avl.storagePersistStatus().state === "granted";
    });
    var granted = await page.evaluate(function(){
      window.__avl.storageHTML();
      window.__avl.storageHTML();
      window.__avl.persistSurvey();
      return {
        status:window.__avl.storagePersistStatus(),
        calls:window.__storagePersistCalls,
        text:document.getElementById("storagewrap").textContent
      };
    });
    assert.deepEqual(granted.status, {state:"granted",requested:true});
    assert.deepEqual(granted.calls, {persisted:2,persist:1});
    assert.match(granted.text, /browser has agreed to keep this data/i);
    assert.equal(await surveyStateSnapshot(page), before);

    await page.evaluate(function(){
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(50);
    assert.deepEqual(
      await page.evaluate(function(){ return window.__storagePersistCalls; }),
      {persisted:2,persist:1},
      "a granted refocus must not query or request again"
    );
  });
});

test("persistence is requested once across boot, refocus, and explicit resolution", async function(){
  await withStorageApp({persisted:"false",persist:"false"}, async function(page){
    var denied = await settledResult(page);
    assert.deepEqual(denied.status, {state:"denied",requested:true});
    assert.deepEqual(denied.calls, {persisted:1,persist:1});

    await page.evaluate(function(){
      Object.defineProperty(document, "visibilityState", {
        configurable:true,
        get:function(){ return "visible"; }
      });
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(function(){
      return window.__storagePersistCalls.persisted === 4;
    });
    await page.evaluate(function(){
      return window.__avl.resolveStoragePersistence();
    });

    assert.deepEqual(
      await page.evaluate(function(){
        return {
          status:window.__avl.storagePersistStatus(),
          calls:window.__storagePersistCalls
        };
      }),
      {
        status:{state:"denied",requested:true},
        calls:{persisted:5,persist:1}
      },
      "persist() must be called once per session even when persistence is re-checked"
    );
  });
});
