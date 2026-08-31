// Autenticación Supabase Auth para Iaptidud supervision.
// Usa únicamente la URL y la clave pública anon ya presentes en index.html.
// v23: permite restaurar una sesión previamente validada cuando la PWA abre sin Internet.
(function(){
  'use strict';

  const SESSION_KEY='iaptidud-supabase-auth-session-v1';
  const OFFLINE_USER_KEY='iaptidud-authenticated-user-cache-v1';
  let authSession=null;
  let currentStorageKey=null;
  let readyResolve;
  const readyPromise=new Promise(resolve=>{readyResolve=resolve});

  function authBaseHeaders(extra={}){
    return {
      'apikey':SUPABASE_ANON_KEY,
      'Authorization':'Bearer '+SUPABASE_ANON_KEY,
      'Accept':'application/json',
      ...extra
    };
  }

  async function readJsonSafe(response){
    try{return await response.json()}catch(e){return null}
  }

  function saveSession(session){
    authSession=session||null;
    if(session){
      localStorage.setItem(SESSION_KEY,JSON.stringify(session));
    }else{
      localStorage.removeItem(SESSION_KEY);
    }
  }

  function saveOfflineUser(user){
    if(user?.id){
      localStorage.setItem(OFFLINE_USER_KEY,JSON.stringify({
        id:user.id,
        email:user.email||'',
        name:user.name||'',
        role:user.role||'Usuario'
      }));
    }else{
      localStorage.removeItem(OFFLINE_USER_KEY);
    }
  }

  function readOfflineUser(){
    try{
      const cached=JSON.parse(localStorage.getItem(OFFLINE_USER_KEY)||'null');
      return cached?.id?cached:null;
    }catch(e){
      return null;
    }
  }

  function sessionExpirySeconds(session){
    if(!session) return 0;
    if(session.expires_at) return Number(session.expires_at)||0;
    if(session.expires_in) return Math.floor(Date.now()/1000)+Number(session.expires_in||0);
    return 0;
  }

  async function refreshSession(){
    if(!authSession?.refresh_token) return null;
    if(!navigator.onLine) return authSession;

    const response=await fetch(SUPABASE_URL+'/auth/v1/token?grant_type=refresh_token',{
      method:'POST',
      headers:authBaseHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({refresh_token:authSession.refresh_token}),
      cache:'no-store'
    });

    if(!response.ok){
      saveSession(null);
      saveOfflineUser(null);
      return null;
    }

    const refreshed=await readJsonSafe(response);
    if(!refreshed?.access_token) return null;
    saveSession(refreshed);
    return refreshed;
  }

  async function getSession(){
    if(!authSession){
      try{authSession=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch(e){authSession=null}
    }
    if(!authSession?.access_token) return null;

    // Offline no se intenta refrescar ni invalidar una sesión previamente válida.
    // El token solo se usa localmente hasta recuperar conexión.
    if(!navigator.onLine) return authSession;

    const expiry=sessionExpirySeconds(authSession);
    if(expiry && expiry-Math.floor(Date.now()/1000)<90){
      return await refreshSession();
    }
    return authSession;
  }

  async function getAccessToken(){
    const session=await getSession();
    return session?.access_token||null;
  }

  async function getVerifiedUser(){
    if(!navigator.onLine) return authSession?.user||null;

    let session=await getSession();
    if(!session?.access_token) return null;

    let response=await fetch(SUPABASE_URL+'/auth/v1/user',{
      method:'GET',
      headers:{
        'apikey':SUPABASE_ANON_KEY,
        'Authorization':'Bearer '+session.access_token,
        'Accept':'application/json'
      },
      cache:'no-store'
    });

    if(response.status===401){
      session=await refreshSession();
      if(!session?.access_token) return null;
      response=await fetch(SUPABASE_URL+'/auth/v1/user',{
        method:'GET',
        headers:{
          'apikey':SUPABASE_ANON_KEY,
          'Authorization':'Bearer '+session.access_token,
          'Accept':'application/json'
        },
        cache:'no-store'
      });
    }

    if(!response.ok) return null;
    return await readJsonSafe(response);
  }

  async function getProfile(user,accessToken){
    const response=await fetch(
      SUPABASE_REST_URL+'/profiles?id=eq.'+encodeURIComponent(user.id)+'&select=id,email,name,role',
      {
        method:'GET',
        headers:{
          'apikey':SUPABASE_ANON_KEY,
          'Authorization':'Bearer '+accessToken,
          'Accept':'application/json'
        },
        cache:'no-store'
      }
    );

    if(!response.ok) return null;
    const rows=await readJsonSafe(response);
    return Array.isArray(rows)&&rows.length?rows[0]:null;
  }

  function userStorageKey(userId){
    return 'iaptidud-inspections-user-'+String(userId);
  }

  function installPerUserPersistence(userId){
    currentStorageKey=userStorageKey(userId);
    let local=[];
    try{
      const parsed=JSON.parse(localStorage.getItem(currentStorageKey)||'[]');
      local=Array.isArray(parsed)?parsed:[];
    }catch(e){local=[]}
    data=local;

    window.persist=function(){
      if(!currentStorageKey) return;
      localStorage.setItem(currentStorageKey,JSON.stringify(Array.isArray(data)?data:[]));
    };
  }

  function updateAuthenticatedUI(){
    const u=currentUser||{name:'Supervisor',role:'Usuario',email:''};
    const homeName=document.getElementById('homeUserName');
    if(homeName) homeName.textContent=u.name||u.email||'Supervisor';
    const pn=document.getElementById('profileName');
    const pr=document.getElementById('profileRole');
    const pe=document.getElementById('profileEmail');
    if(pn) pn.textContent=u.name||u.email||'Usuario';
    if(pr) pr.textContent=u.role||'Usuario';
    if(pe) pe.textContent=u.email||'';
  }

  function hidePrivateNavigation(){
    document.getElementById('bottomnav')?.classList.add('hidden');
    document.getElementById('fab')?.classList.add('hidden');
  }

  function showPrivateNavigation(){
    document.getElementById('bottomnav')?.classList.remove('hidden');
    document.getElementById('fab')?.classList.remove('hidden');
  }

  function clearLegacyDemoSession(){
    localStorage.removeItem('iaptidud-current-user');
  }

  function applyOfflineAuthenticatedUser(cachedUser){
    if(!cachedUser?.id||!authSession?.access_token) return false;
    const sessionUserId=authSession?.user?.id||null;
    if(sessionUserId&&String(sessionUserId)!==String(cachedUser.id)) return false;

    currentUser={
      id:cachedUser.id,
      email:cachedUser.email||authSession?.user?.email||'',
      name:cachedUser.name||String(cachedUser.email||authSession?.user?.email||'Usuario').split('@')[0],
      role:cachedUser.role||'Usuario'
    };

    installPerUserPersistence(currentUser.id);
    showPrivateNavigation();
    updateAuthenticatedUI();
    window.dispatchEvent(new CustomEvent('iaptidud-auth-changed',{detail:{authenticated:true,user:currentUser,offline:true}}));
    return true;
  }

  async function applyAuthenticatedUser(user){
    const session=await getSession();
    if(!session?.access_token) return false;

    const profile=await getProfile(user,session.access_token);
    currentUser={
      id:user.id,
      email:user.email||profile?.email||'',
      name:profile?.name||user.user_metadata?.name||String(user.email||'Usuario').split('@')[0],
      role:profile?.role||'Usuario'
    };

    localStorage.setItem('iaptidud-current-user',JSON.stringify(currentUser));
    saveOfflineUser(currentUser);
    installPerUserPersistence(user.id);
    showPrivateNavigation();
    updateAuthenticatedUI();

    window.dispatchEvent(new CustomEvent('iaptidud-auth-changed',{detail:{authenticated:true,user:currentUser}}));
    return true;
  }

  function applyLoggedOutState(){
    authSession=null;
    currentStorageKey=null;
    currentUser=null;
    data=[];
    if(typeof currentId!=='undefined') currentId=null;
    localStorage.removeItem(SESSION_KEY);
    saveOfflineUser(null);
    clearLegacyDemoSession();
    hidePrivateNavigation();
    try{go('login')}catch(e){}
  }

  async function loginFromForm(){
    const emailInput=document.getElementById('loginEmail');
    const passInput=document.getElementById('loginPass');
    const email=String(emailInput?.value||'').trim().toLowerCase();
    const password=String(passInput?.value||'');

    if(emailInput) emailInput.value='';
    if(passInput) passInput.value='';

    if(!email||!password){
      if(typeof toast==='function') toast('Ingresa correo y contraseña');
      return false;
    }
    if(!navigator.onLine){
      if(typeof toast==='function') toast('Necesitas conexión para iniciar sesión por primera vez');
      return false;
    }

    try{
      const response=await fetch(SUPABASE_URL+'/auth/v1/token?grant_type=password',{
        method:'POST',
        headers:authBaseHeaders({'Content-Type':'application/json'}),
        body:JSON.stringify({email,password}),
        cache:'no-store'
      });

      if(!response.ok){
        if(typeof toast==='function') toast('Correo o contraseña incorrectos');
        return false;
      }

      const session=await readJsonSafe(response);
      if(!session?.access_token||!session?.user){
        if(typeof toast==='function') toast('No se pudo iniciar sesión');
        return false;
      }

      saveSession(session);
      await applyAuthenticatedUser(session.user);
      go('home');

      if(window.IAPTIDUD_SUPABASE_SYNC?.refresh){
        await window.IAPTIDUD_SUPABASE_SYNC.refresh();
      }

      if(typeof toast==='function') toast('Sesión iniciada');
      return true;
    }catch(error){
      console.warn('Error de inicio de sesión Supabase:',error);
      if(typeof toast==='function') toast('No se pudo iniciar sesión');
      return false;
    }
  }

  async function logout(){
    const session=await getSession();
    try{
      if(session?.access_token&&navigator.onLine){
        await fetch(SUPABASE_URL+'/auth/v1/logout?scope=local',{
          method:'POST',
          headers:{
            'apikey':SUPABASE_ANON_KEY,
            'Authorization':'Bearer '+session.access_token,
            'Content-Type':'application/json'
          },
          cache:'no-store'
        });
      }
    }catch(error){
      console.warn('Supabase logout incompleto:',error);
    }finally{
      saveSession(null);
      saveOfflineUser(null);
      applyLoggedOutState();
      window.dispatchEvent(new CustomEvent('iaptidud-auth-changed',{detail:{authenticated:false,user:null}}));
      if(typeof toast==='function') toast('Sesión cerrada');
    }
  }

  async function restoreSession(){
    clearLegacyDemoSession();
    try{authSession=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch(e){authSession=null}

    if(!authSession?.access_token){
      applyLoggedOutState();
      return false;
    }

    // Si no hay Internet, solo se permite entrar cuando esta instalación ya
    // conserva una sesión Supabase y un perfil previamente validados online.
    if(!navigator.onLine){
      const cachedUser=readOfflineUser();
      if(cachedUser&&applyOfflineAuthenticatedUser(cachedUser)){
        try{go('home')}catch(e){}
        return true;
      }
      applyLoggedOutState();
      return false;
    }

    try{
      const user=await getVerifiedUser();
      if(!user){
        saveSession(null);
        saveOfflineUser(null);
        applyLoggedOutState();
        return false;
      }
      await applyAuthenticatedUser(user);
      go('home');
      return true;
    }catch(error){
      console.warn('No se pudo restaurar la sesión Supabase:',error);
      // Un fallo transitorio de red no destruye una sesión previamente validada.
      const cachedUser=readOfflineUser();
      if(!navigator.onLine&&cachedUser&&applyOfflineAuthenticatedUser(cachedUser)){
        try{go('home')}catch(e){}
        return true;
      }
      applyLoggedOutState();
      return false;
    }
  }

  async function revalidateWhenOnline(){
    if(!navigator.onLine||!authSession?.access_token||!currentUser?.id) return;
    try{
      const user=await getVerifiedUser();
      if(!user){
        applyLoggedOutState();
        window.dispatchEvent(new CustomEvent('iaptidud-auth-changed',{detail:{authenticated:false,user:null}}));
        return;
      }
      await applyAuthenticatedUser(user);
      if(window.IAPTIDUD_SUPABASE_SYNC?.refresh){
        await window.IAPTIDUD_SUPABASE_SYNC.refresh();
      }
    }catch(error){
      console.warn('Revalidación de sesión pendiente:',error);
    }
  }

  const baseGo=window.go;
  if(typeof baseGo==='function'){
    window.go=function(id){
      if(id!=='login'&&!currentUser){
        hidePrivateNavigation();
        return baseGo.call(this,'login');
      }
      return baseGo.apply(this,arguments);
    };
  }

  const baseSaveInspection=window.saveInspection;
  if(typeof baseSaveInspection==='function'){
    window.saveInspection=function(){
      if(!currentUser?.id){
        if(typeof toast==='function') toast('Debes iniciar sesión');
        return;
      }
      const idsBefore=new Set(Array.isArray(data)?data.map(x=>x.id):[]);
      const result=baseSaveInspection.apply(this,arguments);
      const created=Array.isArray(data)?data.find(x=>!idsBefore.has(x.id)):null;
      if(created){
        created.user_id=currentUser.id;
        if(typeof persist==='function') persist();
      }
      return result;
    };
  }

  window.updateUserUI=updateAuthenticatedUI;
  window.login=loginFromForm;
  window.logout=logout;

  window.IAPTIDUD_AUTH={
    ready:()=>readyPromise,
    loginFromForm,
    logout,
    getSession,
    getAccessToken,
    getUser:()=>currentUser?{...currentUser}:null,
    getUserId:()=>currentUser?.id||null,
    isAuthenticated:()=>Boolean(currentUser?.id),
    refreshSession
  };

  window.addEventListener('online',()=>setTimeout(revalidateWhenOnline,250));

  restoreSession().finally(()=>{
    readyResolve(true);
    window.dispatchEvent(new CustomEvent('iaptidud-auth-ready',{detail:{authenticated:Boolean(currentUser?.id),user:currentUser,offline:!navigator.onLine}}));
  });
})();