// Evidencias en video optimizadas para Iaptidud supervision.
// Máximo 60 s, compresión local a 720p aprox., Storage privado y cola offline en IndexedDB.
(function(){
  'use strict';

  const BUCKET='iaptidud-files';
  const MAX_DURATION=60.05;
  const VIDEO_BITRATE=1800000;
  const AUDIO_BITRATE=96000;
  const MAX_WIDTH=1280;
  const MAX_HEIGHT=720;
  const DIRECT_UPLOAD_LIMIT=16*1024*1024;
  const DB_NAME='iaptidud-media-v1';
  const STORE_NAME='pending-videos';
  const localVideoUrls=new Map();
  let syncing=false;

  const originalOpenEntrySheet=window.openEntrySheet;
  const originalSaveEvidence=window.saveEvidence;
  const originalRenderEvidenceItems=window.renderEvidenceItems;

  function toastSafe(msg){if(typeof toast==='function') toast(msg);}
  function escSafe(value){return typeof esc==='function'?esc(value):String(value??'').replace(/[&<>"']/g,'');}
  function uid(){return window.IAPTIDUD_AUTH?.getUserId?.()||window.currentUser?.id||null;}
  function currentInspectionSafe(){
    if(typeof data==='undefined'||!Array.isArray(data)||typeof currentId==='undefined') return null;
    return data.find(x=>String(x.id)===String(currentId))||null;
  }
  function safePart(value){return String(value??'item').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'item';}
  function encodePath(path){return String(path||'').split('/').filter(Boolean).map(encodeURIComponent).join('/');}
  function extensionForMime(mime){
    if((mime||'').includes('mp4')) return 'mp4';
    if((mime||'').includes('quicktime')) return 'mov';
    return 'webm';
  }
  function formatBytes(bytes){
    const n=Number(bytes||0);
    if(n<1024) return n+' B';
    if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
    return (n/(1024*1024)).toFixed(1)+' MB';
  }
  function formatDuration(seconds){
    const total=Math.max(0,Math.round(Number(seconds)||0));
    return String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');
  }

  async function authHeaders(extra={}){
    const token=await window.IAPTIDUD_AUTH?.getAccessToken?.();
    if(!token) throw new Error('Sesión no autenticada');
    return {'apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token,...extra};
  }

  function openDb(){
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('No se pudo abrir almacenamiento offline'));
    });
  }
  async function idbPut(key,blob){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_NAME,'readwrite');
      tx.objectStore(STORE_NAME).put(blob,key);
      tx.oncomplete=()=>{db.close();resolve(true)};
      tx.onerror=()=>{db.close();reject(tx.error)};
    });
  }
  async function idbGet(key){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_NAME,'readonly');
      const req=tx.objectStore(STORE_NAME).get(key);
      req.onsuccess=()=>resolve(req.result||null);
      req.onerror=()=>reject(req.error);
      tx.oncomplete=()=>db.close();
    });
  }
  async function idbDelete(key){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_NAME,'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete=()=>{db.close();resolve(true)};
      tx.onerror=()=>{db.close();reject(tx.error)};
    });
  }

  function readVideoMeta(file){
    return new Promise((resolve,reject)=>{
      const video=document.createElement('video');
      const url=URL.createObjectURL(file);
      video.preload='metadata';
      video.muted=true;
      video.onloadedmetadata=()=>{
        const meta={duration:video.duration||0,width:video.videoWidth||0,height:video.videoHeight||0};
        URL.revokeObjectURL(url);resolve(meta);
      };
      video.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('No se pudo leer el video seleccionado'))};
      video.src=url;
    });
  }

  function supportedRecorderMime(){
    if(typeof MediaRecorder==='undefined') return null;
    const candidates=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
    return candidates.find(t=>MediaRecorder.isTypeSupported?.(t))||'';
  }

  async function compressVideo(file,meta,onProgress){
    // Si ya pesa poco, conservar original evita pérdida generacional innecesaria.
    if(file.size<=DIRECT_UPLOAD_LIMIT && meta.width<=MAX_WIDTH && meta.height<=MAX_HEIGHT){
      onProgress?.(100,'El video ya está optimizado');
      return {blob:file,compressed:false};
    }

    const recorderMime=supportedRecorderMime();
    if(recorderMime===null) throw new Error('Este navegador no permite comprimir video localmente');
    if(!HTMLCanvasElement.prototype.captureStream) throw new Error('Este navegador no permite optimizar video localmente');

    const sourceUrl=URL.createObjectURL(file);
    const video=document.createElement('video');
    video.src=sourceUrl;
    video.preload='auto';
    video.playsInline=true;
    video.muted=true;

    await new Promise((resolve,reject)=>{
      video.oncanplay=resolve;
      video.onerror=()=>reject(new Error('No se pudo preparar el video'));
      video.load();
    });

    const scale=Math.min(1,MAX_WIDTH/(video.videoWidth||MAX_WIDTH),MAX_HEIGHT/(video.videoHeight||MAX_HEIGHT));
    let width=Math.max(2,Math.round((video.videoWidth||MAX_WIDTH)*scale));
    let height=Math.max(2,Math.round((video.videoHeight||MAX_HEIGHT)*scale));
    if(width%2) width--;
    if(height%2) height--;

    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{alpha:false});
    const outputStream=canvas.captureStream(30);
    let sourceStream=null;
    let audioContext=null;

    try{
      const capture=video.captureStream||video.mozCaptureStream;
      if(capture){
        sourceStream=capture.call(video);
        sourceStream.getAudioTracks().forEach(track=>outputStream.addTrack(track));
      }else if(window.AudioContext||window.webkitAudioContext){
        const AC=window.AudioContext||window.webkitAudioContext;
        audioContext=new AC();
        const src=audioContext.createMediaElementSource(video);
        const destination=audioContext.createMediaStreamDestination();
        src.connect(destination);
        destination.stream.getAudioTracks().forEach(track=>outputStream.addTrack(track));
      }
    }catch(error){
      console.warn('Audio de compresión no disponible:',error);
    }

    const chunks=[];
    const options={videoBitsPerSecond:VIDEO_BITRATE,audioBitsPerSecond:AUDIO_BITRATE};
    if(recorderMime) options.mimeType=recorderMime;
    const recorder=new MediaRecorder(outputStream,options);
    recorder.ondataavailable=e=>{if(e.data&&e.data.size) chunks.push(e.data)};

    let raf=0;
    const draw=()=>{
      if(!video.paused&&!video.ended){
        ctx.drawImage(video,0,0,width,height);
        const pct=Math.min(99,Math.round((video.currentTime/Math.max(meta.duration,.1))*100));
        onProgress?.(pct,'Optimizando video… '+pct+'%');
        raf=requestAnimationFrame(draw);
      }
    };

    const stopped=new Promise((resolve,reject)=>{
      recorder.onstop=resolve;
      recorder.onerror=e=>reject(e.error||new Error('Falló la compresión del video'));
    });

    try{
      recorder.start(1000);
      await video.play();
      draw();
      await new Promise(resolve=>{video.onended=resolve;});
      if(recorder.state!=='inactive') recorder.stop();
      await stopped;
    }finally{
      cancelAnimationFrame(raf);
      video.pause();
      outputStream.getTracks().forEach(t=>t.stop());
      sourceStream?.getTracks?.().forEach(t=>t.stop());
      if(audioContext) try{await audioContext.close()}catch(e){}
      URL.revokeObjectURL(sourceUrl);
    }

    if(!chunks.length) throw new Error('No se pudo generar el video optimizado');
    const type=(recorderMime||chunks[0].type||'video/webm').split(';')[0];
    const compressed=new Blob(chunks,{type});
    // Nunca empeorar el peso ni la calidad si el original ya era mejor.
    if(compressed.size>=file.size && file.size<=25*1024*1024){
      onProgress?.(100,'Se conservará el original por ser más eficiente');
      return {blob:file,compressed:false};
    }
    onProgress?.(100,'Video optimizado');
    return {blob:compressed,compressed:true};
  }

  async function uploadBlob(blob,path,onProgress){
    onProgress?.(5,'Subiendo evidencia…');
    const response=await fetch(SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+encodePath(path),{
      method:'POST',
      headers:await authHeaders({'Content-Type':blob.type||'video/webm','x-upsert':'false'}),
      body:blob,
      cache:'no-store'
    });
    if(!response.ok&&response.status!==400&&response.status!==409){
      let detail='';try{detail=await response.text()}catch(e){}
      throw new Error('No se pudo subir video a Storage'+(detail?': '+detail:''));
    }
    onProgress?.(100,'Evidencia subida');
    return path;
  }

  async function signedBlobUrl(path){
    if(window.IAPTIDUD_STORAGE?.createSignedUrl){
      const signed=await window.IAPTIDUD_STORAGE.createSignedUrl(path);
      const res=await fetch(signed,{cache:'no-store'});
      if(!res.ok) throw new Error('No se pudo cargar video');
      return URL.createObjectURL(await res.blob());
    }
    return null;
  }

  function evidenceEditorHtml(){
    return `
      <div class="field">
        <label>Tipo de evidencia</label>
        <select id="evidenceMediaType" onchange="IAPTIDUD_VIDEO.switchType(this.value)">
          <option value="photo">📷 Fotografía</option>
          <option value="video">🎥 Video</option>
        </select>
      </div>
      <div id="evidencePhotoBox">
        <div class="field"><label>Fotografía</label><input id="evidencePhoto" type="file" accept="image/*" capture="environment" onchange="previewSelectedPhoto(this,'evidencePhotoPreview')"><img id="evidencePhotoPreview" class="photo-preview hidden" alt="Vista previa"></div>
      </div>
      <div id="evidenceVideoBox" class="hidden">
        <div class="field"><label>Video (máximo 1 minuto)</label><input id="evidenceVideo" type="file" accept="video/*" capture="environment" onchange="IAPTIDUD_VIDEO.preview(this)"></div>
        <video id="evidenceVideoPreview" class="photo-preview hidden" controls playsinline preload="metadata" style="width:100%;max-height:320px;background:#000"></video>
        <div id="videoFileInfo" class="small" style="margin-top:8px"></div>
        <div id="videoProgressBox" class="hidden" style="margin-top:10px">
          <div class="progress"><i id="videoProgressBar" style="width:0%"></i></div>
          <div id="videoProgressText" class="small" style="margin-top:5px">Preparando video…</div>
        </div>
        <p class="small" style="margin-top:8px">La PWA optimiza el video antes de subirlo, manteniendo una calidad adecuada para supervisión.</p>
      </div>
      <div class="field"><label>Descripción opcional</label><textarea id="evidenceDescription" placeholder="Ej: Evidencia del estado observado"></textarea></div>
      <button id="saveEvidenceBtn" class="btn primary" style="width:100%" onclick="saveEvidence()">Guardar evidencia</button>`;
  }

  if(typeof originalOpenEntrySheet==='function'){
    window.openEntrySheet=function(kind){
      const result=originalOpenEntrySheet.apply(this,arguments);
      if(kind==='evidence'){
        const body=document.getElementById('sheetBody');
        if(body) body.innerHTML=evidenceEditorHtml();
      }
      return result;
    };
  }

  function setProgress(percent,text){
    const box=document.getElementById('videoProgressBox');
    const bar=document.getElementById('videoProgressBar');
    const label=document.getElementById('videoProgressText');
    if(box) box.classList.remove('hidden');
    if(bar) bar.style.width=Math.max(0,Math.min(100,percent||0))+'%';
    if(label&&text) label.textContent=text;
  }

  async function saveVideoEvidence(){
    const x=currentInspectionSafe();
    if(!x) return;
    const input=document.getElementById('evidenceVideo');
    const file=input?.files?.[0];
    const description=document.getElementById('evidenceDescription')?.value?.trim()||'';
    if(!file){toastSafe('Selecciona o graba un video');return;}

    const button=document.getElementById('saveEvidenceBtn');
    if(button){button.disabled=true;button.textContent='Procesando video…';}

    try{
      const meta=await readVideoMeta(file);
      if(!Number.isFinite(meta.duration)||meta.duration<=0) throw new Error('No se pudo determinar la duración del video');
      if(meta.duration>MAX_DURATION){
        throw new Error('El video no puede superar 1 minuto');
      }

      setProgress(1,'Preparando video…');
      const optimized=await compressVideo(file,meta,setProgress);
      const blob=optimized.blob;
      if(blob.size>25*1024*1024) throw new Error('El video optimizado supera 25 MB. Graba un video más corto o con menor resolución.');

      const itemId=Date.now();
      const owner=x.user_id||uid();
      if(!owner) throw new Error('Sesión no autenticada');
      const path=[safePart(owner),'evidencias',safePart(x.id),safePart(itemId)+'.'+extensionForMime(blob.type)].join('/');
      const pendingKey='video:'+safePart(owner)+':'+safePart(x.id)+':'+safePart(itemId);
      let mediaUrl=URL.createObjectURL(blob);
      localVideoUrls.set(pendingKey,mediaUrl);

      const item={
        id:itemId,
        description,
        media_type:'video',
        mime_type:blob.type||'video/webm',
        duration:Number(meta.duration.toFixed(2)),
        file_size:blob.size,
        original_size:file.size,
        compressed:Boolean(optimized.compressed),
        photo:mediaUrl
      };

      if(navigator.onLine){
        setProgress(5,'Subiendo evidencia…');
        await uploadBlob(blob,path,setProgress);
        item.storage_path=path;
        delete item.pending_blob_id;
      }else{
        await idbPut(pendingKey,blob);
        item.pending_blob_id=pendingKey;
        toastSafe('Video guardado offline. Se subirá al recuperar Internet');
      }

      x.evidenceItems=Array.isArray(x.evidenceItems)?x.evidenceItems:[];
      x.evidenceItems.push(item);
      x.evidence=x.evidenceItems.length;
      if(typeof updateInspectionStatus==='function') updateInspectionStatus(x);
      if(typeof persist==='function') persist();
      if(typeof closeEntrySheet==='function') closeEntrySheet();
      if(typeof renderDetail==='function') renderDetail();
      if(typeof renderHome==='function') renderHome();
      toastSafe(optimized.compressed?'Video optimizado y guardado':'Video guardado');
    }catch(error){
      console.warn('No se pudo guardar evidencia en video:',error);
      toastSafe(error?.message||'No se pudo procesar el video');
    }finally{
      if(button){button.disabled=false;button.textContent='Guardar evidencia';}
    }
  }

  if(typeof originalSaveEvidence==='function'){
    window.saveEvidence=async function(){
      const type=document.getElementById('evidenceMediaType')?.value||'photo';
      if(type==='video') return await saveVideoEvidence();
      return await originalSaveEvidence.apply(this,arguments);
    };
  }

  window.renderEvidenceItems=function(x){
    const items=Array.isArray(x?.evidenceItems)?x.evidenceItems:[];
    if(!items.length) return '';
    return `<div class="section-title" style="margin-top:18px"><h2>Evidencias registradas</h2><span class="small">${items.length}</span></div><div class="item-list">${items.map(i=>{
      const isVideo=i.media_type==='video'||String(i.mime_type||'').startsWith('video/');
      const media=i.photo||'';
      if(isVideo){
        const status=i.pending_blob_id?' · pendiente de sincronizar':'';
        return `<div class="item-card">${media?`<video class="photo-preview" src="${escSafe(media)}" controls playsinline preload="metadata" style="width:100%;max-height:340px;background:#000"></video>`:'<div class="small">🎥 Video almacenado en Supabase Storage</div>'}<div class="small" style="margin-top:7px">🎥 ${formatDuration(i.duration)} · ${formatBytes(i.file_size)}${status}</div>${i.description?`<p class="small">${escSafe(i.description)}</p>`:''}</div>`;
      }
      return `<div class="item-card">${media?`<img class="photo-preview" src="${escSafe(media)}" alt="Evidencia fotográfica">`:''}${i.description?`<p class="small">${escSafe(i.description)}</p>`:''}</div>`;
    }).join('')}</div>`;
  };

  async function hydratePendingItem(item){
    if(!item?.pending_blob_id) return false;
    try{
      const blob=await idbGet(item.pending_blob_id);
      if(!blob) return false;
      if(!item.photo||!String(item.photo).startsWith('blob:')){
        const old=localVideoUrls.get(item.pending_blob_id);
        if(old) try{URL.revokeObjectURL(old)}catch(e){}
        item.photo=URL.createObjectURL(blob);
        localVideoUrls.set(item.pending_blob_id,item.photo);
      }
      return true;
    }catch(e){return false;}
  }

  async function syncPendingVideos(){
    if(syncing||!navigator.onLine||!uid()||typeof data==='undefined'||!Array.isArray(data)) return;
    syncing=true;
    try{
      for(const x of data){
        const items=Array.isArray(x.evidenceItems)?x.evidenceItems:[];
        for(const item of items){
          if(!item?.pending_blob_id||item.storage_path) continue;
          try{
            const blob=await idbGet(item.pending_blob_id);
            if(!blob) continue;
            const path=[safePart(x.user_id||uid()),'evidencias',safePart(x.id),safePart(item.id)+'.'+extensionForMime(blob.type)].join('/');
            await uploadBlob(blob,path);
            item.storage_path=path;
            const key=item.pending_blob_id;
            delete item.pending_blob_id;
            await idbDelete(key);
            if(typeof persist==='function') persist();
            if(window.IAPTIDUD_SUPABASE_SYNC?.syncInspection) await window.IAPTIDUD_SUPABASE_SYNC.syncInspection(x);
          }catch(error){console.warn('Video offline pendiente:',x?.id,item?.id,error);}
        }
      }
      if(typeof renderDetail==='function'&&document.querySelector('.view.active')?.id==='detail') renderDetail();
    }finally{syncing=false;}
  }

  async function hydratePendingVideos(){
    if(typeof data==='undefined'||!Array.isArray(data)) return;
    let changed=false;
    for(const x of data){
      for(const item of (Array.isArray(x.evidenceItems)?x.evidenceItems:[])){
        if(await hydratePendingItem(item)) changed=true;
      }
    }
    if(changed&&document.querySelector('.view.active')?.id==='detail'&&typeof renderDetail==='function') renderDetail();
  }

  window.IAPTIDUD_VIDEO={
    maxDuration:60,
    videoBitrate:VIDEO_BITRATE,
    audioBitrate:AUDIO_BITRATE,
    switchType(type){
      document.getElementById('evidencePhotoBox')?.classList.toggle('hidden',type!=='photo');
      document.getElementById('evidenceVideoBox')?.classList.toggle('hidden',type!=='video');
    },
    async preview(input){
      const file=input?.files?.[0];
      const preview=document.getElementById('evidenceVideoPreview');
      const info=document.getElementById('videoFileInfo');
      if(!file){if(preview) preview.classList.add('hidden');if(info) info.textContent='';return;}
      try{
        const meta=await readVideoMeta(file);
        if(meta.duration>MAX_DURATION){
          input.value='';
          if(preview){preview.src='';preview.classList.add('hidden');}
          if(info) info.textContent='';
          toastSafe('El video no puede superar 1 minuto');
          return;
        }
        if(preview){
          if(preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
          const url=URL.createObjectURL(file);preview.dataset.objectUrl=url;preview.src=url;preview.classList.remove('hidden');
        }
        if(info) info.textContent=`Duración ${formatDuration(meta.duration)} · Original ${formatBytes(file.size)} · ${meta.width}×${meta.height}`;
      }catch(error){toastSafe(error?.message||'No se pudo leer el video');}
    },
    syncPending:syncPendingVideos
  };

  setTimeout(hydratePendingVideos,0);
  setTimeout(syncPendingVideos,1200);
  window.addEventListener('online',()=>setTimeout(syncPendingVideos,500));
  window.addEventListener('iaptidud-auth-changed',event=>{if(event.detail?.authenticated){setTimeout(hydratePendingVideos,0);setTimeout(syncPendingVideos,1000);}});
  window.addEventListener('beforeunload',()=>localVideoUrls.forEach(url=>{try{URL.revokeObjectURL(url)}catch(e){}}));
})();
