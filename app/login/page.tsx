import type {Metadata} from 'next';
import {isAws} from '@/backend/deployment';
import {getUser,safeReturn} from '../auth';
import {LoginForm} from './sign-in-form';

export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Sign in',robots:{index:false,follow:false}};

export default async function Login({searchParams}:{searchParams:Promise<{return_to?:string}>}){
 const user=await getUser();
 const {return_to='/'}=await searchParams;
 return <div className="signin-page">
  <a className="skip-link" href="#main">Skip to sign-in</a>
  <main id="main" className="signin-main" tabIndex={-1}>
   <section className="signin-card" aria-labelledby="signin-title">
    <a href="/" className="signin-brand" aria-label="DeaLoop home">
     <img src="/brand/dealoop-wordmark.png" alt="DeaLoop AI" width={2048} height={682}/>
    </a>
    <h1 id="signin-title">{user?'Connect or switch a sign-in':'Sign in to DeaLoop'}</h1>
    <p className="signin-description">{user?'Choose how you’d like to access your account.':'Your next find. Your next good deal.'}</p>
    <LoginForm returnTo={safeReturn(return_to)} currentName={user?.displayName||null}/>
    <p className="signin-access-note">{isAws()?'Browse without an account. Posting and offers are currently available to invited testers.':'This test marketplace is private. Hosting access is required too.'}</p>
    {!user&&<a className="signin-account-link" href="/">Continue browsing</a>}
    {user&&<a className="signin-account-link" href="/account">Back to your account</a>}
   </section>
   <footer className="signin-footer"><span>A second life. A better find.</span><a href="/about">About DeaLoop</a></footer>
  </main>
 </div>;
}
