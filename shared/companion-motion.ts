export type CompanionMotion='phone'|'squat'|'pushup';
export const companionMotions:CompanionMotion[]=['phone','squat','pushup'];
export const companionAtlas={width:1774,height:887};
// The generated atlas has uneven row heights; use inspected bounds, not a guessed 6×3 grid.
const columns=[0,296,592,888,1184,1480,1774];
const pushupColumns=[0,309,614,912,1208,1488,1774];
export function companionFrameRect(action:CompanionMotion,frame:number){
  const i=Math.max(0,Math.min(5,Math.floor(frame))),xs=action==='pushup'?pushupColumns:columns;
  const [y,height]=action==='phone'?[0,360]:action==='squat'?[360,335]:[695,192];
  return {x:xs[i],y,width:xs[i+1]-xs[i],height};
}
export function nextCompanionMotion(previous:CompanionMotion,random=Math.random()):CompanionMotion{
  const options=companionMotions.filter(a=>a!==previous);
  const index=Math.min(options.length-1,Math.floor(Math.max(0,Math.min(.999999,random))*options.length));
  return options[index];
}
export const companionWalkAtlas={width:1254,height:1254};
export function companionWalkFrameRect(frame:number){
  const i=Math.max(0,Math.min(5,Math.floor(frame))),xs=[0,447,833,1254],column=i%3;
  return {x:xs[column],y:i<3?0:612,width:xs[column+1]-xs[column],height:i<3?617:598};
}
export function nextRoamStop(position:number,previousDirection:number,random=Math.random()){
  const current=Math.max(0,Math.min(1,position));
  const direction=current<.15?1:current>.85?-1:previousDirection===1?-1:1;
  const distance=.32+Math.max(0,Math.min(1,random))*.5;
  return {target:Math.max(0,Math.min(1,current+direction*distance)),direction};
}
