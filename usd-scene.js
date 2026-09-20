(function(root){
"use strict";

/* Static room-scan geometry, in authored model units. Converting to feet is a
   separate, explicit operation: some scan exporters omit metersPerUnit. */
function identity(){
  return [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
}
function multiply(a,b){
  var out = identity();
  for(var r=0;r<4;r++) for(var c=0;c<4;c++){
    out[r][c] = 0;
    for(var k=0;k<4;k++) out[r][c] += a[r][k]*b[k][c];
  }
  return out;
}
function number(value){
  if(typeof value !== "number" || !isFinite(value)) throw new Error("The scan contains a non-finite coordinate.");
  return value;
}
function vector(value,length){
  if(!Array.isArray(value) || value.length !== length) throw new Error("The scan has an unsupported coordinate shape.");
  return value.map(number);
}
function matrix(value){
  if(!Array.isArray(value) || value.length !== 4) throw new Error("The scan has an unsupported transform.");
  var out = value.map(function(row){ return vector(row,4); });
  if(out[0][3] !== 0 || out[1][3] !== 0 || out[2][3] !== 0 || out[3][3] !== 1){
    throw new Error("Perspective transforms are not supported in room scans.");
  }
  return out;
}
function transform(point,m){
  var p = vector(point,3);
  return [0,1,2].map(function(c){
    return number(p[0]*m[0][c]+p[1]*m[1][c]+p[2]*m[2][c]+m[3][c]);
  });
}
function localTransform(prim){
  var attrs = prim.attributes || {};
  var order = attrs.xformOpOrder || [];
  var out = identity();
  var reset = false;
  if(!Array.isArray(order)) throw new Error("The scan has an invalid transform order.");
  order.forEach(function(op){
    if(op === "!resetXformStack!"){ out = identity(); reset = true; return; }
    var m = identity();
    if(typeof op !== "string") throw new Error("The scan has an invalid transform operation.");
    if(/^xformOp:transform(?::|$)/.test(op)) m = matrix(attrs[op]);
    else if(/^xformOp:translate(?::|$)/.test(op)){
      var translation = vector(attrs[op],3);
      m[3][0] = translation[0]; m[3][1] = translation[1]; m[3][2] = translation[2];
    } else if(/^xformOp:scale(?::|$)/.test(op)){
      var scale = vector(attrs[op],3);
      m[0][0] = scale[0]; m[1][1] = scale[1]; m[2][2] = scale[2];
    } else {
      throw new Error("Unsupported scan transform: " + op + ". Export the scan with baked matrix transforms.");
    }
    out = multiply(m,out);
  });
  return {matrix:out,reset:reset};
}
function displayName(value){
  return String(value).replace(/_grp$/i,"").replace(/([a-z])([A-Z])/g,"$1 $2")
    .replace(/[_-]+/g," ").replace(/\d+$/,"").trim().replace(/\b\w/g,function(c){ return c.toUpperCase(); });
}
function emptyBounds(){ return {min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]}; }
function addPoint(bounds,point){
  for(var i=0;i<3;i++){
    bounds.min[i] = Math.min(bounds.min[i],point[i]);
    bounds.max[i] = Math.max(bounds.max[i],point[i]);
  }
}
function summarize(scene){
  if(!scene || !Array.isArray(scene.prims)) throw new Error("The scan contains no scene.");
  if(scene.upAxis !== "Y" && scene.upAxis !== "Z") throw new Error("The scan has an unsupported up axis.");
  var byPath = Object.create(null), world = Object.create(null), visiting = Object.create(null);
  scene.prims.forEach(function(prim){
    if(typeof prim.path !== "string" || prim.path.charAt(0) !== "/" || byPath[prim.path]) throw new Error("The scan has an invalid or duplicate object path.");
    byPath[prim.path] = prim;
  });
  function worldMatrix(path,depth){
    if(depth > 128 || visiting[path]) throw new Error("The scan hierarchy is too deep.");
    if(world[path]) return world[path];
    var prim = byPath[path];
    if(!prim) return identity();
    visiting[path] = true;
    var local = localTransform(prim);
    var parent = path.slice(0,path.lastIndexOf("/"));
    world[path] = local.reset ? local.matrix : multiply(local.matrix,worldMatrix(parent,depth+1));
    delete visiting[path];
    return world[path];
  }
  function excluded(path){
    for(var depth=0;path;depth++){
      if(depth > 128) throw new Error("The scan hierarchy is too deep.");
      var prim=byPath[path];
      if(prim && ((prim.metadata || {}).active === false || (prim.attributes || {}).visibility === "invisible")) return true;
      path=path.slice(0,path.lastIndexOf("/"));
    }
    return false;
  }
  var meshes = [], areas = [], bounds = emptyBounds(), counts = Object.create(null), totalPoints = 0;
  scene.prims.forEach(function(prim){
    if(excluded(prim.path)) return;
    var m = worldMatrix(prim.path,0);
    var name = prim.path.slice(prim.path.lastIndexOf("/")+1);
    if(/\/Section_grp\/[^/]+$/.test(prim.path)){
      var label=String((prim.metadata || {}).displayName || displayName(name)).trim();
      if(label.length > 256) throw new Error("A room name in the scan is too long.");
      areas.push({path:prim.path,name:label,position:transform([0,0,0],m)});
    }
    if(prim.type !== "Mesh") return;
    var attrs = prim.attributes || {};
    if(!Array.isArray(attrs.points) || !attrs.points.length) throw new Error("A mesh in the scan has no readable points.");
    totalPoints += attrs.points.length;
    if(totalPoints > 500000) throw new Error("This scan is too detailed. Export a simplified room model.");
    var points = attrs.points.map(function(point){ return transform(point,m); });
    var faceCounts = attrs.faceVertexCounts, indices = attrs.faceVertexIndices;
    if(!Array.isArray(faceCounts) || !Array.isArray(indices)) throw new Error("A mesh in the scan has no readable faces.");
    var offset = 0, edges = [], seenEdges = Object.create(null);
    faceCounts.forEach(function(count){
      if(count !== Math.floor(count) || count < 3 || count > 10000 || offset + count > indices.length) throw new Error("The scan has invalid mesh faces.");
      for(var i=0;i<count;i++){
        var a = indices[offset+i], b = indices[offset+(i+1)%count];
        if(a !== Math.floor(a) || b !== Math.floor(b) || a < 0 || b < 0 || a >= points.length || b >= points.length) throw new Error("The scan has an invalid mesh point index.");
        var key = Math.min(a,b)+":"+Math.max(a,b);
        if(!seenEdges[key]){ edges.push([a,b]); seenEdges[key] = true; }
      }
      offset += count;
    });
    if(offset !== indices.length) throw new Error("The scan has extra mesh indices.");
    var meshBounds = emptyBounds();
    points.forEach(function(point){ addPoint(bounds,point); addPoint(meshBounds,point); });
    var category = name.replace(/\d+$/,"") || "Mesh";
    counts[category] = (counts[category] || 0) + 1;
    meshes.push({path:prim.path,name:name,category:category,points:points,edges:edges,bounds:meshBounds});
  });
  if(!meshes.length) throw new Error("The file contains no supported room meshes.");
  return {
    format:scene.format,version:scene.version,upAxis:scene.upAxis,
    metersPerUnit:scene.metersPerUnit == null ? null : number(scene.metersPerUnit),
    meshes:meshes,areas:areas,bounds:bounds,counts:counts,pointCount:totalPoints
  };
}
function dimensions(summary,metersPerUnit){
  if(typeof metersPerUnit !== "number" || !isFinite(metersPerUnit) || metersPerUnit <= 0){
    throw new Error("Choose the scan units before using measurements.");
  }
  var extents = summary.bounds.max.map(function(value,i){ return (value-summary.bounds.min[i])*metersPerUnit/0.3048; });
  return {x:extents[0],y:extents[1],z:extents[2],height:extents[summary.upAxis === "Z" ? 2 : 1]};
}
root.PrePlotUSDScene = {summarize:summarize,dimensions:dimensions};
})(typeof window !== "undefined" ? window : this);
