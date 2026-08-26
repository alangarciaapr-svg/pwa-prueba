// Bitácora avanzada de trazabilidad de Iaptidud supervision.
// Registra actividad con Supabase Auth y muestra el historial solo al Superusuario.
(function(){
  'use strict';

  const QUEUE_KEY='iaptidud-audit-queue-v2';
  const SESSION_ID_KEY='iaptidud-audit-session-id';
  const SESSION_START_KEY='iaptidud-audit-session-start';
  const AUDIT_VERSION='2.0';
  let auditRows=[];
  let wrappersInstalled=false;
  let appOpenLogged=false;

  function getCurrentUser(){
    try{return typeof currentUser!=='undefined'?currentUser:null}catch(e){return null}
  }

  function escapeHtml(value){
    if(typeof window.esc==='function') return window.esc(value);
    return String(value??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  }

  function uuid(){
    try{return crypto.randomUUID()}catch(e){return 's-'+Date.now()+'-'+Math.random().toString(36).slice(2)}
  }

  function startNewSession(){
    const id=uuid();
    const startedAt=new Date().toISOString();
    sessionStorage.setItem(SESSION_ID_KEY,id);
    sessionStorage.setItem(SESSION_START_KEY,startedAt);
    return {id,startedAt};
  }

  function getSession(){
    let id=sessionStorage.getItem(SESSION_ID_KEY);
    let startedAt=sessionStorage.getItem(SESSION_START_KEY);
    if(!id||!startedAt){
      const created=startNewSession();
      id=created.id;startedAt=created.startedAt;
    }
    return {id,startedAt};
  }

  function clearSession(){
    sessionStorage.removeItem(SESSION_ID_KEY);
    sessionStorage.removeItem(SESSION_START_KEY);
  }

  function browserInfo(){
    const ua=navigator.userAgent||'';
    let browser='Otro';
    if(/Edg\//.test(ua)) browser='Microsoft Edge';
    else if(/OPR\//.test(ua)) browser='Opera';
    else if(/Chrome\//.test(ua)&&!/Edg\//.test(ua)) browser='Chrome';
    else if(/Firefox\//.test(ua)) browser='Firefox';
    else if(/Safari\//.test(ua)&&!/Chrome\//.test(ua)) browser='Safari';

    let os='Otro';
    if(/Android/i.test(ua)) os='Android';
    else if(/iPhone|iPad|iPod/i.test(ua)) os='iOS/iPadOS';
    else if(/Windows/i.test(ua)) os='Windows';
    else if(/Mac OS X|Macintosh/i.test(ua)) os='macOS';
    else if(/Linux/i.test(ua)) os='Linux';

    const mobile=Boolean(navigator.userAgentData?.mobile)||/Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const standalone=window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true;
    const connection=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
    return {
      browser,
      os,
      device_type:mobile?'Móvil/Tablet':'Escritorio',
      platform:navigator.userAgentData?.platform||navigator.platform||'',
      language:navigator.language||'',
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'',
      screen:`${screen.width}x${screen.height}`,
      viewport:`${window.innerWidth}x${window.innerHeight}`,
      display_mode:standalone?'PWA instalada':'Navegador',
      connection_type:connection?.effectiveType||'',
      online:navigator.onLine,
      page_host:location.host,
      audit_version:AUDIT_VERSION
    };
  }

  function baseContext(){
    const session=getSession();
    return {
      session_id:session.id,
      session_started_at:session.startedAt,
      ...browserInfo()
    };
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
      p_metadata:{...baseContext(),...(metadata&&typeof metadata==='object'?metadata:{})},
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
      saveQueue(queue.slice(-500));
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

  function inspectionSnapshot(x){
    if(!x) return null;
    const checklist=Array.isArray(x.checklist)?x.checklist.map(i=>({text:i.text||'',done:Boolean(i.done)})):[];
    return {
      id:x.id,
      company:x.company||'',
      site:x.site||'',
      location:x.location||'',
      type:x.type||'',
      date:x.date||'',
      status:x.status||'',
      findings:Number(x.findings)||0,
      evidence:Number(x.evidence)||0,
      checklist,
      signature_present:Boolean(x.signature)
    };
  }

  function inspectionMeta(x){
    if(!x) return {};
    const checklist=Array.isArray(x.checklist)?x.checklist:[];
    const done=checklist.filter(i=>i.done).length;
    const total=checklist.length;
    return {
      company:x.company||'',
      site:x.site||'',
      location:x.location||'',
      type:x.type||'',
      inspection_date:x.date||'',
      status:x.status||'',
      findings:Number(x.findings)||0,
      evidence:Number(x.evidence)||0,
      checklist_total:total,
      checklist_done:done,
      checklist_progress:total?Math.round(done*100/total):0,
      signature_present:Boolean(x.signature)
    };
  }

  function wrapFunction(name,after){
    const original=window[name];
    if(typeof original!=='function'||original.__auditWrapped) return;
    const wrapped=async function(){
      const args=[...arguments];
      const before=inspectionSnapshot(currentInspectionSafe());
      const result=await original.apply(this,args);
      const current=currentInspectionSafe();
      try{await after({args,before,result,current})}catch(e){console.warn('No se pudo registrar',name,e)}
      return result;
    };
    wrapped.__auditWrapped=true;
    window[name]=wrapped;
  }

  function changedChecklistItem(before,current){
    const a=before?.checklist||[];
    const b=Array.isArray(current?.checklist)?current.checklist:[];
    const max=Math.max(a.length,b.length);
    for(let i=0;i<max;i++){
      if(Boolean(a[i]?.done)!==Boolean(b[i]?.done)||String(a[i]?.text||'')!==String(b[i]?.text||'')){
        return {index:i+1,text:b[i]?.text||a[i]?.text||'',previous_value:Boolean(a[i]?.done),new_value:Boolean(b[i]?.done)};
      }
    }
    return null;
  }

  function installWrappers(){
    if(wrappersInstalled) return;
    wrappersInstalled=true;

    wrapFunction('login',async({result})=>{
      const user=getCurrentUser();
      if(result===true&&user?.id){
        startNewSession();
        await logActivity('login','session',null,'Inició sesión en la aplicación',{role:user.role||''});
      }
    });

    const originalLogout=window.logout;
    if(typeof originalLogout==='function'&&!originalLogout.__auditWrapped){
      const wrappedLogout=async function(){
        const user=getCurrentUser();
        if(user?.id){
          const session=getSession();
          const duration=Math.max(0,Math.round((Date.now()-new Date(session.startedAt).getTime())/1000));
          await logActivity('logout','session',null,'Cerró sesión en la aplicación',{
            role:user.role||'',
            duration_seconds:duration
          });
          await flushQueue();
        }
        const result=await originalLogout.apply(this,arguments);
        clearSession();
        return result;
      };
      wrappedLogout.__auditWrapped=true;
      window.logout=wrappedLogout;
    }

    wrapFunction('openDetail',async({current})=>{
      if(current) await logActivity('supervision_viewed','supervision',current.id,'Abrió el detalle de una supervisión',inspectionMeta(current));
    });

    wrapFunction('saveFinding',async({before,current})=>{
      if(!current) return;
      const items=Array.isArray(current.findingItems)?current.findingItems:[];
      const latest=items[items.length-1]||{};
      await logActivity('finding_added','supervision',current.id,'Agregó un hallazgo',{
        ...inspectionMeta(current),
        finding_title:latest.title||'',
        finding_description:latest.description||'',
        severity:latest.severity||'',
        has_photo:Boolean(latest.photo),
        findings_before:before?.findings??null,
        findings_after:Number(current.findings)||0,
        status_before:before?.status||'',
        status_after:current.status||''
      });
    });

    wrapFunction('saveEvidence',async({before,current})=>{
      if(!current) return;
      const items=Array.isArray(current.evidenceItems)?current.evidenceItems:[];
      const latest=items[items.length-1]||{};
      await logActivity('evidence_added','supervision',current.id,'Agregó evidencia fotográfica',{
        ...inspectionMeta(current),
        evidence_description:latest.description||'',
        has_photo:Boolean(latest.photo),
        evidence_before:before?.evidence??null,
        evidence_after:Number(current.evidence)||0,
        status_before:before?.status||'',
        status_after:current.status||''
      });
    });

    wrapFunction('saveSign',async({before,current})=>{
      if(!current) return;
      await logActivity('signature_added','supervision',current.id,'Registró la firma del supervisor',{
        ...inspectionMeta(current),
        signature_before:Boolean(before?.signature_present),
        signature_after:Boolean(current.signature),
        status_before:before?.status||'',
        status_after:current.status||''
      });
    });

    wrapFunction('clearSign',async({before,current})=>{
      const x=current||before;
      if(!x) return;
      await logActivity('signature_removed','supervision',x.id,'Eliminó la firma del supervisor',{
        ...inspectionMeta(current||x),
        signature_before:Boolean(before?.signature_present),
        signature_after:Boolean(current?.signature),
        status_before:before?.status||'',
        status_after:current?.status||''
      });
    });

    wrapFunction('toggleItem',async({before,current})=>{
      if(!current) return;
      const changed=changedChecklistItem(before,current)||{};
      await logActivity('checklist_updated','supervision',current.id,'Actualizó un ítem del checklist',{
        ...inspectionMeta(current),
        checklist_item_number:changed.index||null,
        checklist_item:changed.text||'',
        previous_value:changed.previous_value,
        new_value:changed.new_value,
        status_before:before?.status||'',
        status_after:current.status||''
      });
    });

    const originalPdf=window.exportCompletedPDF;
    if(typeof originalPdf==='function'&&!originalPdf.__auditWrapped){
      const wrappedPdf=async function(){
        const completed=(typeof data!=='undefined'&&Array.isArray(data))?data.filter(x=>x.status==='completada'):[];
        const result=await originalPdf.apply(this,arguments);
        if(completed.length){
          const today=new Date().toISOString().slice(0,10);
          await logActivity('pdf_generated','document',null,'Generó PDF de supervisiones completadas',{
            document_type:'PDF',
            filename:`Iaptidud_Inspecciones_Completadas_${today}.pdf`,
            count:completed.length,
            supervision_ids:completed.slice(0,100).map(x=>String(x.id)),
            companies:[...new Set(completed.map(x=>x.company).filter(Boolean))].slice(0,30),
            sites:[...new Set(completed.map(x=>x.site).filter(Boolean))].slice(0,30)
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
        const rows=(typeof data!=='undefined'&&Array.isArray(data))?data:[];
        const result=await originalCsv.apply(this,arguments);
        await logActivity('csv_generated','document',null,'Generó archivo CSV de supervisiones',{
          document_type:'CSV',
          filename:'inspecciones.csv',
          count:rows.length,
          supervision_ids:rows.slice(0,100).map(x=>String(x.id)),
          companies:[...new Set(rows.map(x=>x.company).filter(Boolean))].slice(0,30),
          sites:[...new Set(rows.map(x=>x.site).filter(Boolean))].slice(0,30)
        });
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
    supervision_viewed:'Consultó supervisión',
    supervision_deleted:'Eliminó supervisión',
    supervision_status_changed:'Cambió estado',
    finding_added:'Agregó hallazgo',
    evidence_added:'Agregó evidencia',
    signature_added:'Agregó firma',
    signature_removed:'Eliminó firma',
    checklist_updated:'Actualizó checklist',
    pdf_generated:'Generó PDF',
    csv_generated:'Generó CSV'
  };

  const META_LABELS={
    company:'Empresa',site:'Faena',location:'Ubicación',type:'Tipo de supervisión',inspection_date:'Fecha de supervisión',
    status:'Estado',previous_status:'Estado anterior',status_before:'Estado antes',status_after:'Estado después',
    findings:'Hallazgos',findings_before:'Hallazgos antes',findings_after:'Hallazgos después',
    evidence:'Evidencias',evidence_before:'Evidencias antes',evidence_after:'Evidencias después',
    checklist_total:'Ítems checklist',checklist_done:'Ítems cumplidos',checklist_progress:'Avance checklist (%)',
    checklist_item_number:'N.º ítem',checklist_item:'Ítem modificado',previous_value:'Valor anterior',new_value:'Valor nuevo',
    finding_title:'Título hallazgo',finding_description:'Descripción hallazgo',severity:'Severidad',
    evidence_description:'Descripción evidencia',has_photo:'Fotografía adjunta',
    signature_present:'Firma presente',signature_before:'Firma antes',signature_after:'Firma después',
    document_type:'Tipo documento',filename:'Nombre del archivo',count:'Cantidad de supervisiones',
    supervision_ids:'IDs supervisiones',companies:'Empresas incluidas',sites:'Faenas incluidas',
    session_id:'ID de sesión',session_started_at:'Inicio de sesión técnica',duration_seconds:'Duración de sesión (segundos)',
    browser:'Navegador',os:'Sistema operativo',device_type:'Dispositivo',platform:'Plataforma',language:'Idioma',timezone:'Zona horaria',
    screen:'Pantalla',viewport:'Área visible',display_mode:'Modo de uso',connection_type:'Tipo de conexión',online:'En línea',
    page_host:'Servidor',audit_version:'Versión de trazabilidad',source:'Origen',deleted_at:'Fecha eliminación'
  };

  function formatDate(value){
    try{return new Date(value).toLocaleString('es-CL',{dateStyle:'short',timeStyle:'medium'})}catch(e){return String(value||'')}
  }

  function formatDuration(seconds){
    const s=Number(seconds);
    if(!Number.isFinite(s)) return String(seconds??'');
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);
    return [h?h+' h':'',m?m+' min':'',(!h&&!m)||sec?sec+' s':''].filter(Boolean).join(' ');
  }

  function formatMetaValue(key,value){
    if(value===null||value===undefined||value==='') return '—';
    if(key==='duration_seconds') return formatDuration(value);
    if(typeof value==='boolean') return value?'Sí':'No';
    if(Array.isArray(value)) return value.join(', ')||'—';
    if(typeof value==='object'){
      try{return JSON.stringify(value)}catch(e){return String(value)}
    }
    return String(value);
  }

  function eventSummary(r){
    const m=r.metadata||{};
    const bits=[];
    if(m.company) bits.push('Empresa: '+m.company);
    if(m.site) bits.push('Faena: '+m.site);
    if(m.finding_title) bits.push('Hallazgo: '+m.finding_title);
    if(m.severity) bits.push('Severidad: '+m.severity);
    if(m.checklist_item) bits.push('Ítem: '+m.checklist_item);
    if(m.filename) bits.push('Archivo: '+m.filename);
    if(m.document_type&&!m.filename) bits.push('Documento: '+m.document_type);
    if(m.status_after&&m.status_before!==m.status_after) bits.push('Estado: '+m.status_before+' → '+m.status_after);
    else if(m.previous_status&&m.status&&m.previous_status!==m.status) bits.push('Estado: '+m.previous_status+' → '+m.status);
    return bits;
  }

  async function fetchAuditRows(){
    const response=await fetch(
      SUPABASE_REST_URL+'/audit_logs?select=id,user_id,user_email,user_name,user_role,action,entity_type,entity_id,description,metadata,occurred_at,created_at&order=occurred_at.desc&limit=1000',
      {method:'GET',headers:await authHeaders(),cache:'no-store'}
    );
    if(!response.ok) throw new Error('No se pudo cargar la trazabilidad');
    const rows=await response.json();
    auditRows=Array.isArray(rows)?rows:[];
    return auditRows;
  }

  function filteredAuditRows(){
    const user=document.getElementById('auditUserFilter')?.value||'';
    const action=document.getElementById('auditActionFilter')?.value||'';
    const date=document.getElementById('auditDateFilter')?.value||'';
    const search=(document.getElementById('auditSearch')?.value||'').trim().toLowerCase();
    return auditRows.filter(r=>{
      if(user&&r.user_id!==user) return false;
      if(action&&r.action!==action) return false;
      if(date&&String(r.occurred_at||'').slice(0,10)!==date) return false;
      if(search){
        const haystack=[r.user_email,r.user_name,r.user_role,r.action,r.entity_id,r.description,JSON.stringify(r.metadata||{})].join(' ').toLowerCase();
        if(!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function renderAuditStats(rows){
    const host=document.getElementById('auditStats');
    if(!host) return;
    const users=new Set(rows.map(r=>r.user_id).filter(Boolean)).size;
    const sessions=new Set(rows.map(r=>r.metadata?.session_id).filter(Boolean)).size;
    const supervisions=rows.filter(r=>String(r.entity_type)==='supervision').length;
    const documents=rows.filter(r=>['pdf_generated','csv_generated'].includes(r.action)).length;
    host.innerHTML=`
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:10px 0">
        <div class="metric"><b>${users}</b><span>Usuarios</span></div>
        <div class="metric"><b>${sessions}</b><span>Sesiones</span></div>
        <div class="metric"><b>${supervisions}</b><span>Eventos supervisión</span></div>
        <div class="metric"><b>${documents}</b><span>Documentos</span></div>
      </div>`;
  }

  function renderAuditRows(){
    const host=document.getElementById('auditRows');
    if(!host) return;
    const rows=filteredAuditRows();
    const count=document.getElementById('auditCount');
    if(count) count.textContent=rows.length+' registro'+(rows.length===1?'':'s');
    renderAuditStats(rows);

    if(!rows.length){
      host.innerHTML='<div class="empty"><div class="big">🕘</div><div class="title">Sin registros</div><div class="small">No hay actividad para los filtros seleccionados.</div></div>';
      return;
    }

    host.innerHTML=rows.map(r=>{
      const m=r.metadata||{};
      const label=ACTION_LABELS[r.action]||r.action;
      const entity=r.entity_id?'#'+escapeHtml(r.entity_id):'—';
      const summary=eventSummary(r);
      const metadataRows=Object.entries(m)
        .filter(([,v])=>v!==null&&v!==undefined&&v!=='')
        .map(([k,v])=>`<div class="row between" style="align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--line);gap:12px"><span class="small">${escapeHtml(META_LABELS[k]||k)}</span><span style="font-size:12px;text-align:right;max-width:58%;word-break:break-word">${escapeHtml(formatMetaValue(k,v))}</span></div>`)
        .join('');
      return `<div class="item-card">
        <div class="row between" style="align-items:flex-start"><div><div class="title">${escapeHtml(label)}</div><div class="small">Evento #${r.id} · ${escapeHtml(r.entity_type||'app')} ${entity}</div></div><span class="small" style="text-align:right">${escapeHtml(formatDate(r.occurred_at))}</span></div>
        <div style="margin-top:8px"><b>${escapeHtml(r.user_name||r.user_email)}</b> <span class="badge pending">${escapeHtml(r.user_role||'Usuario')}</span></div>
        <div class="small" style="margin-top:3px">${escapeHtml(r.user_email||'')}</div>
        ${r.description?`<div style="margin-top:9px">${escapeHtml(r.description)}</div>`:''}
        ${summary.length?`<div class="small" style="margin-top:7px">${summary.map(escapeHtml).join(' · ')}</div>`:''}
        <details style="margin-top:10px">
          <summary class="linkbtn" style="cursor:pointer;list-style:none;padding:6px 0">Ver detalle completo</summary>
          <div class="card" style="box-shadow:none;margin-top:6px;padding:10px">
            <div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="small">UUID usuario</span><span style="font-size:12px;word-break:break-all;text-align:right;max-width:58%">${escapeHtml(r.user_id||'—')}</span></div>
            <div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="small">Hora del evento</span><span style="font-size:12px">${escapeHtml(formatDate(r.occurred_at))}</span></div>
            <div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="small">Hora recibida por servidor</span><span style="font-size:12px">${escapeHtml(formatDate(r.created_at))}</span></div>
            ${metadataRows||'<div class="small">Sin metadatos adicionales.</div>'}
          </div>
        </details>
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
    const user=getCurrentUser();
    if(user?.role!=='Superusuario'){
      if(typeof toast==='function') toast('Solo el Superusuario puede ver la trazabilidad');
      return;
    }
    const overlay=document.getElementById('entrySheet');
    const title=document.getElementById('sheetTitle');
    const body=document.getElementById('sheetBody');
    if(!overlay||!title||!body) return;

    title.textContent='Trazabilidad detallada';
    body.innerHTML=`
      <div class="small" style="margin-bottom:10px">Auditoría de usuarios, sesiones, supervisiones, cambios y documentos generados.</div>
      <div id="auditStats"></div>
      <div class="field"><label>Buscar</label><input id="auditSearch" placeholder="Correo, empresa, faena, ID, hallazgo…" oninput="IAPTIDUD_AUDIT.render()"></div>
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
    const user=getCurrentUser();
    if(user?.role!=='Superusuario'){
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

  async function logAppOpenedOnce(){
    if(appOpenLogged||!window.IAPTIDUD_AUTH?.isAuthenticated?.()) return;
    const user=getCurrentUser();
    if(!user?.id) return;
    appOpenLogged=true;
    await flushQueue();
    await logActivity('app_opened','session',null,'Abrió la aplicación',{role:user.role||''});
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
      appOpenLogged=false;
      if(!sessionStorage.getItem(SESSION_ID_KEY)) startNewSession();
      setTimeout(()=>{installWrappers();installTraceButton();flushQueue()},0);
    }else{
      appOpenLogged=false;
      document.getElementById('auditTraceButton')?.remove();
    }
  });

  window.addEventListener('iaptidud-auth-ready',event=>{
    if(event.detail?.authenticated) setTimeout(logAppOpenedOnce,0);
  });

  window.IAPTIDUD_AUTH?.ready?.().then(()=>setTimeout(logAppOpenedOnce,0)).catch(()=>{});
})();
