import PDFDocument from 'pdfkit';
import {invoices,transaction} from './mongo.mjs';
import {id,assert} from './security.mjs';
import {orderDetails} from './commerce.mjs';
import {queueEmail} from './queue.mjs';
import {allocateInvoiceLines,taxRateFor} from './invoice-lines.mjs';

/**
 * Tax invoices.
 *
 * Two rules shape this whole module.
 *
 * First, an issued invoice never changes. `createInvoice` freezes everything
 * the document shows into `invoices.snapshot`, and `invoicePdf` renders from
 * that column and nothing else. Before this, the PDF was built from a live
 * `orderDetails()` read, so renaming a product or correcting an address
 * silently altered a document a customer had already been sent.
 *
 * Second, nothing on the invoice is invented. The business identity, the GSTIN
 * and the registration number come from configuration; where a value is not
 * configured the line is omitted rather than filled with a placeholder, and
 * there is no GST declaration wording beyond the registration numbers
 * themselves.
 */

/**
 * The business identity printed on an invoice.
 *
 * `name` is the registered legal entity, which is what a GST tax invoice must
 * carry next to the GSTIN. `tradeName` is the customer-facing brand and falls
 * back to the legal name when it is not set separately, so an existing
 * deployment that only ever configured BUSINESS_NAME keeps working.
 */
export function businessDetails(){return {
  name:process.env.BUSINESS_NAME||'',
  tradeName:process.env.BUSINESS_TRADE_NAME||process.env.BUSINESS_NAME||'',
  address:process.env.BUSINESS_ADDRESS||'',
  email:process.env.BUSINESS_EMAIL||'',
  invoiceEmail:process.env.BUSINESS_INVOICE_EMAIL||process.env.BUSINESS_EMAIL||'',
  phone:process.env.BUSINESS_PHONE||'',
  taxId:process.env.BUSINESS_TAX_ID||'',
  registration:process.env.BUSINESS_REGISTRATION||'',
};}

/**
 * The invoice number.
 *
 * Derived from the order number, so it is stable, gapless and never collides.
 * The prefix is configurable because it appears on a legal document and the
 * previous hardcoded 'SZ-' was a leftover from an earlier name for this
 * project.
 */
const invoiceNumber=(orderNumber,version=1)=>{
  const prefix=(process.env.INVOICE_PREFIX||'GEM').trim().toUpperCase();
  const base=`${prefix}-${String(orderNumber).padStart(6,'0')}`;
  // A revision is suffixed rather than renumbered, so the original number
  // stays recognisable on the replacement document.
  return version>1?`${base}-R${version-1}`:base;
};

/** Place of supply, from the state code on the GSTIN and the delivery state. */
function placeOfSupply(business,address){
  if(!business.taxId)return null;
  const sellerState=business.taxId.slice(0,2);
  return {
    sellerStateCode:sellerState,
    buyerState:address?.state||'',
    // Reported, not asserted: deciding CGST/SGST against IGST needs the
    // buyer's state code, which this application does not collect. The
    // invoice prints the place of supply and leaves the split alone.
    note:'Place of supply is the delivery address state.',
  };
}

/**
 * Freezes an invoice for a paid order.
 *
 * Idempotent on (order_id) WHERE status='issued': a retried job, a redelivered
 * webhook and a double-clicked admin button all resolve to the one invoice
 * that already exists, with its original number and its original figures.
 */
export async function createInvoice(orderId){
  const o=await orderDetails(orderId);
  assert(o&&['paid','refunding','partially_refunded','refunded'].includes(o.payment_status),409,'An invoice requires a verified payment.');
  const business=businessDetails();
  assert(business.name&&business.address&&business.email,503,'Invoice business name, address, and email must be configured.');

  // Already issued: do not renumber, do not recompute, do not overwrite.
  const existing=await invoices().findOne({order_id:orderId,status:'issued'});
  if(existing){
    await queueEmail(`invoice-email:${orderId}`,o.email,`Invoice ${existing.number} for order #${o.number}`,{template:'invoice',orderId,userId:o.user_id,attachInvoice:true});
    return existing;
  }

  const snapshot=buildSnapshot(o,business);
  const invoiceId=id();
  await transaction(async session=>{
    // `INSERT ... ON CONFLICT DO NOTHING` against the one-live-invoice-per-order
    // index becomes an upsert carrying only $setOnInsert: if an issued invoice
    // already exists nothing is written, so a retried job cannot renumber or
    // recompute a document a customer has already been sent. order_id and
    // status come from the filter and so must not be repeated in $setOnInsert.
    await invoices().updateOne(
      {order_id:orderId,status:'issued'},
      {$setOnInsert:{
        _id:invoiceId,
        id:invoiceId,
        number:invoiceNumber(o.number,1),
        business,
        snapshot,
        version:1,
        revision_of:null,
        reason:'',
        created_at:new Date(),
      }},
      {upsert:true,session},
    );
    await queueEmail(`invoice-email:${orderId}`,o.email,`Invoice ${invoiceNumber(o.number,1)} for order #${o.number}`,{template:'invoice',orderId,userId:o.user_id,attachInvoice:true},session);
  });
  return invoices().findOne({order_id:orderId,status:'issued'});
}

/**
 * Everything the document prints, frozen at issue time.
 *
 * Built from the order's own item snapshots (`order_items` already records the
 * name, SKU, size, colour and unit price as they were when the order was
 * placed), never from the current catalogue.
 */
export function buildSnapshot(o,business){
  const rate=taxRateFor(o);
  const allocated=allocateInvoiceLines(o,o.items);
  const walletApplied=o.wallet_applied??0;
  const gatewayPaid=o.payment?.gateway_payment_id?o.payment.amount:0;

  return {
    documentVersion:1,
    issuedAt:new Date().toISOString(),
    business,
    placeOfSupply:placeOfSupply(business,o.address),
    order:{
      id:o.id,
      number:o.number,
      placedAt:o.created_at,
      currency:o.currency,
    },
    customer:{
      name:o.address?.name||'',
      email:o.email,
      phone:o.address?.phone||'',
      // One address is collected at checkout and used for both, so they are
      // recorded as the same rather than inventing a separate billing address.
      billing:o.address,
      shipping:o.address,
      sameAddress:true,
    },
    lines:allocated.lines,
    tax:{
      bps:rate.bps,
      // True when the rate was divided back out of the recorded amounts
      // because the order predates the tax_bps column.
      derived:rate.derived,
      amount:allocated.tax,
    },
    totals:{
      subtotal:o.subtotal,
      // The order records one discount figure; the coupon code itself is not
      // stored on the order, so it is reported as an order-level discount
      // rather than attributed to a coupon that cannot be named.
      discount:o.discount,
      taxable:allocated.lines.reduce((sum,l)=>sum+l.taxable,0),
      tax:allocated.tax,
      shipping:o.shipping,
      total:o.total,
    },
    payment:{
      // The two components, so an order split between coins and a card shows
      // both and they add up to the total.
      walletApplied,
      walletCoins:o.wallet_coins??0,
      gatewayAmount:gatewayPaid,
      method:walletApplied>0&&gatewayPaid>0?'Wallet coins and card'
        :walletApplied>0?'Wallet coins'
          :o.payment?.method?`Card / ${o.payment.method}`:'Card',
      reference:o.payment?.gateway_payment_id||'',
      status:o.payment_status,
      paidTotal:walletApplied+gatewayPaid,
    },
  };
}

/* ----------------------------------------------------------------- rendering */

const PAGE={margin:40,width:515};
const INK='#111827';
const MUTED='#6b7280';
const RULE='#d1d5db';

/**
 * Renders the PDF from the stored snapshot.
 *
 * Reads `invoices.snapshot` and nothing else -- no order, no product and no
 * settings lookup -- which is what makes a reprint byte-identical to the
 * original however much the catalogue has changed since.
 */
export async function invoicePdf(orderId,{invoiceId=null}={}){
  const invoice=invoiceId
    ?await invoices().findOne({_id:invoiceId})
    :await invoices().findOne({order_id:orderId,status:'issued'});
  assert(invoice,404,'Invoice is not available yet.');

  const s=invoice.snapshot;
  // An invoice issued before the snapshot column existed has nothing to render
  // from. Say so rather than silently falling back to live data, which is the
  // behaviour this replaced.
  assert(s&&s.order&&Array.isArray(s.lines),409,'This invoice predates the billing snapshot and must be reissued before it can be printed.');

  // CreationDate is pinned to when the invoice was ISSUED, not to now, so a
  // reprint is byte-identical to the original document. A tax invoice that
  // differs every time it is downloaded is not really one document, and a
  // customer and an operator comparing two copies should get the same file.
  const issued=new Date(s.issuedAt);
  const doc=new PDFDocument({size:'A4',margin:PAGE.margin,info:{
    Title:`Invoice ${invoice.number}`,
    Author:s.business.name,
    Subject:`Invoice for order #${s.order.number}`,
    CreationDate:issued,
    ModDate:issued,
  }});
  const chunks=[];
  const result=new Promise((resolve,reject)=>{
    doc.on('data',c=>chunks.push(c));
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.on('error',reject);
  });

  const cur=s.order.currency==='INR'?'\u20B9':`${s.order.currency} `;
  const money=v=>`${cur}${(v/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const left=PAGE.margin;
  const right=PAGE.margin+PAGE.width;
  const rule=(y)=>{doc.strokeColor(RULE).lineWidth(0.6).moveTo(left,y).lineTo(right,y).stroke();};

  /* ------------------------------------------------------------ header */
  doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text(s.business.tradeName||s.business.name,left,PAGE.margin);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text('TAX INVOICE',left,doc.y+2,{characterSpacing:1.6});

  // Document identity, right-aligned against the brand.
  const metaTop=PAGE.margin;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
    .text(`Invoice ${invoice.number}`,left,metaTop,{width:PAGE.width,align:'right'});
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(`Invoice date  ${new Date(s.issuedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}`,left,doc.y+1,{width:PAGE.width,align:'right'})
    .text(`Order #${s.order.number}`,left,doc.y+1,{width:PAGE.width,align:'right'})
    .text(`Order date  ${new Date(s.order.placedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}`,left,doc.y+1,{width:PAGE.width,align:'right'});
  if(invoice.version>1){
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
      .text(`Revision ${invoice.version-1}`,left,doc.y+1,{width:PAGE.width,align:'right'});
  }

  let y=Math.max(doc.y,metaTop+56)+8;
  rule(y);y+=10;

  /* ------------------------------------------- seller and buyer, side by side */
  const col=(PAGE.width-20)/2;
  const blockTop=y;

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('SOLD BY',left,y,{characterSpacing:1});
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(s.business.name,left,doc.y+3,{width:col});
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(s.business.address,left,doc.y+2,{width:col});
  if(s.business.taxId)doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(`GSTIN  ${s.business.taxId}`,left,doc.y+3,{width:col});
  if(s.business.registration)doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`Reg. no.  ${s.business.registration}`,left,doc.y+2,{width:col});
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(s.business.invoiceEmail||s.business.email,left,doc.y+2,{width:col});
  if(s.business.phone)doc.text(s.business.phone,left,doc.y+1,{width:col});
  const sellerBottom=doc.y;

  const bx=left+col+20;
  const a=s.customer.billing||{};
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('BILLED & SHIPPED TO',bx,blockTop,{characterSpacing:1});
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(s.customer.name,bx,doc.y+3,{width:col});
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text([a.line1,a.line2,a.city,a.state,a.postalCode,a.country].filter(Boolean).join(', '),bx,doc.y+2,{width:col})
    .text(s.customer.email,bx,doc.y+2,{width:col});
  if(s.customer.phone)doc.text(s.customer.phone,bx,doc.y+1,{width:col});
  if(s.customer.sameAddress)doc.fontSize(7.5).text('Billing and delivery address are the same.',bx,doc.y+3,{width:col});
  if(s.placeOfSupply?.buyerState)doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`Place of supply  ${s.placeOfSupply.buyerState}`,bx,doc.y+3,{width:col});

  y=Math.max(sellerBottom,doc.y)+12;
  rule(y);y+=12;

  /* ------------------------------------------------------------- line table */
  // Columns sized so the widest realistic value fits without wrapping into
  // its neighbour. Description takes the slack.
  const COLS=[
    {key:'n',label:'#',width:16,align:'left'},
    {key:'desc',label:'DESCRIPTION',width:174,align:'left'},
    {key:'qty',label:'QTY',width:26,align:'right'},
    {key:'rate',label:'RATE',width:58,align:'right'},
    {key:'disc',label:'DISC.',width:50,align:'right'},
    {key:'taxable',label:'TAXABLE',width:58,align:'right'},
    {key:'taxpc',label:'TAX %',width:34,align:'right'},
    {key:'tax',label:'TAX',width:48,align:'right'},
    {key:'total',label:'AMOUNT',width:51,align:'right'},
  ];
  const xOf=(index)=>left+COLS.slice(0,index).reduce((sum,c)=>sum+c.width+3,0);

  const head=(atY)=>{
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED);
    COLS.forEach((c,i)=>doc.text(c.label,xOf(i),atY,{width:c.width,align:c.align,characterSpacing:0.4}));
    const bottom=atY+11;
    rule(bottom);
    return bottom+6;
  };
  y=head(y);

  const taxLabel=s.tax.bps>0?`${(s.tax.bps/100).toFixed(s.tax.bps%100===0?0:2)}%`:'—';
  s.lines.forEach((l,index)=>{
    // Two printed rows per line: the name, then the identifiers underneath.
    const needed=l.hsn?30:26;
    if(y+needed>782){doc.addPage();y=head(PAGE.margin);}
    doc.font('Helvetica').fontSize(8.5).fillColor(INK);
    const cells=[
      String(index+1),
      l.name,
      String(l.quantity),
      money(l.unitPrice),
      l.discount>0?`-${money(l.discount)}`:'—',
      money(l.taxable),
      taxLabel,
      money(l.tax),
      money(l.total),
    ];
    COLS.forEach((c,i)=>doc.text(cells[i],xOf(i),y,{width:c.width,align:c.align,lineBreak:i===1}));
    const nameBottom=doc.y;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text([`SKU ${l.sku}`,l.hsn?`HSN ${l.hsn}`:null,l.size,l.color].filter(Boolean).join('  ·  '),
        xOf(1),nameBottom+1,{width:COLS[1].width+120});
    y=Math.max(nameBottom,doc.y)+7;
    doc.strokeColor('#eceef2').lineWidth(0.5).moveTo(left,y-3).lineTo(right,y-3).stroke();
  });

  /* ---------------------------------------------------------------- totals */
  if(y+150>782){doc.addPage();y=PAGE.margin;}
  y+=6;
  const labelX=left+PAGE.width-250;
  const valueX=left+PAGE.width-110;
  const row=(label,value,{bold=false,size=8.5,gap=13}={})=>{
    doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(bold?INK:MUTED)
      .text(label,labelX,y,{width:130,align:'right'})
      .fillColor(INK).text(value,valueX,y,{width:110,align:'right'});
    y+=gap;
  };

  row('Subtotal',money(s.totals.subtotal));
  if(s.totals.discount>0)row('Discount',`-${money(s.totals.discount)}`);
  row('Taxable value',money(s.totals.taxable));
  row(`Tax${s.tax.bps>0?` (${taxLabel})`:''}`,money(s.totals.tax));
  row('Shipping',s.totals.shipping>0?money(s.totals.shipping):'Free');

  rule(y+1);y+=8;
  row('Total',money(s.totals.total),{bold:true,size:11,gap:16});

  // The payment breakdown. Coins are shown as a payment, not as a discount on
  // the taxable value -- the tax was charged on the full order and redeeming
  // store credit does not change that.
  if(s.payment.walletApplied>0){
    rule(y+1);y+=8;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('PAID BY',labelX,y,{width:130,align:'right'});y+=11;
    row(`Wallet coins (${s.payment.walletCoins.toLocaleString('en-IN')})`,`-${money(s.payment.walletApplied)}`);
    if(s.payment.gatewayAmount>0)row('Card payment',money(s.payment.gatewayAmount));
    row('Amount paid',money(s.payment.paidTotal),{bold:true});
  }else{
    row('Amount paid',money(s.payment.paidTotal||s.totals.total),{bold:true});
  }

  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(`Payment method  ${s.payment.method}`,labelX,y+2,{width:240,align:'right'});
  if(s.payment.reference){
    doc.fontSize(7.5).text(`Reference  ${s.payment.reference}`,labelX,doc.y+1,{width:240,align:'right'});
  }
  y=doc.y+16;

  /* ---------------------------------------------------------------- footer */
  if(y+90>800){doc.addPage();y=PAGE.margin;}
  rule(y);y+=10;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
    .text(`Thank you for shopping with ${s.business.tradeName||s.business.name}.`,left,y,{width:PAGE.width});
  y=doc.y+5;
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  const support=[s.business.invoiceEmail||s.business.email,s.business.phone].filter(Boolean).join('  ·  ');
  if(support)doc.text(`Questions about this invoice: ${support}`,left,y,{width:PAGE.width});
  if(s.returnsPolicy)doc.text(s.returnsPolicy,left,doc.y+3,{width:PAGE.width});
  doc.text('This is a computer-generated invoice.',left,doc.y+3,{width:PAGE.width});
  if(s.tax.derived){
    // Stated plainly rather than hidden: the rate was reconstructed from the
    // recorded amounts because the order predates the tax_bps column.
    doc.text('Tax rate shown is derived from the recorded tax amount for this order.',left,doc.y+2,{width:PAGE.width});
  }

  doc.end();
  return result;
}

/**
 * Issues a corrected invoice, voiding the original.
 *
 * The replacement is a new row with the next version number and a
 * `revision_of` pointer; the original stays in the table marked 'void' with
 * both documents retrievable. Nothing is ever overwritten, which is the whole
 * reason this exists rather than a regenerate button.
 */
export async function reviseInvoice(orderId,reason,actorId){
  assert(typeof reason==='string'&&reason.trim().length>=10,400,'A revision requires a reason of at least 10 characters.');
  const o=await orderDetails(orderId);
  assert(o,404,'Order not found.');
  const business=businessDetails();
  assert(business.name&&business.address&&business.email,503,'Invoice business details must be configured.');

  return transaction(async session=>{
    // LOCK 10 (was `SELECT ... FOR UPDATE` on the issued invoice). Voiding it
    // is the claim: `status:'issued'` in the filter means only one of two
    // concurrent revisions can void the original, and the loser sees no issued
    // invoice to revise rather than both inserting version 2.
    const current=await invoices().findOneAndUpdate(
      {order_id:orderId,status:'issued'},
      {$set:{status:'void'}},
      {returnDocument:'before',session},
    );
    assert(current,409,'There is no issued invoice to revise.');
    const version=current.version+1;
    const next=id();
    const replacement={
      _id:next,
      id:next,
      order_id:orderId,
      number:invoiceNumber(o.number,version),
      business,
      snapshot:buildSnapshot(o,business),
      status:'issued',
      version,
      revision_of:current._id,
      reason:reason.trim(),
      created_at:new Date(),
    };
    await invoices().insertOne(replacement,{session});
    return replacement;
  });
}

/** Every invoice ever issued for an order, newest first. */
export async function invoiceHistory(orderId){
  return invoices()
    .find({order_id:orderId},{projection:{_id:0,id:1,number:1,status:1,version:1,revision_of:1,reason:1,created_at:1}})
    .sort({version:-1})
    .toArray();
}
