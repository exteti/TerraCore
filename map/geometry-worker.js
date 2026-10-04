'use strict';

importScripts('https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js');

const fc = features => turf.featureCollection(features.filter(Boolean));
const areaKm2 = feature => feature ? turf.area(feature) / 1e6 : 0;
const union = (a, b) => !a ? b : !b ? a : turf.union(fc([a, b]));
const difference = (a, b) => !a ? null : !b ? a : turf.difference(fc([a, b]));
const intersect = (a, b) => !a || !b ? null : turf.intersect(fc([a, b]));

function buildLassoShape(coords){
  if(coords.length < 3) return null;
  const ring=[...coords,coords[0]];
  let polygon=turf.polygon([ring]);
  if(turf.kinks(polygon).features.length){
    polygon=turf.unkinkPolygon(polygon).features.reduce((combined,part)=>union(combined,part),null);
  }
  return polygon;
}

function buildBrushShape(coords,radiusKm){
  if(!coords.length) return null;
  const geometry=coords.length>1?turf.lineString(coords):turf.point(coords[0]);
  return turf.buffer(geometry,radiusKm,{units:'kilometers',steps:12});
}

function simplifySelection(shape){
  if(turf.coordAll(shape).length<80) return shape;
  try{return turf.simplify(shape,{tolerance:0.00005,highQuality:false});}
  catch(_){return shape;}
}

function captureWithShape(shape,side,ownGeom,enemyGeoms,minAreaKm2){
  const parts={};
  for(const [key,geometry] of Object.entries(enemyGeoms)){
    const part=intersect(shape,geometry);
    if(part&&areaKm2(part)>=minAreaKm2) parts[key]=part;
  }
  const keys=Object.keys(parts);
  if(!keys.length) return null;

  const selected=keys.map(key=>parts[key]).reduce(union);
  const nextGeoms={};
  const from={};
  for(const key of keys){
    nextGeoms[key]=difference(enemyGeoms[key],parts[key]);
    from[key]=areaKm2(parts[key]);
  }
  nextGeoms[side]=union(ownGeom,selected);
  return {selected,nextGeoms,km:areaKm2(selected),from};
}

function calculateCapture({shape,side,ownGeom,enemyGeoms,minAreaKm2=0.05}){
  const simplified=simplifySelection(shape);
  try{
    const result=captureWithShape(simplified,side,ownGeom,enemyGeoms,minAreaKm2);
    return result||simplified===shape?result:captureWithShape(shape,side,ownGeom,enemyGeoms,minAreaKm2);
  }
  catch(err){
    if(simplified===shape) throw err;
    return captureWithShape(shape,side,ownGeom,enemyGeoms,minAreaKm2);
  }
}

function areaInsideZone(geometry,zone,bounds){
  const [west,south,east,north]=bounds;
  let area=0;
  for(const part of turf.flatten(geometry).features){
    const box=turf.bbox(part);
    if(box[0]>east||box[2]<west||box[1]>north||box[3]<south) continue;
    try{
      const clipped=turf.bboxClip(part,bounds);
      if(!clipped) continue;
      const overlap=intersect(zone,clipped);
      if(overlap) area+=areaKm2(overlap);
    }catch(_){}
  }
  return area;
}

function calculateGrayZone({sharedFrontLine,geometries,widthKm}){
  if(!sharedFrontLine||widthKm<=0) return {geometry:null,areaKm2:0,areas:{}};
  const buffered=turf.buffer(sharedFrontLine,widthKm/2,{units:'kilometers',steps:8});
  const parts=buffered.type==='FeatureCollection'?buffered.features:[buffered];
  const geometry=parts.reduce((combined,part)=>union(combined,part),null);
  if(!geometry) return {geometry:null,areaKm2:0,areas:{}};

  const bounds=turf.bbox(geometry);
  const areas={};
  let totalArea=0;
  for(const [key,territory] of Object.entries(geometries)){
    areas[key]=Math.min(areaKm2(territory),areaInsideZone(territory,geometry,bounds));
    totalArea+=areas[key];
  }
  return {geometry,areaKm2:totalArea,areas};
}

self.onmessage=event=>{
  const {id,type,...payload}=event.data||{};
  try{
    let result;
    if(type==='lasso') result=buildLassoShape(payload.coords||[]);
    else if(type==='brush') result=buildBrushShape(payload.coords||[],payload.radiusKm||0);
    else if(type==='capture') result=calculateCapture(payload);
    else if(type==='gray-zone') result=calculateGrayZone(payload);
    else throw new Error('Неизвестная операция geometry worker: '+type);
    self.postMessage({id,result});
  }catch(err){
    self.postMessage({id,error:err&&err.message?err.message:String(err)});
  }
};