import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchBrowser,
  serve,
  until
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var execFile = promisify(execFileCallback);
var JPG_BYTES = Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAIRAxEAPwDEoooryD9EP//Z",
  "base64"
));
var JPG = "data:image/jpeg;base64," + Buffer.from(JPG_BYTES).toString("base64");

function svg(color,label){
  return "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">' +
    '<rect width="900" height="600" fill="' + color + '"/>' +
    '<text x="450" y="320" text-anchor="middle" fill="white" font-size="72">' +
    label + "</text></svg>"
  );
}

function htmlState(){
  return {
    visit:{
      client:'Müller & Co <script id="injected">bad()</script>',
      site:"Café Bâtiment",
      date:"2026-07-30",
      surveyor:"Jonathan",
      scope:"Replace the presentation system."
    },
    log:{lognote:"Use the west loading door."},
    rooms:[{
      id:1,
      d:{
        name:'Studio < & "Café"',
        len:"30",
        wid:"20",
        seats:"24",
        lux_preset:"300",
        disptype:"Projection",
        inv:"Existing projector",
        ctrl:["Touch panel"],
        flags:"Coordinate loudspeakers with lighting."
      }
    }],
    photos:{
      "log|main":[svg("#16283C","SITE")],
      "1|audio":[svg("#2C7A7B","AUDIO 1"),svg("#C8992F","AUDIO 2")]
    },
    skipped:{},
    ui:{}
  };
}

async function preparePackage(state){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    assert.equal(await page.evaluate(function(state){
      return window.__avl.applyImport(JSON.stringify(state));
    },state || htmlState()),true);
    var result = await page.evaluate(function(){
      var manifest = window.__avl.photoManifest();
      window.__avl.preparePhotoPackage();
      return manifest;
    });
    await until(async function(){
      return page.evaluate(function(){
        var status = window.__avl.photoPackageStatus();
        return status.status === "ready" || status.status === "error" || status.status === "stale";
      });
    });
    var packageResult = await page.evaluate(async function(){
      var status = window.__avl.photoPackageStatus();
      var file = window.__avl.photoPackageFile();
      return {
        status:status,
        bytes:file ? Array.from(new Uint8Array(await file.arrayBuffer())) : [],
        pdfOrder:(window.__avl.photoPackageReportLayout() || {}).photoCards || []
      };
    });
    assert.equal(packageResult.status.status,"ready",packageResult.status.message);
    await context.close();
    return {
      manifest:result,
      bytes:Buffer.from(packageResult.bytes),
      pdfOrder:packageResult.pdfOrder,
      root:packageResult.status.filename.replace(/-package\.zip$/,"")
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

test("the archive HTML is local, escaped, searchable and ordered with the PDF and manifest", async function(){
  var prepared = await preparePackage();
  var root = prepared.root;
  var scratch = await mkdtemp(join(tmpdir(),"preplot-html-"));
  var extracted = join(scratch,"extracted");
  var archivePath = join(scratch,"package.zip");
  try {
    await writeFile(archivePath,prepared.bytes);
    await execFile("/usr/bin/unzip",["-qq",archivePath,"-d",extracted]);
    var htmlPath = join(extracted,root,root + ".html");
    var html = await readFile(htmlPath,"utf8");
    assert.match(html,/<!doctype html><html lang="en"><head><meta charset="utf-8">/);
    assert.match(html,/Photographs are embedded in this report/);
    assert.match(html,/src="data:image\//);
    assert.doesNotMatch(html,/src="photos\//);
    assert.doesNotMatch(html,/data-src="photos\//);
    assert.doesNotMatch(html,/(?:https?:|file:)\/\//i);
    assert.ok(Buffer.byteLength(html,"utf8") < 250000);

    for(var i=0;i<prepared.manifest.length;i++){
      var entry = prepared.manifest[i];
      var photo = await readFile(join(extracted,root,"photos",entry.filename));
      assert.ok(photo.length > 0);
    }

    var reportServer = await serve(join(extracted,root));
    var browser = await launchBrowser();
    try {
      var context = await browser.newContext({
        serviceWorkers:"block",
        viewport:{width:390,height:844},
        hasTouch:true
      });
      var external = [];
      await context.route("**/*",function(route){
        var url = route.request().url();
        if(url.indexOf(reportServer.origin + "/") !== 0) external.push(url);
        return route.continue();
      });
      var page = await context.newPage();
      await page.goto(reportServer.origin + "/" + root + ".html",{waitUntil:"networkidle"});
      assert.deepEqual(external,[],"the report must make no external network requests");
      assert.equal(await page.locator("#injected").count(),0,"survey text must not inject markup");
      assert.match(await page.locator("body").innerText(),/Müller & Co <script id="injected">bad\(\)<\/script>/);
      assert.match(await page.locator("body").innerText(),/Studio < & "Café"/);

      /* Embedded sources produce no network traffic, so networkidle no longer
         implies the images decoded, and loading="lazy" defers anything below
         the fold indefinitely. Force them all before asserting on decode. */
      await page.evaluate(async function(){
        var images = Array.prototype.slice.call(document.querySelectorAll(".photo-card img"));
        images.forEach(function(image){ image.loading = "eager"; });
        await Promise.all(images.map(function(image){
          if(image.complete && image.naturalWidth > 0) return null;
          return new Promise(function(resolve){
            image.addEventListener("load",resolve,{once:true});
            image.addEventListener("error",resolve,{once:true});
          });
        }));
      });

      var cards = await page.locator(".photo-card").evaluateAll(function(nodes){
        return nodes.map(function(node){
          return {
            ref:node.getAttribute("data-ref"),
            filename:node.getAttribute("data-filename"),
            src:node.querySelector("img").getAttribute("src"),
            full:node.querySelector("button").getAttribute("data-src"),
            loaded:node.querySelector("img").naturalWidth > 0
          };
        });
      });
      assert.deepEqual(
        cards.map(function(card){ return [card.ref,card.filename]; }),
        prepared.manifest.map(function(entry){ return [entry.ref,entry.filename]; })
      );
      assert.deepEqual(
        cards.map(function(card){ return card.ref; }),
        prepared.pdfOrder.map(function(card){ return card.ref; })
      );
      cards.forEach(function(card){
        assert.match(card.src,/^data:image\/[a-z0-9.+-]+;base64,/i);
        assert.equal(card.full,card.src,"the card and lightbox must use the same embedded full-size source");
        assert.equal(card.loaded,true,"embedded archive photos must decode without sibling-file access");
      });
      var allImageSources = await page.locator("img[src]").evaluateAll(function(images){
        return images.map(function(image){ return image.getAttribute("src"); });
      });
      for(var sourceIndex=0;sourceIndex<allImageSources.length;sourceIndex++){
        var source = allImageSources[sourceIndex];
        assert.match(source,/^data:image\/[a-z0-9.+-]+;base64,/i);
      }

      var roomLink = page.locator(".photo-links a").first();
      var linkedRef = await roomLink.getAttribute("href");
      assert.equal(await page.locator(linkedRef).count(),1);

      var second = page.locator(".photo-open").nth(1);
      await second.focus();
      await second.click();
      assert.equal(await page.locator("#viewer").getAttribute("aria-hidden"),"false");
      assert.equal(await page.locator("#viewer-ref").textContent(),"PHOTO " + prepared.manifest[1].ref);
      assert.equal(
        await page.locator("#viewer-image").getAttribute("src"),
        cards[1].src
      );
      assert.equal(
        await page.locator("#viewer-image").getAttribute("src"),
        await second.locator("img").getAttribute("src"),
        "the lightbox must use the full-size archive file, not a rendition"
      );

      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("#viewer-ref").textContent(),"PHOTO " + prepared.manifest[2].ref);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#viewer").getAttribute("aria-hidden"),"true");
      assert.equal(await page.evaluate(function(){ return document.activeElement.getAttribute("data-photo-index"); }),"1");

      await page.locator(".photo-open").first().click();
      await page.evaluate(function(){
        var viewer = document.getElementById("viewer");
        var start = new Event("touchstart",{bubbles:true});
        Object.defineProperty(start,"touches",{value:[{clientX:300}]});
        viewer.dispatchEvent(start);
        var end = new Event("touchend",{bubbles:true});
        Object.defineProperty(end,"changedTouches",{value:[{clientX:100}]});
        viewer.dispatchEvent(end);
      });
      assert.equal(await page.locator("#viewer-ref").textContent(),"PHOTO " + prepared.manifest[1].ref);
      await page.locator("#viewer-stage").click({position:{x:2,y:2}});
      assert.equal(await page.locator("#viewer").getAttribute("aria-hidden"),"true");
      await context.close();
    } finally {
      await browser.close();
      await reportServer.close();
    }
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
});

test("the model-only HTML template stays text-sized until portable sources are supplied", async function(){
  var photos = [];
  for(var i=0;i<60;i++) photos.push(JPG);
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    await page.goto(server.origin + "/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    var result = await page.evaluate(function(photoList){
      window.__avl.applyImport(JSON.stringify({
        visit:{client:"Sixty photos",site:"Stress fixture",date:"2026-07-30"},
        log:{},rooms:[],photos:{"log|main":photoList},skipped:{},ui:{}
      }));
      var manifest = window.__avl.photoManifest();
      var model = window.__avl.buildReportModel(manifest);
      model.photos.reverse();
      window.__avl.S().photos = {};
      var html = window.__avl.buildHtmlReport(model);
      var renderedRefs = [];
      html.replace(/class="photo-card"[^>]*data-ref="([^"]+)"/g,function(all,ref){
        renderedRefs.push(ref);
        return all;
      });
      return {
        bytes:new TextEncoder().encode(html).length,
        photos:(html.match(/class="photo-card"/g) || []).length,
        modelRefs:model.photos.map(function(photo){ return photo.ref; }),
        renderedRefs:renderedRefs,
        hasInline:/data:image\//.test(html),
        hasExternal:/(?:https?:|file:)\/\//i.test(html)
      };
    },photos);
    assert.equal(result.photos,60);
    assert.deepEqual(result.renderedRefs,result.modelRefs,
      "the HTML renderer must follow its model even when live survey state differs");
    assert.equal(result.hasInline,false);
    assert.equal(result.hasExternal,false);
    assert.ok(result.bytes < 100000,"sixty full-size photos must still produce a text-sized HTML file");
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

test("a sixty-photo package carries a self-contained HTML report", async function(){
  var photos = [];
  for(var i=0;i<60;i++) photos.push(svg(i % 2 ? "#16283C" : "#2C7A7B","PHOTO " + (i+1)));
  var prepared = await preparePackage({
    visit:{client:"Sixty photos",site:"Portable fixture",date:"2026-07-31"},
    log:{},rooms:[],photos:{"log|main":photos},skipped:{},ui:{}
  });
  var scratch = await mkdtemp(join(tmpdir(),"preplot-html-60-"));
  var extracted = join(scratch,"extracted");
  var archivePath = join(scratch,"package.zip");
  try {
    await writeFile(archivePath,prepared.bytes);
    await execFile("/usr/bin/unzip",["-qq",archivePath,"-d",extracted]);
    var html = await readFile(join(extracted,prepared.root,prepared.root + ".html"),"utf8");
    assert.equal((html.match(/<img src="data:image\/svg\+xml;base64,/g) || []).length,60);
    assert.equal((html.match(/ data-src="data:image\/svg\+xml;base64,/g) || []).length,60);
    assert.doesNotMatch(html,/src="photos\//);
    assert.doesNotMatch(html,/data-src="photos\//);
    assert.ok(Buffer.byteLength(html,"utf8") < 500000,
      "the fixture's sixty embedded photos must stay within a bounded artifact");
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
});

test("the exported HTML embeds the chosen cover photograph, not a sibling path", async function(){
  var state = htmlState();
  state.visit.coverPhotoId = state.photos["1|audio"][1];
  var prepared = await preparePackage(state);
  var scratch = await mkdtemp(join(tmpdir(),"preplot-html-cover-"));
  var extracted = join(scratch,"extracted");
  var archivePath = join(scratch,"package.zip");
  try {
    await writeFile(archivePath,prepared.bytes);
    await execFile("/usr/bin/unzip",["-qq",archivePath,"-d",extracted]);
    var root = prepared.root;
    var html = await readFile(join(extracted,root,root + ".html"),"utf8");

    var hero = /<img class="hero-photo" src="([^"]*)"/.exec(html);
    assert.ok(hero,"a chosen cover must render a hero photograph");
    assert.match(hero[1],/^data:image\/[a-z0-9.+-]+;base64,/i,
      "the cover must be embedded, not left folder-relative");
    assert.doesNotMatch(html,/src="photos\//);
    assert.doesNotMatch(html,/data-src="photos\//);

    /* The cover is the same photograph the cards embed, at the same bytes. */
    var coverEntry = prepared.manifest.filter(function(entry){
      return entry.bucketIndex === 1 && entry.key === "1|audio";
    })[0];
    assert.ok(coverEntry,"the fixture must actually name a cover photo");
    var cardSource = new RegExp(
      'data-filename="' + coverEntry.filename.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") +
      '"[\\s\\S]*?<img src="([^"]*)"'
    ).exec(html);
    assert.ok(cardSource,"the cover photo must also appear as a card");
    assert.equal(hero[1],cardSource[1],
      "the hero and the card must share one embedded source");

    var stored = await readFile(join(extracted,root,"photos",coverEntry.filename));
    assert.equal(
      hero[1].split(",")[1],stored.toString("base64"),
      "the embedded cover must be the full stored original, byte for byte"
    );

    var reportServer = await serve(join(extracted,root));
    var browser = await launchBrowser();
    try {
      var context = await browser.newContext({
        serviceWorkers:"block",
        viewport:{width:1400,height:900}
      });
      var page = await context.newPage();
      await page.goto(reportServer.origin + "/" + root + ".html",{waitUntil:"domcontentloaded"});
      await page.locator(".hero-photo").waitFor({state:"visible"});
      var geometry = await page.locator(".hero-photo").evaluate(function(image){
        var rect = image.getBoundingClientRect();
        return {
          width:rect.width,
          height:rect.height,
          naturalWidth:image.naturalWidth,
          naturalHeight:image.naturalHeight,
          fit:getComputedStyle(image).objectFit
        };
      });
      assert.ok(geometry.width <= geometry.naturalWidth,
        "the HTML cover must not enlarge a photo beyond its stored width");
      assert.ok(geometry.height <= geometry.naturalHeight,
        "the HTML cover must not enlarge a photo beyond its stored height");
      assert.equal(geometry.fit,"contain");
      await context.close();
    } finally {
      await browser.close();
      await reportServer.close();
    }
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
});
