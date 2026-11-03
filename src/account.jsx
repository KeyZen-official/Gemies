'use client';
import React,{useState,useEffect,useRef} from 'react';
import Link from 'next/link';
import {useSearchParams,useRouter,useParams} from 'next/navigation';
import {api,money} from './api.js';
import {useStore,useResource,PageTitle,Field,Loading,Empty,ErrorState,AddressFields,Summary,Icon} from './components.jsx';
import {launchPayment} from './storefront.jsx';
import {Button,buttonClasses} from './components/ui/Button.jsx';
import {Pagination} from './components/ui/Pagination.jsx';
import {badgeClasses} from './components/ui/Badge.js';
import {AuthField} from './components/auth/AuthField.jsx';
import {Wallet} from './components/account/Wallet.jsx';
import {OrderExchange} from './components/account/ExchangeRequest.jsx';
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
function OrderView({id}){const {data:o,loading,error,reload}=useResource(`/orders/${id}`),{user,notify}=useStore(),router=useRouter(),[busy,setBusy]=useState(false);useEffect(()=>{if(o&&['pending','refunding'].includes(o.payment_status)){const t=setInterval(reload,10000);return()=>clearInterval(t);}},[o?.payment_status]);if(loading&&!o)return <Loading/>;if(error)return <ErrorState message={error} onRetry={reload}/>;if(!o)return null;async function action(path,body){setBusy(true);try{await api(path,{method:'POST',body});reload();}catch(e){notify(e.message);}finally{setBusy(false);}}return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-12 lg:pb-20"><div className="mb-6 flex flex-wrap items-center gap-2 text-[10px] text-ink-soft md:mb-8 md:gap-3 md:text-[11px] [&_a:hover]:text-ink"><Link href="/account">My account</Link><span>/</span>Order #{o.number}</div><PageTitle eyebrow={o.payment_status==='paid'?'THANK YOU FOR YOUR ORDER':'ORDER DETAILS'} title={`Order #${o.number}`} text={`Placed ${new Date(o.created_at).toLocaleString()}`}><span className={badgeClasses(o.payment_status)}>{o.payment_status}</span></PageTitle>{o.status==='review'&&<p className="rounded-[5px] border border-[#e6ddcb] bg-[#f5efe4] px-[18px] py-3.5 text-xs leading-relaxed text-[#765e35]">Your payment arrived after the reservation ended. The order is under review and a refund has been queued. It will not be shipped.</p>}{o.payment_status==='pending'&&<p className="rounded-[5px] border border-[#e6ddcb] bg-[#f5efe4] px-[18px] py-3.5 text-xs leading-relaxed text-[#765e35]">Payment has not been confirmed. Only captured payments verified by the server complete an order.</p>}<div className="grid grid-cols-1 items-start gap-9 lg:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)] lg:gap-[4%] xl:gap-[6%]"><div><div className="mt-0 mb-10 flex justify-between gap-[7px] border-b border-rule pb-6 md:mt-2.5 md:gap-2.5">{['confirmed','processing','shipped','delivered'].map((s,i)=><div key={s} className={`flex flex-col items-center gap-[9px] text-[9px] capitalize md:text-[10px] ${['confirmed','processing','shipped','delivered'].indexOf(o.status)>=i ? 'text-ink [&>span]:border-ink [&>span]:bg-ink [&>span]:text-white' : 'text-[#aaa]'}`}><span className="grid size-[26px] place-items-center rounded-full border border-[#ccc]">{['confirmed','processing','shipped','delivered'].indexOf(o.status)>=i?<Icon name="check" size={15}/>:i+1}</span>{s}</div>)}</div><div>{o.items.map(i=><div className="grid grid-cols-[75px_minmax(0,1fr)_auto] items-start gap-3 border-b border-rule py-[22px] first:pt-0 md:grid-cols-[105px_1fr_auto] md:gap-[23px] md:py-6" key={i.id}><img src={i.image} alt={i.name}/><div><h3>{i.name}</h3><p>{i.size} · {i.color}</p><p>Qty {i.quantity} × {money(i.unit_price,o.currency)}</p></div><strong>{money(i.quantity*i.unit_price,o.currency)}</strong></div>)}</div><div className="mt-7 grid grid-cols-1 gap-0 sm:grid-cols-2 sm:gap-5"><section className="mb-5 rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 [&_h2]:text-[21px] md:[&_h2]:text-[22px] [&_p]:text-xs"><h3>Delivery address</h3><p>{o.address.name}<br/>{o.address.line1}<br/>{o.address.line2}<br/>{o.address.city}, {o.address.state} {o.address.postalCode}<br/>{o.address.phone}</p></section><ShipmentTracking id={id}/></div>{o.refund&&<section className="mb-5 rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 [&_h2]:text-[21px] md:[&_h2]:text-[22px] [&_p]:text-xs"><h3>Refund</h3><p>{o.refund.status} · {money(o.refund.amount,o.currency)}</p><p>{o.refund.reason}</p></section>}</div><Summary quote={o}>{o.invoice?<a className={buttonClasses('outline','mt-3 w-full')} href={`/api/orders/${o.id}/invoice`}>Download invoice</a>:o.payment_status==='paid'&&<p>Invoice preparation is queued.</p>}{o.status==='pending'&&<><button className={buttonClasses('dark','mt-3 w-full')} disabled={busy} onClick={async()=>{setBusy(true);try{const d=await api(`/orders/${id}/retry-payment`,{method:'POST'});await launchPayment(d,user,router,notify);}catch(e){notify(e.message);}finally{setBusy(false);}}}>Retry payment</button><button className={buttonClasses('outline','mt-3 w-full')} disabled={busy} onClick={()=>action(`/orders/${id}/cancel`)}>Cancel unpaid order</button></>}<button className="py-2.5 text-[11px] underline underline-offset-4" onClick={reload}>Refresh order status</button></Summary><OrderExchange order={o} onChange={reload}/></div></main>;}


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
function ShipmentTracking({id}){
  const {data,loading,error,reload}=useResource(`/orders/${id}/tracking`);
  const settled=['delivered','rto_delivered','cancelled'].includes(data?.stage);
  useEffect(()=>{
    if(!data||settled)return;
    const timer=setInterval(reload,60000);
    return()=>clearInterval(timer);
  },[data?.stage,settled]);

  const card='mb-5 rounded-lg border border-rule bg-white p-[22px] md:mb-6 md:p-7 [&_h2]:text-[21px] md:[&_h2]:text-[22px] [&_p]:text-xs';
  if(loading&&!data)return <section className={card}><h3>Shipping &amp; tracking</h3><p>Loading…</p></section>;
  if(error)return <section className={card}><h3>Shipping &amp; tracking</h3><p>{error}</p></section>;
  if(!data)return null;

  // No shipment, or no AWB yet. The server supplies the wording.
  if(!data.available){
    return <section className={card}>
      <h3>Shipping &amp; tracking</h3>
      <p>{data.message}</p>
      {data.stage_label&&<p className="text-ink-soft">{data.stage_label}</p>}
    </section>;
  }

  return <section className={card}>
    <h3>Shipping &amp; tracking</h3>
    <p className="font-semibold text-ink">{data.stage_label}</p>
    <p>
      {data.courier||'Courier'}<br/>
      AWB: {data.awb}
      {data.provider_status&&data.provider_status!==data.stage_label&&<><br/><span className="text-ink-soft">{data.provider_status}</span></>}
    </p>
    {data.estimated_delivery&&data.stage!=='delivered'&&
      <p>Estimated delivery: {new Date(data.estimated_delivery).toLocaleDateString()}</p>}
    {data.delivered_at&&
      <p>Delivered {new Date(data.delivered_at).toLocaleString()}</p>}
    {data.tracking_url&&
      <a className="mt-6 inline-block border-b border-[#aaa] pb-[5px] text-xs" href={data.tracking_url} target="_blank" rel="noreferrer">Track shipment</a>}
    {data.history.length>0&&<div className="mt-7 border-t border-rule pt-6">
      <h4 className="m-0 mb-3 text-xs font-semibold tracking-[0.08em] text-ink-soft uppercase">Tracking history</h4>
      <ol className="m-0 list-none space-y-3 p-0">
        {data.history.map((entry,index)=>
          <li key={`${entry.at}-${index}`} className="flex gap-3 text-xs">
            <span className="mt-[6px] size-1.5 shrink-0 rounded-full bg-[#ccc]" aria-hidden/>
            <span className="min-w-0">
              <span className="block text-ink">{entry.status||entry.label}</span>
              <span className="mt-0.5 block text-ink-soft">
                {[entry.location,entry.at?new Date(entry.at).toLocaleString():null].filter(Boolean).join(' · ')}
              </span>
            </span>
          </li>)}
      </ol>
    </div>}
  </section>;
}
