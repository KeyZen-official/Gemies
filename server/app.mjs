import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import {ZodError} from 'zod';
import {config} from './config.mjs';
import {sessionMiddleware,csrfMiddleware,limit,id} from './security.mjs';
import {authRoutes} from './auth.mjs';
import {routes} from './routes.mjs';
import {adminRoutes} from './admin.mjs';
import {razorpayWebhook,shiprocketWebhook} from './webhooks.mjs';
export const app=express();
app.disable('x-powered-by');if(process.env.TRUST_PROXY_HOPS)app.set('trust proxy',Number(process.env.TRUST_PROXY_HOPS));
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://checkout.razorpay.com'],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','https://*.razorpay.com',...(config.mediaEnabled?['https://res.cloudinary.com']:[])],connectSrc:["'self'",'https://*.razorpay.com'],frameSrc:['https://*.razorpay.com'],upgradeInsecureRequests:config.production?[]:null}},strictTransportSecurity:config.production?undefined:false}));
app.use((req,res,next)=>{req.requestId=id();res.set('X-Request-ID',req.requestId);if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');next();});
// Both webhooks take the raw body and are mounted before express.json, the
// session middleware and the CSRF check: they are authenticated by their own
// secret, carry no cookie, and Razorpay's signature is over the exact bytes it
// sent, which re-serialising parsed JSON would change.
app.post('/api/webhooks/razorpay',express.raw({type:'application/json',limit:'256kb'}),razorpayWebhook);
app.post('/api/webhooks/shiprocket',express.raw({type:['application/json','text/plain'],limit:'256kb'}),shiprocketWebhook);
app.use('/api',express.json({limit:'64kb'}),limit('api',600,60),sessionMiddleware,csrfMiddleware);
app.use('/api/auth',authRoutes);app.use('/api/admin',adminRoutes);app.use('/api',routes);
app.use('/api',(req,res)=>res.status(404).json({error:'Endpoint not found.'}));
app.use('/uploads',express.static(path.resolve(process.env.UPLOAD_DIR||'uploads'),{dotfiles:'deny',maxAge:'1d',setHeaders:res=>res.set('X-Content-Type-Options','nosniff')}));
// The Next.js server renders the storefront and proxies /api and /uploads here
// (see next.config.mjs), so this process serves only the API and uploaded files.
// A duplicate-key violation is a 409 with a message that does not echo the
// index or the value. 11000 is MongoDB's code for it.
const isDuplicate=error=>error.code===11000;
app.use((error,req,res,next)=>{const status=error instanceof ZodError?400:isDuplicate(error)?409:error.code==='LIMIT_FILE_SIZE'?413:error.status||500;const message=error instanceof ZodError?error.issues.map(e=>e.message).slice(0,3).join(' '):isDuplicate(error)?'This record already exists.':status===413?'Upload is too large.':status<500?error.message:status===503?error.message:'The operation could not be completed. Please try again.';console.error(JSON.stringify({event:'request_error',requestId:req.requestId,status,code:error.code||error.name}));res.status(status).json({error:message,requestId:req.requestId});});
