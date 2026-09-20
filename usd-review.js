/* Local USD inspection. Geometry stays ephemeral; only explicitly selected
   room names are handed to the survey. No uploads or external asset loading. */
(function(root){
"use strict";
var active = null;
function node(tag,text,parent){
  var element = document.createElement(tag);
  if(text !== undefined) element.textContent = text;
  if(parent) parent.appendChild(element);
  return element;
}
function preview(canvas,scan){
  var ctx = canvas.getContext("2d"), horizontal = scan.upAxis === "Y" ? 2 : 1;
  var a = scan.bounds.min, b = scan.bounds.max;
  var scale = Math.min(560 / Math.max(b[0]-a[0],0.001),260 / Math.max(b[horizontal]-a[horizontal],0.001));
  function xy(p){ return [300+(p[0]-(a[0]+b[0])/2)*scale,150-(p[horizontal]-(a[horizontal]+b[horizontal])/2)*scale]; }
  ctx.fillStyle = "#E9EEF3"; ctx.fillRect(0,0,600,300);
  scan.meshes.forEach(function(mesh){
    ctx.strokeStyle = /^(Wall|Door|Window|Floor)$/i.test(mesh.category) ? "#16283C" : "#64748B";
    ctx.lineWidth = /^Wall$/i.test(mesh.category) ? 1.5 : 0.6;
    ctx.beginPath();
    mesh.edges.forEach(function(edge){
      var from = xy(mesh.points[edge[0]]), to = xy(mesh.points[edge[1]]);
      ctx.moveTo(from[0],from[1]); ctx.lineTo(to[0],to[1]);
    });
    ctx.stroke();
  });
  ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
  scan.areas.forEach(function(area){
    var p = xy(area.position), width = ctx.measureText(area.name).width;
    ctx.fillStyle = "#E9EEF3"; ctx.fillRect(p[0]-width/2-4,p[1]-9,width+8,16);
    ctx.fillStyle = "#2C7A7B"; ctx.fillText(area.name,p[0],p[1]+3);
  });
}
function open(file,options){
  if(active) return;
  options = options || {};
  var origin = document.activeElement;
  var overlay = node("div"); overlay.className = "usd-review";
  overlay.setAttribute("data-usd-review","");
  overlay.setAttribute("role","dialog"); overlay.setAttribute("aria-modal","true");
  overlay.setAttribute("aria-labelledby","usd-review-title");
  var panel = node("div",undefined,overlay); panel.className = "usd-panel";
  var head = node("div",undefined,panel); head.className = "usd-head";
  node("h2","Review room scan",head).id = "usd-review-title";
  var close = node("button","Close",head); close.className = "btn"; close.type = "button";
  close.setAttribute("data-usd-close","");
  var body = node("div",undefined,panel); body.className = "usd-body";
  var filename = node("p",file.name,body); filename.className = "hint";
  var status = node("p","Reading scan…",body); status.setAttribute("role","status");
  var contents = node("div",undefined,body);
  var lock = options.lock ? options.lock() : null;
  var session = {overlay:overlay}; active = session;
  document.body.appendChild(overlay);
  function finish(){
    if(active !== session) return;
    active = null; document.removeEventListener("keydown",keyDown);
    overlay.remove();
    if(options.unlock) options.unlock(lock);
    var trigger = document.querySelector("[data-usd-import]") || origin;
    if(trigger && document.documentElement.contains(trigger)) trigger.focus({preventScroll:true});
  }
  function keyDown(event){
    if(event.key === "Escape"){ event.preventDefault(); finish(); return; }
    if(event.key !== "Tab") return;
    var controls = overlay.querySelectorAll("button:not([disabled]),select,input:not([disabled])");
    var first = controls[0],last = controls[controls.length-1];
    if(event.shiftKey && document.activeElement === first){event.preventDefault();last.focus();}
    else if(!event.shiftKey && document.activeElement === last){event.preventDefault();first.focus();}
  }
  document.addEventListener("keydown",keyDown); close.onclick = finish; close.focus();
  function failure(error){
    if(active !== session) return;
    contents.textContent = "";
    status.textContent = (error && error.message ? error.message : "Could not read this scan.") + " Your survey has not changed.";
  }
  function show(scan){
    if(active !== session) return;
    status.textContent = scan.meshes.length + " objects · " + scan.areas.length + " named space" + (scan.areas.length === 1 ? "" : "s");
    var canvas = node("canvas",undefined,contents); canvas.width = 600; canvas.height = 300;
    canvas.setAttribute("aria-label","Top-down preview of the room scan"); canvas.setAttribute("role","img");
    preview(canvas,scan);
    var counts = Object.keys(scan.counts).map(function(name){ return name + ": " + scan.counts[name]; });
    node("p",counts.join(" · "),contents).className = "hint";
    var unitLabel = node("label","Scan units",contents); unitLabel.htmlFor = "usd-units";
    var units = node("select",undefined,contents); units.id = "usd-units";
    [["","Choose units to see measurements"],["1","Meters"],["0.01","Centimeters"],["0.001","Millimeters"],["0.3048","Feet"],["0.0254","Inches"]].forEach(function(item){
      var option = node("option",item[1],units); option.value = item[0];
    });
    if(scan.metersPerUnit !== null){
      units.value = String(scan.metersPerUnit);
      if(!units.value){ var custom = node("option","File units ("+scan.metersPerUnit+" m)",units); custom.value = String(scan.metersPerUnit); units.value = custom.value; }
    }
    node("p",scan.metersPerUnit === null ? "No units in this file — choose the units used by your scanning app." : "Units read from the file. Change only if the export scale is wrong.",contents).className = "hint";
    var measurements = node("p","",contents); measurements.setAttribute("data-usd-measurements","");
    units.onchange = function(){
      if(!units.value){measurements.textContent = "";return;}
      var dims = root.PrePlotUSDScene.dimensions(scan,Number(units.value));
      measurements.textContent = "Whole-scan bounds: " + dims.x.toFixed(1) + " × " + (scan.upAxis === "Y" ? dims.z : dims.y).toFixed(1) + " ft · vertical span " + dims.height.toFixed(1) + " ft";
    };
    units.onchange();
    node("p","Scan-axis extents only, not individual room dimensions or ceiling heights. Survey measurements stay blank.",contents).className = "hint";
    node("h3","Add named rooms",contents);
    node("p","Adds selected names without replacing existing work. The scan itself is not included in the ZIP.",contents).className = "hint";
    var choices = [], known = options.roomNames ? options.roomNames() : [];
    var seen = Object.create(null);
    known.forEach(function(name){seen[String(name).trim().toLowerCase()] = true;});
    scan.areas.forEach(function(area){
      var row = node("label",undefined,contents); row.className = "usd-choice";
      var input = node("input",undefined,row); input.type = "checkbox";
      input.disabled = !!seen[area.name.toLowerCase()]; input.checked = !input.disabled;
      seen[area.name.toLowerCase()] = true;
      node("span",area.name + (input.disabled ? " — already listed" : ""),row);
      choices.push({input:input,name:area.name});
    });
    if(!choices.length) node("p","No named room markers were found in this scan.",contents);
    var add = node("button","Add selected rooms",contents); add.type = "button"; add.className = "btn pri";
    add.setAttribute("data-usd-add","");
    function update(){ add.disabled = !choices.some(function(choice){return choice.input.checked && !choice.input.disabled;}); }
    choices.forEach(function(choice){choice.input.onchange=update;}); update();
    add.onclick = function(){
      var names = choices.filter(function(choice){return choice.input.checked && !choice.input.disabled;}).map(function(choice){return choice.name;});
      if(!names.length) return;
      if(options.addRooms) options.addRooms(names);
      finish();
    };
  }
  if(file.size > root.PrePlotUSD.maxFileBytes){failure(new Error("Choose a USD file smaller than 32 MB."));return;}
  var reader = new FileReader();
  reader.onerror = function(){failure(new Error("Could not read the selected file."));};
  reader.onload = function(){
    if(active !== session) return;
    setTimeout(function(){
      if(active !== session) return;
      try {show(root.PrePlotUSDScene.summarize(root.PrePlotUSD.parse(reader.result)));}
      catch(error){failure(error);}
    },0);
  };
  try {reader.readAsArrayBuffer(file);}
  catch(error){failure(error);}
}
root.PrePlotUSDReview = {open:open};
})(window);
