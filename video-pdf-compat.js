// Compatibilidad de evidencias audiovisuales con el PDF existente.
// El video permanece en Storage/PWA; el PDF incluye su referencia descriptiva sin incrustar el archivo pesado.
(function(){
  'use strict';

  const original=window.exportCompletedPDF;
  if(typeof original!=='function') return;

  function durationLabel(seconds){
    const total=Math.max(0,Math.round(Number(seconds)||0));
    return String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');
  }
  function sizeLabel(bytes){
    const n=Number(bytes||0);
    if(!n) return '';
    return n>=1048576?(n/1048576).toFixed(1)+' MB':(n/1024).toFixed(1)+' KB';
  }

  window.exportCompletedPDF=async function(){
    const restores=[];
    try{
      const rows=(typeof data!=='undefined'&&Array.isArray(data))?data.filter(x=>x.status==='completada'):[];
      rows.forEach(x=>{
        (Array.isArray(x.evidenceItems)?x.evidenceItems:[]).forEach(item=>{
          const isVideo=item?.media_type==='video'||String(item?.mime_type||'').startsWith('video/');
          if(!isVideo) return;
          restores.push([item,item.photo,item.description]);
          // Evita que el generador existente intente dibujar un video como <img>.
          item.photo=null;
          const meta=[durationLabel(item.duration),sizeLabel(item.file_size)].filter(Boolean).join(' · ');
          const originalDescription=String(item.description||'').trim();
          item.description='🎥 Evidencia audiovisual'+(meta?' · '+meta:'')+(originalDescription?' — '+originalDescription:'')+'. Video disponible en Iaptidud supervision.';
        });
      });
      return await original.apply(this,arguments);
    }finally{
      restores.forEach(([item,photo,description])=>{
        item.photo=photo;
        item.description=description;
      });
    }
  };
})();
