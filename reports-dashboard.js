// Dashboard avanzado de Reportes para Iaptidud supervision.
// Mejora la vista existente sin alterar las funciones base de la aplicación.
(function(){
  'use strict';

  const REPORTS_VERSION='1.0';
  const state={
    period:'30',
    from:'',
    to:'',
    profiles:new Map(),
    profilesLoaded:false,
    loadingProfiles:false
  };

  function esc(value){
    if(typeof window.esc==='function') return window.esc(value);
    return String(value??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  }

  function currentUserSafe(){
    try{return typeof currentUser!=='undefined'?currentUser:null}catch(e){return null}
  }

  function allRows(){
    try{return typeof data!=='undefined'&&Array.isArray(data)?data.filter(Boolean):[]}catch(e){return []}
  }

  function toDate(value){
    if(!value) return null;
    const d=new Date(String(value).slice(0,10)+'T12:00:00');
    return Number.isNaN(d.getTime())?null:d;
  }

  function dateKey(d){
    const y=d.getFullYear();
    const m=String(d.getMonth()+1).padStart(2,'0');
    const day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  function todayAtNoon(){
    const d=new Date();
    d.setHours(12,0,0,0);
    return d;
  }

  function filteredRows(){
    const rows=allRows();
    if(state.period==='all') return rows;

    const today=todayAtNoon();
    let from=null;
    let to=today;

    if(state.period==='today'){
      from=today;
    }else if(['7','30','90'].includes(state.period)){
      from=new Date(today);
      from.setDate(from.getDate()-(Number(state.period)-1));
    }else if(state.period==='custom'){
      from=toDate(state.from);
      to=toDate(state.to);
      if(!from&&!to) return rows;
    }

    return rows.filter(row=>{
      const d=toDate(row.date);
      if(!d) return false;
      if(from&&d<from) return false;
      if(to&&d>to) return false;
      return true;
    });
  }

  function countStatuses(rows){
    return rows.reduce((acc,row)=>{
      const s=row.status||'pendiente';
      if(s==='completada') acc.completed++;
      else if(s==='vencida') acc.overdue++;
      else acc.pending++;
      return acc;
    },{completed:0,pending:0,overdue:0});
  }

  function closeRate(rows){
    if(!rows.length) return 0;
    return Math.round(rows.filter(x=>x.status==='completada').length*100/rows.length);
  }

  function checklistStats(rows){
    let total=0,done=0;
    rows.forEach(row=>{
      const checklist=Array.isArray(row.checklist)?row.checklist:[];
      total+=checklist.length;
      done+=checklist.filter(i=>i&&i.done).length;
    });
    return {total,done,rate:total?Math.round(done*100/total):0};
  }

  function findingStats(rows){
    const stats={total:0,Baja:0,Media:0,Alta:0,'Crítica':0,other:0};
    rows.forEach(row=>{
      const items=Array.isArray(row.findingItems)?row.findingItems:[];
      stats.total+=items.length||Number(row.findings||0);
      if(items.length){
        items.forEach(item=>{
          const severity=String(item?.severity||'').trim();
          if(Object.prototype.hasOwnProperty.call(stats,severity)) stats[severity]++;
          else stats.other++;
        });
      }
    });
    return stats;
  }

  function evidenceCount(rows){
    return rows.reduce((sum,row)=>sum+Number(row.evidence||0),0);
  }

  function signatureStats(rows){
    const signed=rows.filter(x=>Boolean(x.signature)).length;
    return {signed,unsigned:Math.max(0,rows.length-signed)};
  }

  function attentionStats(rows,findings){
    const incomplete=rows.filter(x=>x.status!=='completada');
    return {
      overdue:rows.filter(x=>x.status==='vencida').length,
      missingFinding:incomplete.filter(x=>Number(x.findings||0)<1).length,
      missingEvidence:incomplete.filter(x=>Number(x.evidence||0)<1).length,
      missingSignature:incomplete.filter(x=>!x.signature).length,
      highCritical:Number(findings.Alta||0)+Number(findings['Crítica']||0)
    };
  }

  function groupRows(rows,keyFn,labelFn){
    const map=new Map();
    rows.forEach(row=>{
      const key=String(keyFn(row)||'Sin información');
      if(!map.has(key)) map.set(key,{key,label:labelFn?labelFn(row):key,rows:[]});
      map.get(key).rows.push(row);
    });
    return [...map.values()].map(group=>{
      const c=countStatuses(group.rows);
      return {...group,total:group.rows.length,...c,rate:closeRate(group.rows)};
    }).sort((a,b)=>b.total-a.total||b.rate-a.rate||String(a.label).localeCompare(String(b.label),'es'));
  }

  function periodLabel(){
    const labels={today:'Hoy','7':'Últimos 7 días','30':'Últimos 30 días','90':'Últimos 90 días',all:'Todo el historial',custom:'Rango personalizado'};
    return labels[state.period]||'Últimos 30 días';
  }

  function metricCard(value,label,sub=''){
    return `<div class="report-metric"><b>${esc(value)}</b><span>${esc(label)}</span>${sub?`<small>${esc(sub)}</small>`:''}</div>`;
  }

  function ringCard(value,label,detail,kind='primary'){
    const pct=Math.max(0,Math.min(100,Number(value)||0));
    const tone=kind==='checklist'?'var(--orange)':'var(--green)';
    return `<div class="report-ring-card">
      <div class="report-ring" style="background:conic-gradient(${tone} 0 ${pct}%,var(--line) ${pct}% 100%)"><div><b>${pct}%</b><span>${esc(label)}</span></div></div>
      <div class="small" style="text-align:center;margin-top:8px">${esc(detail)}</div>
    </div>`;
  }

  function groupHTML(title,groups,empty='Sin datos para el período seleccionado.'){
    const body=groups.slice(0,8).map(g=>`<div class="report-group-row">
      <div class="report-group-head"><div><b>${esc(g.label||'Sin información')}</b><div class="small">${g.total} supervisión${g.total===1?'':'es'} · ${g.completed} completada${g.completed===1?'':'s'}</div></div><b>${g.rate}%</b></div>
      <div class="report-bar"><i style="width:${g.rate}%"></i></div>
      <div class="report-mini-status"><span>✓ ${g.completed}</span><span>◷ ${g.pending}</span><span>! ${g.overdue}</span></div>
    </div>`).join('');
    return `<div class="card"><div class="report-card-title">${esc(title)}</div>${body||`<div class="small" style="padding:12px 0">${esc(empty)}</div>`}</div>`;
  }

  function severityHTML(stats){
    return `<div class="card">
      <div class="report-card-title">Hallazgos por severidad</div>
      <div class="report-severity-grid">
        <div><b>${stats.Baja}</b><span>Baja</span></div>
        <div><b>${stats.Media}</b><span>Media</span></div>
        <div><b>${stats.Alta}</b><span>Alta</span></div>
        <div><b>${stats['Crítica']}</b><span>Crítica</span></div>
      </div>
      ${stats.other?`<div class="small" style="margin-top:10px">Otros / sin clasificación: ${stats.other}</div>`:''}
    </div>`;
  }

  function attentionHTML(stats){
    const items=[
      {n:stats.overdue,icon:'🔴',title:'Supervisiones vencidas',detail:'Fuera del plazo informado'},
      {n:stats.highCritical,icon:'⚠️',title:'Hallazgos Alta/Crítica',detail:'Requieren priorización'},
      {n:stats.missingFinding,icon:'📝',title:'Sin hallazgo',detail:'Pendientes de cumplir requisito de cierre'},
      {n:stats.missingEvidence,icon:'📷',title:'Sin evidencia',detail:'Pendientes de cumplir requisito de cierre'},
      {n:stats.missingSignature,icon:'✍️',title:'Sin firma',detail:'Pendientes de cumplir requisito de cierre'}
    ];
    const active=items.filter(x=>x.n>0);
    return `<div class="card report-attention">
      <div class="report-card-title">Atención requerida</div>
      ${active.length?active.map(x=>`<div class="report-alert-row"><span class="report-alert-icon">${x.icon}</span><div style="flex:1"><b>${x.title}</b><div class="small">${x.detail}</div></div><b>${x.n}</b></div>`).join(''):`<div class="notice success" style="margin:10px 0 0">✓ No hay alertas para el período seleccionado.</div>`}
    </div>`;
  }

  function typeHTML(groups){
    const chips=groups.map(g=>`<div class="report-type-chip"><b>${esc(g.label)}</b><span>${g.total}</span><small>${g.rate}% cerradas</small></div>`).join('');
    return `<div class="card"><div class="report-card-title">Por tipo de supervisión</div><div class="report-type-grid">${chips||'<div class="small">Sin datos.</div>'}</div></div>`;
  }

  function profileLabel(userId){
    if(!userId) return 'Histórico sin usuario';
    const p=state.profiles.get(String(userId));
    if(p) return p.name?`${p.name} · ${p.email}`:(p.email||String(userId).slice(0,8));
    return 'Usuario '+String(userId).slice(0,8);
  }

  function usersHTML(rows){
    const groups=groupRows(rows,r=>r.user_id||'legacy',r=>profileLabel(r.user_id));
    return groupHTML('Desempeño por usuario',groups,'No hay supervisiones asociadas a usuarios en este período.');
  }

  async function loadProfiles(){
    const user=currentUserSafe();
    if(user?.role!=='Superusuario'||state.profilesLoaded||state.loadingProfiles) return;
    state.loadingProfiles=true;
    try{
      const token=await window.IAPTIDUD_AUTH?.getAccessToken?.();
      if(!token) return;
      const response=await fetch(SUPABASE_REST_URL+'/profiles?select=id,email,name,role&order=name.asc',{
        headers:{apikey:SUPABASE_ANON_KEY,Authorization:'Bearer '+token,Accept:'application/json'},
        cache:'no-store'
      });
      if(!response.ok) return;
      const profiles=await response.json();
      if(Array.isArray(profiles)) profiles.forEach(p=>state.profiles.set(String(p.id),p));
      state.profilesLoaded=true;
    }catch(error){
      console.warn('No se pudieron cargar perfiles para Reportes:',error);
    }finally{
      state.loadingProfiles=false;
    }
  }

  function installStyles(){
    if(document.getElementById('iaptidudReportsStyles')) return;
    const style=document.createElement('style');
    style.id='iaptidudReportsStyles';
    style.textContent=`
      #reports .report-toolbar{display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:12px}
      #reports .report-scope{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
      #reports .report-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:10px 0}
      #reports .report-metric{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 10px;box-shadow:var(--shadow);text-align:center;min-width:0}
      #reports .report-metric b{display:block;font-size:24px;line-height:1.1}
      #reports .report-metric span{display:block;font-size:12px;color:var(--muted);margin-top:5px}
      #reports .report-metric small{display:block;font-size:10px;color:var(--muted);margin-top:4px}
      #reports .report-ring-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      #reports .report-ring-card{min-width:0}
      #reports .report-ring{width:132px;height:132px;border-radius:50%;display:grid;place-items:center;margin:auto}
      #reports .report-ring>div{width:92px;height:92px;border-radius:50%;background:var(--card);display:grid;place-items:center;align-content:center;text-align:center;padding:6px}
      #reports .report-ring b{font-size:25px}
      #reports .report-ring span{font-size:10px;color:var(--muted);line-height:1.15}
      #reports .report-card-title{font-weight:900;font-size:16px;margin-bottom:10px}
      #reports .report-group-row{padding:11px 0;border-bottom:1px solid var(--line)}
      #reports .report-group-row:last-child{border-bottom:0}
      #reports .report-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      #reports .report-bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin:8px 0 5px}
      #reports .report-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--blue2));border-radius:99px}
      #reports .report-mini-status{display:flex;gap:12px;font-size:11px;color:var(--muted)}
      #reports .report-severity-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
      #reports .report-severity-grid>div{border:1px solid var(--line);border-radius:12px;padding:10px 4px;text-align:center}
      #reports .report-severity-grid b{display:block;font-size:20px}
      #reports .report-severity-grid span{font-size:10px;color:var(--muted)}
      #reports .report-alert-row{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
      #reports .report-alert-row:last-child{border-bottom:0}
      #reports .report-alert-icon{font-size:20px;width:28px;text-align:center}
      #reports .report-type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      #reports .report-type-chip{border:1px solid var(--line);border-radius:13px;padding:11px;min-width:0}
      #reports .report-type-chip b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #reports .report-type-chip span{display:block;font-size:22px;font-weight:900;margin-top:5px}
      #reports .report-type-chip small{display:block;color:var(--muted);font-size:10px}
      #reports .report-export-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      #reports .report-custom-range{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      @media(max-width:390px){
        #reports .report-ring{width:116px;height:116px}
        #reports .report-ring>div{width:80px;height:80px}
        #reports .report-severity-grid{grid-template-columns:repeat(2,1fr)}
        #reports .report-export-actions{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function renderEnhancedReports(){
    installStyles();
    const host=document.getElementById('reports');
    if(!host) return;

    const rows=filteredRows();
    const counts=countStatuses(rows);
    const closing=closeRate(rows);
    const checklist=checklistStats(rows);
    const findings=findingStats(rows);
    const evidence=evidenceCount(rows);
    const signatures=signatureStats(rows);
    const attention=attentionStats(rows,findings);
    const user=currentUserSafe();
    const isSuper=user?.role==='Superusuario';
    const companyGroups=groupRows(rows,r=>r.company||'Sin empresa',r=>r.company||'Sin empresa');
    const siteGroups=groupRows(rows,r=>(r.company||'')+'|'+(r.site||''),r=>`${r.site||'Sin faena'}${r.company?' · '+r.company:''}`);
    const typeGroups=groupRows(rows,r=>r.type||'Sin tipo',r=>r.type||'Sin tipo');

    host.innerHTML=`
      <div class="section-title"><h2>Reportes</h2><span class="small">Dashboard v${REPORTS_VERSION}</span></div>

      <div class="report-toolbar">
        <div class="report-scope">
          <div><b>${isSuper?'Vista global':'Vista personal'}</b><div class="small">${isSuper?'Todas las supervisiones activas visibles para el Superusuario':'Solo tus supervisiones, según permisos de la cuenta'}</div></div>
          <span>${isSuper?'👑':'👤'}</span>
        </div>
        <div class="field" style="margin:0"><label>Período · fecha de inspección</label><select id="reportPeriod" onchange="IAPTIDUD_REPORTS.setPeriod(this.value)">
          <option value="today" ${state.period==='today'?'selected':''}>Hoy</option>
          <option value="7" ${state.period==='7'?'selected':''}>Últimos 7 días</option>
          <option value="30" ${state.period==='30'?'selected':''}>Últimos 30 días</option>
          <option value="90" ${state.period==='90'?'selected':''}>Últimos 90 días</option>
          <option value="all" ${state.period==='all'?'selected':''}>Todo el historial</option>
          <option value="custom" ${state.period==='custom'?'selected':''}>Rango personalizado</option>
        </select></div>
        ${state.period==='custom'?`<div class="report-custom-range">
          <div class="field" style="margin:0"><label>Desde</label><input type="date" value="${esc(state.from)}" onchange="IAPTIDUD_REPORTS.setFrom(this.value)"></div>
          <div class="field" style="margin:0"><label>Hasta</label><input type="date" value="${esc(state.to)}" onchange="IAPTIDUD_REPORTS.setTo(this.value)"></div>
        </div>`:''}
      </div>

      <div class="small" style="margin:4px 2px 8px">${esc(periodLabel())} · ${rows.length} supervisión${rows.length===1?'':'es'} considerada${rows.length===1?'':'s'}</div>

      <div class="report-grid">
        ${metricCard(rows.length,'Total')}
        ${metricCard(counts.completed,'Completadas')}
        ${metricCard(counts.pending,'Pendientes')}
        ${metricCard(counts.overdue,'Vencidas')}
      </div>

      <div class="card">
        <div class="report-card-title">Indicadores principales</div>
        <div class="report-ring-grid">
          ${ringCard(closing,'Cierre de supervisiones',`${counts.completed} de ${rows.length} cerradas`)}
          ${ringCard(checklist.rate,'Cumplimiento checklist',`${checklist.done} de ${checklist.total} ítems cumplen`,'checklist')}
        </div>
        <div class="small" style="margin-top:14px">El cierre exige al menos 1 hallazgo + 1 evidencia + firma. El cumplimiento de checklist se calcula por separado.</div>
      </div>

      <div class="report-grid">
        ${metricCard(findings.total,'Hallazgos')}
        ${metricCard(evidence,'Evidencias')}
        ${metricCard(signatures.signed,'Con firma')}
        ${metricCard(signatures.unsigned,'Sin firma')}
      </div>

      ${attentionHTML(attention)}
      ${severityHTML(findings)}
      ${groupHTML('Por empresa',companyGroups)}
      ${groupHTML('Por faena',siteGroups)}
      ${typeHTML(typeGroups)}
      ${isSuper?usersHTML(rows):''}

      <div class="card">
        <div class="report-card-title">Documentos</div>
        <div class="small" style="margin-bottom:12px">Las exportaciones respetan el período seleccionado. El PDF incluye únicamente supervisiones completadas.</div>
        <div class="report-export-actions">
          <button class="btn secondary" onclick="IAPTIDUD_REPORTS.exportPDF()">📄 Exportar PDF</button>
          <button class="btn secondary" onclick="IAPTIDUD_REPORTS.exportCSV()">📊 Exportar CSV</button>
        </div>
      </div>
    `;

    if(isSuper&&!state.profilesLoaded&&!state.loadingProfiles){
      loadProfiles().then(()=>{if(document.getElementById('reports')?.classList.contains('active')) renderEnhancedReports()});
    }
  }

  function setPeriod(value){
    state.period=String(value||'30');
    if(state.period==='custom'){
      const today=todayAtNoon();
      if(!state.to) state.to=dateKey(today);
      if(!state.from){
        const d=new Date(today);d.setDate(d.getDate()-29);state.from=dateKey(d);
      }
    }
    renderEnhancedReports();
  }

  function setFrom(value){state.from=String(value||'');renderEnhancedReports()}
  function setTo(value){state.to=String(value||'');renderEnhancedReports()}

  async function withFilteredData(callback){
    const rows=filteredRows().slice();
    let original;
    try{
      original=data;
      data=rows;
      return await callback();
    }finally{
      data=original;
    }
  }

  async function exportPDF(){
    if(typeof window.exportCompletedPDF!=='function') return;
    return withFilteredData(()=>window.exportCompletedPDF());
  }

  async function exportCSV(){
    if(typeof window.exportCSV!=='function') return;
    return withFilteredData(()=>window.exportCSV());
  }

  async function refresh(){
    try{await window.IAPTIDUD_SUPABASE_SYNC?.refresh?.()}catch(e){}
    renderEnhancedReports();
  }

  window.IAPTIDUD_REPORTS={render:renderEnhancedReports,setPeriod,setFrom,setTo,exportPDF,exportCSV,refresh};

  const baseGo=window.go;
  if(typeof baseGo==='function'&&!baseGo.__reportsDashboardWrapped){
    const wrappedGo=function(id){
      const result=baseGo.apply(this,arguments);
      if(id==='reports') setTimeout(renderEnhancedReports,0);
      return result;
    };
    wrappedGo.__reportsDashboardWrapped=true;
    window.go=wrappedGo;
  }

  window.renderReports=renderEnhancedReports;

  if(document.getElementById('reports')?.classList.contains('active')) renderEnhancedReports();
})();