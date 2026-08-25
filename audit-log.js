// Bitácora de trazabilidad de Iaptidud supervision.
// Registra actividad con Supabase Auth y muestra el historial solo al Superusuario.
(function(){
  'use strict';

  const QUEUE_KEY='iaptidud-audit-queue-v1';
  let auditRows=[];
  let wrappersInstalled=false;

  function escapeHtml(value){
    if(typeof window.esc==='function') return window.esc(value);
    return String(value??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  }

  function getQueue(){
    try{
      const q=JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');
      return Array.isArray(q)?q:[];
    }catch(e){return []}
  }

  function saveQueue(q){
    localStorage.setItem(QUEUE_KEY,JSON.stringify(Array.isArray(q)?q:[]));
  }

  async function authHeaders(extra={}){
    const token=await window.IAPTIDUD_AUTH?.getAccessToken?.();
    if(!token) throw new Error('Sesión no autenticada');
    return {
      'apikey':SUPABASE_ANON_KEY,
      'Authorization':'Bearer '+token,
      'Accept':'application/json',
      ...extra
    };
  }

  function makeEvent(action,entityType='app',entityId=null,description=null,metadata={}){
    return {
      p_action:String(action||'unknown'),
      p_entity_type:String(entityType||'app'),
      p_entity_id:entityId==null?null:String(entityId),
      p_description:description==null?null:String(description),
      p_metadata:metadata&&typeof metadata==='object'?metadata:{},
      p_occurred_at:new Date().toISOString()
    };
  }

  async function sendEvent(event){
    if(!navigator.onLine) throw new Error('Sin conexión');
    const response=await fetch(SUPABASE_REST_URL+'/rpc/log_iaptidud_activity',{
      method:'POST',
      headers:await authHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify(event),
      cache:'no-store'
    });
    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('Supabase HTTP '+response.status+(detail?': '+detail:''));
    }
    return true;
  }

  async function logActivity(action,entityType='app',entityId=null,description=null,metadata={}){
    if(!window.IAPTIDUD_AUTH?.isAuthenticated?.()) return false;
    const event=makeEvent(action,entityType,entityId,description,metadata);
    try{
      await sendEvent(event);
      return true;
    }catch(error){
      const queue=getQueue();
      queue.push(event);
      saveQueue(queue.slice(-250));
      console.warn('Actividad pendiente de sincronización:',action,error);
      return false;
    }
  }

  async function flushQueue(){
    if(!navigator.onLine||!window.IAPTIDUD_AUTH?.isAuthenticated?.()) return;
    const queue=getQueue();
    if(!queue.length) return;
    const pending=[];
    for(const event of queue){
      try{await sendEvent(event)}catch(e){pending.push(event)}
    }
    saveQueue(pending);
  }

  function currentInspectionSafe(){
    try{
      if(typeof data==='undefined'||!Array.isArray(data)||typeof currentId==='undefined') return null;
      return data.find(x=>String(x.id)===String(currentId))||null;
    }catch(e){return null}
  }

  function inspectionMeta(x){
    if(!x) return {};
    return {company:x.company||'',site:x.site||'',type:x.type||'',status:x.status||''};
  }

  function wrapFunction(name,after){
    const original=window[name];
    if(typeof original!=='function'||original.__auditWrapped) return;
    const wrapped=async function(){
      const args=[...arguments];
      const before=currentInspectionSafe();
      const result=await original.apply(this,args);
      try{await after({args,before,result,current:currentInspectionSafe()})}catch(e){console.warn('No se pudo registrar',name,e)}
      return result;
    };
    wrapped.__auditWrapped=true;
    window[name]=wrapped;
  }

  function installWrappers(){
    if(wrappersInstalled) return;
    wrappersInstalled=true;

    wrapFunction('login',async({result})=>{
      if(result===true&&window.currentUser?.id){
        await logActivity('login','session',null,'Inició sesión en la aplicación',{role:currentUser.role||''});
      }
    });

    const originalLogout=window.logout;
    if(typeof originalLogout==='function'&&!originalLogout.__auditWrapped){
      const wrappedLogout=async function(){
        if(window.currentUser?.id){
          await logActivity('logout','session',null,'Cerró sesión en la aplicación',{role:currentUser.role||''});
          await flushQueue();
        }
        return await originalLogout.apply(this,arguments);
      };
      wrappedLogout.__auditWrapped=true;
      window.logout=wrappedLogout;
    }

    wrapFunction('saveFinding',async({current})=>{
      if(current) await logActivity('finding_added','supervision',current.id,'Agregó un hallazgo',inspectionMeta(current));
    });
    wrapFunction('saveEvidence',async({current})=>{
      if(current) await logActivity('evidence_added','supervision',current.id,'Agregó evidencia fotográfica',inspectionMeta(current));
    });
    wrapFunction('saveSign',async({current})=>{
      if(current) await logActivity('signature_added','supervision',current.id,'Registró la firma del supervisor',inspectionMeta(current));
    });
    wrapFunction('clearSign',async({current,before})=>{
      const x=current||before;
      if(x) await logActivity('signature_removed','supervision',x.id,'Eliminó la firma del supervisor',inspectionMeta(x));
    });
    wrapFunction('toggleItem',async({current})=>{
      if(current) await logActivity('checklist_updated','supervision',current.id,'Actualizó un ítem del checklist',inspectionMeta(current));
    });

    const originalPdf=window.exportCompletedPDF;
    if(typeof originalPdf==='function'&&!originalPdf.__auditWrapped){
      const wrappedPdf=async function(){
        const completed=(typeof data!=='undefined'&&Array.isArray(data))?data.filter(x=>x.status==='completada'):[];
        const result=await originalPdf.apply(this,arguments);
        if(completed.length){
          await logActivity('pdf_generated','document',null,'Generó PDF de supervisiones completadas',{
            count:completed.length,
            supervision_ids:completed.slice(0,100).map(x=>String(x.id))
          });
        }
        return result;
      };
      wrappedPdf.__auditWrapped=true;
      window.exportCompletedPDF=wrappedPdf;
    }

    const originalCsv=window.exportCSV;
    if(typeof originalCsv==='function'&&!originalCsv.__auditWrapped){
      const wrappedCsv=async function(){
        const count=(typeof data!=='undefined'&&Array.isArray(data))?data.length:0;
        const result=await originalCsv.apply(this,arguments);
        await logActivity('csv_generated','document',null,'Generó archivo CSV de supervisiones',{count});
        return result;
      };
      wrappedCsv.__auditWrapped=true;
      window.exportCSV=wrappedCsv;
    }
  }

  const ACTION_LABELS={
    app_opened:'Abrió la aplicación',
    login:'Inicio de sesión',
    logout:'Cierre de sesión',
    supervision_created:'Creó supervisión',
    supervision_deleted:'Eliminó supervisión',
    finding_added:'Agregó hallazgo',
    evidence_added:'Agregó evidencia',
    signature_added:'Agregó firma',
    signature_removed:'Eliminó firma',
    checklist_updated:'Actualizó checklist',
    pdf_generated:'Generó PDF',
    csv_generated:'Generó CSV'
  };

  function formatDate(value){
    try{return new Date(value).toLocaleString('es-CL',{dateStyle:'short',timeStyle:'medium'})}catch(e){return String(value||'')}
  }

  async function fetchAuditRows(){
    const response=await fetch(
      SUPABASE_REST_URL+'/audit_logs?select=id,user_id,user_email,user_name,user_role,action,entity_type,entity_id,description,metadata,occurred_at,created_at&order=occurred_at.desc&limit=500',
      {method:'GET',headers:await authHeaders(),cache:'no-store'}
    );
    if(!response.ok) throw new Error('No se pudo cargar la trazabilidad');
    const rows=await response.json();
    auditRows=Array.isArray(rows)?rows:[];
    return auditRows;
  }

  function renderAuditRows(){
    const host=document.getElementById('auditRows');
    if(!host) return;
    const user=document.getElementById('auditUserFilter')?.value||'';
    const action=document.getElementById('auditActionFilter')?.value||'';
    const date=document.getElementById('auditDateFilter')?.value||'';

    const rows=auditRows.filter(r=>{
      if(user&&r.user_id!==user) return false;
      if(action&&r.action!==action) return false;
      if(date&&String(r.occurred_at||'').slice(0,10)!==date) return false;
      return true;
    });

    const count=document.getElementById('auditCount');
    if(count) count.textContent=rows.length+' registro'+(rows.length===1?'':'s');

    if(!rows.length){
      host.innerHTML='<div class="empty"><div class="big">🕘</div><div class="title">Sin registros</div><div class="small">No hay actividad para los filtros seleccionados.</div></div>';
      return;
    }

    host.innerHTML=rows.map(r=>{
      const label=ACTION_LABELS[r.action]||r.action;
      const entity=r.entity_id?' · #'+escapeHtml(r.entity_id):'';
      return `<div class="item-card">
        <div class="row between"><div class="title">${escapeHtml(label)}</div><span class="small">${escapeHtml(formatDate(r.occurred_at))}</span></div>
        <div class="small" style="margin-top:6px"><b>${escapeHtml(r.user_name||r.user_email)}</b> · ${escapeHtml(r.user_role||'Usuario')}</div>
        <div class="small">${escapeHtml(r.user_email||'')}${entity}</div>
        ${r.description?`<div style="margin-top:8px">${escapeHtml(r.description)}</div>`:''}
      </div>`;
    }).join('');
  }

  function populateAuditFilters(){
    const userSelect=document.getElementById('auditUserFilter');
    const actionSelect=document.getElementById('auditActionFilter');
    if(userSelect){
      const users=new Map();
      auditRows.forEach(r=>users.set(r.user_id,{id:r.user_id,label:(r.user_name||r.user_email)+' — '+r.user_email}));
      userSelect.innerHTML='<option value="">Todos los usuarios</option>'+[...users.values()].map(u=>`<option value="${escapeHtml(u.id)}">${escapeHtml(u.label)}</option>`).join('');
    }
    if(actionSelect){
      const actions=[...new Set(auditRows.map(r=>r.action))].sort();
      actionSelect.innerHTML='<option value="">Todas las acciones</option>'+actions.map(a=>`<option value="${escapeHtml(a)}">${escapeHtml(ACTION_LABELS[a]||a)}</option>`).join('');
    }
  }

  async function openTraceability(){
    if(window.currentUser?.role!=='Superusuario'){
      if(typeof toast==='function') toast('Solo el Superusuario puede ver la trazabilidad');
      return;
    }
    const overlay=document.getElementById('entrySheet');
    const title=document.getElementById('sheetTitle');
    const body=document.getElementById('sheetBody');
    if(!overlay||!title||!body) return;

    title.textContent='Trazabilidad';
    body.innerHTML=`
      <div class="small" style="margin-bottom:10px">Historial de uso, supervisiones y generación de documentos.</div>
      <div class="field"><label>Usuario</label><select id="auditUserFilter" onchange="IAPTIDUD_AUDIT.render()"><option value="">Todos los usuarios</option></select></div>
      <div class="field"><label>Acción</label><select id="auditActionFilter" onchange="IAPTIDUD_AUDIT.render()"><option value="">Todas las acciones</option></select></div>
      <div class="field"><label>Fecha</label><input id="auditDateFilter" type="date" onchange="IAPTIDUD_AUDIT.render()"></div>
      <div class="row between" style="margin:12px 0"><b id="auditCount">Cargando…</b><button class="linkbtn" onclick="IAPTIDUD_AUDIT.refresh()">Actualizar</button></div>
      <div id="auditRows" class="item-list"></div>`;
    overlay.classList.remove('hidden');

    try{
      await fetchAuditRows();
      populateAuditFilters();
      renderAuditRows();
    }catch(error){
      body.innerHTML='<div class="notice offline">No se pudo cargar la trazabilidad. Revisa la conexión e inténtalo nuevamente.</div>';
      console.warn(error);
    }
  }

  function installTraceButton(){
    const profile=document.getElementById('profile');
    if(!profile) return;
    let button=document.getElementById('auditTraceButton');
    if(window.currentUser?.role!=='Superusuario'){
      button?.remove();
      return;
    }
    if(button) return;
    button=document.createElement('button');
    button.id='auditTraceButton';
    button.className='btn secondary';
    button.style.cssText='width:100%;margin-top:10px';
    button.textContent='🕘 Trazabilidad';
    button.onclick=openTraceability;
    profile.appendChild(button);
  }

  const originalGo=window.go;
  if(typeof originalGo==='function'&&!originalGo.__auditNavWrapped){
    const wrappedGo=function(id){
      const result=originalGo.apply(this,arguments);
      if(id==='profile') setTimeout(installTraceButton,0);
      return result;
    };
    wrappedGo.__auditNavWrapped=true;
    window.go=wrappedGo;
  }

  window.IAPTIDUD_AUDIT={
    log:logActivity,
    flush:flushQueue,
    open:openTraceability,
    refresh:async()=>{await fetchAuditRows();populateAuditFilters();renderAuditRows()},
    render:renderAuditRows
  };

  installWrappers();
  installTraceButton();

  window.addEventListener('online',flushQueue);
  window.addEventListener('iaptidud-auth-changed',event=>{
    if(event.detail?.authenticated){
      setTimeout(()=>{installWrappers();installTraceButton();flushQueue()},0);
    }else{
      document.getElementById('auditTraceButton')?.remove();
    }
  });

  window.addEventListener('iaptidud-auth-ready',event=>{
    if(event.detail?.authenticated){
      setTimeout(async()=>{
        installWrappers();
        installTraceButton();
        await flushQueue();
        await logActivity('app_opened','session',null,'Abrió la aplicación',{role:window.currentUser?.role||''});
      },0);
    }
  });
})();