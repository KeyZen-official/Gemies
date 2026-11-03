import {Router} from 'express';
import {z} from 'zod';
import {db as mongo,storeSettings,categories,products,variants,cartItems,wishlist,orders,payments,newsletter,exchangeRequests,transaction} from './mongo.mjs';
import {config} from './config.mjs';
import {auth,assert,id,validSignature,limit} from './security.mjs';
import {itemSchema,checkoutSchema,email} from './validation.mjs';
import {cart,quote,createOrder,paymentOrder,acceptCapturedPayment,orderDetails,releaseOrder,walletOfferFor,payableOf,completeWalletOrder} from './commerce.mjs';
import {razorpay,shiprocket} from './providers.mjs';
import {invoicePdf,businessDetails} from './invoices.mjs';
import {trackingForCustomer} from './fulfillment.mjs';
import {categoryTree,resolveCategory,listProducts} from './catalog.mjs';
import {submitEnquiry} from './contact.mjs';
import {walletSummary,history,TRANSACTION_KINDS} from './wallet.mjs';
import {eligibility,createExchange,exchangeDetails,transition,EXCHANGE_REASONS} from './exchanges.mjs';
export const routes=Router();
// `SELECT 1` was the cheapest round trip that proved the database was
// reachable. `ping` is its MongoDB equivalent: it fails if the driver cannot
// reach a server, which is the only thing this endpoint claims.
routes.get('/health',async(req,res)=>{await mongo().command({ping:1});res.json({ok:true});});
routes.get('/config',async(req,res)=>res.json({currency:config.currency,development:!config.production,payments:config.paymentEnabled,shipping:config.shippingEnabled,email:config.emailEnabled,settings:await storeSettings().findOne({_id:1})}));
// Flat list, kept for the admin product form which needs every category it can
// file a product under, including ones no longer in the navigation.
routes.get('/categories',async(req,res)=>res.json(await categories().find({}).sort({display_order:1,name:1}).toArray()));
// The navigation tree: top-level categories with their subcategories.
routes.get('/categories/tree',async(req,res)=>res.json(await categoryTree()));
// Resolves a /shop path such as ['t-shirts','printed'] to its category, so a
// category page can show the right heading and filter scope.
routes.get('/categories/resolve',async(req,res)=>{const v=z.object({path:z.string().max(160).default('')}).parse(req.query);const segments=v.path.split('/').map(s=>s.trim()).filter(Boolean).slice(0,2);const category=await resolveCategory(segments);assert(category,404,'Category not found.');const parent=category.parent_id?await categories().findOne({_id:category.parent_id},{projection:{_id:0,name:1,slug:1,segment:1}}):null;const children=await categories().find({parent_id:category.id},{projection:{_id:0,name:1,slug:1,segment:1}}).sort({display_order:1,name:1}).toArray();res.json({...category,parent,children});});
routes.get('/products',async(req,res)=>res.json(await listProducts(req.query)));
/**
 * The homepage clothing rail.
 *
 * Built from the catalogue at request time, so changing a rail image or a hang
 * tag in the admin panel shows up on the next page load with no rebuild. This
 * replaced a generated file (src/data/rail-items.js) that a script wrote from
 * the catalogue -- which meant the tags drifted out of date the moment anyone
 * changed a price, and the only fix was to re-run the script and redeploy.
 *
 * The tag is the product's real price unless an operator typed an override, so
 * a hang tag cannot silently disagree with what checkout charges.
 *
 * Shaped for the rail component: `image`, `backImage`, `tag`. `backImage` is
 * omitted rather than duplicated when no back photo exists -- the component's
 * documented fallback reuses the front face, and sending the front twice would
 * make the reverse look deliberate when it is not.
 */
routes.get('/rail',async(req,res)=>{
  const rows=await products().find({
    rail_enabled:true,
    published:true,
    rail_front:{$ne:null},
    ...(config.production?{is_demo:false}:{}),
  },{projection:{
    _id:0,id:1,slug:1,name:1,price:1,rail_front:1,rail_back:1,rail_tag:1,
    display_order:1,colorways:1,swatches:1,category_id:1,fit:1,
  }}).sort({display_order:1,name:1}).limit(12).toArray();

  const categoryIds=[...new Set(rows.map(r=>r.category_id).filter(Boolean))];
  const cats=categoryIds.length
    ?await categories().find({_id:{$in:categoryIds}},{projection:{name:1}}).toArray()
    :[];

  const rupees=new Intl.NumberFormat('en-IN',{style:'currency',currency:config.currency,maximumFractionDigits:0});
  res.json({items:rows.map(row=>({
    id:row.slug,
    name:row.colorways?.[0]?.name?`${row.name} · ${row.colorways[0].name}`:row.name,
    href:`/product/${row.slug}`,
    // The illustration the component falls back to if an image fails to load.
    kind:'tee',
    color:row.colorways?.[0]?.hex??row.swatches?.[0]??'#d8d4cc',
    image:row.rail_front,
    ...(row.rail_back?{backImage:row.rail_back}:{}),
    tag:row.rail_tag||rupees.format(row.price/100),
    details:[cats.find(c=>c._id===row.category_id)?.name,row.fit].filter(Boolean),
  }))});
});
routes.get('/products/:slug',async(req,res)=>{
  const p=await products().findOne({slug:req.params.slug,published:true,...(config.production?{is_demo:false}:{})});
  assert(p,404,'Product not found.');
  // Was a LEFT JOIN, so an uncategorised product still resolves rather than
  // disappearing from the response.
  const category=p.category_id?await categories().findOne({_id:p.category_id},{projection:{name:1,slug:1}}):null;
  p.category=category?.name??null;
  p.category_slug=category?.slug??null;
  const rows=await variants().find({product_id:p.id}).toArray();
  // `stock-reserved AS available`, and `ORDER BY length(size),size,color`.
  // The sort is done here because it is an expression over a field, which a
  // find() sort cannot express; a product has at most a few dozen variants.
  p.variants=rows
    .map(v=>({id:v.id,sku:v.sku,size:v.size,color:v.color,available:v.stock-v.reserved}))
    .sort((a,b)=>a.size.length-b.size.length||a.size.localeCompare(b.size)||a.color.localeCompare(b.color));
  res.json(p);
});
routes.get('/cart',auth,async(req,res)=>res.json(await quote(req.user.id)));
routes.put('/cart/items',auth,async(req,res)=>{
  const v=itemSchema.parse(req.body);
  const variant=await variants().findOne({_id:v.variantId});
  const product=variant?await products().findOne({_id:variant.product_id},{projection:{published:1,is_demo:1}}):null;
  assert(variant&&product?.published&&(!config.production||!product.is_demo),404,'Product unavailable.');
  assert(v.quantity<=variant.stock-variant.reserved,409,'Not enough stock for that quantity.');
  // ON CONFLICT(user_id,variant_id) DO UPDATE SET quantity: the quantity is a
  // replacement, not an increment, so this is an upserting $set.
  await cartItems().updateOne(
    {user_id:req.user.id,variant_id:v.variantId},
    {$set:{user_id:req.user.id,variant_id:v.variantId,quantity:v.quantity}},
    {upsert:true},
  );
  res.json(await quote(req.user.id));
});
routes.delete('/cart/items/:id',auth,async(req,res)=>{await cartItems().deleteOne({user_id:req.user.id,variant_id:req.params.id});res.json(await quote(req.user.id));});
/**
 * The checkout quote, plus what the wallet could pay toward it.
 *
 * The wallet block is computed here so the checkout screen can render the
 * redemption row without doing any arithmetic of its own. `coins` and `inr`
 * are what the server would actually apply, and `reason` explains a zero so
 * the UI can say why rather than hiding the option.
 */
routes.post('/checkout/quote',auth,async(req,res)=>{
  const v=checkoutSchema.parse(req.body);
  const q=await quote(req.user.id,v.coupon);
  const offer=q.total>0?await walletOfferFor(req.user.id,q.total):null;
  res.json({...q,wallet:offer});
});

routes.post('/checkout',auth,limit('checkout',20),async(req,res)=>{
  if(config.production){const b=businessDetails();assert(b.name&&b.address&&b.email&&process.env.RESEND_API_KEY,503,'Store invoicing and transactional email must be configured before checkout.');}
  const v=checkoutSchema.parse(req.body);
  const order=await createOrder(req.user,v,req.headers['idempotency-key']);
  const payable=payableOf(order);

  // A wallet-only order needs no gateway, so it does not need one configured.
  // This check moved below createOrder for exactly that reason: the previous
  // version refused every checkout when Razorpay was absent, including ones
  // the customer could pay for entirely in coins.
  if(payable===0){
    const settled=await completeWalletOrder(order.id);
    return res.json({orderId:order.id,walletOnly:true,walletApplied:order.wallet_applied,walletCoins:order.wallet_coins,status:settled.status,currency:order.currency,amount:0});
  }

  assert(config.paymentEnabled,503,'Checkout is awaiting payment provider configuration. Your bag is saved.');
  const p=await paymentOrder(order.id);
  res.json({orderId:order.id,key:process.env.RAZORPAY_KEY_ID,gatewayOrderId:p.gateway_order_id,amount:p.amount,currency:p.currency,walletOnly:false,walletApplied:order.wallet_applied,walletCoins:order.wallet_coins});
});
routes.post('/payments/verify',auth,limit('payment-verify',30),async(req,res)=>{const v=z.object({orderId:z.string().uuid(),razorpay_payment_id:z.string().regex(/^pay_[a-zA-Z0-9]+$/),razorpay_order_id:z.string().regex(/^order_[a-zA-Z0-9]+$/),razorpay_signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);const p=await payments().findOne({order_id:v.orderId});const owned=p?await orders().findOne({_id:v.orderId,user_id:req.user.id},{projection:{_id:1}}):null;assert(p&&owned&&p.gateway_order_id===v.razorpay_order_id,404,'Payment order not found.');assert(validSignature(`${p.gateway_order_id}|${v.razorpay_payment_id}`,v.razorpay_signature,process.env.RAZORPAY_KEY_SECRET),400,'Payment signature verification failed.');const payment=await razorpay(`/payments/${v.razorpay_payment_id}`);await acceptCapturedPayment(payment);res.json({orderId:v.orderId});});
// Paginated, and reporting the total. It was a hard LIMIT 100 returning a bare
// array, so a customer with 101 orders simply could not reach the oldest one.
// The envelope matches the admin lists: {rows,total,page,limit,pages}.
routes.get('/orders',auth,async(req,res)=>{
  const v=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),limit:z.coerce.number().int().min(1).max(50).default(10)}).parse(req.query);
  const [rows,total]=await Promise.all([
    orders().find({user_id:req.user.id},{projection:{_id:0,id:1,number:1,status:1,payment_status:1,total:1,currency:1,created_at:1}})
      .sort({created_at:-1}).skip((v.page-1)*v.limit).limit(v.limit).toArray(),
    orders().countDocuments({user_id:req.user.id}),
  ]);
  res.json({rows,total,page:v.page,limit:v.limit,pages:Math.max(1,Math.ceil(total/v.limit))});
});
async function ownOrder(req){const o=await orderDetails(req.params.id);assert(o&&(o.user_id===req.user.id||req.user.role==='admin'),404,'Order not found.');return o;}
routes.get('/orders/:id',auth,async(req,res)=>res.json(await ownOrder(req)));
routes.post('/orders/:id/retry-payment',auth,async(req,res)=>{const o=await ownOrder(req);const p=await paymentOrder(o.id);res.json({orderId:o.id,key:process.env.RAZORPAY_KEY_ID,gatewayOrderId:p.gateway_order_id,amount:p.amount,currency:p.currency});});
// releaseOrder is given a real MongoDB session, so cancelling the order,
// returning the reserved stock and releasing any held wallet coins all commit
// together. Before tranche 5 this was a PostgreSQL transaction that the old
// asSession bridge dropped, and those three writes ran unprotected.
routes.post('/orders/:id/cancel',auth,async(req,res)=>{await ownOrder(req);const result=await transaction(session=>releaseOrder(req.params.id,session));assert(result,409,'Paid or fulfilled orders require a support cancellation and refund.');res.json({ok:true});});
routes.get('/orders/:id/invoice',auth,async(req,res)=>{const o=await ownOrder(req);const pdf=await invoicePdf(o.id);res.type('application/pdf').set('Content-Disposition',`attachment; filename="Gemies-${o.number}.pdf"`).send(pdf);});
/**
 * Shipment tracking for the order's owner.
 *
 * Reads only what GEMIES has already stored from a verified provider response.
 * It never calls Shiprocket: a customer refreshing the page must not be able
 * to drive provider traffic, and the worker's sweep keeps the stored state
 * current. With no shipment yet it returns `available: false` and the message
 * the page shows, rather than any placeholder tracking.
 */
routes.get('/orders/:id/tracking',auth,async(req,res)=>{const o=await ownOrder(req);res.json(await trackingForCustomer(o.id));});
routes.get('/shipping/serviceability',limit('serviceability',30),async(req,res)=>{const pin=z.string().regex(/^[1-9]\d{5}$/).parse(req.query.pin);assert(process.env.SHIPROCKET_PICKUP_PINCODE,503,'Pickup PIN code is not configured.');const weight=Number(process.env.PACKAGE_WEIGHT_KG);assert(weight>0,503,'Package weight is not configured.');const data=await shiprocket(`/courier/serviceability/?pickup_postcode=${process.env.SHIPROCKET_PICKUP_PINCODE}&delivery_postcode=${pin}&cod=0&weight=${weight}`);res.json({couriers:(data.data?.available_courier_companies||[]).map(c=>({name:c.courier_name,rate:c.rate,estimatedDays:c.etd}))});});
// Contact Us. Open to signed-out visitors by design, so the rate limit is the
// main abuse control: 5 enquiries per IP per 15 minutes. `req.user` is passed
// when present only to attribute the enquiry, never to authorise it.
routes.post('/contact',limit('contact',5),async(req,res)=>res.status(202).json(await submitEnquiry(req.body,req.user)));
routes.post('/newsletter',limit('newsletter',5),async(req,res)=>{const value=email.parse(req.body.email);assert(req.body.consent===true,400,'Please consent to newsletter emails.');await newsletter().updateOne({email:value},{$setOnInsert:{email:value,created_at:new Date()}},{upsert:true});res.status(202).json({message:'You’re on the list. Thank you for subscribing.'});});
/**
 * Saved products, one page at a time.
 *
 * Split from the membership list below on purpose. Every ProductCard heart on
 * the page reflects whether that product is saved, which needs the *whole* set
 * of saved ids -- so paginating this one endpoint and having the store read it
 * would have left every heart beyond page one looking unsaved.
 */
/* ------------------------------------------------------------- exchanges */

// Whether this order can be exchanged, and which units are still returnable.
// Drives the Request Exchange button, so the customer is never offered a form
// that the server will refuse.
routes.get('/orders/:id/exchange-eligibility',auth,async(req,res)=>{
  await ownOrder(req);
  res.json(await eligibility(req.params.id,req.user.id));
});

const exchangeBody=z.object({
  reason:z.enum(EXCHANGE_REASONS),
  note:z.string().trim().max(1000).default(''),
  // Uploaded through POST /admin/images is not available to a customer, so
  // images are restricted to paths this app already serves.
  images:z.array(z.string().max(400).regex(/^\/(uploads|assets)\/[\w./-]+$/)).max(6).default([]),
  items:z.array(z.object({
    order_item_id:z.string().min(1).max(80),
    quantity:z.number().int().min(1).max(20),
    replacement_variant_id:z.string().uuid().nullable().optional(),
  })).min(1).max(50),
}).strict().refine(v=>v.reason!=='other'||v.note.trim().length>=5,{
  message:'Tell us a little about the problem.',path:['note'],
});

routes.post('/orders/:id/exchange',auth,limit('exchange',10),async(req,res)=>{
  await ownOrder(req);
  const v=exchangeBody.parse(req.body);
  res.status(201).json(await createExchange(req.user,req.params.id,v));
});

// The customer's own exchange history.
routes.get('/exchanges',auth,async(req,res)=>{
  const v=z.object({
    page:z.coerce.number().int().min(1).max(100000).default(1),
    limit:z.coerce.number().int().min(1).max(50).default(10),
  }).parse(req.query);
  const [page,total]=await Promise.all([
    exchangeRequests().find({user_id:req.user.id},{projection:{_id:0,id:1,number:1,status:1,reason:1,eligible_coins:1,eligible_inr:1,created_at:1,updated_at:1,order_id:1}})
      .sort({created_at:-1}).skip((v.page-1)*v.limit).limit(v.limit).toArray(),
    exchangeRequests().countDocuments({user_id:req.user.id}),
  ]);
  // `JOIN orders o` for the order number, resolved over one page of requests.
  const orderRows=page.length
    ?await orders().find({_id:{$in:page.map(r=>r.order_id)}},{projection:{number:1}}).toArray()
    :[];
  const rows=page.map(r=>({...r,order_number:orderRows.find(o=>o._id===r.order_id)?.number??null}));
  res.json({rows,total,page:v.page,limit:v.limit,pages:Math.max(1,Math.ceil(total/v.limit))});
});

routes.get('/exchanges/:id',auth,async(req,res)=>{
  const detail=await exchangeDetails(req.params.id);
  // Owner or admin only, and a miss and a forbidden look identical.
  assert(detail&&(detail.user_id===req.user.id||req.user.role==='admin'),404,'Exchange request not found.');
  res.json(detail);
});

// A customer may withdraw a request before the goods are collected.
routes.post('/exchanges/:id/cancel',auth,async(req,res)=>{
  res.json(await transition(req.params.id,'cancelled',{actor:req.user,note:'Cancelled by the customer',isCustomer:true}));
});

/* --------------------------------------------------------------- wallet */

/**
 * The customer's own wallet.
 *
 * Everything here is computed on the server from the ledger and the configured
 * conversion rate. The client is never asked for a balance, a rate or a rupee
 * value, and never sent another customer's: `req.user.id` is the only identity
 * these two routes will read.
 */
routes.get('/wallet',auth,async(req,res)=>res.json(await walletSummary(req.user.id)));

routes.get('/wallet/transactions',auth,async(req,res)=>{
  const v=z.object({
    page:z.coerce.number().int().min(1).max(100000).default(1),
    limit:z.coerce.number().int().min(1).max(50).default(20),
    kind:z.union([z.literal(''),z.enum(TRANSACTION_KINDS)]).default(''),
    direction:z.union([z.literal(''),z.enum(['credit','debit'])]).default(''),
  }).parse(req.query);
  res.json({...await history(req.user.id,v),kinds:TRANSACTION_KINDS});
});

routes.get('/wishlist',auth,async(req,res)=>{
  const v=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),limit:z.coerce.number().int().min(1).max(48).default(12)}).parse(req.query);
  // Was `wishlist w JOIN products p`. The saved ids are read first and the
  // page is taken from products, so the paging and the published filter both
  // still apply on the products side exactly as the SQL had them. A wishlist
  // is bounded per customer -- /wishlist/ids below returns the whole set -- so
  // the $in is the same size the join's driving side would have been.
  const saved=await wishlist().find({user_id:req.user.id},{projection:{_id:0,product_id:1}}).toArray();
  const ids=saved.map(w=>w.product_id);
  const match={_id:{$in:ids},published:true};
  const [rows,total]=await Promise.all([
    products().find(match).sort({created_at:-1}).skip((v.page-1)*v.limit).limit(v.limit).toArray(),
    products().countDocuments(match),
  ]);
  res.json({rows,total,page:v.page,limit:v.limit,pages:Math.max(1,Math.ceil(total/v.limit))});
});
// Just the ids, for the heart state the store keeps across every grid. Cheap
// enough to stay unbounded: one short column, and it is the complete set by
// definition.
routes.get('/wishlist/ids',auth,async(req,res)=>res.json((await wishlist().find({user_id:req.user.id},{projection:{_id:0,product_id:1}}).toArray()).map(r=>r.product_id)));
routes.put('/wishlist/:id',auth,async(req,res)=>{const p=await products().findOne({_id:req.params.id,published:true},{projection:{_id:1}});assert(p,404,'Product not found.');await wishlist().updateOne({user_id:req.user.id,product_id:p._id},{$setOnInsert:{user_id:req.user.id,product_id:p._id}},{upsert:true});res.json({ok:true});});
routes.delete('/wishlist/:id',auth,async(req,res)=>{await wishlist().deleteOne({user_id:req.user.id,product_id:req.params.id});res.json({ok:true});});
