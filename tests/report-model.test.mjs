import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchBrowser,
  serve
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var JPG_BYTES = Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEoooryD9EP//Z",
  "base64"
));
var JPG = "data:image/jpeg;base64," + Buffer.from(JPG_BYTES).toString("base64");

function modelState(){
  return {
    visit:{
      client:"Model fixture",
      site:"Main < Hall",
      date:"2026-07-30",
      surveyor:"Jonathan",
      scope:"Replace the display and preserve the existing control workflow.",
      coverPhotoId:JPG
    },
    log:{lognote:"Use the west loading door."},
    rooms:[{
      id:1,
      d:{
        name:"Room A",
        len:"30",
        wid:"20",
        hgt:"10",
        seats:"24",
        lux_disp:"210",
        disptype:"Direct-view (LCD / LED)",
        inv:"Existing display",
        ctrl:["Touch panel"],
        flags:"Coordinate the loudspeaker locations."
      }
    }],
    photos:{"1|audio":[JPG]},
    skipped:{},
    ui:{}
  };
}

async function withApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    assert.equal(await page.evaluate(function(state){
      return window.__avl.applyImport(JSON.stringify(state));
    },modelState()),true);
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

test("report-model extraction preserves the fixed PDF byte for byte", async function(){
  await withApp(async function(page){
    var bytes = await page.evaluate(function(jpegBytes){
      var manifest = window.__avl.photoManifest();
      var report = window.__avl.assemblePdfReport(manifest,[{
        bytes:new Uint8Array(jpegBytes),
        width:8,
        height:6,
        mime:"image/jpeg"
      }]);
      return Array.from(report.bytes);
    },JPG_BYTES);
    var hash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    assert.equal(hash,"62fad26a6ba9527345db1ff9e0cb7e78708cc93f58d6c46e7857f76b7e284eb0");
  });
});

test("the PDF renderer consumes the report model without reaching back into survey state", async function(){
  await withApp(async function(page){
    var result = await page.evaluate(function(jpegBytes){
      var manifest = window.__avl.photoManifest();
      var model = window.__avl.buildReportModel(manifest);
      model.cover.client = "MODEL ONLY CLIENT";
      model.rooms[0].title = "MODEL ONLY ROOM";
      window.__avl.S().visit.client = "STATE CLIENT MUST NOT RENDER";
      window.__avl.S().rooms[0].d.name = "STATE ROOM MUST NOT RENDER";
      var report = window.__avl.assemblePdfReportModel(model,[{
        bytes:new Uint8Array(jpegBytes),
        width:8,
        height:6,
        mime:"image/jpeg"
      }]);
      var text = "";
      for(var i=0;i<report.bytes.length;i++) text += String.fromCharCode(report.bytes[i]);
      return {model:model,raw:text};
    },JPG_BYTES);
    assert.deepEqual(
      Object.keys(result.model),
      ["cover","overview","rooms","photos"]
    );
    assert.deepEqual(
      Object.keys(result.model.rooms[0]).sort(),
      ["cards","id","rows","stats","title"]
    );
    assert.match(result.raw,/MODEL ONLY CLIENT/);
    assert.match(result.raw,/MODEL ONLY ROOM/);
    assert.doesNotMatch(result.raw,/STATE CLIENT MUST NOT RENDER/);
    assert.doesNotMatch(result.raw,/STATE ROOM MUST NOT RENDER/);
  });
});
