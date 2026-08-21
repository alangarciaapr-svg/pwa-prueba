// Instalación real de Iaptidud supervision en dispositivos móviles.
// Captura beforeinstallprompt lo antes posible y entrega instrucciones útiles
// cuando el navegador no permite abrir el prompt nativo directamente.
(function(){
  'use strict';

  let deferredInstallPrompt = null;
  let promptWaiters = [];

  function isStandalone(){
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  function isIOS(){
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isInAppBrowser(){
    return /FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent) ||
      /wv\)/i.test(navigator.userAgent);
  }

  function notify(message){
    if(typeof window.toast === 'function'){
      window.toast(message);
    }else{
      console.info(message);
    }
  }

  function settlePromptWaiters(value){
    const waiters = promptWaiters.slice();
    promptWaiters = [];
    waiters.forEach(resolve => resolve(value));
  }

  window.addEventListener('beforeinstallprompt', function(event){
    event.preventDefault();
    deferredInstallPrompt = event;
    settlePromptWaiters(event);
    document.documentElement.dataset.pwaInstallReady = 'true';
  });

  window.addEventListener('appinstalled', function(){
    deferredInstallPrompt = null;
    document.documentElement.dataset.pwaInstalled = 'true';
    hideInstallCard();
    notify('Iaptidud supervision instalada correctamente');
  });

  function waitForInstallPrompt(timeout){
    if(deferredInstallPrompt) return Promise.resolve(deferredInstallPrompt);

    return new Promise(function(resolve){
      let settled = false;
      const finish = function(value){
        if(settled) return;
        settled = true;
        resolve(value || null);
      };

      promptWaiters.push(finish);
      setTimeout(function(){
        const index = promptWaiters.indexOf(finish);
        if(index >= 0) promptWaiters.splice(index, 1);
        finish(null);
      }, timeout || 2500);
    });
  }

  function hideInstallCard(){
    const button = document.querySelector('.install button[onclick="fakeInstall()"]');
    if(button && button.closest('.install')){
      button.closest('.install').style.display = 'none';
    }
  }

  function closeInstallHelp(){
    const overlay = document.getElementById('pwaInstallHelp');
    if(overlay) overlay.remove();
  }

  function showInstallHelp(){
    closeInstallHelp();

    let title = 'Instalar Iaptidud supervision';
    let instructions = '';

    if(isInAppBrowser()){
      instructions = '<b>Abre esta página en el navegador del teléfono.</b><br><br>' +
        'En Android usa Chrome. En iPhone/iPad usa Safari. Luego vuelve a presionar <b>Instalar</b>.';
    }else if(isIOS()){
      instructions = '<b>En iPhone o iPad:</b><br><br>' +
        '1. Toca el botón <b>Compartir</b> (cuadrado con flecha hacia arriba).<br>' +
        '2. Elige <b>Añadir a pantalla de inicio</b>.<br>' +
        '3. Toca <b>Añadir</b>.<br><br>' +
        'Si esa opción no aparece, abre esta misma dirección en Safari.';
    }else{
      instructions = '<b>En Android:</b><br><br>' +
        '1. Abre esta página en Chrome.<br>' +
        '2. Toca el menú <b>⋮</b>.<br>' +
        '3. Elige <b>Instalar app</b> o <b>Añadir a pantalla de inicio</b>.<br><br>' +
        'Si acabas de abrir la aplicación por primera vez, espera unos segundos y vuelve a presionar <b>Instalar</b>.';
    }

    const overlay = document.createElement('div');
    overlay.id = 'pwaInstallHelp';
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-modal','true');
    overlay.innerHTML =
      '<div style="position:absolute;inset:0;background:rgba(15,23,42,.58)" data-close-install></div>' +
      '<div style="position:relative;width:min(680px,calc(100% - 24px));margin:auto;background:var(--card,#fff);color:var(--text,#162235);border-radius:22px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.28)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">' +
          '<div style="font-weight:900;font-size:19px">' + title + '</div>' +
          '<button type="button" data-close-install style="width:42px;height:42px;border-radius:50%;border:1px solid var(--line,#E5E7EB);background:var(--card,#fff);color:var(--text,#162235);font-size:22px">×</button>' +
        '</div>' +
        '<div style="font-size:14px;line-height:1.55">' + instructions + '</div>' +
        '<button type="button" data-close-install style="width:100%;min-height:50px;border:0;border-radius:14px;margin-top:18px;background:var(--blue,#C1121F);color:#fff;font-weight:800">Entendido</button>' +
      '</div>';

    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px';
    overlay.addEventListener('click', function(event){
      if(event.target && event.target.hasAttribute('data-close-install')) closeInstallHelp();
    });
    document.body.appendChild(overlay);
  }

  async function openNativeInstallPrompt(){
    if(!deferredInstallPrompt) return false;

    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;

    try{
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;

      if(choice && choice.outcome === 'accepted'){
        notify('Instalando Iaptidud supervision…');
        return true;
      }

      notify('Instalación cancelada');
      return false;
    }catch(error){
      console.warn('No se pudo abrir el prompt de instalación:', error);
      return false;
    }
  }

  async function installIaptidud(){
    if(isStandalone()){
      hideInstallCard();
      notify('La aplicación ya está instalada');
      return;
    }

    if(await openNativeInstallPrompt()) return;

    // En el primer acceso el service worker puede tardar un instante en dejar
    // la PWA instalable. Esperamos brevemente antes de mostrar instrucciones.
    if('serviceWorker' in navigator){
      try{
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise(resolve => setTimeout(resolve, 1800))
        ]);
      }catch(error){}
    }

    await waitForInstallPrompt(2500);
    if(await openNativeInstallPrompt()) return;

    showInstallHelp();
  }

  function bindInstallButton(){
    // Sustituye la antigua función de demostración sin modificar el resto de la app.
    window.fakeInstall = installIaptidud;
    window.installIaptidud = installIaptidud;

    if(isStandalone()) hideInstallCard();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bindInstallButton, {once:true});
  }else{
    bindInstallButton();
  }

  // Reafirma el enlace después de que los scripts originales terminen de cargar.
  window.addEventListener('load', bindInstallButton, {once:true});
})();
