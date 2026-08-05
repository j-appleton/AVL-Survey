(function(root){
"use strict";

/* Automatic recovery is deliberately separate from survey state. Credentials,
   connection status and retry state must never ride in an export or backup. */
var CONFIG_KEY = "preplot_recovery_config_v1";
var STATUS_KEY = "preplot_recovery_status_v1";
var DEFAULT_ENDPOINT = "https://preplot-recovery.jappleton2217.workers.dev";
var MAX_RECOVERY_BYTES = 50 * 1024 * 1024;
var retryDelays = [5000,15000,60000,300000];

function parseJSON(value, fallback){
  if(!value) return fallback;
  try { return JSON.parse(value); }
  catch(error){ return fallback; }
}
function htmlEsc(value){
  return String(value == null ? "" : value)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function bytesHex(bytes){
  var out = "";
  for(var i=0;i<bytes.length;i++) out += ("0" + bytes[i].toString(16)).slice(-2);
  return out;
}
function sha256Hex(value){
  var bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  return crypto.subtle.digest("SHA-256",bytes).then(function(digest){
    return bytesHex(new Uint8Array(digest));
  });
}
function randomHex(bytes){
  var value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesHex(value);
}
function createId(){
  if(root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
  if(root.crypto && typeof root.crypto.getRandomValues === "function"){
    return "recovery-" + Date.now().toString(36) + "-" + randomHex(12);
  }
  createId.counter = (createId.counter || 0) + 1;
  return "recovery-" + Date.now().toString(36) + "-" + createId.counter.toString(36);
}
function encodedHeader(value){
  return encodeURIComponent(String(value == null ? "" : value).slice(0,240));
}
function fmtTime(value){
  if(!value) return "";
  try {
    return new Date(value).toLocaleString([],{
      month:"short",day:"numeric",hour:"numeric",minute:"2-digit"
    });
  } catch(error){ return String(value); }
}
function errorMessage(error, fallback){
  return error && error.message ? error.message : fallback;
}

function create(options){
  options = options || {};
  var storage = options.storage;
  var buildPayload = options.buildPayload;
  var getSurvey = options.getSurvey;
  var applyPortable = options.applyPortable;
  var onChange = options.onChange || function(){};
  var hasWork = options.hasWork || function(){ return true; };
  var isCaptureBusy = options.isCaptureBusy || function(){ return false; };
  var fetcher = options.fetch || root.fetch.bind(root);
  var online = options.online || function(){ return root.navigator.onLine !== false; };
  var endpoint = String(options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/g,"");
  var config = parseJSON(storage.get(CONFIG_KEY),null);
  var savedStatus = parseJSON(storage.get(STATUS_KEY),{});
  var phase = config ? "idle" : "disconnected";
  var detail = "";
  var dirty = false;
  var revision = 0;
  var timer = null;
  var flight = null;
  var retryIndex = 0;
  var connectOpen = false;
  var restoreOpen = false;
  var recoveries = [];
  var restoreLoading = false;
  var stopped = false;

  function notify(){
    try { onChange(status()); }
    catch(error){}
  }
  function storeConfig(){
    if(config) storage.set(CONFIG_KEY,JSON.stringify(config));
  }
  function storeStatus(){
    storage.set(STATUS_KEY,JSON.stringify(savedStatus));
  }
  function clearTimer(){
    if(timer){ root.clearTimeout(timer); timer = null; }
  }
  function schedule(delay){
    clearTimer();
    if(stopped || !config || !dirty) return;
    timer = root.setTimeout(function(){ timer = null; flush(); },Math.max(0,delay || 0));
  }
  function setPhase(next, message){
    phase = next;
    detail = message || "";
    notify();
  }
  function survey(){
    var value = getSurvey ? getSurvey() : {};
    return value || {};
  }
  function recoveryIdentity(){
    var info = survey();
    var stateCreated = String(info.created || "");
    if(!savedStatus.recoveryId || savedStatus.stateCreated !== stateCreated){
      savedStatus = {
        recoveryId:createId(),
        stateCreated:stateCreated,
        verifiedAt:"",
        stateUpdated:"",
        sha256:"",
        bytes:0
      };
      storeStatus();
    }
    return savedStatus.recoveryId;
  }
  function authHeaders(extra){
    var headers = extra || {};
    if(config && config.token) headers.Authorization = "Bearer " + config.token;
    return headers;
  }
  function fetchWithTimeout(url, init, ms){
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var guard = controller ? root.setTimeout(function(){ controller.abort(); },ms || 60000) : null;
    if(controller) init.signal = controller.signal;
    return Promise.resolve(fetcher(url,init)).then(function(response){
      if(guard) root.clearTimeout(guard);
      return response;
    },function(error){
      if(guard) root.clearTimeout(guard);
      throw error;
    });
  }
  function responseJSON(response){
    return response.text().then(function(text){
      var parsed = parseJSON(text,null);
      if(!parsed) throw new Error("Recovery service returned an unreadable response");
      if(!response.ok) throw new Error(parsed.error || "Recovery service request failed");
      return parsed;
    });
  }
  function markDirty(delay){
    if(!hasWork()) return false;
    revision++;
    dirty = true;
    if(!config){
      phase = "disconnected";
      notify();
      return true;
    }
    if(!online()){
      setPhase("waiting","Waiting for a connection");
      return true;
    }
    setPhase("pending","Recovery copy pending");
    schedule(typeof delay === "number" ? delay : 12000);
    return true;
  }
  function uploadSnapshot(snapshotRevision){
    var info = survey();
    var recoveryId = recoveryIdentity();
    return Promise.resolve(buildPayload()).then(function(payload){
      if(snapshotRevision !== revision) throw {stale:true};
      var text = JSON.stringify(payload);
      var bytes = new TextEncoder().encode(text).length;
      if(bytes > MAX_RECOVERY_BYTES) throw new Error("Recovery copy is larger than the upload limit");
      return sha256Hex(text).then(function(hash){
        if(snapshotRevision !== revision) throw {stale:true};
        return fetchWithTimeout(endpoint + "/v1/recoveries/" + encodeURIComponent(recoveryId),{
          method:"PUT",
          headers:authHeaders({
            "Content-Type":"application/json",
            "X-PrePlot-SHA256":hash,
            "X-PrePlot-Bytes":String(bytes),
            "X-PrePlot-Client":encodedHeader(info.client),
            "X-PrePlot-Site":encodedHeader(info.site),
            "X-PrePlot-Visit-Date":encodedHeader(info.date),
            "X-PrePlot-State-Updated":encodedHeader(info.updated),
            "X-PrePlot-App-Version":encodedHeader(info.appVersion),
            "X-PrePlot-Photo-Count":String(info.photoCount || 0)
          }),
          body:text
        },90000).then(responseJSON).then(function(result){
          if(!result.verified || result.sha256 !== hash || Number(result.bytes) !== bytes){
            throw new Error("Recovery service did not verify the uploaded copy");
          }
          return {result:result,hash:hash,bytes:bytes,recoveryId:recoveryId,updated:info.updated};
        });
      });
    });
  }
  function flush(){
    clearTimer();
    if(stopped || !config || !dirty || flight) return flight || Promise.resolve(false);
    if(!online()){
      setPhase("waiting","Waiting for a connection");
      return Promise.resolve(false);
    }
    if(isCaptureBusy()){
      setPhase("pending","Waiting for photo capture to finish");
      schedule(2000);
      return Promise.resolve(false);
    }
    var snapshotRevision = revision;
    setPhase("uploading","Creating recovery copy…");
    flight = uploadSnapshot(snapshotRevision).then(function(upload){
      if(snapshotRevision !== revision){
        setPhase("pending","Survey changed during recovery");
        schedule(1000);
        return false;
      }
      dirty = false;
      retryIndex = 0;
      savedStatus = {
        recoveryId:upload.recoveryId,
        stateCreated:String(survey().created || ""),
        verifiedAt:upload.result.verifiedAt,
        stateUpdated:upload.updated,
        sha256:upload.hash,
        bytes:upload.bytes
      };
      storeStatus();
      setPhase("verified","");
      return true;
    }).catch(function(error){
      if(error && error.stale){
        setPhase("pending","Survey changed during recovery");
        schedule(1000);
        return false;
      }
      if(error && /authoriz|device|token/i.test(error.message || "")){
        config = null;
        storage.remove(CONFIG_KEY);
        setPhase("disconnected","Recovery connection expired");
        return false;
      }
      setPhase(online() ? "failed" : "waiting",errorMessage(error,"Recovery copy could not be uploaded"));
      if(dirty) schedule(retryDelays[Math.min(retryIndex++,retryDelays.length-1)]);
      return false;
    }).then(function(value){
      flight = null;
      if(dirty && phase !== "disconnected" && phase !== "failed") schedule(1000);
      return value;
    });
    return flight;
  }
  function connect(code, deviceName){
    code = String(code || "").trim();
    if(!code){ setPhase("connect-error","Enter the recovery code"); return Promise.resolve(false); }
    if(!online()){ setPhase("connect-error","Connect to the internet once to register this installation"); return Promise.resolve(false); }
    setPhase("connecting","Connecting recovery…");
    return fetchWithTimeout(endpoint + "/v1/enroll",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({code:code,deviceName:String(deviceName || "PrePlot installation").slice(0,120)})
    },20000).then(responseJSON).then(function(result){
      if(!result.token || !result.deviceId || !result.teamId) throw new Error("Recovery service returned an incomplete connection");
      config = {
        token:String(result.token),
        deviceId:String(result.deviceId),
        teamId:String(result.teamId),
        connectedAt:String(result.connectedAt || new Date().toISOString())
      };
      storeConfig();
      connectOpen = false;
      retryIndex = 0;
      setPhase("idle","");
      if(hasWork()) markDirty(0);
      return true;
    }).catch(function(error){
      setPhase("connect-error",errorMessage(error,"Could not connect recovery"));
      return false;
    });
  }
  function loadRecoveries(){
    if(!config || restoreLoading) return Promise.resolve(false);
    if(!online()){ setPhase("waiting","Connect to the internet to view recovery copies"); return Promise.resolve(false); }
    restoreLoading = true;
    restoreOpen = true;
    notify();
    return fetchWithTimeout(endpoint + "/v1/recoveries",{
      method:"GET",headers:authHeaders({"Accept":"application/json"})
    },30000).then(responseJSON).then(function(result){
      recoveries = Array.isArray(result.recoveries) ? result.recoveries : [];
      restoreLoading = false;
      notify();
      return true;
    }).catch(function(error){
      restoreLoading = false;
      detail = errorMessage(error,"Could not load recovery copies");
      notify();
      return false;
    });
  }
  function restore(recoveryId, versionId){
    if(!config || !online()) return Promise.resolve(false);
    setPhase("restoring","Restoring recovery copy…");
    var path = "/v1/recoveries/" + encodeURIComponent(recoveryId) + "/" + encodeURIComponent(versionId);
    return fetchWithTimeout(endpoint + path,{
      method:"GET",headers:authHeaders({"Accept":"application/json"})
    },90000).then(function(response){
      if(!response.ok) return responseJSON(response);
      var expected = response.headers.get("X-PrePlot-SHA256") || "";
      return response.text().then(function(text){
        return sha256Hex(text).then(function(actual){
          if(!expected || actual !== expected) throw new Error("Recovery copy failed its integrity check");
          return Promise.resolve(applyPortable(text)).then(function(applied){
            if(!applied) throw new Error("Recovery copy could not be restored");
            savedStatus.recoveryId = recoveryId;
            savedStatus.stateCreated = String(survey().created || "");
            savedStatus.stateUpdated = String(survey().updated || "");
            savedStatus.verifiedAt = String(response.headers.get("X-PrePlot-Verified-At") || "");
            savedStatus.sha256 = expected;
            storeStatus();
            restoreOpen = false;
            recoveries = [];
            markDirty(1000);
            return true;
          });
        });
      });
    }).catch(function(error){
      setPhase("failed",errorMessage(error,"Recovery copy could not be restored"));
      return false;
    });
  }
  function resume(){
    if(!config || !hasWork()) return Promise.resolve(false);
    var info = survey();
    if(savedStatus.recoveryId && savedStatus.stateCreated === String(info.created || "") &&
       savedStatus.stateUpdated && savedStatus.stateUpdated === info.updated && !dirty){
      setPhase("verified","");
      return Promise.resolve(true);
    }
    markDirty(500);
    return Promise.resolve(false);
  }
  function start(){
    stopped = false;
    if(config && hasWork()){
      var info = survey();
      recoveryIdentity();
      if(savedStatus.stateCreated === String(info.created || "") && savedStatus.stateUpdated === info.updated){
        phase = "verified";
      } else {
        dirty = true;
        phase = online() ? "pending" : "waiting";
        if(online()) schedule(1500);
      }
    }
    notify();
  }
  function stop(){ stopped = true; clearTimer(); }
  function status(){
    return {
      connected:!!config,
      phase:phase,
      detail:detail,
      dirty:dirty,
      flight:!!flight,
      verifiedAt:savedStatus.verifiedAt || "",
      stateUpdated:savedStatus.stateUpdated || "",
      connectOpen:connectOpen,
      restoreOpen:restoreOpen,
      restoreLoading:restoreLoading,
      recoveries:recoveries.slice()
    };
  }
  function statusHTML(){
    var h = '<div class="recovery-panel" data-recovery-panel><div class="recovery-head">' +
      '<div><div class="flab">Automatic recovery</div>';
    if(!config){
      h += '<div class="hint">Optional cloud safety net. PrePlot still works normally without a connection.</div></div>' +
        '<button type="button" class="btn sm" data-recovery-connect-open>Connect recovery</button></div>';
      if(connectOpen){
        h += '<div class="recovery-connect"><label class="flab" for="recoveryCode">One-time recovery code</label>' +
          '<input id="recoveryCode" data-recovery-code autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" ' +
          'placeholder="Paste code">' +
          '<div class="roomtools"><button type="button" class="btn sm pri" data-recovery-connect>Connect this installation</button>' +
          '<button type="button" class="btn sm ghost" data-recovery-connect-cancel>Cancel</button></div></div>';
      }
      if(detail) h += '<div class="flag" style="margin-top:8px">'+htmlEsc(detail)+'</div>';
      return h + '</div>';
    }
    var label = "Recovery connected";
    var cls = "hint";
    if(phase === "verified") label = "Recovery copy verified " + fmtTime(savedStatus.verifiedAt);
    else if(phase === "waiting") label = "Recovery waiting for a connection";
    else if(phase === "uploading") label = "Creating recovery copy…";
    else if(phase === "pending") label = "Recovery copy pending";
    else if(phase === "restoring") label = "Restoring recovery copy…";
    else if(phase === "failed"){ label = "Recovery needs attention"; cls = "flag"; }
    h += '<div class="'+cls+'" data-recovery-status>'+htmlEsc(label)+'</div>' +
      '<div class="hint">Capture always saves to this device first. Drive remains the permanent job record.</div></div>' +
      '<div class="recovery-actions"><button type="button" class="btn sm" data-recovery-sync'+
      ((phase === "uploading" || phase === "restoring") ? ' disabled' : '')+'>Check now</button>' +
      '<button type="button" class="btn sm ghost" data-recovery-list>Restore recovery</button></div></div>';
    if(detail && phase !== "waiting") h += '<div class="flag" style="margin-top:8px">'+htmlEsc(detail)+'</div>';
    if(restoreOpen){
      h += '<div class="recovery-list" data-recovery-list-wrap>';
      if(restoreLoading) h += '<div class="hint">Loading recovery copies…</div>';
      else if(!recoveries.length) h += '<div class="hint">No recovery copies are available yet.</div>';
      else recoveries.forEach(function(item){
        var name = item.client || item.site || "Untitled survey";
        var sub = [item.site,item.visitDate,fmtTime(item.uploaded)].filter(function(value){ return !!value; }).join(" · ");
        h += '<div class="recovery-item"><div><b>'+htmlEsc(name)+'</b><div class="hint">'+htmlEsc(sub)+'</div></div>' +
          '<button type="button" class="btn sm ghost" data-recovery-restore data-recovery-id="'+htmlEsc(item.recoveryId)+
          '" data-recovery-version="'+htmlEsc(item.versionId)+'">Restore</button></div>';
      });
      h += '<button type="button" class="btn sm ghost" data-recovery-list-close>Close recovery list</button></div>';
    }
    return h + '</div>';
  }

  return {
    start:start,
    stop:stop,
    markDirty:markDirty,
    flush:flush,
    resume:resume,
    connect:connect,
    openConnect:function(){ connectOpen = true; detail = ""; notify(); },
    closeConnect:function(){ connectOpen = false; detail = ""; notify(); },
    loadRecoveries:loadRecoveries,
    closeRecoveries:function(){ restoreOpen = false; recoveries = []; notify(); },
    restore:restore,
    status:status,
    html:statusHTML,
    endpoint:function(){ return endpoint; }
  };
}

root.PrePlotRecovery = {
  create:create,
  createId:createId,
  sha256Hex:sha256Hex,
  DEFAULT_ENDPOINT:DEFAULT_ENDPOINT,
  MAX_RECOVERY_BYTES:MAX_RECOVERY_BYTES
};
})(window);
