import test from "node:test";
import assert from "node:assert/strict";
import worker,{ digestHex } from "../recovery-worker/src/index.js";

var ORIGIN = "https://j-appleton.github.io";

function toHex(bytes){
  return Array.prototype.map.call(new Uint8Array(bytes),function(byte){
    return ("0" + byte.toString(16)).slice(-2);
  }).join("");
}
async function bodyBytes(value){
  if(value == null) return new Uint8Array();
  if(typeof value === "string") return new TextEncoder().encode(value);
  if(value instanceof Uint8Array) return value;
  if(value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

class FakeObject {
  constructor(record,withBody){
    this.key = record.key;
    this.size = record.bytes.length;
    this.etag = record.etag;
    this.httpEtag = '"' + record.etag + '"';
    this.uploaded = record.uploaded;
    this.httpMetadata = record.httpMetadata;
    this.customMetadata = record.customMetadata;
    this.checksums = {sha256:record.sha256,toJSON:function(){ return {sha256:toHex(record.sha256)}; }};
    if(withBody) this.body = new Blob([record.bytes]).stream();
  }
  writeHttpMetadata(headers){
    if(this.httpMetadata && this.httpMetadata.contentType) headers.set("Content-Type",this.httpMetadata.contentType);
    if(this.httpMetadata && this.httpMetadata.cacheControl) headers.set("Cache-Control",this.httpMetadata.cacheControl);
  }
  text(){ return new TextDecoder().decode(this._recordBytes); }
}

class FakeR2 {
  constructor(){ this.records = new Map(); this.sequence = 0; }
  async put(key,value,options){
    options = options || {};
    var existing = this.records.get(key);
    if(options.onlyIf && options.onlyIf.etagMatches && (!existing || existing.etag !== options.onlyIf.etagMatches)) return null;
    var bytes = await bodyBytes(value);
    var digest = await crypto.subtle.digest("SHA-256",bytes);
    var digestHex = toHex(digest);
    if(options.sha256 && String(options.sha256).toLowerCase() !== digestHex) throw new Error("checksum mismatch");
    var record = {
      key:key,bytes:bytes,etag:"etag-" + (++this.sequence),uploaded:new Date(),
      httpMetadata:options.httpMetadata || {},customMetadata:options.customMetadata || {},sha256:digest
    };
    this.records.set(key,record);
    return this.object(record,false);
  }
  object(record,withBody){
    var object = new FakeObject(record,withBody);
    object._recordBytes = record.bytes;
    if(withBody){
      object.text = function(){ return Promise.resolve(new TextDecoder().decode(record.bytes)); };
      object.arrayBuffer = function(){ return Promise.resolve(record.bytes.slice().buffer); };
    }
    return object;
  }
  async get(key){
    var record = this.records.get(key);
    return record ? this.object(record,true) : null;
  }
  async head(key){
    var record = this.records.get(key);
    return record ? this.object(record,false) : null;
  }
  async delete(keys){
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => this.records.delete(key));
  }
  async list(options){
    options = options || {};
    var records = Array.from(this.records.values()).filter(function(record){
      return !options.prefix || record.key.indexOf(options.prefix) === 0;
    }).sort(function(a,b){ return a.key.localeCompare(b.key); });
    return {objects:records.map((record) => this.object(record,false)),truncated:false,delimitedPrefixes:[]};
  }
}

function context(){
  var pending = [];
  return {pending:pending,waitUntil:function(promise){ pending.push(Promise.resolve(promise)); }};
}
function request(path,init){
  init = init || {};
  var headers = new Headers(init.headers || {});
  if(!headers.has("Origin")) headers.set("Origin",ORIGIN);
  return new Request("https://preplot-recovery.example" + path,{...init,headers:headers});
}
async function issueCode(bucket,teamId,code){
  var hash = await digestHex(code);
  await bucket.put("enrollments/" + hash + ".json",JSON.stringify({
    teamId:teamId,issuedAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+86400000).toISOString(),usedAt:null
  }),{httpMetadata:{contentType:"application/json"}});
}
async function enroll(env,code){
  var response = await worker.fetch(request("/v1/enroll",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({code:code,deviceName:"Test device"})
  }),env,context());
  return {response:response,body:await response.json()};
}
async function upload(env,token,recoveryId,payload){
  var hash = await digestHex(payload);
  var ctx = context();
  var response = await worker.fetch(request("/v1/recoveries/" + recoveryId,{
    method:"PUT",headers:{
      Authorization:"Bearer " + token,
      "Content-Type":"application/json",
      "X-PrePlot-SHA256":hash,
      "X-PrePlot-Bytes":String(new TextEncoder().encode(payload).length),
      "X-PrePlot-Client":encodeURIComponent("Müller AV"),
      "X-PrePlot-Site":encodeURIComponent("Main Campus"),
      "X-PrePlot-Visit-Date":"2026-08-05",
      "X-PrePlot-State-Updated":"2026-08-05T12%3A00%3A00.000Z",
      "X-PrePlot-App-Version":"1.22.0",
      "X-PrePlot-Photo-Count":"60"
    },body:payload
  }),env,ctx);
  await Promise.all(ctx.pending);
  return {response:response,body:await response.json(),hash:hash};
}

test("one-use enrollment issues a revocable device token without exposing bucket access",async function(){
  var bucket = new FakeR2();
  var env = {RECOVERY:bucket,ALLOWED_ORIGIN:ORIGIN};
  var code = "PREPLOT-ABCDEF-123456-ABCDEF";
  await issueCode(bucket,"preplot-team",code);
  var first = await enroll(env,code);
  assert.equal(first.response.status,201);
  assert.match(first.body.token,/^[a-f0-9]{64}$/);
  assert.equal(first.body.teamId,"preplot-team");
  assert.ok(bucket.records.has("devices/" + await digestHex(first.body.token) + ".json"));

  var second = await enroll(env,code);
  assert.equal(second.response.status,400);
  assert.match(second.body.error,/already been used/i);
});

test("authenticated recovery upload verifies checksum, lists metadata and restores exact bytes",async function(){
  var bucket = new FakeR2();
  var env = {RECOVERY:bucket,ALLOWED_ORIGIN:ORIGIN};
  var code = "PREPLOT-ABCDEF-654321-ABCDEF";
  await issueCode(bucket,"preplot-team",code);
  var enrolled = await enroll(env,code);
  var payload = JSON.stringify({app:"avl-survey",schema:5,photoFormat:"inline",data:{visit:{client:"Müller AV"}}});
  var uploaded = await upload(env,enrolled.body.token,"recovery-survey-1234",payload);
  assert.equal(uploaded.response.status,201);
  assert.equal(uploaded.body.verified,true);
  assert.equal(uploaded.body.sha256,uploaded.hash);
  assert.equal(uploaded.body.bytes,new TextEncoder().encode(payload).length);

  var listedResponse = await worker.fetch(request("/v1/recoveries",{
    headers:{Authorization:"Bearer " + enrolled.body.token}
  }),env,context());
  var listed = await listedResponse.json();
  assert.equal(listed.recoveries.length,1);
  assert.equal(listed.recoveries[0].client,"Müller AV");
  assert.equal(listed.recoveries[0].photoCount,60);

  var item = listed.recoveries[0];
  var restored = await worker.fetch(request(
    "/v1/recoveries/" + item.recoveryId + "/" + item.versionId,
    {headers:{Authorization:"Bearer " + enrolled.body.token}}
  ),env,context());
  assert.equal(restored.status,200);
  assert.equal(restored.headers.get("X-PrePlot-SHA256"),uploaded.hash);
  assert.equal(await restored.text(),payload);
});

test("origin, authorization, checksum and team boundaries fail closed",async function(){
  var bucket = new FakeR2();
  var env = {RECOVERY:bucket,ALLOWED_ORIGIN:ORIGIN};
  var wrongOrigin = await worker.fetch(new Request("https://preplot-recovery.example/v1/recoveries",{
    headers:{Origin:"https://attacker.example"}
  }),env,context());
  assert.equal(wrongOrigin.status,403);

  var noAuth = await worker.fetch(request("/v1/recoveries"),env,context());
  assert.equal(noAuth.status,401);

  await issueCode(bucket,"preplot-team","PREPLOT-TEAM01-AAAAAA-BBBBBB");
  var teamOne = await enroll(env,"PREPLOT-TEAM01-AAAAAA-BBBBBB");
  var payload = JSON.stringify({ok:true});
  var uploaded = await upload(env,teamOne.body.token,"recovery-private-1234",payload);

  await issueCode(bucket,"another-team","PREPLOT-TEAM02-AAAAAA-BBBBBB");
  var teamTwo = await enroll(env,"PREPLOT-TEAM02-AAAAAA-BBBBBB");
  var crossTeam = await worker.fetch(request(
    "/v1/recoveries/recovery-private-1234/" + uploaded.body.versionId,
    {headers:{Authorization:"Bearer " + teamTwo.body.token}}
  ),env,context());
  assert.equal(crossTeam.status,404);

  var badHash = await worker.fetch(request("/v1/recoveries/recovery-private-1234",{
    method:"PUT",headers:{
      Authorization:"Bearer " + teamOne.body.token,
      "Content-Type":"application/json",
      "X-PrePlot-SHA256":"0".repeat(64),
      "X-PrePlot-Bytes":String(new TextEncoder().encode(payload).length)
    },body:payload
  }),env,context());
  assert.equal(badHash.status,500);
  assert.match((await badHash.json()).error,/could not be stored/i);
});

test("successful uploads retain only the three newest recovery versions",async function(){
  var bucket = new FakeR2();
  var env = {RECOVERY:bucket,ALLOWED_ORIGIN:ORIGIN};
  var code = "PREPLOT-RETAIN-AAAAAA-BBBBBB";
  await issueCode(bucket,"preplot-team",code);
  var enrolled = await enroll(env,code);
  for(var i=0;i<4;i++){
    var uploaded = await upload(env,enrolled.body.token,"recovery-retain-1234",JSON.stringify({version:i}));
    assert.equal(uploaded.response.status,201);
    await new Promise(function(resolve){ setTimeout(resolve,2); });
  }
  var keys = Array.from(bucket.records.keys()).filter(function(key){
    return key.indexOf("teams/preplot-team/recoveries/recovery-retain-1234/") === 0;
  });
  assert.equal(keys.length,3);
});
