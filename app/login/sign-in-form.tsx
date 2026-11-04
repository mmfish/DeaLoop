'use client';
import {useState} from 'react';
import {initializeApp,getApps} from 'firebase/app';
import {getAuth,GoogleAuthProvider,FacebookAuthProvider,signInWithPopup,inMemoryPersistence,setPersistence,signOut} from 'firebase/auth';
import config from '@/config/firebase.json';

export function LoginForm({returnTo,currentName}:{returnTo:string;currentName:string|null}){
 const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[link,setLink]=useState(false);
 async function login(provider:'google'|'facebook'){
  setBusy(provider);setError('');
  const auth=getAuth(getApps()[0]||initializeApp(config));
  try{
   await setPersistence(auth,inMemoryPersistence);
   const p=provider==='google'?new GoogleAuthProvider():new FacebookAuthProvider();
   // Firebase's separate-provider account mode does not request Google email
   // implicitly. Private invitations require its verified email claim.
   p.addScope('email');
   if(provider==='google')p.setCustomParameters({prompt:'select_account'});
   const result=await signInWithPopup(auth,p);
   const googleToken=provider==='google'?GoogleAuthProvider.credentialFromResult(result)?.idToken:undefined;
   const response=await fetch('/api/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_token:await result.user.getIdToken(),google_id_token:googleToken,link_existing:link})});
   const data=await response.json() as {error?:{message?:string}};if(!response.ok)throw Error(data.error?.message||'Unable to complete sign-in.');
   await signOut(auth);window.location.assign(returnTo);
  }catch(e){
   const code=(e as {code?:string}).code;
   const messages:Record<string,string>={
    'auth/popup-closed-by-user':'Sign-in was cancelled. You can try again when you’re ready.',
    'auth/cancelled-popup-request':'Another sign-in window is already open.',
    'auth/popup-blocked':'Your browser blocked the sign-in window. Allow popups for DeaLoop and try again.',
    'auth/unauthorized-domain':'This address has not been enabled for sign-in yet. Please use the deployed DeaLoop website.',
    'auth/account-exists-with-different-credential':'This email already uses another sign-in provider. Sign in with that provider first.',
    'auth/operation-not-allowed':'This provider is not available yet.',
    'auth/network-request-failed':'Could not reach the sign-in provider. Check your connection and try again.',
   };
   setError(code?(messages[code]||'The provider could not complete sign-in. Please try again.'):((e as Error).message||'Sign-in failed.'));
   await signOut(auth).catch(()=>{});setBusy(null);
  }
 }
 return <div className="signin-options" aria-busy={!!busy}>
  {currentName&&<label className="auth-link-choice"><input type="checkbox" checked={link} onChange={e=>setLink(e.target.checked)} disabled={!!busy}/><span>Connect this sign-in to <strong>{currentName}</strong>’s current DeaLoop account.<small>Keep its posts, activity, and agent connections. Only select this when both accounts are yours.</small></span></label>}
  <div className="auth-buttons"><button className="button auth-provider" disabled={!!busy} onClick={()=>login('google')}><span className="provider-mark" aria-hidden="true">G</span>{busy==='google'?'Connecting…':'Continue with Google'}</button><button className="button auth-provider" disabled={!!busy} onClick={()=>login('facebook')}><span className="provider-mark facebook-mark" aria-hidden="true">f</span>{busy==='facebook'?'Connecting…':'Continue with Facebook'}</button></div>
  <p className="signin-status" role="status">{busy?`Opening ${busy==='google'?'Google':'Facebook'} sign-in…`:null}</p>
  {error&&<p className="auth-error" role="alert">{error}</p>}
  <p className="auth-footnote">You’re in control. Agent access is approved separately.</p>
 </div>;
}
