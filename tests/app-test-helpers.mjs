import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";

var require = createRequire(import.meta.url);
var { chromium } = require("playwright");

var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png"
};

export function serve(root){
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

export function launchBrowser(){
  var executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  return chromium.launch({headless:true, executablePath:executablePath});
}
