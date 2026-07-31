(function(root){
  "use strict";

  var MAX_SUMMARY = 1500;

  function isPlainObject(value){
    if(!value || typeof value !== "object" || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function photoId(entry){
    return entry && typeof entry === "object" && !Array.isArray(entry) &&
      typeof entry.id === "string" ? entry.id : "";
  }

  function normaliseSummary(value){
    return String(value === undefined || value === null ? "" : value)
      .slice(0,MAX_SUMMARY);
  }

  function empty(){
    return {summary:"",excluded:{}};
  }

  function ensure(state){
    if(!state || typeof state !== "object") return empty();
    if(!isPlainObject(state.compose)) state.compose = empty();
    state.compose.summary = normaliseSummary(state.compose.summary);
    if(!isPlainObject(state.compose.excluded)) state.compose.excluded = {};
    return state.compose;
  }

  function descriptorIds(photos){
    var ids = {};
    Object.keys(photos || {}).forEach(function(key){
      var list = photos[key];
      if(!Array.isArray(list)) return;
      list.forEach(function(entry){
        var id = photoId(entry);
        if(id) ids[id] = true;
      });
    });
    return ids;
  }

  function repair(state){
    var compose = ensure(state);
    var ids = descriptorIds(state.photos);
    var cleaned = {};
    Object.keys(compose.excluded).forEach(function(id){
      if(ids[id] && compose.excluded[id] === true) cleaned[id] = true;
    });
    if(state.visit && state.visit.coverPhotoId) delete cleaned[state.visit.coverPhotoId];
    compose.excluded = cleaned;
    return compose;
  }

  function validate(compose){
    if(!isPlainObject(compose)) return "compose is malformed";
    if(typeof compose.summary !== "string") return "compose summary is not text";
    if(compose.summary.length > MAX_SUMMARY) return "compose summary is too long";
    if(!isPlainObject(compose.excluded)) return "compose exclusions are malformed";
    var keys = Object.keys(compose.excluded);
    for(var i=0;i<keys.length;i++){
      if(compose.excluded[keys[i]] !== true){
        return "compose exclusion " + keys[i] + " is malformed";
      }
    }
    return "";
  }

  function summary(state){
    return ensure(state).summary;
  }

  function setSummary(state,value){
    ensure(state).summary = normaliseSummary(value);
    return state.compose.summary;
  }

  function isExcluded(state,entry){
    var id = photoId(entry);
    return !!(id && ensure(state).excluded[id] === true);
  }

  function setExcluded(state,entry,value){
    var id = photoId(entry);
    if(!id) return {ok:false,reason:"Only stored photos can be excluded."};
    if(value && state.visit && state.visit.coverPhotoId === id){
      return {ok:false,reason:"The cover photo must stay in the report. Choose another cover first."};
    }
    var excluded = ensure(state).excluded;
    if(value) excluded[id] = true;
    else delete excluded[id];
    return {ok:true,excluded:!!value};
  }

  function remove(state,entry){
    var id = photoId(entry);
    if(!id || !state || !isPlainObject(state.compose) ||
       !isPlainObject(state.compose.excluded) ||
       !Object.prototype.hasOwnProperty.call(state.compose.excluded,id)) return false;
    delete state.compose.excluded[id];
    return true;
  }

  root.PrePlotCompose = {
    MAX_SUMMARY:MAX_SUMMARY,
    isPlainObject:isPlainObject,
    photoId:photoId,
    normaliseSummary:normaliseSummary,
    empty:empty,
    ensure:ensure,
    descriptorIds:descriptorIds,
    repair:repair,
    validate:validate,
    summary:summary,
    setSummary:setSummary,
    isExcluded:isExcluded,
    setExcluded:setExcluded,
    remove:remove
  };
})(window);
