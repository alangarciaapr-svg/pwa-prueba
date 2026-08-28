// Gestión privada de archivos pesados de Iaptidud supervision en Supabase Storage.
// Mantiene datos estructurados en Postgres y mueve fotos/firmas fuera de JSON/Base64.
(function(){
  'use strict';

  const BUCKET='iaptidud-files';
  const STORAGE_MARKER='storage://';
  const objectUrlCache=new Map();
  let exportWrapperInstalled=false;
  let clearSignWrapperInstalled=false;

  function currentUserSafe(){
    try{return typeof currentUser!=='undefined'?currentUser:null}catch(e){return null}
  }

  function currentInspection(){
    try{
      if(typeof data==='undefined'||!Array.isArray(data)||typeof currentId==='undefined') return null;
      return data.find(x=>String(x.id)===String(currentId))||null;
    }catch(e){return null}
  }

  function userId(){
    return window.IAPTIDUD_AUTH?.getUserId?.()||currentUserSafe()?.id||null;
  }

  function isDataUrl(value){return typeof value==='string'&&value.startsWith('data:')}
  function isStorageMarker(value){return typeof value==='string'&&value.startsWith(STORAGE_MARKER)}
  function marker(path){return path?STORAGE_MARKER+path:null}
  function pathFromMarker(value){return isStorageMarker(value)?value.slice(STORAGE_MARKER.length):null}

  function encodePath(path){
    return String(path||'').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  function mimeFromDataUrl(value){
    const match=String(value||'').match(/^data:([^;,]+)[;,]/i);
    return match?.[1]?.toLowerCase()||'application/octet-stream';
  }

  function extensionForMime(mime){
    if(mime==='image/jpeg') return 'jpg';
    if(mime==='image/webp') return 'webp';
    if(mime==='application/pdf') return 'pdf';
    return 'png';
  }

  function safePart(value){
    return String(value??'item').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'item';
  }

  function buildPath(owner,kind,inspectionId,itemId,mime){
    return [
      safePart(owner),
      safePart(kind),
      safePart(inspectionId),
      safePart(itemId)+'.'+extensionForMime(mime)
    ].join('/');
  }

  async function authHeaders(extra={}){
    const token=await window.IAPTIDUD_AUTH?.getAccessToken?.();
    if(!token) throw new Error('Sesión no autenticada');
    return {
      'apikey':SUPABASE_ANON_KEY,
      'Authorization':'Bearer '+token,
      ...extra
    };
  }

  async function dataUrlToBlob(value){
    const response=await fetch(value);
    if(!response.ok) throw new Error('No se pudo preparar el archivo');
    return await response.blob();
  }

  function blobToDataUrl(blob){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(reader.error||new Error('No se pudo leer el archivo'));
      reader.readAsDataURL(blob);
    });
  }

  async function createSignedUrl(path,expiresIn=604800){
    const response=await fetch(
      SUPABASE_URL+'/storage/v1/object/sign/'+BUCKET+'/'+encodePath(path),
      {
        method:'POST',
        headers:await authHeaders({'Content-Type':'application/json','Accept':'application/json'}),
        body:JSON.stringify({expiresIn}),
        cache:'no-store'
      }
    );
    if(!response.ok){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('No se pudo autorizar archivo'+(detail?': '+detail:''));
    }
    const body=await response.json();
    const signed=body?.signedURL||body?.signedUrl||body?.signed_url;
    if(!signed) throw new Error('Supabase no devolvió URL firmada');
    return /^https?:\/\//i.test(signed)?signed:SUPABASE_URL+signed;
  }

  async function blobUrlForPath(path,force=false){
    if(!path) return null;
    if(!force&&objectUrlCache.has(path)) return objectUrlCache.get(path).url;
    const signed=await createSignedUrl(path);
    const response=await fetch(signed,{cache:'no-store'});
    if(!response.ok) throw new Error('No se pudo descargar archivo de Storage');
    const blob=await response.blob();
    const url=URL.createObjectURL(blob);
    const previous=objectUrlCache.get(path);
    if(previous?.url) try{URL.revokeObjectURL(previous.url)}catch(e){}
    objectUrlCache.set(path,{url,blob});
    return url;
  }

  async function uploadDataUrl(value,path){
    if(!isDataUrl(value)) throw new Error('Archivo no válido');
    const blob=await dataUrlToBlob(value);
    const response=await fetch(
      SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+encodePath(path),
      {
        method:'POST',
        headers:await authHeaders({
          'Content-Type':blob.type||mimeFromDataUrl(value),
          'x-upsert':'false'
        }),
        body:blob,
        cache:'no-store'
      }
    );

    if(!response.ok&&response.status!==400&&response.status!==409){
      let detail='';
      try{detail=await response.text()}catch(e){}
      throw new Error('No se pudo subir archivo a Storage'+(detail?': '+detail:''));
    }

    return await blobUrlForPath(path,true);
  }

  async function removeObject(path){
    if(!path||!navigator.onLine) return false;
    try{
      const response=await fetch(
        SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+encodePath(path),
        {method:'DELETE',headers:await authHeaders(),cache:'no-store'}
      );
      if(response.ok||response.status===404){
        const cached=objectUrlCache.get(path);
        if(cached?.url) try{URL.revokeObjectURL(cached.url)}catch(e){}
        objectUrlCache.delete(path);
        return true;
      }
    }catch(e){}
    return false;
  }

  async function prepareMediaItem(item,owner,kind,inspectionId){
    if(!item||typeof item!=='object') return false;
    let changed=false;

    if(isDataUrl(item.photo)){
      const mime=mimeFromDataUrl(item.photo);
      const path=item.storage_path||buildPath(owner,kind,inspectionId,item.id||Date.now(),mime);
      const url=await uploadDataUrl(item.photo,path);
      item.storage_path=path;
      item.photo=url;
      changed=true;
    }else if(item.storage_path&&(!item.photo||isStorageMarker(item.photo))){
      try{item.photo=await blobUrlForPath(item.storage_path)}catch(error){
        console.warn('No se pudo cargar archivo',item.storage_path,error);
      }
    }

    return changed;
  }

  async function prepareInspection(inspection){
    if(!inspection||!navigator.onLine) return false;
    const owner=inspection.user_id||userId();
    if(!owner) return false;
    let changed=false;

    const findings=Array.isArray(inspection.findingItems)?inspection.findingItems:[];
    for(const item of findings){
      try{if(await prepareMediaItem(item,owner,'hallazgos',inspection.id)) changed=true}
      catch(error){console.warn('Hallazgo pendiente de Storage:',inspection.id,item?.id,error)}
    }

    const evidence=Array.isArray(inspection.evidenceItems)?inspection.evidenceItems:[];
    for(const item of evidence){
      try{if(await prepareMediaItem(item,owner,'evidencias',inspection.id)) changed=true}
      catch(error){console.warn('Evidencia pendiente de Storage:',inspection.id,item?.id,error)}
    }

    if(isDataUrl(inspection.signature)){
      const oldPath=inspection.signature_path||null;
      const mime=mimeFromDataUrl(inspection.signature);
      const path=buildPath(owner,'firmas',inspection.id,'firma-'+Date.now(),mime);
      try{
        const url=await uploadDataUrl(inspection.signature,path);
        inspection.signature_path=path;
        inspection.signature=url;
        changed=true;
        if(oldPath&&oldPath!==path) removeObject(oldPath);
      }catch(error){
        console.warn('Firma pendiente de Storage:',inspection.id,error);
      }
    }else{
      const signaturePath=inspection.signature_path||pathFromMarker(inspection.signature);
      if(signaturePath){
        inspection.signature_path=signaturePath;
        if(!inspection.signature||isStorageMarker(inspection.signature)){
          try{inspection.signature=await blobUrlForPath(signaturePath)}catch(error){
            console.warn('No se pudo cargar firma:',inspection.id,error);
          }
        }
      }
    }

    if(changed&&typeof persist==='function') persist();
    return changed;
  }

  async function hydrateInspection(inspection){
    if(!inspection||!navigator.onLine) return inspection;
    const findings=Array.isArray(inspection.findingItems)?inspection.findingItems:[];
    const evidence=Array.isArray(inspection.evidenceItems)?inspection.evidenceItems:[];

    await Promise.all([...findings,...evidence].map(async item=>{
      if(item?.storage_path){
        try{item.photo=await blobUrlForPath(item.storage_path)}catch(error){
          console.warn('Archivo de Storage no disponible:',item.storage_path,error);
        }
      }
    }));

    const signaturePath=inspection.signature_path||pathFromMarker(inspection.signature);
    if(signaturePath){
      inspection.signature_path=signaturePath;
      try{inspection.signature=await blobUrlForPath(signaturePath)}catch(error){
        console.warn('Firma de Storage no disponible:',signaturePath,error);
      }
    }
    return inspection;
  }

  function mediaItemsForDatabase(items){
    return (Array.isArray(items)?items:[]).map(item=>{
      const out={...item};
      if(out.storage_path) delete out.photo;
      return out;
    });
  }

  function signatureForDatabase(inspection){
    const path=inspection?.signature_path||pathFromMarker(inspection?.signature);
    if(path) return marker(path);
    return inspection?.signature||null;
  }

  function applySignatureFromDatabase(target,value){
    const path=pathFromMarker(value);
    if(path){
      target.signature_path=path;
      target.signature=marker(path);
    }else if(value){
      target.signature=value;
    }
    return target;
  }

  function installPersistWrapper(){
    const original=window.persist;
    if(typeof original!=='function'||original.__storagePersistWrapped) return;

    const wrapped=function(){
      const restores=[];
      try{
        if(typeof data!=='undefined'&&Array.isArray(data)){
          data.forEach(x=>{
            [...(Array.isArray(x.findingItems)?x.findingItems:[]),...(Array.isArray(x.evidenceItems)?x.evidenceItems:[])].forEach(item=>{
              if(item?.storage_path&&item.photo&&!isStorageMarker(item.photo)){
                restores.push([item,'photo',item.photo]);
                item.photo=marker(item.storage_path);
              }
            });
            if(x?.signature_path&&x.signature&&!isStorageMarker(x.signature)){
              restores.push([x,'signature',x.signature]);
              x.signature=marker(x.signature_path);
            }
          });
        }
        return original.apply(this,arguments);
      }finally{
        restores.forEach(([obj,key,value])=>{obj[key]=value});
      }
    };
    wrapped.__storagePersistWrapped=true;
    window.persist=wrapped;
  }

  async function dataUrlForTransient(value,path){
    if(isDataUrl(value)) return value;
    let blob=null;
    if(path&&objectUrlCache.has(path)) blob=objectUrlCache.get(path).blob;
    if(!blob&&path){
      const signed=await createSignedUrl(path);
      const response=await fetch(signed,{cache:'no-store'});
      if(response.ok) blob=await response.blob();
    }
    if(blob) return await blobToDataUrl(blob);
    if(typeof value==='string'&&value.startsWith('blob:')){
      const response=await fetch(value);
      if(response.ok) return await blobToDataUrl(await response.blob());
    }
    return value;
  }

  function installPdfWrapper(){
    if(exportWrapperInstalled) return;
    const original=window.exportCompletedPDF;
    if(typeof original!=='function') return;
    exportWrapperInstalled=true;

    window.exportCompletedPDF=async function(){
      const restores=[];
      try{
        const rows=(typeof data!=='undefined'&&Array.isArray(data))?data.filter(x=>x.status==='completada'):[];
        for(const x of rows){
          for(const item of [...(Array.isArray(x.findingItems)?x.findingItems:[]),...(Array.isArray(x.evidenceItems)?x.evidenceItems:[])]){
            if(item?.storage_path){
              restores.push([item,'photo',item.photo]);
              item.photo=await dataUrlForTransient(item.photo,item.storage_path);
            }
          }
          if(x?.signature_path){
            restores.push([x,'signature',x.signature]);
            x.signature=await dataUrlForTransient(x.signature,x.signature_path);
          }
        }
        return await original.apply(this,arguments);
      }finally{
        restores.forEach(([obj,key,value])=>{obj[key]=value});
      }
    };
  }

  function installClearSignWrapper(){
    if(clearSignWrapperInstalled) return;
    const original=window.clearSign;
    if(typeof original!=='function') return;
    clearSignWrapperInstalled=true;

    window.clearSign=async function(){
      const before=currentInspection();
      const oldPath=before?.signature_path||pathFromMarker(before?.signature);
      const result=await original.apply(this,arguments);
      const after=currentInspection();
      if(after&&oldPath){
        delete after.signature_path;
        if(after.signature&&isStorageMarker(after.signature)) delete after.signature;
        if(typeof updateInspectionStatus==='function') updateInspectionStatus(after);
        if(typeof persist==='function') persist();
        removeObject(oldPath);
      }
      return result;
    };
  }

  function installWrappers(){
    installPersistWrapper();
    installPdfWrapper();
    installClearSignWrapper();
  }

  function releaseObjectUrls(){
    objectUrlCache.forEach(entry=>{try{URL.revokeObjectURL(entry.url)}catch(e){}});
    objectUrlCache.clear();
  }

  window.IAPTIDUD_STORAGE={
    bucket:BUCKET,
    marker,
    pathFromMarker,
    isDataUrl,
    prepareInspection,
    hydrateInspection,
    mediaItemsForDatabase,
    signatureForDatabase,
    applySignatureFromDatabase,
    createSignedUrl,
    removeObject,
    installWrappers,
    releaseObjectUrls
  };

  installWrappers();
  window.addEventListener('online',()=>setTimeout(installWrappers,0));
  window.addEventListener('iaptidud-auth-changed',event=>{
    if(event.detail?.authenticated){
      setTimeout(installWrappers,0);
    }else{
      releaseObjectUrls();
    }
  });
  window.addEventListener('iaptidud-auth-ready',()=>setTimeout(installWrappers,0));
})();