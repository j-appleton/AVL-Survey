import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { launchBrowser, serve, surveyStateSnapshot, until } from "./app-test-helpers.mjs";

var ROOT = resolve(import.meta.dirname,"..");
var TOKEN = "a".repeat(64);

function state(client){
  return {
    app:"avl-survey",schema:5,photoFormat:"inline",appVersion:"1.22.0",
    data:{
      visit:{client:client || ""},log:{},rooms:[],photos:{},captions:{},
      compose:{summary:"",excluded:{}},skipped:{},ui:{},
      meta:{created:"2026-08-05T12:00:00.000Z",updated:"2026-08-05T12:00:00.000Z",app:"1.22.0"}
    }
  };
}

async function withRecoveryApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  var context = await browser.newContext({serviceWorkers:"block"});
  await context.addInitScript(function(token){
    var nativeFetch = window.fetch.bind(window);
    window.__recoveryOnline = true;
    window.__recoveryCalls = [];
    window.__restorePayload = "";
    window.__recoveryUploadFailure = false;
    Object.defineProperty(navigator,"onLine",{
      configurable:true,get:function(){ return window.__recoveryOnline; }
    });
    function digest(text){
      return crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)).then(function(value){
        return Array.prototype.map.call(new Uint8Array(value),function(byte){
          return ("0" + byte.toString(16)).slice(-2);
        }).join("");
      });
    }
    window.fetch = function(input,init){
      var url = String(input && input.url || input);
      if(url.indexOf("preplot-recovery.") < 0) return nativeFetch(input,init);
      init = init || {};
      window.__recoveryCalls.push({url:url,method:init.method || "GET",headers:init.headers || {},body:String(init.body || "")});
      if(url.indexOf("/v1/enroll") > -1){
        return Promise.resolve(new Response(JSON.stringify({
          token:token,deviceId:"device-12345678",teamId:"preplot-team",connectedAt:"2026-08-05T12:01:00.000Z"
        }),{status:201,headers:{"Content-Type":"application/json"}}));
      }
      if((init.method || "GET") === "PUT"){
        if(window.__recoveryUploadFailure){
          return Promise.resolve(new Response(JSON.stringify({error:"recovery service unavailable"}),{
            status:503,headers:{"Content-Type":"application/json"}
          }));
        }
        var body = String(init.body || "");
        var headers = init.headers || {};
        return digest(body).then(function(hash){
          return new Response(JSON.stringify({
            verified:true,recoveryId:"recovery-test-1234",versionId:"version-12345678",
            bytes:new TextEncoder().encode(body).length,sha256:hash,verifiedAt:"2026-08-05T12:02:00.000Z"
          }),{status:201,headers:{"Content-Type":"application/json"}});
        });
      }
      if(url.endsWith("/v1/recoveries")){
        return Promise.resolve(new Response(JSON.stringify({recoveries:[{
          recoveryId:"recovery-test-1234",versionId:"version-12345678",
          client:"Recovered client",site:"Recovered site",visitDate:"2026-08-05",
          uploaded:"2026-08-05T12:02:00.000Z",bytes:512,photoCount:0
        }]}),{status:200,headers:{"Content-Type":"application/json"}}));
      }
      if(url.indexOf("/v1/recoveries/") > -1){
        var payload = window.__restorePayload;
        return digest(payload).then(function(hash){
          return new Response(payload,{status:200,headers:{
            "Content-Type":"application/json","X-PrePlot-SHA256":hash,
            "X-PrePlot-Verified-At":"2026-08-05T12:02:00.000Z"
          }});
        });
      }
      return Promise.resolve(new Response(JSON.stringify({error:"unexpected recovery request"}),{status:500}));
    };
  },TOKEN);
  var page = await context.newPage();
  await page.goto(server.origin,{waitUntil:"networkidle"});
  try { await run(page); }
  finally { await browser.close(); await server.close(); }
}

test("recovery is optional and makes no request while disconnected or offline",async function(){
  await withRecoveryApp(async function(page){
    await page.evaluate(function(payload){ return window.__avl.applyImport(JSON.stringify(payload)); },state("Offline client"));
    await page.waitForTimeout(350);
    var before = await surveyStateSnapshot(page);
    var result = await page.evaluate(function(){
      window.__recoveryOnline = false;
      window.dispatchEvent(new Event("offline"));
      return window.__avl.recovery().resume().then(function(){
        return {
          calls:window.__recoveryCalls.length,
          phase:window.__avl.recovery().status().phase,
          client:window.__avl.S().visit.client,
          envelope:JSON.stringify(window.__avl.envelope()),
          panel:document.querySelector("[data-recovery-panel]").textContent
        };
      });
    });
    var after = await surveyStateSnapshot(page);
    assert.equal(result.calls,0);
    assert.equal(result.phase,"disconnected");
    assert.equal(result.client,"Offline client");
    assert.match(result.panel,/still works normally without a connection/i);
    assert.doesNotMatch(result.envelope,/token|device-12345678|preplot_recovery_config/i);
    assert.equal(after,before);
  });
});

test("one-time connection uploads only after local persistence and verifies exact bytes",async function(){
  await withRecoveryApp(async function(page){
    await page.evaluate(function(payload){ return window.__avl.applyImport(JSON.stringify(payload)); },state("Verified client"));
    await page.waitForTimeout(350);
    var before = await surveyStateSnapshot(page);
    var connected = await page.evaluate(function(){
      return window.__avl.recovery().connect("PREPLOT-ONE-TIME-CODE","Jonathan's iPhone").then(function(ok){
        if(!ok) return false;
        window.__avl.persistSurvey();
        return window.__avl.recovery().flush();
      });
    });
    assert.equal(connected,true);
    await until(async function(){
      return page.evaluate(function(){ return window.__avl.recovery().status().phase === "verified"; });
    });
    var result = await page.evaluate(function(){
      var calls = window.__recoveryCalls;
      var upload = calls.filter(function(call){ return call.method === "PUT"; })[0];
      return {
        enrolls:calls.filter(function(call){ return call.url.indexOf("/v1/enroll") > -1; }).length,
        uploads:calls.filter(function(call){ return call.method === "PUT"; }).length,
        auth:upload && upload.headers.Authorization,
        byteHeader:upload && Number(upload.headers["X-PrePlot-Bytes"]),
        bodyBytes:upload && new TextEncoder().encode(upload.body).length,
        phase:window.__avl.recovery().status().phase,
        panel:document.querySelector("[data-recovery-status]").textContent,
        survey:JSON.stringify(window.__avl.S()),
        envelope:JSON.stringify(window.__avl.envelope()),
        raw:window.__avl.raw(),
        config:localStorage.getItem("preplot_recovery_config_v1")
      };
    });
    var after = await surveyStateSnapshot(page);
    assert.equal(result.enrolls,1);
    assert.equal(result.uploads,1);
    assert.equal(result.auth,"Bearer " + TOKEN);
    assert.equal(result.byteHeader,result.bodyBytes);
    assert.equal(result.phase,"verified");
    assert.match(result.panel,/Recovery copy verified/);
    assert.match(result.config,new RegExp(TOKEN));
    [result.survey,result.envelope,result.raw].forEach(function(value){
      assert.doesNotMatch(value,new RegExp(TOKEN));
      assert.doesNotMatch(value,/device-12345678|preplot_recovery_config_v1/);
    });
    assert.equal(after,before,"recovery metadata must not enter survey state");
  });
});

test("offline edits queue locally and upload when the installed app reconnects",async function(){
  await withRecoveryApp(async function(page){
    await page.evaluate(function(){ return window.__avl.recovery().connect("PREPLOT-ONE-TIME-CODE","Phone"); });
    await page.evaluate(function(){
      window.__recoveryCalls = [];
      window.__recoveryOnline = false;
      var input = document.querySelector('[data-scope="visit"][data-k="client"]');
      input.value = "Captured with no signal";
      input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.waitForTimeout(350);
    var queued = await page.evaluate(function(){
      return {
        client:window.__avl.S().visit.client,
        phase:window.__avl.recovery().status().phase,
        uploads:window.__recoveryCalls.filter(function(call){ return call.method === "PUT"; }).length
      };
    });
    assert.equal(queued.client,"Captured with no signal");
    assert.equal(queued.phase,"waiting");
    assert.equal(queued.uploads,0);

    await page.evaluate(function(){
      window.__recoveryOnline = true;
      window.dispatchEvent(new Event("online"));
    });
    await until(async function(){
      return page.evaluate(function(){ return window.__avl.recovery().status().phase === "verified"; });
    });
    var after = await page.evaluate(function(){
      return {
        client:window.__avl.S().visit.client,
        uploads:window.__recoveryCalls.filter(function(call){ return call.method === "PUT"; }).length
      };
    });
    assert.equal(after.client,"Captured with no signal");
    assert.equal(after.uploads,1);
  });
});

test("an upload failure settles honestly and remains retryable",async function(){
  await withRecoveryApp(async function(page){
    await page.evaluate(function(payload){ return window.__avl.applyImport(JSON.stringify(payload)); },state("Retry client"));
    await page.waitForTimeout(350);
    await page.evaluate(function(){
      window.__recoveryUploadFailure = true;
      return window.__avl.recovery().connect("PREPLOT-ONE-TIME-CODE","Phone");
    });
    await until(async function(){
      return page.evaluate(function(){ return window.__avl.recovery().status().phase === "failed"; });
    });
    var failed = await page.evaluate(function(){
      var status = window.__avl.recovery().status();
      return {phase:status.phase,detail:status.detail,flight:status.flight};
    });
    assert.deepEqual(failed,{
      phase:"failed",detail:"recovery service unavailable",flight:false
    });

    assert.equal(await page.evaluate(function(){
      window.__recoveryUploadFailure = false;
      return window.__avl.recovery().flush();
    }),true,"a failed upload must not poison the next recovery attempt");
  });
});

test("a listed recovery restores through the guarded portable import path",async function(){
  await withRecoveryApp(async function(page){
    await page.evaluate(function(payload){ return window.__avl.applyImport(JSON.stringify(payload)); },state("Current work"));
    await page.waitForTimeout(350);
    await page.evaluate(function(){ return window.__avl.recovery().connect("PREPLOT-ONE-TIME-CODE","Laptop"); });
    var restoredState = state("Recovered client");
    restoredState.data.visit.site = "Recovered site";
    await page.evaluate(function(payload){ window.__restorePayload = JSON.stringify(payload); },restoredState);
    assert.equal(await page.evaluate(function(){ return window.__avl.recovery().loadRecoveries(); }),true);
    assert.equal(await page.evaluate(function(){
      return window.__avl.recovery().restore("recovery-test-1234","version-12345678");
    }),true);
    var result = await page.evaluate(function(){
      return {
        client:window.__avl.S().visit.client,
        site:window.__avl.S().visit.site,
        backup:JSON.parse(window.__avl.backupRaw()).data.visit.client
      };
    });
    assert.deepEqual(result,{client:"Recovered client",site:"Recovered site",backup:"Current work"});
  });
});
