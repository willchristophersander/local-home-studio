import { roofRidgeX } from '../geometry';
import type { Asset, Beam, Project, Roof, Slab, Wall } from '../shared/model';

/** Eight risers cover the 1.45 m drop. Seven treads sit in the mudroom; the last is the landing at the studio floor. */
function mudroomStairs(): Slab[] {
  const drop = 1.45;
  const steps = 8;
  const rise = drop / steps;
  const run = 0.25;
  const x0 = 0.62;
  const x1 = 1.58;
  const nose = -0.34;
  const treads = Array.from({ length: steps - 1 }, (_, index) => {
    const step = index + 1;
    const z1 = nose - (steps - 1 - step) * run;
    return {
      id: `stair-${step}`, name: `Stair ${step}`, holes: [], color: '#b08968', storeyId: 'mudroom',
      polygon: [{ x: x0, z: z1 - run }, { x: x1, z: z1 - run }, { x: x1, z: z1 }, { x: x0, z: z1 }],
      elevation: -drop + step * rise, thickness: step * rise,
    };
  });
  treads.push({
    id: 'stair-landing', name: 'Stair landing', holes: [], color: '#b08968', storeyId: 'mudroom',
    polygon: [{ x: x0, z: nose }, { x: x1, z: nose }, { x: x1, z: -0.1 }, { x: x0, z: -0.1 }],
    elevation: 0, thickness: rise,
  });
  return treads;
}
/** Concrete starts below the mudroom floor and rises to the siding of each room. */
function foundationWalls(): Wall[] {
  const base = -1.45 - 0.2 - 0.45;
  const concrete = '#a39e96';
  const course = (id: string, name: string, start: string, end: string, top: number, storeyId: string): Wall => ({
    id, name, start, end, thickness: 0.2, base, height: top - base, color: concrete, storeyId, finish: 'concrete',
  });
  return [
    course('f-south', 'Studio foundation south', 'sw', 'se', 0, 'ground'),
    course('f-east', 'Studio foundation east', 'se', 'ne', 0, 'ground'),
    course('f-north', 'Studio foundation north', 'ne', 'nw', 0, 'ground'),
    course('f-west', 'Studio foundation west', 'nw', 'sw', 0, 'ground'),
    course('mf-south', 'Mudroom foundation south', 'm-sw', 'm-se', -1.45, 'mudroom'),
    course('mf-east', 'Mudroom foundation east', 'm-se', 'm-ne', -1.45, 'mudroom'),
    course('mf-north', 'Mudroom foundation north', 'm-nw', 'm-ne', -1.45, 'mudroom'),
    course('mf-west', 'Mudroom foundation west', 'm-nw', 'm-sw', -1.45, 'mudroom'),
    course('gf-south', 'Garden foundation south', 'g-sw', 'g-se', 0, 'garden'),
    course('gf-east', 'Garden foundation east', 'g-se', 'g-ne', 0, 'garden'),
    course('gf-north', 'Garden foundation north', 'g-ne', 'g-nw', 0, 'garden'),
    course('gf-west', 'Garden foundation west', 'g-nw', 'g-sw', 0, 'garden'),
    course('gaf-south', 'Garage foundation south', 'ga-sw', 'ga-se', 0, 'garage'),
    course('gaf-east', 'Garage foundation east', 'ga-se', 'ga-ne', 0, 'garage'),
    course('gaf-north', 'Garage foundation north', 'ga-ne', 'ga-nw', 0, 'garage'),
    course('gaf-west', 'Garage foundation west', 'ga-nw', 'ga-sw', 0, 'garage'),
  ];
}
const wood = '#8d5e3a';
const oak = '#7a4f2c';
/** Keeps a roof-hung beam on one slope so its top stays a single plane. */
function besideRidge(roof: Roof, width: number): number {
  return roofRidgeX(roof) - width / 2 - 0.02;
}
function ceilingBeams(): Beam[] {
  const main = { id: 'roof', name: 'Asymmetric roof', kind: 'gable' as const, x: -0.2, z: -0.2, width: 8.4, depth: 6.4, eaveHeight: 5.7, pitchLeft: 18, pitchRight: 30, thickness: 0.15, color: '#6b746b' };
  const garden = { id: 'g-roof', name: 'Garden gable', kind: 'gable' as const, x: 3.8, z: -4.8, width: 5.4, depth: 4.2, eaveHeight: 2.75, pitchLeft: 30, pitchRight: 30, thickness: 0.15, color: '#6e6356' };
  const garage = { id: 'ga-roof', name: 'Garage roof', kind: 'gable' as const, x: -4.25, z: -2.6, width: 4.21, depth: 6.25, eaveHeight: 2.6, pitchLeft: 20, pitchRight: 20, thickness: 0.14, color: '#6a7068' };
  const across = (id: string, name: string, x: number, z: number, length: number, width: number, depth: number, elevation: number, storeyId: string): Beam => ({ id, name, x, z, length, width, depth, elevation, axis: 'x', color: oak, storeyId });
  const along = (id: string, name: string, x: number, z: number, length: number, width: number, depth: number, roof: Roof, storeyId: string): Beam => ({ id, name, x, z, length, width, depth, elevation: roof.eaveHeight, axis: 'z', color: wood, storeyId, roofId: roof.id });
  return [
    across('beam-s1', 'Studio beam 1', 0.2, 1.5, 7.6, 0.24, 0.32, 2.7, 'ground'),
    across('beam-s2', 'Studio beam 2', 0.2, 3, 7.6, 0.24, 0.32, 2.7, 'ground'),
    across('beam-s3', 'Studio beam 3', 0.2, 4.5, 7.6, 0.24, 0.32, 2.7, 'ground'),
    across('beam-m1', 'Mudroom beam 1', 0.2, -1.15, 3, 0.18, 0.26, 1.25, 'mudroom'),
    across('beam-m2', 'Mudroom beam 2', 0.2, -1.9, 3, 0.18, 0.26, 1.25, 'mudroom'),
    along('beam-u1', 'Upper beam west', 2.4, 0.2, 5.6, 0.16, 0.24, main, 'upper'),
    along('beam-u2', 'Upper ridge beam', besideRidge(main, 0.18), 0.2, 5.6, 0.18, 0.28, main, 'upper'),
    along('beam-u3', 'Upper beam east', 6.8, 0.2, 5.6, 0.16, 0.24, main, 'upper'),
    along('beam-g1', 'Garden beam west', 5.2, -4.45, 3.4, 0.12, 0.16, garden, 'garden'),
    along('beam-g2', 'Garden ridge beam', besideRidge(garden, 0.14), -4.45, 3.4, 0.14, 0.2, garden, 'garden'),
    along('beam-g3', 'Garden beam east', 7.8, -4.45, 3.4, 0.12, 0.16, garden, 'garden'),
    along('beam-ga1', 'Garage beam west', -3.2, -2.15, 5.25, 0.12, 0.16, garage, 'garage'),
    along('beam-ga2', 'Garage ridge beam', besideRidge(garage, 0.14), -2.15, 5.25, 0.14, 0.2, garage, 'garage'),
    along('beam-ga3', 'Garage beam east', -1.2, -2.15, 5.25, 0.12, 0.16, garage, 'garage'),
  ];
}
export const essentials: Asset[] = [
  {id:'sofa',name:'Linen sofa',kind:'sofa',width:2.3,height:.82,depth:.95,color:'#b5b59e',aiAllowed:true,license:'Original procedural model'},
  {id:'table',name:'Oak coffee table',kind:'table',width:1.15,height:.42,depth:.65,color:'#9d7751',aiAllowed:true,license:'Original procedural model'},
  {id:'chair',name:'Lounge chair',kind:'chair',width:.78,height:.85,depth:.8,color:'#bd805e',aiAllowed:true,license:'Original procedural model'},
  {id:'plant',name:'Indoor olive',kind:'plant',width:.6,height:1.55,depth:.6,color:'#667656',aiAllowed:true,license:'Original procedural model'},
  {id:'bed',name:'Platform bed',kind:'bed',width:1.8,height:.7,depth:2.1,color:'#ded4bf',aiAllowed:true,license:'Original procedural model'},
  {id:'cabinet',name:'Low sideboard',kind:'cabinet',width:1.65,height:.8,depth:.42,color:'#987758',aiAllowed:true,license:'Original procedural model'},
];
export function createSample(): Project {
  return {
    schemaVersion:1,revision:0,name:'Split-level studio',storeys:[{id:'ground',name:'Ground floor',elevation:0},{id:'upper',name:'Upper floor',elevation:2.9},{id:'mudroom',name:'Mudroom',elevation:-1.45},{id:'mudroom-upper',name:'Mudroom upper',elevation:1.45},{id:'garden',name:'Garden room',elevation:0},{id:'garage',name:'Garage',elevation:0}],
    nodes:[{id:'sw',x:0,z:0},{id:'se',x:8,z:0},{id:'ne',x:8,z:6},{id:'nw',x:0,z:6},{id:'m-nw',x:0,z:-.24},{id:'m-ne',x:3.4,z:-.24},{id:'m-se',x:3.4,z:-2.6},{id:'m-sw',x:0,z:-2.6},{id:'g-sw',x:4,z:-4.6},{id:'g-se',x:9,z:-4.6},{id:'g-ne',x:9,z:-.8},{id:'g-nw',x:4,z:-.8},{id:'ga-sw',x:-4,z:-2.35},{id:'ga-se',x:-.22,z:-2.35},{id:'ga-ne',x:-.22,z:3.4},{id:'ga-nw',x:-4,z:3.4}],
    walls:[
      {id:'south',name:'Entry wall',start:'sw',end:'se',thickness:.2,base:0,height:2.9,color:'#c4b8a8',storeyId:'ground'},
      {id:'east',name:'Garden wall',start:'se',end:'ne',thickness:.2,base:0,height:2.9,color:'#c4b8a8',storeyId:'ground'},
      {id:'north',name:'North wall',start:'ne',end:'nw',thickness:.2,base:0,height:2.9,color:'#c4b8a8',storeyId:'ground'},
      {id:'west',name:'West wall',start:'nw',end:'sw',thickness:.2,base:0,height:2.9,color:'#c4b8a8',storeyId:'ground'},
      {id:'u-south',name:'Upper entry wall',start:'sw',end:'se',thickness:.2,base:2.9,height:2.6,color:'#c4b8a8',storeyId:'upper'},
      {id:'u-east',name:'Upper garden wall',start:'se',end:'ne',thickness:.2,base:2.9,height:2.6,color:'#c4b8a8',storeyId:'upper'},
      {id:'u-north',name:'Upper north wall',start:'ne',end:'nw',thickness:.2,base:2.9,height:2.6,color:'#c4b8a8',storeyId:'upper'},
      {id:'u-west',name:'Upper west wall',start:'nw',end:'sw',thickness:.2,base:2.9,height:2.6,color:'#c4b8a8',storeyId:'upper'},
      {id:'m-south',name:'Mudroom entry',start:'m-sw',end:'m-se',thickness:.2,base:-1.45,height:2.9,color:'#c4b8a8',storeyId:'mudroom'},
      {id:'m-east',name:'Mudroom east',start:'m-se',end:'m-ne',thickness:.2,base:-1.45,height:2.9,color:'#c4b8a8',storeyId:'mudroom'},
      {id:'m-north',name:'Mudroom step',start:'m-nw',end:'m-ne',thickness:.2,base:-1.45,height:2.9,color:'#c4b8a8',storeyId:'mudroom'},
      {id:'m-west',name:'Mudroom west',start:'m-nw',end:'m-sw',thickness:.2,base:-1.45,height:2.9,color:'#c4b8a8',storeyId:'mudroom'},
      {id:'mu-south',name:'Mudroom upper entry',start:'m-sw',end:'m-se',thickness:.2,base:1.45,height:2.6,color:'#c4b8a8',storeyId:'mudroom-upper'},
      {id:'mu-east',name:'Mudroom upper east',start:'m-se',end:'m-ne',thickness:.2,base:1.45,height:2.6,color:'#c4b8a8',storeyId:'mudroom-upper'},
      {id:'mu-north',name:'Mudroom upper step',start:'m-nw',end:'m-ne',thickness:.2,base:1.45,height:2.6,color:'#c4b8a8',storeyId:'mudroom-upper'},
      {id:'mu-west',name:'Mudroom upper west',start:'m-nw',end:'m-sw',thickness:.2,base:1.45,height:2.6,color:'#c4b8a8',storeyId:'mudroom-upper'},
      {id:'g-south',name:'Garden entry',start:'g-sw',end:'g-se',thickness:.2,base:0,height:2.6,color:'#c4b8a8',storeyId:'garden',roofId:'g-roof'},
      {id:'g-east',name:'Garden east',start:'g-se',end:'g-ne',thickness:.2,base:0,height:2.6,color:'#c4b8a8',storeyId:'garden',roofId:'g-roof'},
      {id:'g-north',name:'Garden north',start:'g-ne',end:'g-nw',thickness:.2,base:0,height:2.6,color:'#c4b8a8',storeyId:'garden',roofId:'g-roof'},
      {id:'g-west',name:'Garden west',start:'g-nw',end:'g-sw',thickness:.2,base:0,height:2.6,color:'#c4b8a8',storeyId:'garden',roofId:'g-roof'},
      {id:'ga-south',name:'Garage door wall',start:'ga-sw',end:'ga-se',thickness:.2,base:0,height:2.4,color:'#c4b8a8',storeyId:'garage',roofId:'ga-roof'},
      {id:'ga-east',name:'Garage on house wall',start:'ga-se',end:'ga-ne',thickness:.2,base:0,height:2.4,color:'#c4b8a8',storeyId:'garage',roofId:'ga-roof'},
      {id:'ga-north',name:'Garage north',start:'ga-ne',end:'ga-nw',thickness:.2,base:0,height:2.4,color:'#c4b8a8',storeyId:'garage',roofId:'ga-roof'},
      {id:'ga-west',name:'Garage west',start:'ga-nw',end:'ga-sw',thickness:.2,base:0,height:2.4,color:'#c4b8a8',storeyId:'garage',roofId:'ga-roof'},
      ...foundationWalls(),
    ],
    openings:[{id:'entry',wallId:'south',kind:'door',offset:.6,width:1,sill:0,height:2.2},{id:'window-n',wallId:'north',kind:'window',offset:3,width:2.7,sill:1,height:1.45},{id:'window-e',wallId:'east',kind:'window',offset:2.1,width:2.8,sill:1.1,height:1.35},{id:'mud-door',wallId:'m-south',kind:'door',offset:.6,width:1,sill:0,height:2.1},{id:'mud-step',wallId:'m-north',kind:'door',offset:.6,width:1,sill:0,height:2.65},{id:'u-window-s',wallId:'u-south',kind:'window',offset:4.2,width:2.2,sill:.85,height:1.2},{id:'u-window-n',wallId:'u-north',kind:'window',offset:2.8,width:2.6,sill:.85,height:1.2},{id:'u-window-e',wallId:'u-east',kind:'window',offset:1.6,width:2.4,sill:.9,height:1.15},{id:'mu-window',wallId:'mu-south',kind:'window',offset:1.9,width:1.1,sill:.45,height:1.2},{id:'g-door',wallId:'g-south',kind:'door',offset:2.05,width:.9,sill:0,height:2.1},{id:'g-window',wallId:'g-east',kind:'window',offset:1.1,width:1.6,sill:.95,height:1.1},{id:'ga-door',wallId:'ga-south',kind:'door',offset:.69,width:2.4,sill:0,height:2.13},{id:'ga-window',wallId:'ga-west',kind:'window',offset:2.3,width:1.2,sill:1.15,height:.8}],
    slabs:[
      {id:'floor',name:'Main floor',polygon:[{x:0,z:0},{x:8,z:0},{x:8,z:6},{x:0,z:6}],holes:[[{x:5.15,z:3.15},{x:7.9,z:3.15},{x:7.9,z:5.9},{x:5.15,z:5.9}]],elevation:0,thickness:.2,color:'#bda580',storeyId:'ground'},
      {id:'platform',name:'Reading platform',polygon:[{x:5.15,z:3.15},{x:7.9,z:3.15},{x:7.9,z:5.9},{x:5.15,z:5.9}],holes:[],elevation:.6,thickness:.6,color:'#c8b496',storeyId:'ground'},
      {id:'mud-floor',name:'Mudroom floor',polygon:[{x:0,z:-2.6},{x:3.4,z:-2.6},{x:3.4,z:-.24},{x:0,z:-.24}],holes:[],elevation:-1.45,thickness:.2,color:'#b7a48c',storeyId:'mudroom'},
      {id:'upper-floor',name:'Upper floor',polygon:[{x:0,z:0},{x:8,z:0},{x:8,z:6},{x:0,z:6}],holes:[],elevation:2.9,thickness:.2,color:'#d4c4a8',storeyId:'upper',ceiling:'planks'},
      {id:'mud-upper',name:'Mudroom upper floor',polygon:[{x:0,z:-2.6},{x:3.4,z:-2.6},{x:3.4,z:-.24},{x:0,z:-.24}],holes:[],elevation:1.45,thickness:.2,color:'#cbb892',storeyId:'mudroom-upper',ceiling:'planks'},
      {id:'g-floor',name:'Garden floor',polygon:[{x:4,z:-4.6},{x:9,z:-4.6},{x:9,z:-.8},{x:4,z:-.8}],holes:[],elevation:0,thickness:.2,color:'#c9b48a',storeyId:'garden'},
      {id:'ga-floor',name:'Garage floor',polygon:[{x:-4,z:-2.35},{x:-.22,z:-2.35},{x:-.22,z:3.4},{x:-4,z:3.4}],holes:[],elevation:0,thickness:.2,color:'#b7b3ab',storeyId:'garage'},
      ...mudroomStairs(),
    ],
    roofs:[{id:'roof',name:'Asymmetric roof',kind:'gable',x:-.2,z:-.2,width:8.4,depth:6.4,eaveHeight:5.7,pitchLeft:18,pitchRight:30,thickness:.15,color:'#6b746b'},{id:'mud-roof',name:'Mudroom roof',kind:'shed',x:-.15,z:-2.75,width:3.7,depth:2.6,eaveHeight:4.25,pitchLeft:4,pitchRight:0,thickness:.1,color:'#6b746b'},{id:'g-roof',name:'Garden gable',kind:'gable',x:3.8,z:-4.8,width:5.4,depth:4.2,eaveHeight:2.75,pitchLeft:30,pitchRight:30,thickness:.15,color:'#6e6356'},{id:'ga-roof',name:'Garage roof',kind:'gable',x:-4.25,z:-2.6,width:4.21,depth:6.25,eaveHeight:2.6,pitchLeft:20,pitchRight:20,thickness:.14,color:'#6a7068'}],
    beams:ceilingBeams(),
    assets:structuredClone(essentials),
    instances:[
      {id:'sofa-1',name:'Linen sofa',assetId:'sofa',x:2.6,y:0,z:4.65,rotation:0,scale:1,slabId:'floor'},
      {id:'table-1',name:'Oak coffee table',assetId:'table',x:2.6,y:0,z:3.1,rotation:0,scale:1,slabId:'floor'},
      {id:'chair-1',name:'Lounge chair',assetId:'chair',x:6.4,y:0,z:4.6,rotation:20,scale:1,slabId:'platform'},
      {id:'plant-1',name:'Indoor olive',assetId:'plant',x:7.25,y:0,z:5.25,rotation:0,scale:1,slabId:'platform'},
      {id:'cabinet-1',name:'Low sideboard',assetId:'cabinet',x:.55,y:0,z:2.7,rotation:90,scale:1,slabId:'floor'},
      {id:'mud-cabinet',name:'Mudroom cabinet',assetId:'cabinet',x:2.45,y:0,z:-1.4,rotation:180,scale:1,slabId:'mud-floor'},
      {id:'bed-1',name:'Upper bed',assetId:'bed',x:5.2,y:0,z:3.4,rotation:0,scale:1,slabId:'upper-floor'},
      {id:'g-chair',name:'Garden chair',assetId:'chair',x:6.5,y:0,z:-2.7,rotation:180,scale:1,slabId:'g-floor'},
    ],measurements:[],
  };
}
