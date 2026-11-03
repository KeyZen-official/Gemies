'use client';
import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {api,money,setCsrf} from './api.js';
import {readCache,writeCache,clearAllCache,useIsomorphicLayoutEffect} from './lib/client-cache.js';
import {Button} from './components/ui/Button.jsx';
import {storeMark,storeName,storeMarkRatio} from './data/store-mark.js';
// Shared primitives: store context, icons, data fetching and form pieces.
// The page sections and the product tile live as individual components under
// src/components/ — Navbar, Footer, HeroBanner, PromoCard, OfferCard,
// ProductCard, ProductGrid, CategoryCard, RecommendedCollections,
// CollectionSection and BottomPromoBanner.
export const StoreContext=createContext(null);
export const useStore=()=>useContext(StoreContext);
export function Icon({name,size=21,...props}){const paths={search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,user:<><circle cx="12" cy="7" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3Z"/></>,heart:<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>,bag:<><path d="M5 7h14l1 14H4L5 7Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></>,arrow:<path d="M5 12h14m-6-6 6 6-6 6"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,menu:<path d="M4 6h16M4 12h16M4 18h16"/>,check:<path d="m5 12 4 4L19 6"/>,truck:<><path d="M2 6h12v11H2ZM14 10h4l4 4v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,shield:<><path d="m12 2 8 4v6c0 6-8 10-8 10S4 18 4 12V6Z"/><path d="m8 12 3 3 5-6"/></>,minus:<path d="M5 12h14"/>,plus:<path d="M5 12h14M12 5v14"/>,calendar:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18"/></>,box:<><path d="M21 8.5v7L12 21l-9-5.5v-7L12 3Z"/><path d="m3 8.5 9 5 9-5M12 13.5V21"/></>,pin:<><path d="M12 22s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="11" r="2.5"/></>,download:<path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16"/>,refresh:<><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/></>,home:<><path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/></>,pencil:<><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.5 6.5 3 3"/></>};return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]||paths.arrow}</svg>;}
// The Gemies monogram plus the wordmark. `tone` picks the ink: the supplied
// artwork is cream, made for a dark background, so a light surface needs the
// recoloured file instead. Explicit width and height reserve the space before
// the image loads, so the bar does not jump.
export function Logo({className='',tone='dark'}){return <span className={`flex items-center gap-[7px] text-[23px] font-semibold tracking-[-0.6px] md:gap-2.5 lg:text-[25px] ${className}`}><img src={tone==='light'?storeMark.light:storeMark.dark} alt="" width={storeMarkRatio.width} height={storeMarkRatio.height} className="h-[26px] w-auto lg:h-[30px]"/>{storeName}</span>;}
export function Provider({children}){const [user,setUser]=useState(null),[ready,setReady]=useState(false),[config,setConfig]=useState({currency:'INR',settings:{}}),[cart,setCart]=useState({items:[]}),[wishlist,setWishlist]=useState(()=>new Set()),[toast,setToast]=useState(null);
  // notify(message) still works everywhere; the optional second argument adds a
  // link to the toast, so "added to bag" can offer a way through to the cart.
  const notify=(message,action=null)=>setToast(message?{message,action}:null);async function refreshCart(){try{const c=await api('/cart');setCart(c);return c;}catch{setCart({items:[]});}}
  // Wishlist membership is kept here so every ProductCard heart reflects the
  // saved state and can toggle it, rather than only ever adding.
  // Reads /wishlist/ids, not /wishlist. The latter is paginated now, and a
  // page of it would leave every heart beyond the first page looking unsaved.
  async function refreshWishlist(){try{const ids=await api('/wishlist/ids');setWishlist(new Set(ids));}catch{setWishlist(new Set());}}
  async function toggleWishlist(productId){const saved=wishlist.has(productId);try{await api(`/wishlist/${productId}`,{method:saved?'DELETE':'PUT'});setWishlist(previous=>{const next=new Set(previous);if(saved)next.delete(productId);else next.add(productId);return next;});notify(saved?'Removed from your wishlist.':'Saved to your wishlist.');return !saved;}catch(e){notify(e.message);return saved;}}
  // The CSRF token is stripped before the session is cached: it is a security
  // token and only ever comes from a live response. Everything else here is
  // identity, which lets a gated page paint before the round trip finishes.
  async function refreshUser(){const s=await api('/auth/session');setUser(s.user);setCsrf(s.user?.csrf);if(s.user){const {csrf,...identity}=s.user;writeCache('session',identity);}else clearAllCache();return s.user;}
  /*
    Paint from the cache, then revalidate.

    Without this the app bootstrapped from nothing on every refresh: `ready`
    false and `user` null until /auth/session answered, so every gated page --
    the admin, the cart, the account -- showed a spinner for the length of a
    round trip. That is the flash on reload.

    The layout effect runs before the browser paints and after hydration, so
    the server and the client agree on the first render and the cached state
    lands without a visible frame of placeholder. `ready` is only forced true
    when there is a cached session; a signed-out visitor is unaffected.
  */
  const hydrated=useRef(false);
  useIsomorphicLayoutEffect(()=>{if(hydrated.current)return;hydrated.current=true;const cachedConfig=readCache('config');if(cachedConfig)setConfig(cachedConfig);const cachedUser=readCache('session');if(cachedUser){setUser(cachedUser);setReady(true);}},[]);
  useEffect(()=>{Promise.all([refreshUser(),api('/config').then(c=>{setConfig(c);writeCache('config',c);})]).catch(e=>notify(e.message)).finally(()=>setReady(true));},[]);useEffect(()=>{if(user){refreshCart();refreshWishlist();}else{setCart({items:[]});setWishlist(new Set());}},[user?.id]);useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(null),toast.action?7000:5000);return()=>clearTimeout(t);},[toast]);return <StoreContext.Provider value={{user,setUser,ready,config,setConfig,cart,setCart,refreshCart,refreshUser,wishlist,refreshWishlist,toggleWishlist,notify}}>{children}{toast&&<div className="fixed bottom-4 left-1/2 z-100 flex w-max max-w-[92vw] -translate-x-1/2 items-center gap-5 rounded-[9px] bg-[#161616] px-[17px] py-[15px] text-xs leading-snug text-white shadow-[0_10px_35px_rgba(0,0,0,0.13)] md:bottom-7 md:max-w-[min(90vw,650px)] md:gap-[22px] md:px-5 md:py-[17px] md:text-[13px]" role="status"><span>{toast.message}</span>{toast.action&&<Link className="shrink-0 font-bold underline underline-offset-[3px]" href={toast.action.href} onClick={()=>setToast(null)}>{toast.action.label}</Link>}<button className="flex text-white" onClick={()=>setToast(null)} aria-label="Dismiss notification"><Icon name="close" size={16}/></button></div>}</StoreContext.Provider>;}
export function Loading(){return <div className="flex items-center justify-center gap-3.5 px-5 py-20 text-[13px] text-[#888]" role="status"><span className="size-5 animate-spin rounded-full border-2 border-[#ddd] border-t-[#333]"/>Loading your next favourites…</div>;}
export function ErrorState({message,onRetry}){return <div className="mx-auto max-w-[700px] px-[22px] py-16 text-center md:px-6 md:py-[85px]"><h2 className="text-[26px] md:text-[29px]">Something needs attention</h2><p className="mb-7 text-xs md:text-sm" role="alert">{message}</p>{onRetry&&<Button variant="dark" onClick={onRetry}>Try again</Button>}</div>;}
export function Empty({title,text,link='/shop',label='Explore the collection'}){return <div className="mx-auto max-w-[700px] px-[22px] py-16 text-center md:px-6 md:py-[85px]"><Icon name="bag" size={38} className="mx-auto mb-6 text-[#666]"/><h2 className="text-[26px] md:text-[29px]">{title}</h2><p className="mb-7 text-xs md:text-sm">{text}</p><Button variant="dark" href={link}>{label}<Icon name="arrow" size={17}/></Button></div>;}
// An empty url skips the request, so a caller whose endpoint depends on an
// earlier fetch can wait without firing a request at /api and without breaking
// the rules of hooks by calling this conditionally.
// `cacheKey` opts a call site into the localStorage cache in src/lib: the
// cached payload paints immediately and the request revalidates behind it. Only
// for public, slow-changing data -- the navbar's category tree. Never for
// anything under /admin, where a stale number is worse than a spinner.
export function useResource(url,{cacheKey}={}){const [data,setData]=useState(null),[error,setError]=useState(''),[fetching,setFetching]=useState(!!url),[version,setVersion]=useState(0);
  const primed=useRef(false);
  useIsomorphicLayoutEffect(()=>{if(!cacheKey||primed.current)return;primed.current=true;const cached=readCache(cacheKey);if(cached!=null)setData(cached);},[cacheKey]);
  useEffect(()=>{if(!url){setFetching(false);setError('');return;}let live=true;setFetching(true);setError('');api(url).then(r=>{if(!live)return;setData(r);if(cacheKey)writeCache(cacheKey,r);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setFetching(false);});return()=>{live=false};},[url,version,cacheKey]);
  // `loading` means "there is nothing to show yet", not "a request is open".
  // That distinction is what stops a spinner replacing content that is already
  // on screen every time a page or filter changes -- the previous rows stay put
  // and `refreshing` is there for callers that want to dim them.
  return {data,setData,error,loading:fetching&&data===null,refreshing:fetching&&data!==null,reload:()=>setVersion(v=>v+1)};}
// Stands in for react-router's writable useSearchParams tuple. Next's own hook
// is read-only, so writing a new query string means pushing a new URL.
export function useQueryParams(){const params=useSearchParams(),pathname=usePathname(),router=useRouter();const setParams=next=>{const query=next.toString();router.push(query?`${pathname}?${query}`:pathname,{scroll:false});};return [params,setParams];}
export function PageTitle({eyebrow,title,text,children}){return <div className="mt-3 mb-[30px] flex flex-col items-start justify-between gap-[18px] md:mt-3.5 md:mb-10 md:flex-row md:items-center md:gap-6"><div>{eyebrow&&<div className="text-[9px] font-semibold tracking-[2px] text-ink-soft md:text-[10px]">{eyebrow}</div>}<h1 className="my-2.5 text-[31px] md:mt-2.5 md:mb-3.5 md:text-[35px] lg:text-[42px]">{title}</h1>{text&&<p className="m-0 text-xs md:text-sm">{text}</p>}</div>{children}</div>;}
export function Field({label,className='',children,...props}){return <label className={`mb-[18px] flex flex-col gap-2.5 text-[11px] md:mb-5 md:text-xs ${className}`}><span className="font-medium">{label}</span>{children??<input className="text-xs md:text-[13px]" {...props}/>}</label>;}
export function AddressFields({value={},onChange}){const fields=[['name','Full name','name'],['phone','Mobile number','tel'],['line1','Street address','address-line1'],['line2','Apartment, landmark (optional)','address-line2'],['city','City','address-level2'],['state','State','address-level1'],['postalCode','PIN code','postal-code']];return <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2 md:gap-x-[18px]">{fields.map(([key,label,autocomplete])=><Field key={key} label={label} name={key} autoComplete={autocomplete} value={value[key]||''} onChange={e=>onChange({...value,[key]:e.target.value,country:'India'})} required={key!=='line2'} pattern={key==='phone'?'[6-9][0-9]{9}':key==='postalCode'?'[1-9][0-9]{5}':undefined} maxLength={key==='phone'?10:key==='postalCode'?6:180}/>)}<Field label="Country" value="India" readOnly/></div>;}
export function Summary({quote,children}){const {config}=useStore();return <aside className="rounded-[10px] bg-[#f0f0ec] p-[25px] lg:sticky lg:top-[25px] lg:p-6 xl:p-[30px]"><h2 className="mb-[30px] text-[22px]">Order summary</h2>{[['Subtotal','subtotal'],['Discount','discount'],['Shipping','shipping'],['Tax','tax']].map(([label,key])=><div className="mb-[18px] flex justify-between gap-2.5 text-[13px]" key={key}><span className="text-ink-soft">{label}</span><span>{key==='discount'&&quote[key]>0?'−':''}{money(quote[key]||0,quote.currency||config.currency)}</span></div>)}<div className="mt-[25px] flex justify-between gap-2.5 border-t border-[#d6d6ce] pt-[22px] text-base"><span>Total</span><strong className="text-xl">{money(quote.total||0,quote.currency||config.currency)}</strong></div>{children}<p className="mt-[18px] mb-0 flex items-center justify-center gap-2 text-[10px]"><Icon name="shield" size={16}/> Secure checkout with Razorpay</p></aside>;}
