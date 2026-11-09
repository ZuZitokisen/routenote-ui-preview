// Explicit receipt lookup only. Never creates a new operation or discards input automatically.
export function appendWorkspaceRecovery({element,adapter,reload}={}){
 if(!element||element.querySelector('[data-workspace-recovery]'))return;
 const doc=element.ownerDocument,button=doc.createElement('button'),status=doc.createElement('p');button.type='button';button.className='button secondary';button.dataset.workspaceRecovery='true';button.textContent='保存結果を確認';
 button.addEventListener('click',async()=>{button.disabled=true;try{const result=await adapter.recover();if(!element.isConnected)return;if(result.status==='committed'){status.textContent='前の保存が完了したことを確認しました。入力を控えてから最新内容を読み直してください。';const refresh=doc.createElement('button');refresh.type='button';refresh.className='button secondary';refresh.textContent='最新内容を読み直す';refresh.addEventListener('click',reload);status.append(refresh);}else status.textContent=result.status==='none'?'未確認の保存はありません。入力内容と最新の記録を確認してください。':'保存の到着をまだ確認できません。重複を避けるため新しい保存は行いません。時間をおいて再確認してください。';}catch(error){if(element.isConnected)status.textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}});
 element.append(button,status);
}
