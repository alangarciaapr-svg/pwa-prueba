// Sincronización Supabase autenticada entre dispositivos.
// Conserva el funcionamiento local/offline y aplica RLS por usuario autenticado.
(function(){
  'use strict';

  const REST_URL=SUPABASE_URL+'/rest/v1';

  async function headers(extra={}){
    const token=await window.IAPTIDUD_AUTH?.getAccessToken?.();
    if(!token) throw new Error('Sesión no autenticada');
    return {
      'apikey':SUPABASE_ANON_KEY,
      'Authorization':'Bearer '+token,
      'Accept':'application/json',
      ...extra
    };
  }

  function authenticatedUserId(){
    return window.IAPTIDUD_AUTH?.getUserId?.()||currentUser?.id||null;
  }

  function toSupabaseRow(x){
    const owner=(x&&Object.prototype.hasOwnProperty.call(x,'user_id'))
      ? x.user_id
      : authenticatedUserId();

    return {
      id:x.id,
      user_id:owner,
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
      user_id:row.user_id||null,
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
    const uid=authenticatedUserId();
    if(!uid) return false;

    const hasOwner=Object.prototype.hasOwnProperty.call(x,'user_id');
    const isLegacy=hasOwner && x.user_id==null;
    if(!hasOwner) x.user_id=uid;

    let response;

    // Los registros anteriores a Supabase Auth conservan user_id = NULL.
    // El Superusuario puede actualizarlos sin convertirlos en registros propios.
    if(isLegacy && currentUser?.role==='Superusuario'){
      const patch=toSupabaseRow(x);
      delete patch.id;
      delete patch.user_id;

      response=await fetch(
        REST_URL+'/inspections?id=eq.'+encodeURIComponent(String(x.id)),
        {
          method:'PATCH',
          headers:await headers({
            'Content-Type':'application/json',
            'Prefer':'return=representation'
          }),
          body:JSON.stringify(patch),
          cache:'no-store'
        }
      );
    }else{
      response=await fetch(REST_URL+'/inspections?on_conflict=id',{
        method:'POST',
        headers:await headers({
          'Content-Type':'application/json',
          'Prefer':'resolution=merge-duplicates,return=representation'
        }),
        body:JSON.stringify(toSupabaseRow(x)),
        cache:'no-store'
      });
    }

    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('Supabase HTTP '+response.status+(detail?': '+detail:''));
    }

    return true;
  }

  async function loadInspections(){
    if(!navigator.onLine) return false;
    if(!authenticatedUserId()) return false;
    if(typeof data==='undefined'||!Array.isArray(data)) return false;

    const response=await fetch(REST_URL+'/inspections?select=*&order=updated_at.desc',{
      method:'GET',
      headers:await headers(),
      cache:'no-store'
    });

    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('Supabase HTTP '+response.status+(detail?': '+detail:''));
    }

    const rows=await response.json();
    const remoteRows=Array.isArray(rows)?rows:[];

    const deletedIds=new Set(
      remoteRows.filter(row=>row.deleted_at).map(row=>String(row.id))
    );
    if(deletedIds.size){
      data=data.filter(x=>!deletedIds.has(String(x.id)));
    }

    const remote=remoteRows
      .filter(row=>!row.deleted_at)
      .map(fromSupabaseRow);

    const uid=authenticatedUserId();

    // Para usuarios normales, el historial local se mantiene limitado a sus registros.
    // El Superusuario puede recibir registros de otros usuarios por RLS; esos registros
    // conservan su user_id y nunca son reasignados al sincronizar.
    data=data.filter(x=>{
      if(Number(x.id)<=3) return false;
      if(x.user_id&&x.user_id!==uid&&currentUser?.role!=='Superusuario') return false;
      return true;
    });

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

    console.info('Supabase Auth: historial cargado:',remote.length,'user_id:',uid);
    return true;
  }

  async function syncExistingLocalInspections(){
    if(!navigator.onLine) return false;
    const uid=authenticatedUserId();
    if(!uid) return false;
    if(typeof data==='undefined'||!Array.isArray(data)) return false;

    // Desde Supabase Auth, toda inspección nueva recibe user_id al crearse,
    // por lo que nunca reclamamos automáticamente registros históricos sin dueño.
    const candidates=data.filter(x=>
      Number(x.id)>3 &&
      x.user_id===uid
    );

    for(const inspection of candidates){
      try{
        await syncInspection(inspection);
      }catch(error){
        console.warn('No se pudo subir inspección local pendiente:',inspection?.id,error);
      }
    }
    if(typeof persist==='function') persist();
    return true;
  }

  function currentInspection(){
    if(typeof data==='undefined'||!Array.isArray(data)) return null;
    if(typeof currentId==='undefined'||currentId==null) return null;
    return data.find(x=>x.id===currentId)||null;
  }

  function isSuperuser(){
    return typeof currentUser!=='undefined'
      && currentUser
      && currentUser.role==='Superusuario';
  }

  async function markInspectionDeleted(x){
    if(!navigator.onLine) throw new Error('Sin conexión');
    if(!x) throw new Error('Inspección no encontrada');
    if(!authenticatedUserId()) throw new Error('Sesión no autenticada');

    await syncInspection(x);

    const stamp=new Date().toISOString();
    const response=await fetch(
      REST_URL+'/inspections?id=eq.'+encodeURIComponent(String(x.id)),
      {
        method:'PATCH',
        headers:await headers({
          'Content-Type':'application/json',
          'Prefer':'return=minimal'
        }),
        body:JSON.stringify({deleted_at:stamp,updated_at:stamp}),
        cache:'no-store'
      }
    );

    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('Supabase HTTP '+response.status+(detail?': '+detail:''));
    }
    return true;
  }

  window.deleteCurrentInspection=async function(){
    if(!isSuperuser()){
      if(typeof toast==='function') toast('Solo el Superusuario puede eliminar inspecciones');
      return;
    }

    const inspection=currentInspection();
    if(!inspection) return;
    if(!navigator.onLine){
      if(typeof toast==='function') toast('Necesitas conexión para eliminar una inspección');
      return;
    }

    const ok=confirm('¿Eliminar esta inspección?\n\nSe quitará de todos los dispositivos y no volverá a aparecer.');
    if(!ok) return;

    try{
      await markInspectionDeleted(inspection);
      data=data.filter(x=>String(x.id)!==String(inspection.id));
      if(typeof persist==='function') persist();
      if(typeof currentId!=='undefined') currentId=null;
      if(typeof renderHome==='function') renderHome();
      if(typeof renderInspections==='function') renderInspections();
      if(typeof renderReports==='function') renderReports();
      if(typeof go==='function') go('inspections');
      if(typeof toast==='function') toast('Inspección eliminada');
    }catch(error){
      console.warn('No se pudo eliminar la inspección:',error);
      if(typeof toast==='function') toast('No se pudo eliminar la inspección');
    }
  };

  const originalRenderDetail=window.renderDetail;
  if(typeof originalRenderDetail==='function'){
    window.renderDetail=function(){
      const result=originalRenderDetail.apply(this,arguments);
      if(isSuperuser()){
        const inspection=currentInspection();
        const host=document.getElementById('detailContent');
        if(inspection&&host&&!host.querySelector('#superuserDeleteInspection')){
          const button=document.createElement('button');
          button.id='superuserDeleteInspection';
          button.className='btn danger';
          button.style.cssText='width:100%;margin-top:16px;margin-bottom:10px';
          button.textContent='🗑 Eliminar inspección';
          button.onclick=window.deleteCurrentInspection;
          host.appendChild(button);
        }
      }
      return result;
    };
  }

  function wrapMutation(name){
    const original=window[name];
    if(typeof original!=='function') return;
    window[name]=function(){
      const result=original.apply(this,arguments);
      Promise.resolve(result).then(async()=>{
        const inspection=currentInspection();
        if(!inspection||!navigator.onLine||!authenticatedUserId()) return;
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
      if(!authenticatedUserId()){
        if(typeof toast==='function') toast('Debes iniciar sesión');
        return;
      }
      const idsBefore=new Set((typeof data!=='undefined'&&Array.isArray(data))?data.map(x=>x.id):[]);
      const result=originalSaveInspection.apply(this,arguments);

      Promise.resolve(result).then(async()=>{
        if(typeof data==='undefined'||!Array.isArray(data)) return;
        const created=data.find(x=>!idsBefore.has(x.id));
        if(!created) return;
        if(!created.user_id) created.user_id=authenticatedUserId();
        if(typeof persist==='function') persist();

        if(!navigator.onLine){
          if(typeof toast==='function') toast('Inspección guardada localmente. Se sincronizará al volver Internet');
          return;
        }

        try{
          await syncInspection(created);
          if(typeof toast==='function') toast('Inspección guardada en Supabase');
          console.info('Inspección sincronizada:',created.id,'user_id:',created.user_id);
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
    await window.IAPTIDUD_AUTH?.ready?.();
    if(!navigator.onLine||!authenticatedUserId()) return false;
    try{
      await loadInspections();
      await syncExistingLocalInspections();
      await loadInspections();
      return true;
    }catch(error){
      console.warn('Sincronización autenticada incompleta:',error);
      return false;
    }
  }

  window.addEventListener('online',initialSync);
  window.addEventListener('iaptidud-auth-changed',event=>{
    if(event.detail?.authenticated) initialSync();
  });

  window.IAPTIDUD_SUPABASE_SYNC={
    url:SUPABASE_URL,
    syncInspection,
    loadInspections,
    syncExistingLocalInspections,
    deleteInspection:markInspectionDeleted,
    refresh:initialSync
  };

  initialSync();
})();