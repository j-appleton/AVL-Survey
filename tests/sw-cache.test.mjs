import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function loadWorker(source,caches){
  var handlers = {};
  var claims = 0;
  var self = {
    location:{origin:"https://example.test"},
    addEventListener:function(type,handler){ handlers[type] = handler; },
    skipWaiting:function(){},
    clients:{
      claim:function(){
        claims++;
        return Promise.resolve();
      }
    }
  };
  runInNewContext(source,{
    self:self,
    caches:caches,
    fetch:function(){ return Promise.reject(new Error("not used")); },
    URL:URL,
    Response:Response,
    Promise:Promise,
    Error:Error
  });
  return {
    handlers:handlers,
    claims:function(){ return claims; }
  };
}

function waitFor(handler){
  var pending = null;
  handler({
    waitUntil:function(promise){ pending = promise; }
  });
  assert.ok(pending,"the lifecycle event must extend its work");
  return pending;
}

test("an incomplete new offline cache rejects installation and is removed", async function(){
  var source = await readFile(join(ROOT,"sw.js"),"utf8");
  var cacheName = source.match(/var CACHE = "([^"]+)"/)[1];
  var deleted = [];
  var cache = {
    addAll:function(){ return Promise.resolve(); },
    match:function(asset){
      return Promise.resolve(asset === "./photo-store.js" ? null : {ok:true});
    }
  };
  var worker = loadWorker(source,{
    open:function(name){
      assert.equal(name,cacheName);
      return Promise.resolve(cache);
    },
    delete:function(name){
      deleted.push(name);
      return Promise.resolve(true);
    },
    keys:function(){ return Promise.resolve(["previous-cache",cacheName]); },
    match:function(){ return Promise.resolve(null); }
  });

  await assert.rejects(
    waitFor(worker.handlers.install),
    /Offline cache is incomplete: \.\/photo-store\.js/
  );
  assert.deepEqual(deleted,[cacheName],
    "only the incomplete attempted cache should be removed during install");
  assert.equal(worker.claims(),0);
});

test("activation keeps the previous cache when the new cache is incomplete", async function(){
  var source = await readFile(join(ROOT,"sw.js"),"utf8");
  var cacheName = source.match(/var CACHE = "([^"]+)"/)[1];
  var deleted = [];
  var keysCalls = 0;
  var cache = {
    match:function(asset){
      return Promise.resolve(asset === "./index.html" ? null : {ok:true});
    }
  };
  var worker = loadWorker(source,{
    open:function(name){
      assert.equal(name,cacheName);
      return Promise.resolve(cache);
    },
    delete:function(name){
      deleted.push(name);
      return Promise.resolve(true);
    },
    keys:function(){
      keysCalls++;
      return Promise.resolve(["previous-cache",cacheName]);
    },
    match:function(){ return Promise.resolve(null); }
  });

  await assert.rejects(
    waitFor(worker.handlers.activate),
    /Offline cache is incomplete: \.\/index\.html/
  );
  assert.equal(keysCalls,0,"old-cache deletion must not begin before verification");
  assert.deepEqual(deleted,[]);
  assert.equal(worker.claims(),0);
});
