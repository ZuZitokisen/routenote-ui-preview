// Explicit controls for mobile numeric keyboards. Never saves or changes a value.
export function installInputAssist({win=window,doc=document}={}) {
  const toolbar=doc.createElement('div');toolbar.className='input-assist';toolbar.hidden=true;
  toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','数値入力の操作');
  toolbar.innerHTML='<span class="input-assist-label">数値入力</span><button type="button" data-input-next>次の項目 <span aria-hidden="true">↓</span></button><button type="button" data-input-done>入力完了</button>';
  doc.body.append(toolbar);
  const next=toolbar.querySelector('[data-input-next]'),done=toolbar.querySelector('[data-input-done]');let active=null;
  const editable=el=>el?.matches?.('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]):not([type=color]):not([type=range]):not([type=reset]),select,textarea')&&!el.disabled&&!el.readOnly&&!el.matches(':disabled')&&!el.closest('[hidden],[inert],details:not([open])')&&win.getComputedStyle(el).display!=='none'&&win.getComputedStyle(el).visibility!=='hidden'&&![...ancestors(el)].some(x=>win.getComputedStyle(x).display==='none');
  function* ancestors(el){for(let p=el.parentElement;p;p=p.parentElement)yield p;}
  const following=()=>{if(!active?.isConnected)return null;const scope=active.form||active.closest('dialog')||doc;const fields=[...scope.querySelectorAll('input,select,textarea')].filter(editable);return fields[fields.indexOf(active)+1]||null;};
  function position(){if(toolbar.hidden)return;const v=win.visualViewport;const gap=v?Math.max(0,win.innerHeight-v.height-v.offsetTop):0;toolbar.style.bottom=`${gap+8}px`;if(v){toolbar.style.left=`${v.offsetLeft+8}px`;toolbar.style.width=`${Math.max(0,v.width-16)}px`;}else{toolbar.style.left='8px';toolbar.style.width='calc(100% - 16px)';}}
  function hide(){active=null;toolbar.hidden=true;doc.body.classList.remove('numeric-input-active');}
  function show(el){active=el;const host=el.closest('dialog[open]')||doc.body;if(toolbar.parentElement!==host)host.append(toolbar);if(next.disabled!==!following())next.disabled=!following();toolbar.hidden=false;doc.body.classList.add('numeric-input-active');position();}
  const onFocus=e=>{if(e.target.matches?.('input[type=number],input[inputmode=decimal],input[inputmode=numeric]')&&editable(e.target))show(e.target);else if(!toolbar.contains(e.target))hide();};
  const onBlur=e=>{if(e.target!==active)return;if(toolbar.contains(e.relatedTarget))return;hide();};
  function advance(){const target=following();if(target){target.focus();target.scrollIntoView?.({block:'center',behavior:'auto'});}else{active?.blur();hide();}}
  const finish=()=>{active?.blur();hide();};
  const preserve=e=>{if(e.target.closest('button'))e.preventDefault();};
  const key=e=>{if(e.key==='Enter'&&e.target===active&&!e.isComposing&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey){e.preventDefault();advance();}else if(e.key==='Escape'&&e.target===active){finish();}};
  doc.addEventListener('focusin',onFocus);doc.addEventListener('focusout',onBlur);doc.addEventListener('keydown',key);
  toolbar.addEventListener('pointerdown',preserve);next.addEventListener('click',advance);done.addEventListener('click',finish);
  win.addEventListener('resize',position);win.visualViewport?.addEventListener('resize',position);win.visualViewport?.addEventListener('scroll',position);
  const observer=new win.MutationObserver(()=>{if(active){if(!editable(active)||!active.isConnected)hide();else{const disabled=!following();if(next.disabled!==disabled)next.disabled=disabled;}}});observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','disabled','open','inert']});
  return ()=>{observer.disconnect();doc.removeEventListener('focusin',onFocus);doc.removeEventListener('focusout',onBlur);doc.removeEventListener('keydown',key);win.removeEventListener('resize',position);win.visualViewport?.removeEventListener('resize',position);win.visualViewport?.removeEventListener('scroll',position);hide();toolbar.remove();};
}
