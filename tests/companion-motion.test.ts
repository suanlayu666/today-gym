import test from 'node:test';
import assert from 'node:assert/strict';
import {companionAtlas,companionFrameRect,companionMotions,nextCompanionMotion,companionWalkAtlas,companionWalkFrameRect,nextRoamStop} from '../shared/companion-motion';
test('随机动作可覆盖三种动作且不会连续重复',()=>{
  const visited=new Set<string>();
  for(const action of companionMotions)for(const n of [0,.49,.5,.99,1]){const next=nextCompanionMotion(action,n);assert.notEqual(next,action);assert.ok(companionMotions.includes(next));visited.add(next);}
  assert.equal(visited.size,3);
});
test('18 个帧裁切均位于素材边界内，俯卧撑不切掉头部',()=>{
  for(const action of companionMotions)for(let i=0;i<6;i++){const r=companionFrameRect(action,i);assert.ok(r.x>=0&&r.y>=0&&r.width>0&&r.height>0);assert.ok(r.x+r.width<=companionAtlas.width);assert.ok(r.y+r.height<=companionAtlas.height);}
  assert.equal(companionFrameRect('pushup',0).width,309);
});
test('走路的六帧不越界，左右随机停点有距离且不走出活动范围',()=>{
  for(let i=0;i<6;i++){const r=companionWalkFrameRect(i);assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=companionWalkAtlas.width&&r.y+r.height<=companionWalkAtlas.height);}
  for(const x of [0,.1,.5,.9,1])for(const d of [-1,1])for(const random of [0,.5,1]){const p=nextRoamStop(x,d,random);assert.ok(p.target>=0&&p.target<=1);assert.ok(Math.abs(p.target-x)>=.15);assert.equal(Math.sign(p.target-x),p.direction);}
  assert.equal(nextRoamStop(.5,1,0).direction,-1);assert.equal(nextRoamStop(.5,-1,0).direction,1);
});
