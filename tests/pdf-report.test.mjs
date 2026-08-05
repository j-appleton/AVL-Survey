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
  surveyStateSnapshot,
  until
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var execFile = promisify(execFileCallback);

function svg(color,label){
  return "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">' +
    '<rect width="900" height="600" fill="'+color+'"/>' +
    '<circle cx="450" cy="300" r="160" fill="white"/>' +
    '<text x="450" y="320" text-anchor="middle" font-size="54">'+label+'</text>' +
    '</svg>'
  );
}
function reportState(){
  var photos = [
    svg("#2C7A7B","1"),svg("#C8992F","2"),svg("#16283C","3"),
    svg("#64748B","4"),svg("#9F1239","5"),svg("#0F766E","6"),svg("#7C3AED","7")
  ];
  return {
    visit:{
      client:"Müller AV",
      site:"Café Bâtiment",
      date:"2026-07-30",
      surveyor:"Jonathan",
      scope:"Replace the presentation system and document coordination constraints.",
      coverPhotoId:photos[4]
    },
    log:{lognote:"Dock access is limited after 4 PM."},
    rooms:[
      {id:1,d:{
        name:"Salle de conférence",
        len:"32",wid:"20",hgt:"11",seats:"18",
        lux_disp:"210",lux_mid:"340",lux_rear:"620",
        disptype:"Direct-view (LCD / LED)",
        type:"Conference",far:"28",
        inv:"Existing 86-inch display and rack",
        ctrl:["Touch panel","Auto-sensing"],
        lightctl:"Crestron",
        flags:"Coordinate ceiling loudspeaker locations with lighting."
      }},
      {id:2,d:{
        name:"Breakout",
        lux_preset:"300",
        disptype:"Projection",
        flags:"No dedicated power at the display wall."
      }}
    ],
    photos:{
      "log|main":[photos[0],photos[1]],
      "1|dims":[photos[2]],
      "1|audio":[photos[3],photos[4]],
      "2|light":[photos[5],photos[6]]
    },
    skipped:{},
    ui:{}
  };
}
async function withPdfApp(state,run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    assert.equal(
      await page.evaluate(function(payload){
        return window.__avl.applyImport(JSON.stringify(payload));
      },state),
      true
    );
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}
async function optionalTool(t,command,args){
  try {
    return await execFile(command,args);
  } catch(error){
    if(error && error.code === "ENOENT"){
      t.diagnostic(command + " is not installed locally; CI installs the independent PDF gate");
      return null;
    }
    throw error;
  }
}

test("designed report is structurally valid, mixed-orientation and text-traceable", async function(t){
  await withPdfApp(reportState(),async function(page){
    var before = await surveyStateSnapshot(page);
    var result = await page.evaluate(async function(){
      var report = await window.__avl.generatePdfReport();
      return {
        bytes:Array.from(report.bytes),
        pages:report.pages,
        layout:report.layout,
        dimensions:report.renditionDimensions,
        released:report.renditionsReleased
      };
    });
    assert.equal(await surveyStateSnapshot(page),before);
    assert.deepEqual(
      await page.evaluate(function(){ return window.__avl.PDF_COLORS; }),
      {
        navy:"#16283C",
        teal:"#2C7A7B",
        gold:"#C8992F",
        card:"#E9EEF3",
        ink:"#1A2B3C",
        muted:"#64748B"
      }
    );
    assert.equal(result.released,true);
    assert.equal(result.pages.length,6);
    assert.deepEqual(
      result.pages.map(function(p){ return [p.width,p.height]; }),
      [[612,792],[612,792],[612,792],[612,792],[792,612],[792,612]]
    );
    assert.equal(result.layout.coverImageIndex,4);
    assert.equal(result.layout.roomTiles[1].dimensions.length,0);
    assert.equal(
      result.layout.roomTiles[0].light.filter(function(tile){
        return tile.qualifier === "measured";
      }).length,
      3
    );
    assert.equal(
      result.layout.roomTiles[1].light[0].qualifier,
      "estimated, no meter"
    );
    assert.match(
      result.layout.roomTiles[0].light[3].qualifier,
      /^from 210 lux at display wall$/
    );
    assert.equal(result.layout.photoCards.length,7);
    assert.deepEqual(
      result.layout.photoCards.map(function(card){ return card.imageIndex; }),
      [0,1,2,3,4,5,6]
    );
    result.dimensions.forEach(function(image){
      assert.equal(Math.max(image.width,image.height),600);
    });

    var raw = Buffer.from(result.bytes).toString("latin1");
    assert.equal((raw.match(/\/DCTDecode/g) || []).length,7);
    var imageHeaders = Array.from(
      raw.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)[\s\S]*?\/DCTDecode/g)
    ).map(function(match){
      return {width:Number(match[1]),height:Number(match[2])};
    });
    assert.deepEqual(
      imageHeaders,
      result.dimensions.map(function(image){
        return {width:image.width,height:image.height};
      }),
      "every embedded DCT image declares the dimensions scanned from its rendition"
    );
    assert.match(raw,/ re W n /,"the cover and photo crops must use a clipping path");
    assert.ok((raw.match(/ Tc /g) || []).length > 0,"eyebrow labels use real letterspacing");
    assert.doesNotMatch(raw,/window\.print/);

    var scratch = await mkdtemp(join(tmpdir(),"preplot-pdf-"));
    try {
      var pdf = join(scratch,"report.pdf");
      await writeFile(pdf,Buffer.from(result.bytes));
      var info = await execFile("pdfinfo",[pdf]);
      assert.match(info.stdout,/Pages:\s+6/);
      assert.match(info.stdout,/Title:\s+PrePlot — Müller AV — Café Bâtiment — 2026-07-30/);

      var qpdf = await optionalTool(t,"qpdf",["--check",pdf]);
      if(qpdf) assert.match(qpdf.stdout + qpdf.stderr,/No syntax or stream encoding errors found/);

      var textResult = await optionalTool(t,"pdftotext",["-layout",pdf,"-"]);
      if(textResult){
        var text = textResult.stdout;
        assert.match(text,/Müller AV/);
        assert.match(text,/Café Bâtiment/);
        assert.match(text,/Salle de conférence/);
        assert.match(text,/estimated, no meter/);
        assert.match(text,/from 210 lux at display wall/);
        assert.doesNotMatch(text,/disclaimer|verify these measurements|unverified/i);
        var manifest = await page.evaluate(function(){ return window.__avl.photoManifest(); });
        var position = -1;
        manifest.forEach(function(entry){
          var refAt = text.indexOf("PHOTO " + entry.ref,position + 1);
          var fileAt = text.indexOf(entry.filename,refAt);
          assert.ok(refAt > position,"photo refs must extract in manifest order");
          assert.ok(fileAt > refAt,"each filename must follow its matching ref");
          position = fileAt;
        });
        assert.match(text,/PAGE 6 OF 6/);
      }
    } finally {
      await rm(scratch,{recursive:true,force:true});
    }
  });
});

test("wrapped overview text resets header letterspacing before it is drawn", async function(){
  await withPdfApp({
    visit:{client:"Wrap fixture",site:"Long notes",date:"2026-08-05"},
    log:{},rooms:[],photos:{},skipped:{},ui:{}
  },async function(page){
    var result = await page.evaluate(function(){
      var body = "Will need to coordinate specifically with their open schedule as business will be active and their client base will be sensitive. This second sentence makes the wrapping unmistakable.";
      var documentModel = window.__avl.buildReportDocument({
        summary:"",
        cover:{
          client:"Wrap fixture",site:"Long notes",date:"2026-08-05",
          surveyor:"Jonathan",photoCount:0,coverPhoto:null
        },
        overview:[{title:"Site logistics",body:body}],
        rooms:[],
        photos:[]
      },[]);
      var overview = documentModel.pages.filter(function(candidate){
        return candidate.kind === "overview";
      })[0];
      return overview.commands.filter(function(command){
        return command.indexOf("/F1 9.50 Tf") > -1;
      });
    });
    assert.ok(result.length > 1,"the fixture must wrap across multiple body lines");
    result.forEach(function(command){
      assert.match(
        command,/ 0\.00 Tc /,
        "ordinary body text must explicitly clear the page header's letterspacing"
      );
    });
  });
});

test("a short executive summary shares the Visit overview page with field notes", async function(){
  await withPdfApp({
    visit:{client:"Combined fixture",site:"Overview",date:"2026-08-05"},
    log:{},rooms:[],photos:{},skipped:{},ui:{}
  },async function(page){
    var result = await page.evaluate(function(){
      var summary = "Replace the presentation system while preserving the room's familiar operating flow.";
      var note = "Coordinate the installation around the client's public schedule.";
      var documentModel = window.__avl.buildReportDocument({
        summary:summary,
        cover:{
          client:"Combined fixture",site:"Overview",date:"2026-08-05",
          surveyor:"Jonathan",photoCount:0,coverPhoto:null
        },
        overview:[{title:"Site logistics",body:note}],
        rooms:[],photos:[]
      },[]);
      var overviewPages = documentModel.pages.filter(function(candidate){
        return candidate.kind === "overview";
      });
      var commands = overviewPages.length ? overviewPages[0].commands.join("\n") : "";
      return {
        kinds:documentModel.pages.map(function(candidate){ return candidate.kind; }),
        overviewPages:overviewPages.length,
        hasSummary:commands.indexOf(window.__avl.pdfTextToken(summary)) > -1,
        hasNote:commands.indexOf(window.__avl.pdfTextToken(note)) > -1
      };
    });
    assert.equal(result.kinds.indexOf("summary"),-1,"summary-only pages should not be produced");
    assert.equal(result.overviewPages,1);
    assert.equal(result.hasSummary,true,"the summary must render on Visit overview");
    assert.equal(result.hasNote,true,"the first field note must share that page");
  });
});

test("room tables and information cards retain wrapped text across pages", async function(){
  await withPdfApp({
    visit:{client:"Room flow fixture",site:"Long answers",date:"2026-08-05"},
    log:{},rooms:[],photos:{},skipped:{},ui:{}
  },async function(page){
    var result = await page.evaluate(function(){
      var rows = [];
      for(var index=0;index<24;index++){
        rows.push({
          label:"Pathways and rack field with a deliberately long label " + index,
          value:"This answer records the route, access constraints, coordination needs, " +
            "and conditions that must remain visible to engineering and operations. " +
            (index === 23 ? "TABLETAILMARKER" : "Row " + index)
        });
      }
      var equipment = "FSR MAS-8100, Tascam DV-D01U, Shure SCM268, Onkyo DX-C390, " +
        "Crown CDi2000, existing cabling, and rack accessories must all remain visible. " +
        "The complete inventory also includes power distribution, network switching, " +
        "wireless microphone receivers, playback equipment, spare cabling, and hardware " +
        "that engineering must account for in the quote and installation plan. " +
        "EQUIPMENTTAILMARKER";
      var documentModel = window.__avl.buildReportDocument({
        summary:"",
        cover:{
          client:"Room flow fixture",site:"Long answers",date:"2026-08-05",
          surveyor:"Jonathan",photoCount:0,coverPhoto:null
        },
        overview:[],
        rooms:[{
          id:"1",title:"Conference Hall",stats:[],rows:rows,
          cards:[
            {header:"Existing equipment",bullets:[{label:"Inventory",value:equipment}]},
            {header:"Control",bullets:[
              {label:"Interface",value:"Touch panel"},
              {label:"Lighting control",value:"Not required"},
              {label:"Operator",value:"Public / unattended"}
            ]}
          ]
        }],
        photos:[]
      },[]);
      var roomPages = documentModel.pages.filter(function(candidate){
        return candidate.kind === "room";
      });
      return {
        count:roomPages.length,
        commands:roomPages.map(function(candidate){
          return candidate.commands.join("\n");
        }).join("\n")
      };
    });
    assert.ok(result.count > 1,"long room data must continue onto another page");
    assert.match(result.commands,/TABLETAILMARKER/,"table values must not stop after two lines");
    assert.match(result.commands,/EQUIPMENTTAILMARKER/,"equipment values must not be ellipsized");
  });
});

test("cover identity survives portable import, reordering and deliberate deletion", async function(){
  await withPdfApp(reportState(),async function(page){
    await page.locator('[data-app-view="photos"]').click();
    await page.locator('[data-photos="1|audio"] [data-viewph]').nth(1).click();
    await page.waitForSelector("[data-phv-cover]");
    assert.equal(
      await page.locator("[data-phv-cover]").getAttribute("aria-pressed"),
      "true"
    );
    await page.locator("[data-phv-cover]").click();
    assert.equal(
      await page.evaluate(function(){ return window.__avl.S().visit.coverPhotoId; }),
      ""
    );
    await page.locator("[data-phv-cover]").click();
    assert.equal(
      await page.locator("[data-phv-cover]").getAttribute("aria-pressed"),
      "true"
    );
    await page.locator("[data-phv-close]").click();
    var result = await page.evaluate(async function(newPhoto){
      var first = await window.__avl.generatePdfReport();
      var portable = await window.__avl.portableEnvelope();
      var imported = await window.__avl.applyPortableDescriptorImportForTest(
        JSON.stringify(portable)
      );
      var importedCover = window.__avl.S().visit.coverPhotoId;
      var importedPhotos = window.__avl.S().photos["1|audio"];
      var survivesImport = importedCover === importedPhotos[1].id;
      window.__avl.S().photos["1|audio"].unshift(newPhoto);
      var reordered = await window.__avl.generatePdfReport();
      window.__avl.switchAppView("photos");
      var button = document.querySelector('[data-photos="1|audio"] [data-delph="2"]');
      button.click();
      button.click();
      var cleared = window.__avl.S().visit.coverPhotoId;
      var fallback = await window.__avl.generatePdfReport();
      return {
        first:first.layout.coverImageIndex,
        imported:imported,
        survivesImport:survivesImport,
        reordered:reordered.layout.coverImageIndex,
        cleared:cleared,
        fallback:fallback.layout.coverImageIndex
      };
    },svg("#111827","NEW"));
    assert.equal(result.first,4);
    assert.equal(result.imported,true);
    assert.equal(result.survivesImport,true);
    assert.equal(result.reordered,5,"the stable descriptor id follows the selected photo");
    assert.equal(result.cleared,"");
    assert.equal(result.fallback,null);
  });
});

test("zero photos still produce a valid navy report", async function(){
  await withPdfApp({
    visit:{client:"No photos",site:"Empty room",date:"2026-07-30"},
    log:{},rooms:[],photos:{},skipped:{},ui:{}
  },async function(page){
    var result = await page.evaluate(async function(){
      var report = await window.__avl.generatePdfReport();
      return {
        bytes:Array.from(report.bytes),
        pages:report.pages,
        cover:report.layout.coverImageIndex
      };
    });
    assert.equal(result.cover,null);
    assert.deepEqual(result.pages,[
      {kind:"cover",width:612,height:792}
    ]);
    var raw = Buffer.from(result.bytes).toString("latin1");
    assert.match(raw,/%PDF-1\.4/);
    assert.equal((raw.match(/\/DCTDecode/g) || []).length,0);
  });
});

test("a dense room flows onto continuation pages without dropping the final fields", async function(t){
  var dense = {
    name:"Ballroom A",type:"Multipurpose",use:"Meetings, performances and banquets",
    len:"96",wid:"64",hgt:"24",seats:"500",
    ceil:"Open plenum",wall:["Drywall","Concrete"],back:"issue",
    obst:"Beams, sprinklers, chandeliers and operable partitions",
    lt_time:"14:30",lt_sky:"Sunny",lt_shade:"Partial / sheer",
    lt_src:["Overhead LED/fluorescent","Skylight","Stage lighting"],
    lux_disp:"680",lux_mid:"530",lux_rear:"940",
    disptype:"Projection",scr_diag:"240",scr_gain:"1.0",
    near:"12",far:"88",viewtype:"Analytical / detailed content",
    propdiag:"240",mounth:"Above the proscenium",sight:"issue",
    exdisp:"Existing projector and motorized screen to remove",
    noise:"57",hvac:"issue",reverb:"issue",
    mics:["Ceiling array","Wireless handheld","Lavalier"],
    spk:"Coordinate line arrays with lighting and rigging",
    outlets:"issue",panel:"Electrical room 180 feet away",
    dedic:"issue",powby:"EC / by others",
    drops:"ok",dropn:"12",cat:"Cat6a",
    switch:"IDF on level 2 with limited PoE budget",
    vlan:"Client IT to provide AV VLAN and addressing",
    fw:"issue",uc:"Microsoft Teams",
    conduit:"issue",pathtype:["Cable tray","J-hooks","Floor box"],
    runft:"285",core:"issue",rackloc:"Control booth at rear",
    rackru:"8",rackvent:"issue",
    inv:"Projector, screen, analog mixer, amplifiers and control rack",
    reuse:"issue",remov:"AV contractor",
    ctrl:["Touch panel","Button panel","Existing system"],
    lightctl:"DMX",oper:"Trained AV staff"
  };
  await withPdfApp({
    visit:{client:"Dense fixture",site:"Convention center",date:"2026-07-30"},
    log:{},rooms:[{id:1,d:dense}],photos:{},skipped:{},ui:{}
  },async function(page){
    var result = await page.evaluate(async function(){
      var report = await window.__avl.generatePdfReport();
      return {bytes:Array.from(report.bytes),pages:report.pages};
    });
    var roomPages = result.pages.filter(function(p){ return p.kind === "room"; });
    assert.ok(roomPages.length > 1,"dense rooms need a continuation rather than clipped rows");
    var raw = Buffer.from(result.bytes).toString("latin1");
    assert.match(raw,/FIELD RECORD - CONTINUED/);
    assert.match(raw,/Rack ventilation adequate/);

    var scratch = await mkdtemp(join(tmpdir(),"preplot-dense-pdf-"));
    try {
      var pdf = join(scratch,"dense.pdf");
      await writeFile(pdf,Buffer.from(result.bytes));
      var textResult = await optionalTool(t,"pdftotext",["-layout",pdf,"-"]);
      if(textResult){
        assert.match(textResult.stdout,/Rack ventilation adequate/);
        assert.match(textResult.stdout,new RegExp("PAGE " + result.pages.length + " OF " + result.pages.length));
      }
    } finally {
      await rm(scratch,{recursive:true,force:true});
    }
  });
});

test("sixty-photo report stays bounded and releases every rendition", async function(){
  var photos = [];
  for(var i=1;i<=60;i++) photos.push(svg(i%2 ? "#16283C" : "#2C7A7B",String(i)));
  await withPdfApp({
    visit:{client:"Sixty photos",site:"Stress fixture",date:"2026-07-30"},
    log:{},rooms:[],photos:{"log|main":photos},skipped:{},ui:{}
  },async function(page){
    var result = await page.evaluate(async function(){
      var started = performance.now();
      var report = await window.__avl.generatePdfReport();
      return {
        bytes:report.bytes.length,
        elapsed:performance.now()-started,
        released:report.renditionsReleased,
        images:report.renditionDimensions,
        photoPages:report.pages.filter(function(p){ return p.kind === "photos"; }).length
      };
    });
    assert.equal(result.released,true);
    assert.equal(result.images.length,60);
    assert.equal(result.photoPages,10);
    assert.ok(result.bytes < 8 * 1024 * 1024);
    result.images.forEach(function(image){
      assert.equal(Math.max(image.width,image.height),600);
    });
  });
});
