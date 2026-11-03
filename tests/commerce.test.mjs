import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {startMongo,stopMongo} from './mongo-harness.mjs';
process.env.NODE_ENV='test';process.env.STORE_CURRENCY='INR';
process.env.APP_URL='http://localhost:3000';process.env.RAZORPAY_KEY_ID='rzp_test_fixture';process.env.RAZORPAY_KEY_SECRET='fixture-secret';process.env.RAZORPAY_WEBHOOK_SECRET='fixture-webhook';
process.env.SHIPROCKET_EMAIL='fixture@example.invalid';process.env.SHIPROCKET_PASSWORD='fixture';process.env.SHIPROCKET_PICKUP_LOCATION='fixture';process.env.PACKAGE_WEIGHT_KG='1';process.env.PACKAGE_LENGTH_CM='30';process.env.PACKAGE_BREADTH_CM='20';process.env.PACKAGE_HEIGHT_CM='12';
process.env.BUSINESS_NAME='TEST FIXTURE — NOT A REAL INVOICE';process.env.BUSINESS_ADDRESS='Test address only';process.env.BUSINESS_EMAIL='fixture@example.invalid';process.env.RESEND_API_KEY='fixture';process.env.EMAIL_FROM='fixture@example.invalid';
// An isolated in-memory replica set, started before anything under server/ is
// imported so those modules connect to it and never to Atlas.
await startMongo();
const mongo=await import('../server/mongo.mjs');
const {users,categories,products,variants,cartItems,orders,payments,paymentAttempts,refunds,invoices,jobs,emailNotifications,webhookEvents,contactMessages,rateLimits,transaction}=mongo;
/** `SELECT count(*)::int AS n FROM c WHERE ...`, keeping the `.n` shape. */
const countN=async(collection,filter={})=>({n:await collection().countDocuments(filter)});
/** `SELECT COALESCE(sum(field),0)::int AS n FROM c`. */
const sumN=async(collection,field)=>{
  const [row]=await collection().aggregate([{$group:{_id:null,n:{$sum:`$${field}`}}}]).toArray();
  return {n:row?.n??0};
};
const {app}=await import('../server/app.mjs');const {id,passwordHash,passwordMatches,validSignature}=await import('../server/security.mjs');const {totals,createOrder,paymentOrder,acceptCapturedPayment,releaseOrder}=await import('../server/commerce.mjs');const {createShipment,syncTracking,requestRefund,refundableBalance}=await import('../server/fulfillment.mjs');const {createInvoice,invoicePdf}=await import('../server/invoices.mjs');const {runJob}=await import('../server/jobs.mjs');
let server,base,customer,other,adminUser,productId,variantId,categoryId,paidOrder;const nativeFetch=globalThis.fetch;const remotes=new Map(),providerCalls=[];let providerFailure='',trackStatus=6,awbSeq=0,lastAwb='TEST-AWB-0';
globalThis.fetch=async(url,options={})=>{if(String(url).startsWith(base||'http://never.invalid'))return nativeFetch(url,options);const address=new URL(url);providerCalls.push({path:address.pathname,body:options.body?JSON.parse(options.body):null});if(providerFailure&&address.pathname.includes(providerFailure))throw new Error('Simulated connection failure');const payload=options.body?JSON.parse(options.body):{};let data;
  if(address.hostname==='api.razorpay.com'){const key=address.pathname.replace('/v1','');if(key==='/orders'&&options.method==='POST'){data={id:`order_${randomUUID().replaceAll('-','')}`,amount:payload.amount,currency:payload.currency,receipt:payload.receipt};remotes.set(data.id,data);}else if(key.startsWith('/payments/')&&key.endsWith('/refund')){data={id:`rfnd_${randomUUID().replaceAll('-','')}`,payment_id:key.split('/')[2],amount:payload.amount,receipt:payload.receipt,status:'processed'};remotes.set(data.id,data);}else if(key.endsWith('/refunds'))data={items:[...remotes.values()].filter(x=>x.payment_id===key.split('/')[2])};else data=remotes.get(key.split('/').at(-1));}
  else if(address.hostname==='apiv2.shiprocket.in'){if(address.pathname.endsWith('/auth/login'))data={token:'test-shipping-token'};else if(address.pathname.endsWith('/orders/create/adhoc'))data={order_id:1234,shipment_id:5678};else if(address.pathname.endsWith('/courier/assign/awb')){awbSeq+=1;lastAwb=`TEST-AWB-${awbSeq}`;data={response:{data:{awb_code:lastAwb,courier_name:'Test courier',courier_company_id:11}}};}else if(address.pathname.includes('/courier/track/')){const ref=address.pathname.split('/').at(-1);const awbFor=address.pathname.includes('/track/awb/')?ref:`AWB-SHIP-${ref}`;data={tracking_data:{track_status:1,shipment_status:trackStatus,track_url:'https://example.invalid/track',shipment_track:[{current_status:trackStatus===7?'Delivered':'In Transit',current_status_code:trackStatus,awb_code:awbFor,courier_name:'Test courier',edd:'2026-02-01 18:00:00',...(trackStatus===7?{delivered_date:'2026-01-31 12:00:00'}:{})}],shipment_track_activities:[{status:trackStatus===7?'Delivered':'In Transit',activity:'Scan',location:'Mumbai',date:'2026-01-30 09:00:00'}]}};}}
  else if(address.hostname==='api.resend.com')data={id:'test-email-id'};
  if(!data)throw new Error(`Unexpected test provider call: ${url}`);return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};
async function request(route,{method='GET',body,session,headers={}}={}){const response=await nativeFetch(`${base}/api${route}`,{method,headers:{Origin:process.env.APP_URL,...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});const data=response.headers.get('content-type')?.includes('json')?await response.json():await response.arrayBuffer();return {status:response.status,data,headers:response.headers};}
async function fixtureUser(name,role='customer'){const uid=id(),email=`${name}@example.invalid`;await users().insertOne({_id:uid,id:uid,name,email,password_hash:await passwordHash('a-very-secure-test-password'),verified:true,role,created_at:new Date()});const response=await request('/auth/login',{method:'POST',body:{email,password:'a-very-secure-test-password'}});assert.equal(response.status,200);return {id:uid,name,email,role,cookie:response.headers.get('set-cookie').split(';')[0],csrf:response.data.user.csrf};}
const address={name:'Fixture Customer',phone:'9876543210',line1:'123 Test street',line2:'',city:'Test City',state:'Test State',postalCode:'400001',country:'India'};
async function addToCart(user=customer,quantity=1,vid=variantId){await cartItems().updateOne({user_id:user.id,variant_id:vid},{$set:{user_id:user.id,variant_id:vid,quantity}},{upsert:true});}
async function capturedOrder(user=customer){await addToCart(user);const order=await createOrder(user,{address,coupon:''},id());const p=await paymentOrder(order.id);const payment={id:`pay_${randomUUID().replaceAll('-','')}`,order_id:p.gateway_order_id,amount:p.amount,currency:p.currency,status:'captured',captured:true};remotes.set(payment.id,payment);await acceptCapturedPayment(payment);return {order,p,payment};}
before(async()=>{await mongo.connect();await mongo.ensureSchema();server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;customer=await fixtureUser('customer');other=await fixtureUser('other');adminUser=await fixtureUser('admin','admin');categoryId=id();productId=id();variantId=id();
  await categories().insertOne({_id:categoryId,id:categoryId,name:'Sneakers',slug:'sneakers',segment:'sneakers',parent_id:null,in_nav:true,display_order:0});
  await products().insertOne({_id:productId,id:productId,slug:'test-shoe',name:'Test shoe',description:'Fixture product for tests only.',brand:'Test brand',category_id:categoryId,audience:'Unisex',price:18000,compare_price:null,images:['/assets/products/regular-black-02.webp'],published:true,featured:false,is_demo:false,display_order:0,swatches:[],colorways:[],fit:null,fabric:null,created_at:new Date()});
  await variants().insertOne({_id:variantId,id:variantId,product_id:productId,sku:'TEST-UK8',size:'UK 8',color:'Test',stock:100,reserved:0});});
after(async()=>{globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));await mongo.close();await stopMongo();});
test('passwords are salted, hashed, and checked securely',async()=>{const a=await passwordHash('long-test-passphrase'),b=await passwordHash('long-test-passphrase');assert.notEqual(a,b);assert.ok(await passwordMatches('long-test-passphrase',a));assert.equal(await passwordMatches('wrong',a),false);});
test('registration requires email verification; verification tokens are one-use',async()=>{let r=await request('/auth/register',{method:'POST',body:{name:'New customer',email:'new@example.invalid',password:'a-long-test-passphrase'}});assert.equal(r.status,202);r=await request('/auth/login',{method:'POST',body:{email:'new@example.invalid',password:'a-long-test-passphrase'}});assert.equal(r.status,403);const job=await jobs().findOne({kind:'email','payload.recipient':'new@example.invalid',dedupe_key:/^verify:/});const raw=job.payload.data.url.match(/token=([a-f0-9]+)/)[1];r=await request('/auth/verify',{method:'POST',body:{token:raw}});assert.equal(r.status,200);assert.equal((await request('/auth/verify',{method:'POST',body:{token:raw}})).status,400);r=await request('/auth/login',{method:'POST',body:{email:'new@example.invalid',password:'a-long-test-passphrase'}});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Lax/);});
test('password reset invalidates all existing sessions and cannot be replayed',async()=>{await request('/auth/forgot',{method:'POST',body:{email:other.email}});const job=await jobs().findOne({'payload.recipient':other.email,dedupe_key:/^reset:/});const raw=job.payload.data.url.match(/token=([a-f0-9]+)/)[1];const r=await request('/auth/reset',{method:'POST',body:{token:raw,password:'a-new-long-passphrase'}});assert.equal(r.status,200);assert.equal((await request('/cart',{session:other})).status,401);assert.equal((await request('/auth/reset',{method:'POST',body:{token:raw,password:'a-new-long-passphrase'}})).status,400);const login=await request('/auth/login',{method:'POST',body:{email:other.email,password:'a-new-long-passphrase'}});other.cookie=login.headers.get('set-cookie').split(';')[0];other.csrf=login.data.user.csrf;});
test('authentication, administrative authorization and CSRF are enforced',async()=>{assert.equal((await request('/cart')).status,401);assert.equal((await request('/admin/dashboard',{session:customer})).status,403);assert.equal((await request('/admin/dashboard',{session:adminUser})).status,200);assert.equal((await request('/auth/profile',{method:'PATCH',session:customer,headers:{Origin:'https://evil.invalid'},body:{name:'attacker'}})).status,403);assert.equal((await request('/auth/profile',{method:'PATCH',session:customer,headers:{'X-CSRF-Token':''},body:{name:'attacker'}})).status,403);});
test('search, category filtering, pagination, and malicious search input are safe',async()=>{let r=await request('/products?q=shoe&category=sneakers&limit=1');assert.equal(r.data.products.length,1);assert.equal(r.data.products[0].id,productId);r=await request('/products?q=%27%3BDROP%20TABLE%20users%3B--');assert.equal(r.status,200);assert.ok((await countN(users)).n>=4);assert.equal((await request('/products?sort=invalid')).status,400);});
test('cart rejects invalid quantities and persists across requests',async()=>{assert.equal((await request('/cart/items',{method:'PUT',session:customer,body:{variantId,quantity:-1}})).status,400);assert.equal((await request('/cart/items',{method:'PUT',session:customer,body:{variantId,quantity:2}})).status,200);assert.equal((await request('/cart',{session:customer})).data.items[0].quantity,2);});
// `tax_bps` is returned alongside the amounts so createOrder can record the
// rate the order was charged at. The invoice prints a tax rate per line, and
// dividing it back out of the total is wrong the moment the rate changes in
// settings.
test('server totals use integer minor units, configured tax, shipping and coupons',()=>{assert.deepEqual(totals([{price:10001,quantity:2}],{shipping:500,free_shipping_threshold:30000,tax_bps:1800},{percent:10,minimum:0}),{subtotal:20002,discount:2000,shipping:500,tax:3240,total:21742,tax_bps:1800});});
test('checkout rejects client totals and malformed addresses',async()=>{assert.equal((await request('/checkout/quote',{method:'POST',session:customer,body:{address,coupon:'',total:1}})).status,400);assert.equal((await request('/checkout/quote',{method:'POST',session:customer,body:{address:{...address,postalCode:'0'},coupon:''}})).status,400);});
test('order creation is idempotent and reserves stock exactly once',async()=>{await addToCart(customer,2);const key=id();const [a,b]=await Promise.all([createOrder(customer,{address,coupon:''},key),createOrder(customer,{address,coupon:''},key)]);assert.equal(a.id,b.id);assert.equal(a.total,36000);assert.equal((await variants().findOne({_id:variantId})).reserved,2);await assert.rejects(createOrder(customer,{address:{...address,city:'Other'},coupon:''},key),/details changed/);await transaction(session=>releaseOrder(a.id,session));});
test('concurrent customers cannot oversell inventory',async()=>{const v=id();await variants().insertOne({_id:v,id:v,product_id:productId,sku:'LAST-PAIR',size:'UK 9',color:'Test',stock:1,reserved:0});await cartItems().deleteMany({user_id:{$in:[customer.id,other.id]}});await addToCart(customer,1,v);await addToCart(other,1,v);const results=await Promise.allSettled([createOrder(customer,{address,coupon:''},id()),createOrder(other,{address,coupon:''},id())]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await variants().findOne({_id:v})).reserved,1);for(const r of results)if(r.status==='fulfilled')await transaction(session=>releaseOrder(r.value.id,session));await cartItems().deleteMany({variant_id:v});});
test('invalid signatures and authorized-but-uncaptured payments are rejected',async()=>{assert.equal(validSignature('body','bad','secret'),false);await assert.rejects(acceptCapturedPayment({status:'authorized',captured:false}),/not captured/);await addToCart();const o=await createOrder(customer,{address,coupon:''},id());const p=await paymentOrder(o.id);assert.equal((await request('/payments/verify',{method:'POST',session:customer,body:{orderId:o.id,razorpay_payment_id:'pay_fake',razorpay_order_id:p.gateway_order_id,razorpay_signature:'0'.repeat(64)}})).status,400);await assert.rejects(acceptCapturedPayment({id:'pay_wrong',order_id:p.gateway_order_id,status:'captured',captured:true,amount:1,currency:'INR'}),/amount or currency/);await transaction(session=>releaseOrder(o.id,session));});
test('captured payments consume inventory once and deduplicate financial jobs',async()=>{const before=(await variants().findOne({_id:variantId})).stock;paidOrder=await capturedOrder();await Promise.all([acceptCapturedPayment(paidOrder.payment),acceptCapturedPayment(paidOrder.payment)]);const v=await variants().findOne({_id:variantId});assert.equal(v.stock,before-1);assert.equal(v.reserved,0);const invoiceJobs=await countN(jobs,{dedupe_key:`invoice:${paidOrder.order.id}`});assert.equal(invoiceJobs.n,1);assert.equal((await request(`/orders/${paidOrder.order.id}`,{session:other})).status,404);});
test('signed webhook duplicates do not repeat fulfillment or stock consumption',async()=>{const body=JSON.stringify({event:'payment.captured',payload:{payment:{entity:{id:paidOrder.payment.id}}}});const signature=createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');for(let i=0;i<2;i++){const response=await nativeFetch(`${base}/api/webhooks/razorpay`,{method:'POST',headers:{'Content-Type':'application/json','X-Razorpay-Signature':signature},body});assert.equal(response.status,200);}assert.equal((await countN(webhookEvents)).n,1);const bad=await nativeFetch(`${base}/api/webhooks/razorpay`,{method:'POST',headers:{'Content-Type':'application/json','X-Razorpay-Signature':'bad'},body});assert.equal(bad.status,400);});
test('late captured payments are held for refund without fulfillment',async()=>{await addToCart();const o=await createOrder(customer,{address,coupon:''},id());const p=await paymentOrder(o.id);await transaction(session=>releaseOrder(o.id,session));await acceptCapturedPayment({id:'pay_late',order_id:p.gateway_order_id,amount:p.amount,currency:p.currency,status:'captured',captured:true});const row=await orders().findOne({_id:o.id});assert.equal(row.status,'review');assert.equal(row.payment_status,'paid');assert.ok(await jobs().findOne({dedupe_key:`refund:${o.id}`}));assert.equal(await jobs().findOne({dedupe_key:`shipment:${o.id}`}),null);});
test('unknown payment creation outcome is not retried blindly',async()=>{await addToCart();const o=await createOrder(customer,{address,coupon:''},id());providerFailure='/v1/orders';await assert.rejects(paymentOrder(o.id),/uncertain/);providerFailure='';const before=providerCalls.length;await assert.rejects(paymentOrder(o.id),/reconciliation/);assert.equal(providerCalls.length,before);await transaction(session=>releaseOrder(o.id,session));});
test('invoice generation is idempotent and PDF is protected',async()=>{await createInvoice(paidOrder.order.id);await createInvoice(paidOrder.order.id);assert.equal((await countN(invoices,{order_id:paidOrder.order.id})).n,1);const pdf=await invoicePdf(paidOrder.order.id);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');await mkdir('tmp/pdfs',{recursive:true});await writeFile('tmp/pdfs/test-fixture-invoice.pdf',pdf);assert.equal((await request(`/orders/${paidOrder.order.id}/invoice`,{session:other})).status,404);assert.equal((await request(`/orders/${paidOrder.order.id}/invoice`,{session:customer})).status,200);});
test('Shiprocket shipment creation and AWB assignment are idempotent',async()=>{const before=providerCalls.filter(x=>x.path.endsWith('/orders/create/adhoc')).length;const s=await createShipment(paidOrder.order.id);const again=await createShipment(paidOrder.order.id);assert.equal(s.id,again.id);assert.match(s.awb,/^TEST-AWB-\d+$/);assert.equal(providerCalls.filter(x=>x.path.endsWith('/orders/create/adhoc')).length,before+1);});
test('delivery is set only from authoritative tracking and never regresses',async()=>{trackStatus=6;await syncTracking(paidOrder.order.id);assert.equal((await orders().findOne({_id:paidOrder.order.id})).status,'shipped');trackStatus=7;await syncTracking(paidOrder.order.id);assert.equal((await orders().findOne({_id:paidOrder.order.id})).status,'delivered');trackStatus=6;await syncTracking(paidOrder.order.id);assert.equal((await orders().findOne({_id:paidOrder.order.id})).status,'delivered');assert.equal((await request(`/admin/orders/${paidOrder.order.id}/status`,{method:'POST',session:adminUser,body:{status:'delivered'}})).status,400);});
test('unknown shipment outcome requires reconciliation without duplicate creation',async()=>{const o=await capturedOrder();providerFailure='/orders/create/adhoc';await assert.rejects(createShipment(o.order.id),/uncertain/);providerFailure='';const before=providerCalls.length;await assert.rejects(createShipment(o.order.id),/reconciliation/);assert.equal(providerCalls.length,before);});
test('refunds are verified and inventory is restored only once',async()=>{const o=await capturedOrder();const stock=(await variants().findOne({_id:variantId})).stock;await requestRefund(o.order.id,'Fixture cancellation');assert.equal((await orders().findOne({_id:o.order.id})).payment_status,'refunded');assert.equal((await variants().findOne({_id:variantId})).stock,stock+1);await assert.rejects(requestRefund(o.order.id,'Fixture cancellation'),/not eligible/);assert.equal((await variants().findOne({_id:variantId})).stock,stock+1);});
test('email provider failure remains retryable and does not change paid orders',async()=>{await jobs().updateMany({kind:{$ne:'email'}},{$set:{available_at:new Date(Date.now()+86400000)}});providerFailure='/emails';await runJob();providerFailure='';const j=await jobs().findOne({kind:'email',attempts:{$gt:0}},{sort:{created_at:1}});assert.equal(j.status,'pending');assert.equal(j.attempts,1);assert.equal((await orders().findOne({_id:paidOrder.order.id})).payment_status,'paid');await jobs().updateMany({kind:'email'},{$set:{available_at:new Date()}});for(let i=0;i<30;i++)if(!await runJob())break;assert.ok((await countN(emailNotifications,{status:'sent'})).n>0);});
test('logout invalidates the session',async()=>{assert.equal((await request('/auth/logout',{method:'POST',session:other})).status,200);assert.equal((await request('/cart',{session:other})).status,401);});

// ---------------------------------------------------------------------------
// Payment lifecycle: authorisation, failure and retry, out-of-order webhooks,
// event-id idempotency, partial refunds, and the two races a real checkout
// actually hits — a browser refresh mid-payment, and a webhook that beats the
// browser callback home.
// ---------------------------------------------------------------------------
const uid=()=>randomUUID().replaceAll('-','').slice(0,16);

/** Posts a correctly signed webhook, optionally with a Razorpay event id. */
async function webhook(event,entity,{eventId=null,extra={}}={}){
  const body=JSON.stringify({event,payload:entity,...extra});
  const signature=createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  return nativeFetch(`${base}/api/webhooks/razorpay`,{method:'POST',headers:{'Content-Type':'application/json','X-Razorpay-Signature':signature,...(eventId?{'X-Razorpay-Event-Id':eventId}:{})},body});
}
/** A pending order with a Razorpay order created against it. */
async function pendingPayment(user=customer){await addToCart(user);const order=await createOrder(user,{address,coupon:''},id());const p=await paymentOrder(order.id);return {order,p};}
/** Registers a payment entity with the provider stub and returns it. */
function stubPayment(p,fields){const payment={id:`pay_${uid()}`,order_id:p.gateway_order_id,amount:p.amount,currency:p.currency,...fields};remotes.set(payment.id,payment);return payment;}
const orderRow=id=>orders().findOne({_id:id});
const totalStock=()=>sumN(variants,'stock');

test('an authorised payment is recorded but never fulfils the order',async()=>{
  const {order,p}=await pendingPayment();
  const payment=stubPayment(p,{status:'authorized',captured:false,method:'upi'});
  const before=await totalStock();
  const response=await webhook('payment.authorized',{payment:{entity:payment}},{eventId:`evt_${uid()}`});
  assert.equal(response.status,200);

  const o=await orderRow(order.id);
  assert.equal(o.payment_status,'pending');
  assert.equal(o.status,'pending');
  assert.equal((await totalStock()).n,before.n,'authorisation must not consume stock');

  const row=await payments().findOne({_id:p.id});
  assert.equal(row.status,'authorized');
  assert.equal(row.gateway_payment_id,null,'no payment is attached until capture');
  assert.equal(row.method,'upi');

  const attempt=await paymentAttempts().findOne({gateway_payment_id:payment.id});
  assert.equal(attempt.status,'authorized');
  assert.equal(attempt.order_id,order.id);

  // Capturing the same payment now does fulfil it, exactly once.
  payment.status='captured';payment.captured=true;remotes.set(payment.id,payment);
  await webhook('payment.captured',{payment:{entity:payment}},{eventId:`evt_${uid()}`});
  const paid=await orderRow(order.id);
  assert.equal(paid.payment_status,'paid');
  assert.equal(paid.status,'confirmed');
  assert.equal((await totalStock()).n,before.n-1);

  // An out-of-order failure for the same payment must not undo any of that.
  await webhook('payment.failed',{payment:{entity:{...payment,status:'failed',error_code:'LATE'}}},{eventId:`evt_${uid()}`});
  const still=await orderRow(order.id);
  assert.equal(still.payment_status,'paid');
  assert.equal(still.status,'confirmed');
  assert.equal((await payments().findOne({_id:p.id})).status,'captured');
  assert.equal((await paymentAttempts().findOne({gateway_payment_id:payment.id})).status,'captured');
  assert.equal((await totalStock()).n,before.n-1,'stock is consumed once, not reversed');
});

test('a failed payment leaves the order open and a retry can still capture',async()=>{
  const {order,p}=await pendingPayment();
  const failed=stubPayment(p,{status:'failed',captured:false,error_code:'BAD_REQUEST_ERROR',error_description:'Payment declined'});
  await webhook('payment.failed',{payment:{entity:failed}},{eventId:`evt_${uid()}`});

  const o=await orderRow(order.id);
  assert.equal(o.status,'pending','a failed attempt is not a cancelled order');
  assert.equal(o.payment_status,'pending');
  assert.equal(o.reserved,true,'the reservation survives so the customer can retry');
  assert.equal((await payments().findOne({_id:p.id})).status,'failed');
  const attempt=await paymentAttempts().findOne({gateway_payment_id:failed.id});
  assert.equal(attempt.error_code,'BAD_REQUEST_ERROR');

  // Second attempt against the same Razorpay order succeeds.
  const ok=stubPayment(p,{status:'captured',captured:true,method:'card'});
  await webhook('payment.captured',{payment:{entity:ok}},{eventId:`evt_${uid()}`});
  assert.equal((await orderRow(order.id)).payment_status,'paid');
  assert.equal((await countN(paymentAttempts,{order_id:order.id})).n,2,
    'both attempts are on record');
});

test('webhook idempotency is keyed on the provider event id, not the body',async()=>{
  const {p}=await pendingPayment();
  const payment=stubPayment(p,{status:'authorized',captured:false});
  const eventId=`evt_${uid()}`;

  const first=await webhook('payment.authorized',{payment:{entity:payment}},{eventId});
  assert.equal(first.status,200);
  assert.equal((await first.json()).duplicate,undefined);

  // A redelivery of the same event whose body differs by a byte must still be
  // recognised: hashing the body alone would treat this as new.
  const again=await webhook('payment.authorized',{payment:{entity:payment}},{eventId,extra:{account_id:'acc_redelivery'}});
  assert.equal(again.status,200);
  assert.equal((await again.json()).duplicate,true);
  assert.equal((await countN(webhookEvents,{event_id:eventId})).n,1);
});

test('incorrect currency and amount are both rejected at capture',async()=>{
  const {p}=await pendingPayment();
  await assert.rejects(acceptCapturedPayment({id:`pay_${uid()}`,order_id:p.gateway_order_id,amount:p.amount,currency:'USD',status:'captured',captured:true}),/amount or currency/);
  await assert.rejects(acceptCapturedPayment({id:`pay_${uid()}`,order_id:p.gateway_order_id,amount:p.amount+100,currency:p.currency,status:'captured',captured:true}),/amount or currency/);
});

test('a browser refresh mid-payment reuses one Razorpay order',async()=>{
  await addToCart(customer);
  const key=id();
  const first=await createOrder(customer,{address,coupon:''},key);
  const second=await createOrder(customer,{address,coupon:''},key);
  assert.equal(first.id,second.id,'the same checkout key returns the same order');

  const p1=await paymentOrder(first.id);
  const created=providerCalls.filter(c=>c.path==='/v1/orders').length;
  const p2=await paymentOrder(first.id);
  const p3=await paymentOrder(first.id);
  assert.equal(p1.gateway_order_id,p2.gateway_order_id);
  assert.equal(p2.gateway_order_id,p3.gateway_order_id);
  assert.equal(providerCalls.filter(c=>c.path==='/v1/orders').length,created,
    'refreshing does not create another Razorpay order');
  await transaction(session=>releaseOrder(first.id,session));
});

test('a webhook arriving before the browser callback fulfils exactly once',async()=>{
  const {order,p}=await pendingPayment();
  const payment=stubPayment(p,{status:'captured',captured:true,method:'netbanking'});
  const before=await totalStock();

  // Webhook wins the race.
  await webhook('payment.captured',{payment:{entity:payment}},{eventId:`evt_${uid()}`});
  assert.equal((await orderRow(order.id)).payment_status,'paid');
  assert.equal((await totalStock()).n,before.n-1);

  // The browser callback then arrives with a valid signature over our own
  // stored Razorpay order id.
  const signature=createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${p.gateway_order_id}|${payment.id}`).digest('hex');
  const response=await request('/payments/verify',{method:'POST',session:customer,body:{orderId:order.id,razorpay_payment_id:payment.id,razorpay_order_id:p.gateway_order_id,razorpay_signature:signature}});
  assert.equal(response.status,200);
  assert.equal((await totalStock()).n,before.n-1,'stock is not deducted a second time');
  assert.equal((await countN(paymentAttempts,{gateway_payment_id:payment.id})).n,1);

  // And a different payment can never be attached to a settled order.
  await assert.rejects(acceptCapturedPayment({id:`pay_${uid()}`,order_id:p.gateway_order_id,amount:p.amount,currency:p.currency,status:'captured',captured:true}),/different payment/);
});

test('partial refunds respect the refundable balance and settle the order once',async()=>{
  const paid=await capturedOrder();
  const orderId=paid.order.id;
  const payment=await payments().findOne({order_id:orderId});
  const slice=Math.floor(payment.amount/4);
  const before=await totalStock();

  await requestRefund(orderId,'First partial refund',{amount:slice,refundKey:'slice-1'});
  let row=await orderRow(orderId);
  assert.equal(row.payment_status,'partially_refunded');
  assert.equal(row.status,'confirmed','a partly refunded order is still a real order');
  assert.equal((await totalStock()).n,before.n,'a partial refund cannot say which line to restock');

  let balance=await refundableBalance(orderId);
  assert.equal(balance.refunded,slice);
  assert.equal(balance.balance,payment.amount-slice);
  assert.equal((await payments().findOne({_id:payment.id})).refunded_amount,slice);

  // Same key is the same operation: no second refund, no second provider call.
  // Named `refundCount`, not `refunds`: that is the collection handle.
  const refundCount=()=>countN(refunds,{order_id:orderId});
  const issued=providerCalls.filter(c=>c.path.endsWith('/refund')).length;
  await requestRefund(orderId,'First partial refund',{amount:slice,refundKey:'slice-1'});
  assert.equal((await refundCount()).n,1);
  assert.equal(providerCalls.filter(c=>c.path.endsWith('/refund')).length,issued);

  // A distinct key is a distinct refund.
  await requestRefund(orderId,'Second partial refund',{amount:slice,refundKey:'slice-2'});
  assert.equal((await refundCount()).n,2);
  assert.equal((await refundableBalance(orderId)).refunded,slice*2);

  // Over-refunding and keyless partial refunds are both refused.
  await assert.rejects(requestRefund(orderId,'Beyond the balance',{amount:payment.amount,refundKey:'slice-3'}),/refundable balance/);
  await assert.rejects(requestRefund(orderId,'No key supplied',{amount:slice}),/refund key/);

  // Clearing the remainder settles the order and restores stock exactly once.
  const remainder=(await refundableBalance(orderId)).balance;
  await requestRefund(orderId,'Remaining balance',{amount:remainder,refundKey:'slice-final'});
  row=await orderRow(orderId);
  assert.equal(row.payment_status,'refunded');
  assert.equal(row.status,'refunded');
  assert.equal((await totalStock()).n,before.n+1,'stock restored once, on full settlement');
  assert.equal((await refundableBalance(orderId)).balance,0);
  await assert.rejects(requestRefund(orderId,'Already settled'),/not eligible/);
});

test('the admin transaction view exposes attempts and refunds but no secrets',async()=>{
  const paid=await capturedOrder();
  const response=await request(`/admin/orders/${paid.order.id}/payment`,{session:adminUser});
  assert.equal(response.status,200);
  const {order,payment,attempts,refunds,refundable,mode}=response.data;
  assert.equal(order.id,paid.order.id);
  assert.equal(payment.status,'captured');
  assert.match(payment.gateway_payment_id,/^pay_/);
  assert.match(payment.gateway_order_id,/^order_/);
  assert.ok(attempts.length>=1);
  assert.equal(attempts[0].status,'captured');
  assert.ok(Array.isArray(refunds));
  assert.equal(refundable,payment.amount);
  assert.equal(mode,'test');
  const serialised=JSON.stringify(response.data);
  for(const secret of [process.env.RAZORPAY_KEY_SECRET,process.env.RAZORPAY_WEBHOOK_SECRET]){
    assert.equal(serialised.includes(secret),false,'no credential may reach an admin screen');
  }
  assert.equal((await request(`/admin/orders/${paid.order.id}/payment`,{session:customer})).status,403);
});

// ---------------------------------------------------------------- email
// The queue is the contract: queueEmail writes one email_notifications row
// and one jobs row, both keyed on the same UNIQUE dedupe key, and that key is
// also sent to Resend as its Idempotency-Key. These tests assert on those rows
// rather than on the provider, because what matters is that the right email is
// queued exactly once from the right verified event.
const emailsFor = async (recipient) => emailNotifications().find({recipient},{projection:{_id:0,dedupe_key:1,template:1,subject:1,status:1,order_id:1,created_at:1}}).sort({created_at:1}).toArray();
const emailByKey = (rows, prefix) => rows.filter((r) => r.dedupe_key.startsWith(prefix));
/**
 * A verified user with no session.
 *
 * Deliberately not `fixtureUser`, which signs in: /auth/login is rate limited
 * to 12 per IP per 15 minutes, and these tests need more users than that
 * allows. None of them act as the user over HTTP, so a row is enough.
 */
async function emailOnlyUser(name) {
  const uid = id();
  const userEmail = `${name}@example.invalid`;
  await users().insertOne({_id:uid,id:uid,name,email:userEmail,password_hash:await passwordHash('a-very-secure-test-password'),verified:true,role:'customer',created_at:new Date()});
  return {id: uid, name, email: userEmail};
}

test('registration queues a welcome email and a separate verification email', async () => {
  const address_ = 'welcome-test@example.invalid';
  const r = await request('/auth/register', {method: 'POST', body: {name: 'Welcome Test', email: address_, password: 'a-long-test-passphrase'}});
  assert.equal(r.status, 202);

  const rows = await emailsFor(address_);
  const welcome = emailByKey(rows, 'welcome:');
  const verify = emailByKey(rows, 'verify:');
  assert.equal(welcome.length, 1, 'exactly one welcome email');
  assert.equal(verify.length, 1, 'exactly one verification email');
  assert.equal(welcome[0].template, 'welcome');
  assert.equal(verify[0].template, 'verify');

  // Registering the same address again must not produce a second welcome: the
  // user row is not created, so nothing is queued.
  await request('/auth/register', {method: 'POST', body: {name: 'Welcome Test', email: address_, password: 'a-long-test-passphrase'}});
  assert.equal(emailByKey(await emailsFor(address_), 'welcome:').length, 1);
});

test('a completed password reset notifies the account owner', async () => {
  const user = await emailOnlyUser('pwnotify');
  await request('/auth/forgot', {method: 'POST', body: {email: user.email}});
  const job = await jobs().findOne({'payload.recipient':user.email,dedupe_key:/^reset:/});
  const raw = job.payload.data.url.match(/token=([a-f0-9]+)/)[1];

  assert.equal((await request('/auth/reset', {method: 'POST', body: {token: raw, password: 'another-long-passphrase'}})).status, 200);
  const changed = emailByKey(await emailsFor(user.email), 'password-changed:');
  assert.equal(changed.length, 1, 'the owner is told their password changed');
  assert.equal(changed[0].template, 'password_changed');
});

test('a verified capture queues the order confirmation exactly once', async () => {
  const user = await emailOnlyUser('ordermail');
  const {order} = await capturedOrder(user);

  const paid = emailByKey(await emailsFor(user.email), `paid:${order.id}`);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].template, 'paid');
  assert.equal(paid[0].order_id, order.id, 'the ledger records which order it was about');

  // Replaying the same capture — a redelivered webhook — must not queue a
  // second confirmation, because the dedupe key is the order.
  await acceptCapturedPayment({id: (await payments().findOne({order_id:order.id})).gateway_payment_id,
    order_id: (await payments().findOne({order_id:order.id})).gateway_order_id,
    amount: order.total, currency: order.currency, status: 'captured', captured: true});
  assert.equal(emailByKey(await emailsFor(user.email), `paid:${order.id}`).length, 1, 'no duplicate on replay');

  // And the order email carries the real order: rendering must not throw and
  // must contain the line items and the totals.
  const {buildEmail} = await import('../server/emails/index.mjs');
  const built = await buildEmail({template: 'paid', orderId: order.id, recipient: user.email, subject: 'x', key: 'k'});
  assert.match(built.html, /Test shoe/);
  assert.match(built.text, /Total/);
  assert.match(built.html, new RegExp(String(order.number)));
});

test('an order confirmation is never queued for an unpaid order', async () => {
  const user = await emailOnlyUser('unpaidmail');
  await addToCart(user);
  const order = await createOrder(user, {address, coupon: ''}, id());
  await paymentOrder(order.id);
  // The customer reached the payment screen and stopped there.
  assert.equal(emailByKey(await emailsFor(user.email), `paid:${order.id}`).length, 0);
});

test('a failed payment emails the customer once per failed attempt', async () => {
  const user = await emailOnlyUser('failmail');
  await addToCart(user);
  const order = await createOrder(user, {address, coupon: ''}, id());
  const p = await paymentOrder(order.id);
  const attempt = {id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id, amount: p.amount,
    currency: p.currency, status: 'failed', error_description: 'Your card was declined by the issuing bank.'};

  const {markFailed} = await import('../server/payments.mjs');
  await markFailed(attempt);
  const failed = emailByKey(await emailsFor(user.email), `payment-failed:${attempt.id}`);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].template, 'payment_failed');

  // A redelivered payment.failed for the same attempt must not email again.
  await markFailed(attempt);
  assert.equal(emailByKey(await emailsFor(user.email), `payment-failed:${attempt.id}`).length, 1);

  // The order is untouched, so the customer can still retry.
  assert.equal((await orders().findOne({_id:order.id})).status, 'pending');
});

test('shipping emails are worded by delivery stage and sent once per change', async () => {
  const {shippingStage} = await import('../server/emails/templates.mjs');
  assert.equal(shippingStage('Delivered', 7), 'delivered');
  assert.equal(shippingStage('Out For Delivery', 19), 'out_for_delivery');
  assert.equal(shippingStage('In Transit', 6), 'shipped');
  assert.equal(shippingStage('RTO Initiated', 0), 'exception');
  assert.equal(shippingStage('Canceled', 0), 'cancelled');

  const user = await emailOnlyUser('shipmail');
  const {order} = await capturedOrder(user);
  // The shipment row is inserted directly rather than through createShipment:
  // the Shiprocket mock returns one fixed pair of provider ids, so a second
  // real creation collides on their unique constraints. What is under test
  // here is the tracking email, and shipment creation has its own test above.
  const shipmentId = id();
  await mongo.shipments().insertOne({
    _id: shipmentId, id: shipmentId, order_id: order.id,
    provider_order_id: `po-${order.id}`, provider_shipment_id: `ps-${order.id}`,
    awb: null, courier: null, tracking_url: null, label_url: null,
    status: 'created', last_synced: null,
  });
  trackStatus = 6;
  await syncTracking(order.id);
  const afterShipped = emailByKey(await emailsFor(user.email), 'tracking:');
  assert.equal(afterShipped.length, 1, 'one email for the first status');
  assert.match(afterShipped[0].subject, /Shipped/);

  // Polling the same status again changes nothing, so no second email.
  await syncTracking(order.id);
  assert.equal(emailByKey(await emailsFor(user.email), 'tracking:').length, 1, 'no email when the status has not moved');

  // A real change does send, and is worded for the new stage.
  trackStatus = 7;
  await syncTracking(order.id);
  const afterDelivered = emailByKey(await emailsFor(user.email), 'tracking:');
  assert.equal(afterDelivered.length, 2);
  assert.ok(afterDelivered.some((e) => /Delivered/.test(e.subject)), 'the delivered email is worded as delivered');
  trackStatus = 6;
});

test('refund emails cover initiation and completion without duplicating', async () => {
  const user = await emailOnlyUser('refundmail');
  const {order} = await capturedOrder(user);
  await requestRefund(order.id, 'Customer changed their mind');

  const rows = await emailsFor(user.email);
  assert.equal(emailByKey(rows, `refund-started:${order.id}`).length, 1);
  assert.equal(emailByKey(rows, `refunded:${order.id}`).length, 1);
  assert.equal(emailByKey(rows, `refunded:${order.id}`)[0].template, 'refunded');

  // Reconciling again must not re-send either email.
  const {syncRefund} = await import('../server/fulfillment.mjs');
  await syncRefund(order.id);
  const after = await emailsFor(user.email);
  assert.equal(emailByKey(after, `refund-started:${order.id}`).length, 1);
  assert.equal(emailByKey(after, `refunded:${order.id}`).length, 1);
});

test('admin notifications are queued only when an admin address is configured', async () => {
  // No ADMIN_NOTIFICATION_EMAIL is set in this fixture environment, so the
  // admin notification is skipped rather than queued to an empty recipient.
  assert.equal((await countN(emailNotifications,{dedupe_key:/^admin:/})).n, 0);
  assert.equal((await countN(emailNotifications,{recipient:''})).n, 0,
    'nothing is ever queued to an empty address');

  const {queueAdminEmail} = await import('../server/queue.mjs');
  assert.equal(await queueAdminEmail('probe', 'Probe', {template: 'admin_error', data: {area: 'Probe'}}), false);
});

test('an email job records a dedupe key that Resend receives as its idempotency key', async () => {
  const user = await emailOnlyUser('idemmail');
  const {order} = await capturedOrder(user);
  const key = `paid:${order.id}`;
  const job = await jobs().findOne({dedupe_key:key});
  assert.equal(job.kind, 'email');
  assert.equal(job.payload.key, key, 'the key travels in the payload to the provider header');

  // The same key cannot be queued twice, whichever path tries.
  const {queueEmail} = await import('../server/queue.mjs');
  await queueEmail(key, user.email, 'Duplicate attempt', {template: 'paid', orderId: order.id});
  assert.equal((await countN(jobs,{dedupe_key:key})).n, 1);
  assert.equal((await countN(emailNotifications,{dedupe_key:key})).n, 1);
});

test('a permanently failed email is recorded as failed on the ledger', async () => {
  const user = await emailOnlyUser('ledgermail');
  const {queueEmail} = await import('../server/queue.mjs');
  const key = `ledger-probe:${user.id}`;
  await queueEmail(key, user.email, 'Probe', {template: 'welcome', userId: user.id, data: {name: 'Probe'}});
  // Push the job to its last attempt, and make it the oldest pending job so
  // runJob claims this one: the claim query orders by available_at, and
  // earlier tests leave their own email jobs queued.
  await jobs().updateOne({dedupe_key:key},{$set:{attempts:8,available_at:new Date(Date.now()-86400000)}});
  providerFailure = '/emails';
  await runJob();
  providerFailure = '';

  const row = await emailNotifications().findOne({dedupe_key:key});
  assert.equal(row.status, 'failed', 'the ledger shows the terminal state, not just the job');
  assert.ok(row.last_error, 'a redacted reason is recorded');
  // The recorded reason must not leak a provider body or a credential.
  assert.ok(!/Bearer|re_[A-Za-z0-9]|api\.resend\.com/.test(row.last_error), 'no credential or provider body in the reason');
});

test('contact form validates, stores, acknowledges and deduplicates', async () => {
  const enquiry = {name: 'Priya Shah', email: 'priya@example.invalid', subject: 'Sizing question',
    message: 'Is the medium true to size? I am usually a 40 inch chest and between sizes.'};

  // Too short a message is refused with a message the form can show.
  assert.equal((await request('/contact', {method: 'POST', body: {...enquiry, message: 'too short'}})).status, 400);
  // A bad email address is refused.
  assert.equal((await request('/contact', {method: 'POST', body: {...enquiry, email: 'not-an-email'}})).status, 400);
  // An unknown field is refused, so the endpoint cannot be used as a sink.
  assert.equal((await request('/contact', {method: 'POST', body: {...enquiry, isAdmin: true}})).status, 400);

  const ok = await request('/contact', {method: 'POST', body: enquiry});
  assert.equal(ok.status, 202);
  assert.match(ok.data.message, /received/i);

  const stored = await contactMessages().findOne({email:enquiry.email});
  assert.ok(stored, 'the enquiry is stored before any email is queued');
  assert.equal(stored.subject, enquiry.subject);

  // Two emails: the enquiry to the business, the acknowledgement to the sender.
  const ack = emailByKey(await emailsFor(enquiry.email), `contact-ack:${stored.id}`);
  assert.equal(ack.length, 1);
  assert.equal(ack[0].template, 'contact_ack');
  const toBusiness = await emailNotifications().find({dedupe_key:`contact:${stored.id}`}).toArray();
  assert.equal(toBusiness.length, 1);
  assert.equal(toBusiness[0].template, 'contact_enquiry');
  assert.equal(toBusiness[0].recipient, process.env.BUSINESS_EMAIL);

  // Submitting the identical enquiry again stores nothing new and sends nothing.
  assert.equal((await request('/contact', {method: 'POST', body: enquiry})).status, 202);
  assert.equal((await countN(contactMessages,{email:enquiry.email})).n, 1);
  assert.equal(emailByKey(await emailsFor(enquiry.email), 'contact-ack:').length, 1);

  // The route is rate limited at 5 per IP per 15 minutes, which is the main
  // abuse control for an endpoint open to signed-out visitors. By now this IP
  // has spent its allowance, so the next attempt is refused outright.
  const limited = await request('/contact', {method: 'POST', body: {...enquiry, subject: 'Another question'}});
  assert.equal(limited.status, 429, 'the contact form is rate limited per IP');
});

test('contact form rejects bot and spam submissions without telling them why', async () => {
  // The previous test deliberately exhausted the per-IP allowance. Clear it so
  // this test exercises the validation and spam rules rather than the limiter.
  await rateLimits().deleteMany({});
  const base_ = {name: 'Bot', email: 'bot@example.invalid', subject: 'Cheap deals',
    message: 'Visit our store for the best prices available anywhere online today.'};

  // Honeypot filled: the schema only permits an empty string.
  assert.equal((await request('/contact', {method: 'POST', body: {...base_, website: 'http://spam.example'}})).status, 400);

  // Link-heavy body: answered 202, same as a success, so a bot learns nothing.
  const spam = await request('/contact', {method: 'POST',
    body: {...base_, email: 'spam@example.invalid', message: 'Buy now http://a.example http://b.example http://c.example right away'}});
  assert.equal(spam.status, 202);
  assert.equal((await countN(contactMessages,{email:'spam@example.invalid'})).n, 0,
    'spam is not stored');
  assert.equal((await countN(emailNotifications,{recipient:'spam@example.invalid'})).n, 0,
    'and no email is queued for it');

  // A header-injection attempt is refused the same way.
  const injected = await request('/contact', {method: 'POST',
    body: {...base_, email: 'inject@example.invalid', message: 'Hello there\nBcc: victim@example.invalid\nplease respond soon'}});
  assert.equal(injected.status, 202);
  assert.equal((await countN(contactMessages,{email:'inject@example.invalid'})).n, 0);
});

test('order emails address only the order owner, never another customer', async () => {
  const owner = await emailOnlyUser('ownermail');
  const {order} = await capturedOrder(owner);

  // Every email about this order went to the address on the order.
  const about = await emailNotifications().find({order_id:order.id},{projection:{_id:0,recipient:1}}).toArray();
  assert.ok(about.length > 0);
  for (const row of about) assert.equal(row.recipient, owner.email, 'no email about this order went elsewhere');

  // And the order itself is still not readable by another customer, so order
  // contents cannot be obtained by asking for someone else's confirmation.
  //
  // A fresh session is needed rather than `other`: an earlier test resets that
  // user's password, which by design deletes all of their sessions.
  await rateLimits().deleteMany({});
  const snoop = await fixtureUser('snoop');
  assert.equal((await request(`/orders/${order.id}`, {session: snoop})).status, 404);
  assert.equal((await request(`/orders/${order.id}/invoice`, {session: snoop})).status, 404);
});

test('no email template leaks an API key or renders unescaped customer input', async () => {
  const {renderEmail, templateNames} = await import('../server/emails/index.mjs');
  const {orderDetails} = await import('../server/commerce.mjs');
  const order = await orderDetails(paidOrder.order.id);
  const hostile = '<script>alert(1)</script>';
  for (const name of templateNames) {
    const r = renderEmail(name, {
      origin: 'https://example.invalid', order, name: hostile, url: 'https://example.invalid/verify?token=x',
      when: 'now', amount: 100, stage: 'delivered', phase: 'completed', email: 'a@example.invalid',
      subject: hostile, message: hostile, orderNumber: '1', area: 'Probe', detail: hostile, reference: 'r',
    });
    assert.ok(!r.html.includes(process.env.RESEND_API_KEY), `${name} must not contain the API key`);
    assert.ok(!/<script/i.test(r.html), `${name} must escape customer input`);
    assert.ok(r.subject && r.html && r.text, `${name} must render all three parts`);
  }
});
