// Sincronización Supabase entre dispositivos.
// Mantiene el funcionamiento local/offline existente y agrega nube compartida.
(function(){
  'use strict';

  const SUPABASE_URL='https://xjzftawmfnlwkwslmpzo.supabase.co';
  const SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqemZ0YXdtZm5sd2t3c2xtcHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNzI4NzIsImV4cCI6MjEwMjg0ODg3Mn0.LzsJcd-zhiZRsKHb2xxQNWzIYmvZT0GMBSCshF8mCSs';
  const REST_URL=SUPABASE_URL+'/rest/v1';

  function headers(extra={}){
    return {
      'apikey':SUPABASE_ANON_KEY,
      'Authorization':'Bearer '+SUPABASE_ANON_KEY,
      'Accept':'application/json',
      ...extra
    };
  }

  function toSupabaseRow(x){
    return {
      id:x.id,
      type:x.type,
      company:x.company,
      site:x.site,
      location:x.location,
      inspection_date:x.date,
      status:x.status||'pendiente',
      findings:Number(x.findings||0),
      evidence:Number(x.evidence||0),
      checklist:Array.isArray(x.checklist)?x.checklist:[],
      finding_items:Array.isArray(x.findingItems)?x.findingItems:[],
      evidence_items:Array.isArray(x.evidenceItems)?x.evidenceItems:[],
      signature:x.signature||null,
      updated_at:new Date().toISOString()
    };
  }

  function fromSupabaseRow(row){
    return {
      id:Number(row.id),
      type:row.type||'Seguridad',
      company:row.company||'',
      site:row.site||'',
      location:row.location||'',
      date:row.inspection_date||'',
      status:row.status||'pendiente',
      findings:Number(row.findings||0),
      evidence:Number(row.evidence||0),
      checklist:Array.isArray(row.checklist)?row.checklist:[],
      findingItems:Array.isArray(row.finding_items)?row.finding_items:[],
      evidenceItems:Array.isArray(row.evidence_items)?row.evidence_items:[],
      signature:row.signature||undefined
    };
  }

  async function syncInspection(x){
    if(!navigator.onLine||!x) return false;

    const response=await fetch(REST_URL+'/inspections?on_conflict=id',{
      method:'POST',
      headers:headers({
        'Content-Type':'application/json',
        'Prefer':'resolution=merge-duplicates,return=representation'
      }),
      body:JSON.stringify(toSupabaseRow(x)),
      cache:'no-store'
    });

    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('Supabase HTTP '+response.status+(detail?': '+detail:''));
    }

    return true;
  }

  async function loadInspections(){
    if(!navigator.onLine) return false;
    if(typeof data==='undefined'||!Array.isArray(data)) return false;

    const response=await fetch(REST_URL+'/inspections?select=*&order=updated_at.desc',{
      method:'GET',
      headers:headers(),
      cache:'no-store'
    });

    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('Supabase HTTP '+response.status+(detail?': '+detail:''));
    }

    const rows=await response.json();
    const remote=Array.isArray(rows)?rows.map(fromSupabaseRow):[];
    const localById=new Map(data.map(x=>[String(x.id),x]));

    remote.forEach(remoteInspection=>{
      const key=String(remoteInspection.id);
      const local=localById.get(key);
      if(local){
        Object.assign(local,remoteInspection);
      }else{
        data.push(remoteInspection);
        localById.set(key,remoteInspection);
      }
    });

    data.sort((a,b)=>Number(b.id||0)-Number(a.id||0));
    if(typeof persist==='function') persist();

    const active=document.querySelector('.view.active')?.id;
    if(active==='home'&&typeof renderHome==='function') renderHome();
    if(active==='inspections'&&typeof renderInspections==='function') renderInspections();
    if(active==='reports'&&typeof renderReports==='function') renderReports();
    if(active==='detail'&&typeof renderDetail==='function') renderDetail();

    console.info('Supabase: inspecciones cargadas:',remote.length);
    return true;
  }

  // Recupera inspecciones creadas previamente en este dispositivo que aún
  // solo estén en localStorage. Se omiten los 3 registros demo originales.
  async function syncExistingLocalInspections(){
    if(!navigator.onLine) return false;
    if(typeof data==='undefined'||!Array.isArray(data)) return false;

    const candidates=data.filter(x=>Number(x.id)>3);
    for(const inspection of candidates){
      try{
        await syncInspection(inspection);
      }catch(error){
        console.warn('No se pudo subir inspección local pendiente:',inspection?.id,error);
      }
    }
    return true;
  }

  function currentInspection(){
    if(typeof data==='undefined'||!Array.isArray(data)) return null;
    if(typeof currentId==='undefined'||currentId==null) return null;
    return data.find(x=>x.id===currentId)||null;
  }

  function wrapMutation(name){
    const original=window[name];
    if(typeof original!=='function') return;

    window[name]=function(){
      const result=original.apply(this,arguments);
      Promise.resolve(result).then(async()=>{
        const inspection=currentInspection();
        if(!inspection||!navigator.onLine) return;
        try{
          await syncInspection(inspection);
        }catch(error){
          console.warn('No se pudo actualizar inspección en Supabase:',inspection.id,error);
        }
      });
      return result;
    };
  }

  const originalSaveInspection=window.saveInspection;
  if(typeof originalSaveInspection==='function'){
    window.saveInspection=function(){
      const idsBefore=new Set((typeof data!=='undefined'&&Array.isArray(data))?data.map(x=>x.id):[]);
      const result=originalSaveInspection.apply(this,arguments);

      Promise.resolve(result).then(async()=>{
        if(typeof data==='undefined'||!Array.isArray(data)) return;
        const created=data.find(x=>!idsBefore.has(x.id));
        if(!created) return;

        if(!navigator.onLine){
          if(typeof toast==='function') toast('Inspección guardada localmente. Se sincronizará al volver Internet');
          return;
        }

        try{
          await syncInspection(created);
          if(typeof toast==='function') toast('Inspección guardada en Supabase');
          console.info('Inspección sincronizada con Supabase:',created.id);
        }catch(error){
          console.warn('No se pudo sincronizar la inspección con Supabase:',error);
          if(typeof toast==='function') toast('Inspección guardada localmente; sincronización pendiente');
        }
      });

      return result;
    };
  }

  ['toggleItem','saveFinding','saveEvidence','saveSign','clearSign'].forEach(wrapMutation);

  async function initialSync(){
    if(!navigator.onLine) return;
    try{
      // Primero sube cualquier inspección real que exista solo en este equipo.
      await syncExistingLocalInspections();
      // Después descarga la base compartida para mostrarla en este dispositivo.
      await loadInspections();
    }catch(error){
      console.warn('Sincronización inicial con Supabase incompleta:',error);
    }
  }

  window.addEventListener('online',initialSync);
  initialSync();

  window.IAPTIDUD_SUPABASE_SYNC={
    url:SUPABASE_URL,
    syncInspection,
    loadInspections,
    syncExistingLocalInspections,
    refresh:initialSync
  };
})();
