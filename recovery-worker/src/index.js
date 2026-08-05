var MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
var MAX_SMALL_BODY_BYTES = 8192;
var KEEP_VERSIONS = 3;

function json(value, status, headers){
  var responseHeaders = new Headers(headers || {});
  responseHeaders.set("Content-Type","application/json; charset=utf-8");
  responseHeaders.set("Cache-Control","no-store");
  return new Response(JSON.stringify(value),{status:status || 200,headers:responseHeaders});
}
function addCors(response, origin){
  var copy = new Response(response.body,response);
  if(origin){
    copy.headers.set("Access-Control-Allow-Origin",origin);
    copy.headers.set("Vary","Origin");
  }
  return copy;
}
function allowedOrigin(request, env){
  var origin = request.headers.get("Origin") || "";
  return origin && origin === env.ALLOWED_ORIGIN ? origin : "";
}
function corsPreflight(origin){
  return new Response(null,{status:204,headers:{
    "Access-Control-Allow-Origin":origin,
    "Access-Control-Allow-Methods":"GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers":[
      "Authorization","Content-Type","X-PrePlot-SHA256","X-PrePlot-Bytes",
      "X-PrePlot-Client","X-PrePlot-Site","X-PrePlot-Visit-Date",
      "X-PrePlot-State-Updated","X-PrePlot-App-Version","X-PrePlot-Photo-Count"
    ].join(", "),
    "Access-Control-Max-Age":"86400",
    "Cache-Control":"no-store",
    "Vary":"Origin"
  }});
}
function hex(bytes){
  if(!bytes) return "";
  var values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var out = "";
  for(var i=0;i<values.length;i++) out += ("0" + values[i].toString(16)).slice(-2);
  return out;
}
function randomHex(size){
  var value = new Uint8Array(size);
  crypto.getRandomValues(value);
  return hex(value);
}
function digestHex(value){
  var bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  return crypto.subtle.digest("SHA-256",bytes).then(function(result){ return hex(result); });
}
function safeId(value){
  value = String(value || "");
  return /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : "";
}
function safeVersion(value){
  value = String(value || "");
  return /^[A-Za-z0-9_-]{8,140}$/.test(value) ? value : "";
}
function headerText(request, name){
  var value = String(request.headers.get(name) || "");
  try { return decodeURIComponent(value).slice(0,240); }
  catch(error){ return value.slice(0,240); }
}
function parseBearer(request){
  var value = request.headers.get("Authorization") || "";
  var match = value.match(/^Bearer\s+([A-Fa-f0-9]{64})$/);
  return match ? match[1].toLowerCase() : "";
}
function readSmallJSON(request){
  var length = Number(request.headers.get("Content-Length") || 0);
  if(length > MAX_SMALL_BODY_BYTES) return Promise.reject(new Error("Request is too large"));
  return request.text().then(function(text){
    if(new TextEncoder().encode(text).length > MAX_SMALL_BODY_BYTES) throw new Error("Request is too large");
    var value;
    try { value = JSON.parse(text); }
    catch(error){ throw new Error("Request is not valid JSON"); }
    return value;
  });
}
function objectJSON(object){
  if(!object || typeof object.text !== "function") return Promise.reject(new Error("Stored record is unreadable"));
  return object.text().then(function(text){
    try { return JSON.parse(text); }
    catch(error){ throw new Error("Stored record is unreadable"); }
  });
}
function authenticate(request, env){
  var token = parseBearer(request);
  if(!token) return Promise.resolve(null);
  return digestHex(token).then(function(tokenHash){
    return env.RECOVERY.get("devices/" + tokenHash + ".json");
  }).then(function(object){
    if(!object) return null;
    return objectJSON(object);
  }).then(function(device){
    if(!device || !safeId(device.teamId) || !safeId(device.deviceId) || device.revokedAt) return null;
    return device;
  }).catch(function(){ return null; });
}
function enrollmentLimit(record){
  var value = Math.floor(Number(record && record.maxUses));
  return isFinite(value) && value > 0 && value <= 100 ? value : 1;
}
function enrollmentUseCount(record){
  var value = Math.floor(Number(record && record.useCount));
  if(isFinite(value) && value >= 0) return value;
  return record && record.usedAt ? 1 : 0;
}
function reserveEnrollment(env, key, input, attempt){
  return env.RECOVERY.get(key).then(function(object){
    if(!object) throw new Error("Recovery code is invalid or has expired");
    return objectJSON(object).then(function(record){
      if(!safeId(record.teamId)) throw new Error("Recovery code is invalid");
      if(!record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) throw new Error("Recovery code is invalid or has expired");
      var maxUses = enrollmentLimit(record);
      var useCount = enrollmentUseCount(record);
      if(useCount >= maxUses){
        throw new Error(maxUses > 1 ? "Recovery code has reached its installation limit" : "Recovery code has already been used");
      }
      var deviceId = crypto.randomUUID();
      var connectedAt = new Date().toISOString();
      var token = randomHex(32);
      var deviceName = String(input.deviceName || "PrePlot installation").slice(0,120);
      var uses = Array.isArray(record.uses) ? record.uses.slice(0,Math.max(0,maxUses - 1)) : [];
      uses.push({deviceId:deviceId,deviceName:deviceName,connectedAt:connectedAt});
      var reserved = {
        teamId:record.teamId,
        enrollmentId:record.enrollmentId || "",
        issuedAt:record.issuedAt || "",
        expiresAt:record.expiresAt,
        maxUses:maxUses,
        useCount:useCount + 1,
        uses:uses
      };
      if(maxUses === 1) reserved.usedAt = connectedAt;
      return env.RECOVERY.put(key,JSON.stringify(reserved),{
        onlyIf:{etagMatches:object.etag},
        httpMetadata:{contentType:"application/json"}
      }).then(function(marked){
        if(!marked){
          if(attempt >= 4) throw new Error("Recovery code is busy. Try again.");
          return reserveEnrollment(env,key,input,attempt + 1);
        }
        return {
          teamId:record.teamId,deviceId:deviceId,deviceName:deviceName,
          connectedAt:connectedAt,token:token
        };
      });
    });
  });
}
function enroll(request, env){
  return readSmallJSON(request).then(function(input){
    var code = String(input.code || "").trim();
    if(code.length < 12 || code.length > 160) throw new Error("Recovery code is invalid");
    return digestHex(code).then(function(codeHash){
      var key = "enrollments/" + codeHash + ".json";
      return reserveEnrollment(env,key,input,0).then(function(reserved){
        return digestHex(reserved.token).then(function(tokenHash){
          var device = {
            teamId:reserved.teamId,
            deviceId:reserved.deviceId,
            deviceName:reserved.deviceName,
            connectedAt:reserved.connectedAt
          };
          return env.RECOVERY.put("devices/" + tokenHash + ".json",JSON.stringify(device),{
            httpMetadata:{contentType:"application/json"},
            customMetadata:{teamId:reserved.teamId,deviceId:reserved.deviceId}
          }).then(function(){
            return json({
              token:reserved.token,deviceId:reserved.deviceId,
              teamId:reserved.teamId,connectedAt:reserved.connectedAt
            },201);
          });
        });
      });
    });
  }).catch(function(error){
    return json({error:error && error.message ? error.message : "Enrollment failed"},400);
  });
}
function listAll(bucket, options){
  var objects = [];
  function next(cursor){
    var query = {
      prefix:options.prefix,
      limit:1000,
      include:options.include || []
    };
    if(cursor) query.cursor = cursor;
    return bucket.list(query).then(function(page){
      objects = objects.concat(page.objects || []);
      return page.truncated ? next(page.cursor) : objects;
    });
  }
  return next("");
}
function cleanupOldVersions(env, teamId, recoveryId){
  var prefix = "teams/" + teamId + "/recoveries/" + recoveryId + "/";
  return listAll(env.RECOVERY,{prefix:prefix}).then(function(objects){
    objects.sort(function(a,b){ return b.uploaded.getTime() - a.uploaded.getTime(); });
    var old = objects.slice(KEEP_VERSIONS).map(function(object){ return object.key; });
    return old.length ? env.RECOVERY.delete(old) : undefined;
  }).catch(function(error){
    console.error(JSON.stringify({message:"recovery cleanup failed",error:String(error),recoveryId:recoveryId}));
  });
}
function uploadRecovery(request, env, ctx, device, recoveryId){
  var expectedHash = String(request.headers.get("X-PrePlot-SHA256") || "").toLowerCase();
  var expectedBytes = Number(request.headers.get("X-PrePlot-Bytes"));
  if(!/^[a-f0-9]{64}$/.test(expectedHash)) return Promise.resolve(json({error:"Missing or invalid recovery checksum"},400));
  if(!isFinite(expectedBytes) || expectedBytes < 2 || expectedBytes > MAX_UPLOAD_BYTES || Math.floor(expectedBytes) !== expectedBytes){
    return Promise.resolve(json({error:"Recovery copy is too large or has no valid size"},413));
  }
  var contentLength = Number(request.headers.get("Content-Length") || 0);
  if(contentLength && contentLength !== expectedBytes) return Promise.resolve(json({error:"Recovery size does not match"},400));
  if(!request.body) return Promise.resolve(json({error:"Recovery copy is empty"},400));

  var versionId = Date.now().toString(36) + "-" + crypto.randomUUID();
  var key = "teams/" + device.teamId + "/recoveries/" + recoveryId + "/" + versionId + ".json";
  var metadata = {
    teamId:device.teamId,
    recoveryId:recoveryId,
    versionId:versionId,
    client:headerText(request,"X-PrePlot-Client"),
    site:headerText(request,"X-PrePlot-Site"),
    visitDate:headerText(request,"X-PrePlot-Visit-Date"),
    stateUpdated:headerText(request,"X-PrePlot-State-Updated"),
    appVersion:headerText(request,"X-PrePlot-App-Version"),
    photoCount:String(Math.max(0,parseInt(request.headers.get("X-PrePlot-Photo-Count") || "0",10) || 0)),
    sha256:expectedHash,
    uploadedBy:device.deviceId
  };
  return env.RECOVERY.put(key,request.body,{
    sha256:expectedHash,
    httpMetadata:{contentType:"application/json",cacheControl:"no-store"},
    customMetadata:metadata
  }).then(function(object){
    var storedHash = object && object.checksums ? hex(object.checksums.sha256) : "";
    if(!object || object.size !== expectedBytes || storedHash !== expectedHash){
      return env.RECOVERY.delete(key).then(function(){
        return json({error:"Recovery copy failed storage verification"},500);
      });
    }
    var verifiedAt = new Date().toISOString();
    ctx.waitUntil(cleanupOldVersions(env,device.teamId,recoveryId));
    console.log(JSON.stringify({message:"recovery verified",teamId:device.teamId,recoveryId:recoveryId,bytes:object.size}));
    return json({
      verified:true,recoveryId:recoveryId,versionId:versionId,
      bytes:object.size,sha256:expectedHash,verifiedAt:verifiedAt
    },201);
  }).catch(function(error){
    console.error(JSON.stringify({message:"recovery upload failed",error:String(error),recoveryId:recoveryId}));
    return json({error:"Recovery copy could not be stored"},500);
  });
}
function recoveryList(env, device){
  var prefix = "teams/" + device.teamId + "/recoveries/";
  return listAll(env.RECOVERY,{prefix:prefix,include:["customMetadata"]}).then(function(objects){
    var latest = {};
    objects.forEach(function(object){
      var meta = object.customMetadata || {};
      var recoveryId = safeId(meta.recoveryId);
      var versionId = safeVersion(meta.versionId);
      if(!recoveryId || !versionId || meta.teamId !== device.teamId) return;
      var current = latest[recoveryId];
      if(!current || object.uploaded.getTime() > current.uploadedValue){
        latest[recoveryId] = {
          recoveryId:recoveryId,
          versionId:versionId,
          client:meta.client || "",
          site:meta.site || "",
          visitDate:meta.visitDate || "",
          stateUpdated:meta.stateUpdated || "",
          photoCount:Number(meta.photoCount || 0),
          bytes:object.size,
          uploaded:object.uploaded.toISOString(),
          uploadedValue:object.uploaded.getTime()
        };
      }
    });
    var rows = Object.keys(latest).map(function(key){
      var row = latest[key];
      delete row.uploadedValue;
      return row;
    });
    rows.sort(function(a,b){ return String(b.uploaded).localeCompare(String(a.uploaded)); });
    return json({recoveries:rows});
  });
}
function recoveryObject(env, device, recoveryId, versionId){
  var key = "teams/" + device.teamId + "/recoveries/" + recoveryId + "/" + versionId + ".json";
  return env.RECOVERY.get(key).then(function(object){
    if(!object) return json({error:"Recovery copy was not found"},404);
    var metadata = object.customMetadata || {};
    if(metadata.teamId !== device.teamId || metadata.recoveryId !== recoveryId || metadata.versionId !== versionId){
      return json({error:"Recovery copy was not found"},404);
    }
    var headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type","application/json; charset=utf-8");
    headers.set("Cache-Control","no-store");
    headers.set("X-PrePlot-SHA256",metadata.sha256 || hex(object.checksums && object.checksums.sha256));
    headers.set("X-PrePlot-Verified-At",object.uploaded.toISOString());
    return new Response(object.body,{status:200,headers:headers});
  });
}
function authenticated(request, env, handler){
  return authenticate(request,env).then(function(device){
    if(!device) return json({error:"Recovery device is not authorized"},401);
    return handler(device);
  });
}
function route(request, env, ctx){
  var url = new URL(request.url);
  var path = url.pathname.replace(/\/+$/g,"") || "/";
  if(request.method === "GET" && path === "/v1/health"){
    return Promise.resolve(json({service:"PrePlot recovery",ok:true}));
  }
  if(request.method === "POST" && path === "/v1/enroll") return enroll(request,env);
  if(request.method === "GET" && path === "/v1/recoveries"){
    return authenticated(request,env,function(device){ return recoveryList(env,device); });
  }
  var parts = path.split("/").filter(function(part){ return !!part; });
  if(parts.length === 3 && parts[0] === "v1" && parts[1] === "recoveries" && request.method === "PUT"){
    var recoveryId = safeId(decodeURIComponent(parts[2]));
    if(!recoveryId) return Promise.resolve(json({error:"Recovery id is invalid"},400));
    return authenticated(request,env,function(device){ return uploadRecovery(request,env,ctx,device,recoveryId); });
  }
  if(parts.length === 4 && parts[0] === "v1" && parts[1] === "recoveries" && request.method === "GET"){
    var requestedRecovery = safeId(decodeURIComponent(parts[2]));
    var versionId = safeVersion(decodeURIComponent(parts[3]));
    if(!requestedRecovery || !versionId) return Promise.resolve(json({error:"Recovery reference is invalid"},400));
    return authenticated(request,env,function(device){ return recoveryObject(env,device,requestedRecovery,versionId); });
  }
  return Promise.resolve(json({error:"Not found"},404));
}

var worker = {
  fetch: function(request, env, ctx){
    var origin = allowedOrigin(request,env);
    if(request.method === "OPTIONS"){
      return Promise.resolve(origin ? corsPreflight(origin) : json({error:"Origin is not allowed"},403));
    }
    if(!origin && new URL(request.url).pathname !== "/v1/health"){
      return Promise.resolve(json({error:"Origin is not allowed"},403));
    }
    return route(request,env,ctx).then(function(response){ return addCors(response,origin); }).catch(function(error){
      console.error(JSON.stringify({message:"unhandled recovery error",error:String(error),path:new URL(request.url).pathname}));
      return addCors(json({error:"Internal recovery service error"},500),origin);
    });
  }
};

export default worker;
export {digestHex,hex,listAll,MAX_UPLOAD_BYTES,KEEP_VERSIONS};
