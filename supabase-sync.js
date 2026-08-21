// Sincronización adicional con Supabase.
// No reemplaza el guardado local existente: solo envía la inspección recién creada a la nube.
(function(){
  'use strict';

  const SUPABASE_URL='https://xjzftawmfnlwkwslmpzo.supabase.co';
  const SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqemZ0YXdtZm5sd2t3c2xtcHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNzI4NzIsImV4cCI6MjEwMjg0ODg3Mn0.LzsJcd-zhiZRsKHb2xxQNWzIYmvZT0GMBSCshF8mCSs';
  const REST_URL=SUPABASE_URL+'/rest/v1';

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

  async function syncInspection(x){
    const response=await fetch(REST_URL+'/inspections?on_conflict=id',{
      method:'POST',
      headers:{
        'apikey':SUPABASE_ANON_KEY,
        'Authorization':'Bearer '+SUPABASE_ANON_KEY,
        'Content-Type':'application/json',
        'Accept':'application/json',
        'Prefer':'resolution=merge-duplicates,return=representation'
      },
      body:JSON.stringify(toSupabaseRow(x)),
      cache:'no-store'
    });

    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('Supabase HTTP '+response.status+(detail?': '+detail:''));
    }
    return response.json();
  }

  const originalSaveInspection=window.saveInspection;
  if(typeof originalSaveInspection!=='function'){
    console.warn('No se encontró saveInspection para activar la sincronización con Supabase.');
    return;
  }

  window.saveInspection=function(){
    const idsBefore=new Set((typeof data!=='undefined'&&Array.isArray(data))?data.map(x=>x.id):[]);
    const result=originalSaveInspection.apply(this,arguments);

    Promise.resolve(result).then(async()=>{
      if(typeof data==='undefined'||!Array.isArray(data)) return;
      const created=data.find(x=>!idsBefore.has(x.id));
      if(!created) return;

      if(!navigator.onLine){
        if(typeof toast==='function') toast('Inspección guardada localmente. Sin conexión a Supabase');
        return;
      }

      try{
        await syncInspection(created);
        if(typeof toast==='function') toast('Inspección guardada en Supabase');
        console.info('Inspección sincronizada con Supabase:',created.id);
      }catch(error){
        console.warn('No se pudo sincronizar la inspección con Supabase:',error);
        if(typeof toast==='function') toast('Inspección guardada localmente; falló la sincronización');
      }
    });

    return result;
  };

  window.IAPTIDUD_SUPABASE_SYNC={
    url:SUPABASE_URL,
    syncInspection:syncInspection
  };
})();
