// Read-only polling policy. A check is only a hint: only a verified full read is adopted.
export function createBrowseRecordSync({adapter,checkChanges,isEditing=()=>false,isSaving=()=>false,onApplied=()=>{},onConfirmed=()=>{},onError=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,random=Math.random,now=Date.now}={}){
 let context={browse:false,visible:false,authorized:false},epoch=0,timer=null,running=false,disposed=false,queued=false,failures=0,lastFull=now();
 const active=()=>!disposed&&context.browse&&context.visible&&context.authorized;
 const safe=()=>active()&&!isEditing()&&!isSaving()&&adapter.canBackgroundRefresh();
 const cancel=()=>{if(timer!==null)clearTimer(timer);timer=null;};
 function schedule(){cancel();if(!active())return;const delay=failures?Math.min(180000,30000*2**failures):27000+Math.floor(Math.max(0,Math.min(1,random()))*3000);timer=setTimer(()=>{timer=null;void run();},delay);}
 async function run(){
  if(!active())return;if(running){queued=true;return;}if(!safe()){schedule();return;}
  running=true;const generation=epoch,valid=()=>generation===epoch&&safe();
  try{
   const cursor=adapter.watchCursor(),hint=await checkChanges({cursor});if(!valid())return;
   if(!hint||hint.ok!==true||hint.schemaVersion!==1||hint.authoritative!==false||typeof hint.changed!=='boolean'||!/^[a-f0-9]{64}$/.test(hint.cursor)||typeof hint.checkedAt!=='string'||!Number.isFinite(Date.parse(hint.checkedAt))||(!hint.changed&&hint.cursor!==cursor))throw Error('更新確認の形式を確認できません。');
   if(hint.changed||now()-lastFull>=300000){const staged=await adapter.prepareRefresh();if(!valid())return;if(!staged.commitIfCurrent(valid))return;lastFull=now();onApplied(adapter.read());}
   if(valid()){failures=0;onConfirmed();}
  }catch(error){if(generation===epoch&&active()){failures++;onError(error);}}
  finally{running=false;if(queued){queued=false;if(active()){void run();return;}}schedule();}
 }
 return{setContext(next,{alreadyFresh=false}={}){const previous=active();const changed=Object.keys(next).some(key=>context[key]!==next[key]);context={...context,...next};if(changed){epoch++;cancel();}if(!active())return;if(!previous||changed){if(alreadyFresh){lastFull=now();schedule();}else void run();}},retry(){cancel();void run();},notifyFresh(){lastFull=now();failures=0;schedule();},dispose(){disposed=true;epoch++;queued=false;cancel();}};
}
