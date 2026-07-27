/* Authoritative storage for newly captured photo bytes. Survey state keeps
   compact descriptors and portable exports re-inline each photo. */
(function(global){
  "use strict";

  var DB_NAME = "avl-photos";
  var DB_VERSION = 1;
  var STORE_NAME = "photos";
  var dbPromise = null;
  var fallbackCounter = 0;

  function nowISO(){
    try { return new Date().toISOString(); }
    catch(error){ return ""; }
  }

  function createId(){
    if(global.crypto && typeof global.crypto.randomUUID === "function"){
      try { return global.crypto.randomUUID(); }
      catch(error){}
    }
    fallbackCounter++;
    return "avl-" + Date.now().toString(36) + "-" + fallbackCounter.toString(36);
  }

  function decodeDataUrl(dataUrl){
    var value = String(dataUrl);
    var comma = value.indexOf(",");
    if(value.slice(0,5) !== "data:" || comma < 6) throw new Error("Invalid photo data");

    var parts = value.slice(5,comma).split(";");
    var mime = parts[0] || "application/octet-stream";
    var payload = value.slice(comma + 1);
    var bytes;

    if(parts.indexOf("base64") > -1){
      var binary = atob(payload);
      bytes = new Uint8Array(binary.length);
      for(var i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    } else {
      var decoded = decodeURIComponent(payload);
      if(global.TextEncoder){
        bytes = new TextEncoder().encode(decoded);
      } else {
        var utf8 = unescape(encodeURIComponent(decoded));
        bytes = new Uint8Array(utf8.length);
        for(var j=0;j<utf8.length;j++) bytes[j] = utf8.charCodeAt(j);
      }
    }

    return {mime:mime, bytes:bytes};
  }

  function recordFromDataUrl(dataUrl, width, height){
    var decoded = decodeDataUrl(dataUrl);
    var blob = new Blob([decoded.bytes], {type:decoded.mime});
    return {
      id:createId(),
      mime:decoded.mime,
      blob:blob,
      width:Math.max(0, parseInt(width,10) || 0),
      height:Math.max(0, parseInt(height,10) || 0),
      bytes:blob.size,
      createdAt:nowISO()
    };
  }

  function open(){
    if(dbPromise) return dbPromise;
    if(!global.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));

    dbPromise = new Promise(function(resolve, reject){
      var request;
      try { request = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch(error){
        dbPromise = null;
        reject(error);
        return;
      }

      request.onupgradeneeded = function(){
        var db = request.result;
        if(!db.objectStoreNames.contains(STORE_NAME)){
          db.createObjectStore(STORE_NAME, {keyPath:"id"});
        }
      };
      request.onsuccess = function(){
        var db = request.result;
        db.onversionchange = function(){
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = function(){
        dbPromise = null;
        reject(request.error || new Error("Could not open photo storage"));
      };
    });
    return dbPromise;
  }

  function transaction(mode, operation){
    return open().then(function(db){
      return new Promise(function(resolve, reject){
        var tx;
        try { tx = db.transaction(STORE_NAME, mode); }
        catch(error){
          reject(error);
          return;
        }

        var result;
        tx.oncomplete = function(){ resolve(result); };
        tx.onabort = function(){ reject(tx.error || new Error("Photo storage transaction was aborted")); };
        tx.onerror = function(){};

        try {
          result = operation(tx.objectStore(STORE_NAME), tx);
        } catch(error){
          try { tx.abort(); } catch(abortError){}
          reject(error);
        }
      });
    });
  }

  function addRecord(record){
    return transaction("readwrite", function(store){
      store.add(record);
      return record;
    });
  }

  function addDataUrl(dataUrl, width, height){
    var record;
    try { record = recordFromDataUrl(dataUrl, width, height); }
    catch(error){ return Promise.reject(error); }
    return addRecord(record);
  }

  function addDataUrls(items){
    var records;
    try {
      records = (items || []).map(function(item){
        return recordFromDataUrl(item.data, item.width, item.height);
      });
    } catch(error){
      return Promise.reject(error);
    }
    return transaction("readwrite", function(store){
      records.forEach(function(record){ store.add(record); });
      return records;
    });
  }

  function get(id){
    return open().then(function(db){
      return new Promise(function(resolve, reject){
        var request;
        try { request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id); }
        catch(error){
          reject(error);
          return;
        }
        request.onsuccess = function(){ resolve(request.result || null); };
        request.onerror = function(){ reject(request.error || new Error("Could not read photo")); };
      });
    });
  }

  function all(){
    return open().then(function(db){
      return new Promise(function(resolve, reject){
        var records = [];
        var request;
        try { request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).openCursor(); }
        catch(error){
          reject(error);
          return;
        }
        request.onsuccess = function(){
          var cursor = request.result;
          if(!cursor){
            resolve(records);
            return;
          }
          records.push(cursor.value);
          cursor.continue();
        };
        request.onerror = function(){ reject(request.error || new Error("Could not list photos")); };
      });
    });
  }

  function keys(){
    return open().then(function(db){
      return new Promise(function(resolve, reject){
        var values = [];
        var request;
        try {
          request = db.transaction(STORE_NAME, "readonly")
            .objectStore(STORE_NAME)
            .openKeyCursor();
        } catch(error){
          reject(error);
          return;
        }
        request.onsuccess = function(){
          var cursor = request.result;
          if(!cursor){
            resolve(values);
            return;
          }
          values.push(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = function(){ reject(request.error || new Error("Could not list photo keys")); };
      });
    });
  }

  function clear(){
    return transaction("readwrite", function(store){
      store.clear();
      return true;
    });
  }

  global.AVLPhotoStore = {
    DB_NAME:DB_NAME,
    DB_VERSION:DB_VERSION,
    STORE_NAME:STORE_NAME,
    createId:createId,
    recordFromDataUrl:recordFromDataUrl,
    addRecord:addRecord,
    addDataUrl:addDataUrl,
    addDataUrls:addDataUrls,
    get:get,
    keys:keys,
    all:all,
    clear:clear
  };
})(window);
