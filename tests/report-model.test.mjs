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
    /* D0 established the original byte snapshot. D1 deliberately changes
       only the product capitalization carried by the PDF metadata. */
    assert.equal(hash,"52d13f185a35a94ccd581d2feca72238fac2b34b38265bebece96d9bcc23145d");
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
      ["summary","cover","overview","rooms","photos"]
    );
    assert.deepEqual(
      Object.keys(result.model.rooms[0]).sort(),
      ["cards","id","rows","stats","title"]
    );
    assert.match(result.raw,/MODEL ONLY CLIENT/);
    assert.match(result.raw,/MODEL ONLY ROOM/);
    assert.doesNotMatch(result.raw,/STATE CLIENT MUST NOT RENDER/);
    assert.doesNotMatch(result.raw,/STATE ROOM MUST NOT RENDER/);
    var titleMatch = result.raw.match(/\/Title <FEFF([0-9A-F]+)>/);
    assert.ok(titleMatch,"the PDF must carry a Unicode document title");
    var title = "";
    for(var i=0;i<titleMatch[1].length;i+=4){
      title += String.fromCharCode(parseInt(titleMatch[1].slice(i,i+4),16));
    }
    assert.match(title,/MODEL ONLY CLIENT/);
    assert.doesNotMatch(title,/STATE CLIENT MUST NOT RENDER/);
  });
});

test("canonical ambient-light fields drive both the custom UI and report model", async function(){
  await withApp(async function(page){
    var result = await page.evaluate(function(){
      var fields = window.__avl.LIGHT_FIELDS;
      var time = fields.filter(function(field){ return field.k === "lt_time"; })[0];
      var display = fields.filter(function(field){ return field.k === "lux_disp"; })[0];
      time.l = "Canonical time label";
      time.reportLabel = "Canonical report time";
      display.reportTileLabel = "Canonical display tile";
      window.__avl.S().rooms[0].d.lt_time = "10:30";
      window.__avl.switchAppView("photos");
      window.__avl.switchAppView("survey");
      var model = window.__avl.buildReportModel(window.__avl.photoManifest());
      return {
        keys:fields.map(function(field){ return field.k; }),
        ui:document.getElementById("app").textContent,
        rows:model.rooms[0].rows,
        stats:model.rooms[0].stats
      };
    });
    assert.deepEqual(result.keys,[
      "lt_time","lt_sky","lt_shade","lt_src","lux_disp","lux_mid",
      "lux_rear","lux_preset","disptype","scr_diag","scr_gain"
    ]);
    assert.match(result.ui,/Canonical time label/);
    assert.ok(result.rows.some(function(row){
      return row.label === "Canonical report time" && row.value === "10:30";
    }));
    assert.ok(result.stats.some(function(tile){
      return tile.label === "Canonical display tile" &&
        tile.value === "210 lux" &&
        tile.qualifier === "measured";
    }));
  });
});
