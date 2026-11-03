'use client';
import React,{useState,useEffect} from 'react';
import Link from 'next/link';
import {useParams,useRouter} from 'next/navigation';
import {api,money} from './api.js';
import {infoTitles,infoBodies,infoSettingKeys,contactBody} from './info-content.js';
import {useStore,useResource,useQueryParams,Loading,ErrorState,Empty,PageTitle,Icon,Field,Summary,AddressFields} from './components.jsx';
import {ProductGrid} from './components/ProductGrid.jsx';
import {CategoryBrowser} from './components/shop/CategoryBrowser.jsx';
import {HomeRail} from './components/HomeRail.jsx';
import {PromoCard} from './components/PromoCard.jsx';
import {OfferCard} from './components/OfferCard.jsx';
import {HomeCollection} from './components/HomeCollection.jsx';
import {RecommendedCollections} from './components/RecommendedCollections.jsx';
import {BottomPromoBanner} from './components/BottomPromoBanner.jsx';
import {ContactForm} from './components/ContactForm.jsx';
import {promoCards,justDropped,homeCollections} from './data/home-content.js';
import {Container} from './components/ui/Container.jsx';
import {Button,buttonClasses} from './components/ui/Button.jsx';
import {Pagination} from './components/ui/Pagination.jsx';
import {WalletRedemption} from './components/checkout/WalletRedemption.jsx';
// Each product section fetches its own products through HomeCollection, keyed
// to the query on its entry in home-content.js. There is no single catalogue
// fetch split up here any more -- see the note in HomeCollection.jsx for what
// that was doing wrong.
export function Home(){
  return <>
    {/* The clothing rail replaces the photographic HeroBanner. That component
        is still in src/components/HeroBanner.jsx, unused, so swapping back is
        this one line. */}
    <HomeRail/>
    <Container as="main" className="pb-8 md:pb-11">
      {/* Three equal columns with the reference's 14px gutter (gap-3.5), two
          on tablet, one on mobile. Three columns start at xl rather than lg:
          at 1024px a third of the container leaves 251px of text width, and
          the longest heading measures 319px at 30px Manrope, so it would wrap
          onto a third line and squeeze the garment. Two wider columns there
          keep both the heading and the product at full size. */}
      <section className="mt-6 grid grid-cols-1 gap-3.5 md:mt-8 md:grid-cols-2 lg:mt-12 xl:grid-cols-3" aria-label="Featured promotions">
        {promoCards.map(card=><PromoCard key={card.id} card={card}/>)}
        <OfferCard/>
      </section>

      {/* The first grid on the page, so its top row loads eagerly. */}
      <HomeCollection section={justDropped} priorityCount={4}/>

      <RecommendedCollections/>

      {/* Shirts, then Bottom Wear. Both read their products from the category
          endpoint, so each heading can only ever show its own category. */}
      {homeCollections.map(section=>
        <HomeCollection key={section.id} section={section} align="split"/>)}

      <BottomPromoBanner/>
    </Container>
  </>;
}
// /shop renders the same listing as a category page, with no category
// applied. Both go through CategoryBrowser so filters, sorting, paging and
// the empty states exist in one place.
export function Shop(){return <CategoryBrowser/>;}
export function Cart(){const {cart,refreshCart,user,ready,config,notify}=useStore();if(!ready)return <Loading/>;if(!user)return <Empty title="Your bag, saved for you" text="Sign in to build your bag and keep it across devices." link="/login?next=/cart" label="Sign in"/>;async function update(item,quantity){try{await api(`/cart/items${quantity? '':'/'+item.variant_id}`,{method:quantity?'PUT':'DELETE',...(quantity?{body:{variantId:item.variant_id,quantity}}:{})});await refreshCart();}catch(e){notify(e.message);}}return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-12 lg:pb-20"><PageTitle eyebrow="GOOD CHOICES" title="Your shopping bag" text={`${cart.items.reduce((n,i)=>n+i.quantity,0)} items in your rotation`}/>{!cart.items.length?<Empty title="Your bag is waiting" text="Find a pair you love and make it yours."/>:<div className="grid grid-cols-1 items-start gap-9 lg:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)] lg:gap-[4%] xl:gap-[6%]"><div>{cart.items.map(i=><article key={i.variant_id} className="grid grid-cols-[75px_minmax(0,1fr)_auto] items-start gap-3 border-b border-rule py-[22px] first:pt-0 md:grid-cols-[105px_1fr_auto] md:gap-[23px] md:py-6"><Link href={`/product/${i.slug}`}><img src={i.images[0]} alt={i.name}/></Link><div><Link href={`/product/${i.slug}`}><h3>{i.name}</h3></Link><p>{i.size} · {i.color}</p><div className="inline-flex min-h-8 items-center justify-center gap-[11px] rounded-[30px] border border-[#d4d4cd] px-[7px] py-[5px] text-[11px] md:gap-3.5 md:px-[9px]"><button aria-label={`Decrease ${i.name} quantity`} onClick={()=>update(i,i.quantity-1)}><Icon name="minus" size={14}/></button><span>{i.quantity}</span><button aria-label={`Increase ${i.name} quantity`} disabled={i.quantity>=Math.min(i.available,20)} onClick={()=>update(i,i.quantity+1)}><Icon name="plus" size={14}/></button></div><button className="py-2.5 text-[11px] underline underline-offset-4" onClick={()=>update(i,0)}>Remove</button>{i.available<i.quantity&&<p className="text-xs text-[#a83329]">Stock changed. Please update this item.</p>}</div><strong>{money(i.price*i.quantity,config.currency)}</strong></article>)}<Link className="mt-6 inline-block border-b border-[#aaa] pb-[5px] text-xs" href="/shop">← Continue shopping</Link></div><Summary quote={cart}><Link className={buttonClasses('dark','mt-3 w-full')} href="/checkout">Continue to checkout<Icon name="arrow" size={17}/></Link></Summary></div>}</main>;}
export async function launchPayment(data,user,router,notify){if(!window.Razorpay){await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://checkout.razorpay.com/v1/checkout.js';script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Payment checkout could not load. Retry from your order page.'));};document.head.appendChild(script);});}const checkout=new window.Razorpay({key:data.key,amount:data.amount,currency:data.currency,order_id:data.gatewayOrderId,name:'Gemies',description:'Your everyday essentials',prefill:{name:user.name,email:user.email},theme:{color:'#111111'},handler:async response=>{try{await api('/payments/verify',{method:'POST',body:{orderId:data.orderId,...response}});notify('Payment verified. Thank you for your order.');}catch(e){notify(`${e.message} Check your order for the final payment status.`);}router.push(`/orders/${data.orderId}`);},modal:{ondismiss:()=>{notify('Payment window closed. Your pending order is saved.');router.push(`/orders/${data.orderId}`);}}});checkout.on('payment.failed',()=>notify('Payment was not completed. You can retry from your order.'));checkout.open();}
export function Checkout(){const {user,ready,cart,config,notify,refreshCart}=useStore(),router=useRouter(),[address,setAddress]=useState({country:'India'}),[addresses,setAddresses]=useState([]),[coupon,setCoupon]=useState(''),[q,setQ]=useState(null),[busy,setBusy]=useState(false),[save,setSave]=useState(false),[key,setKey]=useState(()=>crypto.randomUUID()),[useWallet,setUseWallet]=useState(false),[offer,setOffer]=useState(null);useEffect(()=>{if(user)api('/auth/addresses').then(setAddresses).catch(e=>notify(e.message));},[user?.id]);
  // A fresh idempotency key whenever anything that changes the order changes,
  // so a retry after an edit is a new checkout rather than a replay of the old
  // one. `useWallet` is in here too: the redemption is part of the order.
  useEffect(()=>{setQ(null);setKey(crypto.randomUUID());},[address,coupon,useWallet]);
  // The wallet offer is the server's, re-read whenever the order value could
  // have moved. Nothing about the discount is computed in the browser.
  useEffect(()=>{let live=true;if(!user||!cart.items.length){setOffer(null);return;}api('/checkout/quote',{method:'POST',body:{address,coupon,useWallet}}).then(r=>{if(live){setOffer(r.wallet??null);setQ(r);}}).catch(()=>{if(live)setOffer(null);});return()=>{live=false;};},[user?.id,coupon,useWallet,cart.items.length]);if(!ready)return <Loading/>;if(!user)return <Empty title="Let’s make it yours" text="Sign in to securely complete your checkout." link="/login?next=/checkout" label="Sign in"/>;if(!cart.items.length)return <Empty title="Your bag is empty" text="Add your favourites before checking out."/>;
  // Whether coins settle the whole order. Read off the server's offer against
  // the server's total, never computed from a balance the browser holds.
  const total=(q||cart).total;const walletCovers=useWallet&&Boolean(offer?.allowed)&&offer.inr>=total;
  return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-12 lg:pb-20"><PageTitle eyebrow="ONE STEP CLOSER" title="Checkout" text="A few details, then your new favourites are on their way."/><form className="grid grid-cols-1 items-start gap-9 lg:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)] lg:gap-[4%] xl:gap-[6%]" onSubmit={async e=>{e.preventDefault();setBusy(true);try{const quote=await api('/checkout/quote',{method:'POST',body:{address,coupon,useWallet}});setQ(quote);setOffer(quote.wallet??null);if(save){await api('/auth/addresses',{method:'POST',body:address});setSave(false);}
      const data=await api('/checkout',{method:'POST',headers:{'Idempotency-Key':key},body:{address,coupon,useWallet}});
      // A wallet-only order is already paid and confirmed by the time the
      // server answers, so there is no gateway to open. Going to Razorpay for
      // a zero-rupee payment would fail, and treating this as a normal
      // payment would ask the customer to pay nothing.
      if(data.walletOnly){notify('Order placed with your GEMIES coins.');await refreshCart();router.push(`/orders/${data.orderId}`);return;}
      await launchPayment(data,user,router,notify);}catch(e){notify(e.message);}finally{setBusy(false);}}}><div className="grid grid-cols-1 [&>section]:mb-7 [&>section]:border-b [&>section]:border-rule [&>section]:pb-7 [&_h2]:mb-[22px] [&_h2]:text-xl [&_p]:text-[13px]"><section><h2>01 / Contact</h2><p>{user.name} · {user.email}</p></section><section><h2>02 / Delivery address</h2>{addresses.length>0&&<label className="mb-[18px] flex flex-col gap-2.5 text-[11px] md:mb-5 md:text-xs [&>span]:font-medium"><span>Use a saved address</span><select defaultValue="" onChange={e=>{const a=addresses.find(x=>x.id===e.target.value);if(a)setAddress(a.details);}}><option value="">Enter a new address</option>{addresses.map(a=><option value={a.id} key={a.id}>{a.details.name} — {a.details.line1}</option>)}</select></label>}<AddressFields value={address} onChange={setAddress}/><label className="my-4 mb-6 flex items-center gap-2.5 text-xs [&_input]:h-4 [&_input]:min-h-4 [&_input]:w-4 [&_input]:accent-ink"><input type="checkbox" checked={save} onChange={e=>setSave(e.target.checked)}/>Save this address to my account</label></section><section><h2>03 / Payment</h2><div className="flex items-center gap-[18px] rounded-[5px] border border-[#bbb] p-[18px] [&_p]:mt-1.5 [&_p]:mb-0 [&_p]:text-[11px] [&_strong]:text-[13px]"><Icon name="shield"/><div><strong>Razorpay secure checkout</strong><p>Pay with the methods enabled by the store’s payment account.</p></div></div>{!config.payments&&!walletCovers&&<p className="rounded-[5px] border border-[#e6ddcb] bg-[#f5efe4] px-[18px] py-3.5 text-xs leading-relaxed text-[#765e35]">Card payments are not configured yet. You can save your bag and return when checkout is available{offer?.enabled&&offer.availableCoins>0?', or pay with GEMIES coins if they cover the order in full':''}.</p>}
      {walletCovers&&<p className="rounded-[5px] border border-[#cfe0c4] bg-[#eaf0e6] px-[18px] py-3.5 text-xs leading-relaxed text-[#3d5b2d]">Your GEMIES coins cover this order in full. No card payment is needed and none will be taken.</p>}</section></div><Summary quote={q||cart}><div className="hidden border-t border-[#d6d6ce] pt-[15px] lg:block [&>div]:my-3 [&>div]:flex [&>div]:items-center [&>div]:gap-3 [&>div]:text-[11px] [&_img]:h-12 [&_img]:w-[45px] [&_img]:object-contain [&_small]:mt-[5px] [&_small]:block [&_small]:text-[10px] [&_small]:text-[#888]">{cart.items.map(i=><div key={i.variant_id}><img src={i.images[0]} alt=""/><span>{i.name}<small>{i.size} · Qty {i.quantity}</small></span></div>)}</div><div className="my-6 mb-2.5 flex rounded-[5px] bg-white"><input placeholder="Discount code" aria-label="Discount code" value={coupon} onChange={e=>setCoupon(e.target.value)}/><button type="button" onClick={async()=>{try{const result=await api('/checkout/quote',{method:'POST',body:{address,coupon,useWallet}});setQ(result);setOffer(result.wallet??null);notify(coupon?'Discount applied.':'Totals updated.');}catch(e){notify(e.message);}}}>Apply</button></div>
      <WalletRedemption offer={offer} total={(q||cart).total} currency={config.currency} checked={useWallet} onChange={setUseWallet} disabled={busy}/>
      {/* A wallet-only order needs no gateway, so it must not be blocked by the
          gateway being unconfigured. Anything with a remainder to collect still
          is. */}
      <button className={buttonClasses('dark','mt-3 w-full')} disabled={busy||(!config.payments&&!walletCovers)}>{busy?(walletCovers?'Placing your order…':'Preparing secure payment…'):(walletCovers?'Place order with coins':'Pay securely')}<Icon name="arrow" size={17}/></button><p className="text-[11px] leading-relaxed [&_a]:underline">By placing an order, you accept our <Link href="/info/terms">terms</Link>. Final prices and availability are checked before payment.</p></Summary></form></main>;}
export function Wishlist(){const {user,ready}=useStore();return !ready?<Loading/>:!user?<Empty title="Keep your favourites close" text="Sign in to save the pieces you love." link="/login?next=/wishlist" label="Sign in"/>:<Saved/>;}
function Saved(){
  const [page,setPage]=useState(1);
  const {data,loading,error,refreshing,reload}=useResource(`/wishlist?page=${page}&limit=12`);
  const {notify,refreshWishlist}=useStore();
  const rows=data?.rows??[];
  // Removing the last item on a page would otherwise leave the view on an empty
  // page with no way back except the pager.
  async function remove(product){
    try{
      await api(`/wishlist/${product.id}`,{method:'DELETE'});
      await refreshWishlist();
      if(rows.length===1&&page>1)setPage(page-1); else reload();
    }catch(e){notify(e.message);}
  }
  return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-12 lg:pb-20">
    <PageTitle eyebrow="YOUR PERSONAL EDIT" title="Saved favourites" text={data?.total?`${data.total} saved ${data.total===1?'piece':'pieces'}`:undefined}/>
    {loading?<Loading/>:error?<ErrorState message={error} onRetry={reload}/>:rows.length?<>
      <div className={refreshing?'opacity-60 transition-opacity':'transition-opacity'}>
        <ProductGrid products={rows}/>
      </div>
      <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
        {rows.map(p=><button key={p.id} className="py-2.5 text-[13px] underline underline-offset-4" onClick={()=>remove(p)}>Remove {p.name}</button>)}
      </div>
      <Pagination page={data.page} pages={data.pages} total={data.total} unit="saved" onPage={next=>{setPage(next);window.scrollTo({top:0,behavior:'smooth'});}}/>
    </>:<Empty title="A little inspiration goes a long way" text="Tap the heart on a product to save it here."/>}
  </main>;
}
export function Brands(){return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-12 lg:pb-20"><PageTitle eyebrow="THE NAMES YOU KNOW" title="Explore our brands" text="Discover the labels in the Gemies collection."/><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-5">{['Nike','Adidas','Puma','New Balance'].map(b=><Link href={`/shop?brand=${encodeURIComponent(b)}`} key={b}><h2 className="text-[27px] md:text-[32px] lg:text-[40px]">{b}</h2><span>Shop collection <Icon name="arrow"/></span></Link>)}</div></main>;}
export function Info(){const {page}=useParams(),{config}=useStore();const settingKey=infoSettingKeys[page];const body=settingKey?config.settings[settingKey]:page==='contact'?contactBody(config.settings.support_email):infoBodies[page];return <main className="mx-auto min-h-[500px] w-[calc(100%-24px)] max-w-shell pt-6 pb-11 md:w-[calc(100%-32px)] md:pt-8 md:pb-14 lg:w-[calc(100%-64px)] lg:pt-12 lg:pb-20 max-w-[900px]"><PageTitle title={infoTitles[page]||'Page not found'}/><p className="text-[15px] leading-[1.9] whitespace-pre-wrap">{body||'The store has not published this policy yet. Please contact the store before placing an order.'}</p>{page==='contact'&&config.settings.support_email&&<a className={buttonClasses('dark')} href={`mailto:${config.settings.support_email}`}>Email support</a>}{/* The form posts to the server, which validates, rate-limits and queues both the enquiry and the customer acknowledgement. */}{page==='contact'&&<ContactForm/>}<Link className="mt-6 inline-block border-b border-[#aaa] pb-[5px] text-xs" href="/shop">Explore the collection →</Link></main>;}
