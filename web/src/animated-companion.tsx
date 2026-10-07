import {useEffect,useRef,useState} from 'react';
import {companionAtlas,companionFrameRect,companionWalkAtlas,companionWalkFrameRect,nextCompanionMotion,nextRoamStop,type CompanionMotion} from '../../shared/companion-motion';

const labels:Record<CompanionMotion,string>={phone:'看平板',squat:'深蹲',pushup:'俯卧撑'};
type Pose={action:CompanionMotion;frame:number;phase:'rest'|'walk'|'action';position:number;direction:number};
export function AnimatedCompanion(){
  const [ready,setReady]=useState(false),[paused,setPaused]=useState(false),[reduced,setReduced]=useState(true),[visible,setVisible]=useState(true);
  const [pose,setPose]=useState<Pose>({action:'phone',frame:0,phase:'rest',position:.5,direction:1});
  const previous=useRef<CompanionMotion>('pushup'),position=useRef(.5),direction=useRef(-1),arena=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>setReduced(media.matches),visibility=()=>setVisible(document.visibilityState==='visible');
    update();visibility();media.addEventListener('change',update);document.addEventListener('visibilitychange',visibility);
    let mounted=true,loaded=0;
    const images=['/gym-companion-actions.png','/gym-companion-walk.png'].map(src=>{const image=new Image();image.onload=()=>{loaded++;if(mounted&&loaded===2)setReady(true);};image.src=src;return image;});
    return()=>{mounted=false;for(const image of images)image.onload=null;media.removeEventListener('change',update);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  useEffect(()=>{
    if(!ready||paused||reduced||!visible)return;
    let timer:ReturnType<typeof setTimeout>,stopped=false;
    function exercise(){
      if(stopped)return;
      const action=nextCompanionMotion(previous.current);previous.current=action;
      let tick=0;const repetitions=2+Math.floor(Math.random()*2);
      function advance(){
        if(stopped)return;
        setPose({action,frame:tick%6,phase:'action',position:position.current,direction:direction.current});tick++;
        if(tick<6*repetitions)timer=setTimeout(advance,230);
        else timer=setTimeout(()=>{if(stopped)return;setPose(p=>({...p,phase:'rest'}));timer=setTimeout(walk,1200+Math.random()*1200);},230);
      }
      advance();
    }
    function walk(){
      if(stopped)return;
      const start=position.current,plan=nextRoamStop(start,direction.current);direction.current=plan.direction;
      const arenaWidth=arena.current?.getBoundingClientRect().width??620,spriteWidth=arenaWidth<400?160:200;
      const duration=Math.max(2200,Math.min(6000,Math.abs(plan.target-start)*Math.max(0,arenaWidth-spriteWidth)/45*1000));
      const steps=Math.ceil(duration/160);let tick=0;
      function advance(){
        if(stopped)return;
        position.current=start+(plan.target-start)*Math.min(1,tick/steps);
        setPose({action:previous.current,frame:tick%6,phase:'walk',position:position.current,direction:direction.current});tick++;
        if(tick<=steps)timer=setTimeout(advance,160);
        else timer=setTimeout(()=>{if(stopped)return;setPose(p=>({...p,phase:'rest'}));timer=setTimeout(exercise,450+Math.random()*550);},180);
      }
      advance();
    }
    timer=setTimeout(walk,350);
    return()=>{stopped=true;clearTimeout(timer);};
  },[ready,paused,reduced,visible]);
  const enabled=ready&&!paused&&!reduced&&visible,walking=enabled&&pose.phase==='walk',playing=enabled&&pose.phase!=='rest';
  const rect=walking?companionWalkFrameRect(pose.frame):companionFrameRect(pose.action,pose.frame),atlas=walking?companionWalkAtlas:companionAtlas;
  const horizontal=!walking&&pose.action==='pushup';
  const width=horizontal?200:200*rect.width/rect.height,height=horizontal?200*rect.height/rect.width:200;
  const spriteStyle={width,height,backgroundImage:`url("/gym-companion-${walking?'walk':'actions'}.png")`,backgroundSize:`${atlas.width/rect.width*100}% ${atlas.height/rect.height*100}%`,backgroundPosition:`${rect.x/(atlas.width-rect.width)*100}% ${rect.y/(atlas.height-rect.height)*100}%`,transform:walking&&pose.direction===-1?'scaleX(-1)':undefined};
  const motion=playing?walking?'walk':pose.action:'rest';
  return <div ref={arena} className="companion-figure animated-companion roaming-companion" data-testid="animated-companion" data-motion={motion} data-frame={playing?pose.frame:0} data-position={pose.position.toFixed(4)} data-direction={pose.direction}>
    <div className="companion-track"><div className={'companion-walker '+(walking?'is-walking':'')} style={{left:`${reduced?50:pose.position*100}%`}}>
      <button type="button" className="companion-control" onClick={()=>setPaused(p=>!p)} aria-label={paused?'恢复人物随机动作':'暂停人物随机动作'} aria-pressed={paused} title={reduced?'系统减少动态效果已开启':paused?'点击恢复随机动作':`${walking?'来回走动':playing?labels[pose.action]:'休息'} · 点击暂停（装饰动画）`}>
        {playing?<span className="companion-sprite" style={spriteStyle} aria-hidden="true"/>:<img src="/gym-companion.png" alt="" width="200" height="200"/>}
      </button><span className="companion-shadow" aria-hidden="true"/>
    </div></div>
  </div>;
}
