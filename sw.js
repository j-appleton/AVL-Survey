/* PrePlot — offline service worker.
   Bump CACHE when you change any app file; old caches are purged on activate. */
var CACHE = "avl-survey-v30";

var ASSETS = [
  "./",
  "./index.html",
  "./photo-store.js",
  "./photo-captions.js",
  "./compose.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon.png"
];

function verifyOfflineCache(cache){
  return Promise.all(ASSETS.map(function(asset){
    return cache.match(asset);
  })).then(function(matches){
    for(var i=0;i<matches.length;i++){
      if(!matches[i]) throw new Error("Offline cache is incomplete: " + ASSETS[i]);
    }
    return cache;
  });
}

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c){
        return c.addAll(ASSETS).then(function(){
          return verifyOfflineCache(c);
        });
      })
      .catch(function(error){
        return caches.delete(CACHE).then(function(){ throw error; });
      })
  );
});

/* A new worker waits until the open app explicitly asks it to activate.
   This prevents a deploy from replacing the runtime during an active survey. */
self.addEventListener("message", function(e){
  if(e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.open(CACHE)
      .then(verifyOfflineCache)
      .then(function(){ return caches.keys(); })
      .then(function(keys){
        return Promise.all(keys.map(function(k){
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function(){ return self.clients.claim(); })
  );
});

/* Cache-first: on a job site there is no network, and the app never
   needs fresh data from anywhere. Network is only a fallback. */
self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  if(new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function(hit){
      if(hit) return hit;
      return fetch(req).then(function(res){
        if(res && res.status === 200 && res.type === "basic"){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
        }
        return res;
      }).catch(function(){
        // navigation request with no network and no cache entry → serve the shell
        if(req.mode === "navigate") return caches.match("./index.html");
        return new Response("", { status: 504, statusText: "Offline" });
      });
    })
  );
});
