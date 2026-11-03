'use client';
import React,{useState,useEffect,useRef} from 'react';
import Link from 'next/link';
import {useSearchParams,useRouter,useParams} from 'next/navigation';
import {api,money} from './api.js';
import {useStore,useResource,PageTitle,Field,Loading,Empty,ErrorState,AddressFields,Icon} from './components.jsx';
import {launchPayment} from './storefront.jsx';
import {Button,buttonClasses} from './components/ui/Button.jsx';
import {Pagination} from './components/ui/Pagination.jsx';
import {badgeClasses} from './components/ui/Badge.js';
import {AuthField} from './components/auth/AuthField.jsx';
import {Wallet} from './components/account/Wallet.jsx';
import {OrderExchange} from './components/account/ExchangeRequest.jsx';
import {OrderProgress,ShipmentSteps} from './components/account/OrderProgress.jsx';
import {OrderSummaryCard} from './components/account/OrderSummaryCard.jsx';
import {authContent,promoLabel,promoImage} from './data/auth-content.js';
/**
 * Every authentication screen: sign in, create account, forgot, reset, verify
 * and resend. One component serves all six because the form is the same shape
 * in each case — a few fields, one POST to /auth/{mode}, one message — and the
 * six routes under src/app are thin shells that pick the mode.
 *
 * Layout is a split screen: a promotional panel beside the form, stacking to
 * one column below lg. The panel is a flat colour with an isolated garment on
 * it, so there is no photograph to crop and nothing is baked into the image.
 *
 * The split starts at lg rather than md: 55% of a 768px tablet is 422px, and
 * the form alone is 420px wide, which would leave it touching both edges.
 *
 * Height is `100svh` minus the navbar rather than `100vh`. The navbar is part
 * of the persistent shell and takes real space, so a full 100vh panel would
 * always push the page into a scroll; `svh` additionally avoids the jump when
 * mobile browser chrome hides.
 *
 * On the form behaviour, which is unchanged: submission reads the form with
 * FormData, so each input's `name` is the request key, and the register and
 * reset endpoints parse with a strict schema that rejects unknown keys. That
 * is why the confirm-password field below has no `name` — see the note there.
 */
export function AuthPage({mode}){
  const params=useSearchParams(),router=useRouter(),{refreshUser,config}=useStore();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [confirmError,setConfirmError]=useState('');
  const confirmRef=useRef(null);
  useEffect(()=>{setMessage('');setError('');setConfirmError('');},[mode]);

  const content=authContent[mode]??authContent.login;
  const {left,right}=content;
  const hasEmail=['login','register','forgot','resend'].includes(mode);
  const hasPassword=['login','register','reset'].includes(mode);

  async function handleSubmit(e){
    e.preventDefault();
    // Read the form before any await: after one, e.currentTarget is null.
    const values=Object.fromEntries(new FormData(e.currentTarget));
    setError('');
    setConfirmError('');

    // Confirm-password is checked here and only here. The server has no such
    // field, so this stays entirely on the client and the request body is
    // unchanged.
    if(mode==='register'&&(confirmRef.current?.value??'')!==(values.password??'')){
      setConfirmError('Both passwords must match.');
      confirmRef.current?.focus();
      return;
    }

    setBusy(true);
    try{
      if(mode==='reset'||mode==='verify')values.token=params.get('token')||'';
      const result=await api(`/auth/${mode}`,{method:'POST',body:values});
      if(mode==='login'){
        // Re-reads /auth/session as the source of truth: this is what installs
        // the CSRF token and triggers the cart and wishlist fetches. It must
        // stay awaited before the redirect.
        await refreshUser();
        const next=params.get('next');
        // Only same-site paths: rejects absolute URLs and protocol-relative
        // ones such as //evil.example.
        router.push(next?.startsWith('/')&&!next.startsWith('//')?next:'/account');
      }else setMessage(result.message||'Request completed.');
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }

  return <main className="grid grid-cols-1 font-manrope lg:min-h-[calc(100svh-var(--spacing-nav))] lg:grid-cols-[45fr_55fr]">
    {/* Promotional panel. Compact band on mobile, full column from lg. */}
    {/*
      The promotional panel is the photograph. Stacked, it is a band at the top
      of the page: 32vh on a phone, and taller from sm, because `object-cover`
      on a portrait photograph in a wide short band discards a lot — at 768px
      wide a 32vh band shows only 28% of the image, which is a slice through
      the middle of a black shirt. 42vh shows the collar through mid-body and
      still leaves room for the form on a 1024px-tall tablet.
    */}
    {/*
      The promotional panel: the photograph full-bleed, with the copy over its
      lower-left.
      
      No store mark here. The navbar sits directly above this panel and already
      carries it, so a second one is the same logo twice within 60px.
      
      The copy can sit on the photograph because the focal point is chosen to
      put the floor, not the shirt, behind it — see `focal` in auth-content.js.
      That is what makes this work: dark type over the black shirt would be
      unreadable, and a scrim strong enough to fix that washes the garment out
      to grey.
    */}
    <section className="relative flex min-h-[34vh] flex-col justify-end overflow-hidden bg-auth-panel sm:min-h-[44vh] lg:min-h-0">
      {/*
        A blurred copy of the same photograph, filling the panel behind the
        sharp one.
        
        On the split layout the photograph is contained rather than cropped, so
        the whole garment is visible — but the panel is wider than the photo's
        3:2, which leaves a bar down each side. A flat bar seams badly: the
        photo's edge averages #d5bfa8 on the left against the panel's #f1eee8.
        A blurred copy carries the same wall tone and the same direction of
        light, so the join is invisible, and it costs no extra request because
        it is the same file.
        
        scale-110 pushes the blur's own soft edge outside the panel; without it
        the blur samples past the image and leaves a pale rim.
        
        blur-3xl with brightness lifted, rather than a lighter blur: at 40px
        the shirt's dark mass still bleeds into the bars as a grey smudge
        (darkest pixel 84 of 255). At 64px and 1.18 brightness the bars average
        205, against the photograph's own edge tone of 192 — close enough that
        the join does not read as an edge.
      */}
      <img
        src={promoImage.src}
        alt=""
        aria-hidden="true"
        fetchPriority="high"
        className="absolute inset-0 hidden h-full w-full scale-110 object-cover blur-3xl brightness-[1.18] lg:block"
      />
      <img
        src={promoImage.src}
        alt=""
        width={promoImage.width}
        height={promoImage.height}
        // Eager, and high priority: this is the largest element on the page
        // and the thing a visitor looks at while the form hydrates, so
        // deferring it would only produce a flash of empty beige.
        fetchPriority="high"
        // Cover below lg, contain from lg. The stacked band is wide and short,
        // where containing a portrait photo would render it 191px wide inside
        // a 390px band — a stamp floating in a field of beige. The split
        // panel is tall, where cover had to discard 17% of the image.
        className={`absolute inset-0 h-full w-full object-cover lg:object-contain ${promoImage.focal}`}
      />

      {/* A gentle wash of the panel colour over the lower third only. The
          garment clears this region, so nothing of the shirt is greyed; what
          it calms is the dried flowers and the stone, which sit exactly where
          the heading goes and would otherwise compete with it. */}
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[34%] bg-linear-to-t from-auth-panel/90 via-auth-panel/55 to-transparent" />

      {/* 380px rather than a ch cap: `ch` resolves against this div's inherited
          16px, so 34ch is 314px, which breaks the 34px heading awkwardly. At
          380px the heading sets on two balanced lines and the sentence below
          on two, at every width where both are shown. */}
      {/* 30px at lg, 34px only from 2xl. Containing the photograph means the
          garment sits at its true height rather than being pushed up by a
          crop, so the copy has less room: at 1366x768 — a very common laptop
          — the 34px heading left exactly 1px between the hem and the label. */}
      <div className="relative max-w-[380px] px-6 pb-7 sm:px-8 lg:px-12 lg:pb-8">
        <p className="m-0 text-[11px] leading-none font-bold tracking-[2px] text-auth-ink">{promoLabel}</p>
        <h2 className="mt-3.5 mb-0 text-[24px] leading-[1.15] font-bold tracking-[-0.02em] text-auth-ink lg:text-[30px] 2xl:text-[34px]">
          {left.heading}
        </h2>
        {/*
          Shown from xl, not lg. Stacked, the band must stay compact so the
          form is visible without scrolling. And at 1024-1279 the panel's
          aspect is close enough to the photograph's that almost nothing
          crops, so the shirt sits low and these two extra lines would push
          the copy straight into the hem — measured at -6px clearance.
          The heading carries the message on its own at those widths.
        */}
        <p className="mt-3.5 mb-0 hidden text-[14px] leading-relaxed text-auth-ink xl:block">{left.text}</p>
      </div>
    </section>

    {/* Form panel.
        
        The form grows in two steps above the laptop sizes. It is 420px wide up
        to xl, which is right when the column itself is around 700px, but this
        column is 55% of the viewport: on a 2560px display that is 1408px, and
        a 420px form in the middle of it reads as a small box adrift in white.
        520px at 2xl keeps the measure comfortable while filling the column
        properly. The input height and type scale with it inside AuthField. */}
    <section className="flex items-center justify-center bg-white px-6 py-12 sm:px-8 lg:px-12 lg:py-14">
      <div className="w-full max-w-[420px] xl:max-w-[460px] 2xl:max-w-[520px]">
        <p className="m-0 text-[10px] leading-none font-bold tracking-[2px] text-auth-muted 2xl:text-[11px]">{right.eyebrow}</p>
        <h1 className="mt-4 mb-0 text-[28px] leading-[1.15] font-bold tracking-[-0.02em] text-auth-ink sm:text-[31px] lg:text-[34px] 2xl:text-[38px]">
          {right.heading}
        </h1>
        <p className="mt-2.5 mb-0 text-[14px] leading-relaxed text-auth-muted 2xl:text-[15px]">{right.text}</p>

        <form className="mt-8 flex flex-col gap-[18px]" onSubmit={handleSubmit}>
          {mode==='register'&&
            <AuthField label="Full name" name="name" placeholder="Enter your full name." autoComplete="name" minLength="2" maxLength="100" required/>}

          {hasEmail&&
            <AuthField label="Email address" name="email" type="email" placeholder="Enter your email address." autoComplete="email" maxLength="254" required/>}

          {hasPassword&&
            <AuthField
              label={mode==='reset'?'New password':'Password'}
              name="password"
              revealable
              placeholder={mode==='login'?'Enter your password.':'Create a password.'}
              autoComplete={mode==='login'?'current-password':'new-password'}
              minLength={mode==='login'?1:12}
              maxLength="128"
              // The only password rule the server enforces is a 12-character
              // minimum, so that is the only requirement stated.
              hint={mode==='login'?undefined:'Use at least 12 characters. A unique passphrase works well.'}
              required
            />}

          {/* Confirm password: client-side only, and deliberately without a
              `name`. FormData collects named controls, and POST /auth/register
              parses with a strict schema, so a named field here would be sent
              as an unknown key and the server would reject the signup with a
              400. Without a name it can never reach the request. */}
          {mode==='register'&&
            <AuthField
              label="Confirm password"
              revealable
              inputRef={confirmRef}
              placeholder="Re-enter your password."
              autoComplete="new-password"
              minLength="12"
              maxLength="128"
              error={confirmError}
              required
            />}

          {mode==='login'&&
            <div className="flex items-center justify-between gap-4 text-[13px]">
              <Link className="text-auth-muted underline underline-offset-4 transition-colors hover:text-auth-ink" href="/forgot">Forgot password?</Link>
              {/* Resend exists as a real route backed by POST /auth/resend. */}
              <Link className="text-auth-muted underline underline-offset-4 transition-colors hover:text-auth-ink" href="/resend">Resend verification</Link>
            </div>}

          {error&&
            <p role="alert" className="m-0 rounded-[7px] border border-auth-error/25 bg-auth-error/6 px-4 py-3 text-[13px] leading-relaxed text-auth-error">
              {error}
            </p>}

          {message&&
            <div role="status" className="m-0 rounded-[7px] bg-[#eaf0e6] px-4 py-3.5 text-[13px] leading-relaxed text-[#3d5b2d]">
              {message}
              {['reset','verify'].includes(mode)&&
                <Link className="mt-2.5 block font-semibold underline underline-offset-4" href="/login">Continue to sign in →</Link>}
            </div>}

          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            /* No top margin: the form's gap-[18px] already separates it, and
               adding one here would make the space before the primary action
               the only uneven gap in the form. */
            className="relative flex h-[52px] w-full items-center justify-center rounded-full bg-[#111111] text-[14px] font-bold text-white transition-colors duration-200 hover:bg-[#292725] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-[#111111] 2xl:h-[58px] 2xl:text-[15px]"
          >
            <span>{busy?'Please wait…':content.submit}</span>
            {!busy&&<Icon name="arrow" size={18} className="absolute right-5"/>}
          </button>
        </form>

        {mode==='login'
          ? <p className="mt-7 mb-0 text-center text-[13px] text-auth-muted">New to Gemies? <Link className="font-semibold text-auth-ink underline underline-offset-4" href="/register">Create an account</Link></p>
          : <p className="mt-7 mb-0 text-center text-[13px] text-auth-muted">Already have an account? <Link className="font-semibold text-auth-ink underline underline-offset-4" href="/login">Sign in</Link></p>}

        {/* Shown on every screen that sends mail, never on sign-in, which
            needs no email delivery to work. */}
        {!config.email&&mode!=='login'&&
          <p className="mt-6 mb-0 rounded-[7px] border border-[#e6ddcb] bg-[#f5efe4] px-4 py-3.5 text-[13px] leading-relaxed text-[#765e35]">
            Email delivery is awaiting store configuration. Requests are queued securely and cannot be verified until an email provider is connected.
          </p>}
      </div>
    </section>
  </main>;
}
export function Account(){const {user,ready,refreshUser,notify}=useStore(),router=useRouter(),[tab,setTab]=useState('orders');if(!ready)return <Loading/>;if(!user)return <Empty title="Your personal Gemies space" text="Sign in for orders, addresses, and account settings." link="/login?next=/account" label="Sign in"/>;return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-12 lg:pb-20"><PageTitle eyebrow="YOUR ACCOUNT" title={`Hello, ${user.name.split(' ')[0]}.`} text="Your orders, your details, your next favourites."><button className={buttonClasses('outline')} onClick={async()=>{try{await api('/auth/logout',{method:'POST'});await refreshUser();router.push('/');}catch(e){notify(e.message);}}}>Sign out</button></PageTitle><div className="mb-[26px] flex gap-6 overflow-x-auto border-b border-rule md:mb-9 md:gap-7 [&>a]:ml-auto [&>a]:py-[15px] [&>a]:text-[11px] [&>a]:whitespace-nowrap md:[&>a]:text-xs">{['orders','wallet','addresses','profile','security'].map(t=><button key={t} className={`border-b-2 py-[15px] text-[11px] whitespace-nowrap capitalize md:text-xs ${tab===t ? 'border-ink font-semibold' : 'border-transparent'}`} onClick={()=>setTab(t)}>{t}</button>)}{user.role==='admin'&&<Link href="/admin">Store administration ↗</Link>}</div>{tab==='orders'?<OrderHistory/>:tab==='wallet'?<Wallet/>:tab==='addresses'?<Addresses/>:tab==='profile'?<form className="mb-5 max-w-[560px] rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 [&_h2]:text-[21px] md:[&_h2]:text-[22px] [&_p]:text-xs" onSubmit={async e=>{e.preventDefault();try{await api('/auth/profile',{method:'PATCH',body:{name:new FormData(e.currentTarget).get('name')}});await refreshUser();notify('Profile updated.');}catch(e){notify(e.message);}}}><h2>Personal details</h2><Field label="Full name" name="name" defaultValue={user.name} minLength="2" required/><Field label="Verified email" value={user.email} readOnly/><button className={buttonClasses('dark')}>Save changes</button></form>:<form className="mb-5 max-w-[560px] rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 [&_h2]:text-[21px] md:[&_h2]:text-[22px] [&_p]:text-xs" onSubmit={async e=>{e.preventDefault();try{await api('/auth/password',{method:'POST',body:Object.fromEntries(new FormData(e.currentTarget))});await refreshUser();notify('Password changed. Please sign in again.');router.push('/login');}catch(e){notify(e.message);}}}><h2>Change password</h2><Field label="Current password" name="current" type="password" autoComplete="current-password" required/><Field label="New password" name="password" type="password" autoComplete="new-password" minLength="12" maxLength="128" required/><p className="text-[11px] leading-relaxed [&_a]:underline">Changing your password signs you out on every device.</p><button className={buttonClasses('dark')}>Update password</button></form>}</main>;}
function OrderHistory(){
  const [page,setPage]=useState(1);
  const {data,loading,error,refreshing,reload}=useResource(`/orders?page=${page}&limit=10`);
  if(loading)return <Loading/>;
  if(error)return <ErrorState message={error} onRetry={reload}/>;
  // "Your story starts with a pair" was footwear-era copy on a clothing store.
  if(!data.total)return <Empty title="No orders yet" text="Your orders will appear here after checkout."/>;
  return <>
    <div className={refreshing?'opacity-60 transition-opacity':'transition-opacity'}>
      {data.rows.map(o=><Link key={o.id} href={`/orders/${o.id}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-3 border-b border-rule py-5 text-[13px] hover:bg-[#f2f2ed] md:grid-cols-[1.5fr_1fr_1fr_1fr_auto] md:gap-5 md:px-5 md:py-6 md:text-sm [&>p]:mt-[7px] [&>p]:mb-0 [&>p]:text-[12px]"><div><strong>Order #{o.number}</strong><p>{new Date(o.created_at).toLocaleDateString()}</p></div><span className={badgeClasses(o.payment_status)}>{o.payment_status}</span><span className="capitalize">{o.status}</span><strong>{money(o.total,o.currency)}</strong><Icon name="arrow"/></Link>)}
    </div>
    <Pagination page={data.page} pages={data.pages} total={data.total} unit="orders" onPage={setPage}/>
  </>;
}
function Addresses(){const {data,loading,error,reload}=useResource('/auth/addresses'),{notify}=useStore(),[address,setAddress]=useState({country:'India'}),[show,setShow]=useState(false);return <><div className="my-[22px] flex flex-wrap items-start justify-between gap-5 md:flex-nowrap md:items-center [&_h2]:m-0 [&_h2]:text-[22px] md:[&_h2]:text-2xl"><h2>Saved addresses</h2><button className={buttonClasses('outline')} onClick={()=>setShow(!show)}>{show?'Close':'Add address'}</button></div>{show&&<form className="mb-5 rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 [&_h2]:text-[21px] md:[&_h2]:text-[22px] [&_p]:text-xs" onSubmit={async e=>{e.preventDefault();try{await api('/auth/addresses',{method:'POST',body:address});setAddress({country:'India'});setShow(false);reload();notify('Address saved.');}catch(e){notify(e.message);}}}><AddressFields value={address} onChange={setAddress}/><button className={buttonClasses('dark')}>Save address</button></form>}{loading?<Loading/>:error?<ErrorState message={error}/>:<div className="mt-7 grid grid-cols-1 gap-0 sm:grid-cols-2 sm:gap-5">{data.map(a=><article className="mb-5 rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 [&_h2]:text-[21px] md:[&_h2]:text-[22px] [&_p]:text-xs" key={a.id}><h3>{a.details.name}</h3><p>{a.details.line1}<br/>{a.details.line2}<br/>{a.details.city}, {a.details.state} {a.details.postalCode}</p><p>{a.details.phone}</p><button className="py-2.5 text-[11px] underline underline-offset-4" onClick={async()=>{try{await api(`/auth/addresses/${a.id}`,{method:'DELETE'});reload();}catch(e){notify(e.message);}}}>Remove address</button></article>)}{!data.length&&<p>No saved addresses yet.</p>}</div>}</>;}
export function Order(){const {id}=useParams(),{user,ready}=useStore();if(!ready)return <Loading/>;if(!user)return <Empty title="Sign in to see your order" text="Your order details are private." link={`/login?next=/orders/${id}`} label="Sign in"/>;return <OrderView id={id}/>;}
/*
  Payment status as a pill.

  Its own small map rather than the shared badgeClasses(): that helper is tuned
  to the catalogue's warm palette and is used by the order *history* rows, and
  this page needs the cooler tracking palette around it. Both read the same
  `payment_status` field, so the two cannot disagree about the facts, only
  about the colour.
*/
const PAYMENT_TONES={
  paid:'bg-track-green-soft text-track-green',
  refunded:'bg-[#f3f4f6] text-track-muted',
  refunding:'bg-[#fef3c7] text-[#b45309]',
  pending:'bg-[#fef3c7] text-[#b45309]',
};

/** A titled white card. The page's one surface, so the radius and border cannot drift between sections. */
function OrderCard({title,icon,action,children,className='',bodyClassName='px-5 py-5 md:px-6'}){
  return <section className={`overflow-hidden rounded-[14px] border border-track-border bg-white shadow-[0_1px_3px_rgba(17,24,39,0.06)] ${className}`}>
    {title&&<header className="flex flex-wrap items-center justify-between gap-3 border-b border-track-border bg-track-surface px-5 py-4 md:px-6">
      <h2 className="m-0 flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em] text-track-ink md:text-base">
        {icon&&<Icon name={icon} size={18} strokeWidth={1.9} className="shrink-0 text-track-green"/>}
        {title}
      </h2>
      {action}
    </header>}
    <div className={bodyClassName}>{children}</div>
  </section>;
}

/**
 * The order details page.
 *
 * Laid out as a receipt: what was ordered and where it is going down the main
 * column, what it cost and what can be done about it in a panel beside it.
 *
 * Every value on screen is read from GET /orders/:id and GET /orders/:id/
 * tracking. Nothing is computed from an assumption -- the progress tracker is
 * given the order's own status, the item rows are the snapshots taken at
 * checkout, and the totals are the ones that were charged.
 *
 * Two polls run here. A pending or refunding payment is re-read every ten
 * seconds, because Razorpay confirms out of band and the customer is sitting
 * on this page waiting for it. The parcel is polled separately inside
 * ShipmentTracking on a much slower timer; they are deliberately not merged,
 * since the payment question is settled within a minute and the delivery one
 * takes days.
 */
function OrderView({id}){
  const {data:o,loading,error,reload,refreshing}=useResource(`/orders/${id}`),{user,notify}=useStore(),router=useRouter(),[busy,setBusy]=useState(false);
  useEffect(()=>{if(o&&['pending','refunding'].includes(o.payment_status)){const t=setInterval(reload,10000);return()=>clearInterval(t);}},[o?.payment_status]);
  if(loading&&!o)return <Loading/>;
  if(error)return <ErrorState message={error} onRetry={reload}/>;
  if(!o)return null;

  async function action(path,body){setBusy(true);try{await api(path,{method:'POST',body});reload();}catch(e){notify(e.message);}finally{setBusy(false);}}

  // Units, not rows: two of one shirt is two items in the bag, and the summary
  // headline and the card title have to agree with each other.
  const units=o.items.reduce((total,item)=>total+item.quantity,0);
  const placed=new Date(o.created_at);
  const notice='rounded-[12px] border border-[#fde68a] bg-[#fffbeb] px-4 py-3.5 text-[13px] leading-relaxed text-[#92400e] md:px-5';

  return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-10 lg:pb-20">
    {/* Breadcrumb. "Orders" points at /account, which opens on the orders tab
        by default -- there is no separate orders route to link to. */}
    <nav aria-label="Breadcrumb" className="mb-5 md:mb-6">
      <ol className="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-[11px] text-track-muted md:text-xs">
        <li className="flex items-center gap-2"><Link className="flex items-center gap-1.5 hover:text-track-ink" href="/"><Icon name="home" size={14} strokeWidth={1.9}/><span className="sr-only sm:not-sr-only">Home</span></Link><Icon name="arrow" size={12} strokeWidth={1.9} className="text-[#d1d5db]"/></li>
        <li className="flex items-center gap-2"><Link className="hover:text-track-ink" href="/account">My Account</Link><Icon name="arrow" size={12} strokeWidth={1.9} className="text-[#d1d5db]"/></li>
        <li className="flex items-center gap-2"><Link className="hover:text-track-ink" href="/account">Orders</Link><Icon name="arrow" size={12} strokeWidth={1.9} className="text-[#d1d5db]"/></li>
        <li aria-current="page" className="font-medium text-track-ink">Order #{o.number}</li>
      </ol>
    </nav>

    <div className="mb-7 flex flex-col items-start justify-between gap-4 md:mb-8 md:flex-row md:items-start md:gap-6">
      <div className="min-w-0">
        <p className="m-0 text-[10px] font-bold tracking-[0.14em] text-track-green uppercase md:text-[11px]">
          {o.payment_status==='paid'?'Thank you for your order':'Order details'}
        </p>
        <h1 className="mt-2 mb-0 text-[28px] leading-none font-bold tracking-[-0.02em] text-track-ink md:text-[34px]">Order #{o.number}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-track-muted md:text-[13px]">
          <span className="flex items-center gap-2">
            <Icon name="calendar" size={15} strokeWidth={1.8} className="shrink-0"/>
            Placed on {placed.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})} at {placed.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}
          </span>
          <span aria-hidden="true" className="hidden h-3.5 w-px bg-track-border sm:block"/>
          <span className="flex items-center gap-2">
            <Icon name="box" size={15} strokeWidth={1.8} className="shrink-0"/>
            {units} {units===1?'item':'items'}
          </span>
        </div>
      </div>
      <span className={`inline-flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-[12px] font-semibold capitalize ${PAYMENT_TONES[o.payment_status]??'bg-[#f3f4f6] text-track-muted'}`}>
        <Icon name="shield" size={15} strokeWidth={2}/>{o.payment_status}
      </span>
    </div>

    {o.status==='review'&&<p className={`${notice} mb-6`}>Your payment arrived after the reservation ended. The order is under review and a refund has been queued. It will not be shipped.</p>}
    {o.payment_status==='pending'&&<p className={`${notice} mb-6`}>Payment has not been confirmed. Only captured payments verified by the server complete an order.</p>}

    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.85fr)_minmax(320px,1fr)] lg:gap-7">
      <div className="min-w-0">
        <OrderProgress status={o.status}/>

        <OrderCard title={`Ordered items (${units})`} icon="bag" className="mb-6" bodyClassName="">
          <ul className="m-0 list-none p-0">
            {o.items.map(i=><li key={i.id} className="flex flex-wrap items-start gap-4 border-b border-track-border px-5 py-4 last:border-b-0 md:flex-nowrap md:gap-5 md:px-6 md:py-5">
              {/* A fixed, padded tile with object-contain. The catalogue
                  photography is square but the cut-outs inside it are not, so
                  cropping to fill would slice sleeves and hems off. */}
              <span className="grid size-[72px] shrink-0 place-items-center overflow-hidden rounded-[10px] bg-track-image md:size-[84px]">
                {i.image
                  ?<img src={i.image} alt={i.name} className="size-full object-contain p-1.5" loading="lazy"/>
                  :<Icon name="bag" size={24} strokeWidth={1.6} className="text-[#9ca3af]"/>}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="m-0 text-[14px] leading-snug font-semibold text-track-ink md:text-[15px]">{i.name}</h3>
                <p className="m-0 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-track-muted md:text-[13px]">
                  {[i.size,i.color].filter(Boolean).map((value,index,list)=><React.Fragment key={index}>
                    <span>{value}</span>
                    {index<list.length-1&&<span aria-hidden="true" className="text-track-border">|</span>}
                  </React.Fragment>)}
                </p>
                <p className="m-0 mt-1 text-[12px] text-track-muted md:text-[13px]">Qty: {i.quantity}</p>
              </div>
              <div className="shrink-0 text-right">
                <strong className="block text-[14px] font-bold text-track-ink tabular-nums md:text-[15px]">{money(i.quantity*i.unit_price,o.currency)}</strong>
                {/* The unit price is only worth a second line when it differs
                    from the line total. */}
                {i.quantity>1&&<small className="mt-1 block text-[11px] text-track-muted tabular-nums">{money(i.unit_price,o.currency)} each</small>}
              </div>
            </li>)}
          </ul>
        </OrderCard>

        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
          {/* No Edit action here. There is no endpoint that changes the
              delivery address on a placed order -- the address is a snapshot
              taken at checkout and is what the invoice and the Shiprocket
              booking were both built from -- so an Edit button would either do
              nothing or quietly disagree with the parcel already in transit. */}
          <OrderCard title="Delivery address" icon="pin">
            <address className="m-0 text-[13px] leading-relaxed text-track-muted not-italic">
              <strong className="mb-1 block font-semibold text-track-ink">{o.address.name}</strong>
              {o.address.line1}<br/>
              {o.address.line2&&<>{o.address.line2}<br/></>}
              {o.address.city}, {o.address.state} {o.address.postalCode}
              {o.address.phone&&<><br/><span className="mt-1.5 inline-block text-track-ink">{o.address.phone}</span></>}
            </address>
          </OrderCard>

          <ShipmentTracking id={id} placedAt={o.created_at}/>
        </div>

        {o.refund&&<OrderCard title="Refund" icon="refresh" className="mt-6">
          <p className="m-0 text-[13px] text-track-muted">
            <span className="font-semibold text-track-ink capitalize">{o.refund.status}</span> · {money(o.refund.amount,o.currency)}
          </p>
          {o.refund.reason&&<p className="m-0 mt-1.5 text-[13px] text-track-muted">{o.refund.reason}</p>}
        </OrderCard>}

        <OrderExchange order={o} onChange={reload}/>
      </div>

      <OrderSummaryCard order={o} units={units} onRefresh={reload} refreshing={refreshing}>
        {/* Retry and cancel belong above the invoice: an unpaid order has no
            invoice, and these are the only two things that can move it on. */}
        {o.status==='pending'&&<>
          <button type="button" className={buttonClasses('dark','w-full')} disabled={busy} onClick={async()=>{setBusy(true);try{const d=await api(`/orders/${id}/retry-payment`,{method:'POST'});await launchPayment(d,user,router,notify);}catch(e){notify(e.message);}finally{setBusy(false);}}}>Retry payment</button>
          <button type="button" className={buttonClasses('outline','w-full !border-track-border !text-track-ink hover:!bg-track-surface')} disabled={busy} onClick={()=>action(`/orders/${id}/cancel`)}>Cancel unpaid order</button>
        </>}
      </OrderSummaryCard>
    </div>
  </main>;
}


/**
 * Shipment tracking, as the customer sees it.
 *
 * Reads /orders/:id/tracking, which serves only what GEMIES has already stored
 * from a verified Shiprocket response. Nothing here is invented: before a
 * shipment exists the endpoint says so and this renders that sentence, and
 * before an AWB is issued it says the parcel is booked but not yet trackable.
 *
 * Polled while the parcel is moving, because the status changes without the
 * customer doing anything. Polling stops once it is delivered, returned or
 * cancelled -- there is nothing further to see.
 */
function ShipmentTracking({id,placedAt}){
  const {data,loading,error,reload}=useResource(`/orders/${id}/tracking`);
  const settled=['delivered','rto_delivered','cancelled'].includes(data?.stage);
  useEffect(()=>{
    if(!data||settled)return;
    const timer=setInterval(reload,60000);
    return()=>clearInterval(timer);
  },[data?.stage,settled]);

  const title='Shipping & tracking';
  if(loading&&!data)return <OrderCard title={title} icon="truck"><p className="m-0 text-[13px] text-track-muted">Loading…</p></OrderCard>;
  if(error)return <OrderCard title={title} icon="truck"><p className="m-0 text-[13px] text-track-muted">{error}</p></OrderCard>;
  if(!data)return null;

  // No shipment, or booked but no AWB yet. The server supplies the wording;
  // the milestones are still drawn, all but the first one upcoming, so the
  // empty state shows what is coming rather than only what is missing.
  if(!data.available){
    return <OrderCard title={title} icon="truck">
      <p className="m-0 mb-5 text-[12px] leading-relaxed text-track-muted md:text-[13px]">{data.message}</p>
      {/* `rank` is absent entirely when there is no shipment and present when
          the parcel is booked but has no AWB, so this covers both: nothing is
          claimed beyond "placed" in the first case, and a real booking is not
          understated in the second. */}
      <ShipmentSteps rank={data.rank??0} history={data.history??[]} placedAt={placedAt}/>
    </OrderCard>;
  }

  return <OrderCard title={title} icon="truck">
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-2 rounded-full bg-track-green-soft px-3 py-1.5 text-[12px] font-semibold text-track-green">
        <Icon name="truck" size={14} strokeWidth={2}/>{data.stage_label}
      </span>
      {data.provider_status&&data.provider_status!==data.stage_label&&
        <span className="text-[11px] text-track-muted">{data.provider_status}</span>}
    </div>

    <dl className="m-0 mb-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px] md:text-[13px]">
      {data.courier&&<><dt className="m-0 text-track-muted">Courier</dt><dd className="m-0 font-medium text-track-ink">{data.courier}</dd></>}
      <dt className="m-0 text-track-muted">Tracking no.</dt>
      <dd className="m-0 font-medium text-track-ink tabular-nums">{data.awb}</dd>
      {data.estimated_delivery&&data.stage!=='delivered'&&<>
        <dt className="m-0 text-track-muted">Expected</dt>
        <dd className="m-0 font-medium text-track-ink">{new Date(data.estimated_delivery).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</dd>
      </>}
      {data.delivered_at&&<>
        <dt className="m-0 text-track-muted">Delivered</dt>
        <dd className="m-0 font-medium text-track-ink">{new Date(data.delivered_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</dd>
      </>}
    </dl>

    <ShipmentSteps rank={data.rank??0} history={data.history} placedAt={placedAt}/>

    {data.tracking_url&&<a className="mt-5 inline-flex items-center gap-2 text-[12px] font-semibold text-track-green hover:underline hover:underline-offset-4" href={data.tracking_url} target="_blank" rel="noreferrer">
      Track on courier site<Icon name="arrow" size={14} strokeWidth={2.2}/>
    </a>}

    {/* The base stylesheet gives every <details> a bottom rule and 17px of
        vertical padding, which belongs to the FAQ accordions it was written
        for. Both are cancelled so this one sits flush inside the card. */}
    {data.history.length>0&&<details className="mt-5 !border-t !border-b-0 !border-track-border !py-0 text-[12px]">
      <summary className="cursor-pointer pt-4 font-semibold text-track-ink">Tracking history ({data.history.length})</summary>
      <ol className="m-0 mt-3 list-none space-y-3 p-0">
        {data.history.map((entry,index)=>
          <li key={`${entry.at}-${index}`} className="flex gap-3">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#d1d5db]" aria-hidden="true"/>
            <span className="min-w-0">
              <span className="block text-track-ink">{entry.status||entry.label}</span>
              <span className="mt-0.5 block text-track-muted">
                {[entry.location,entry.at?new Date(entry.at).toLocaleString():null].filter(Boolean).join(' · ')}
              </span>
            </span>
          </li>)}
      </ol>
    </details>}
  </OrderCard>;
}
