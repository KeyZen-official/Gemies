import {z} from 'zod';
import {config} from './config.mjs';
export const email=z.string().trim().toLowerCase().email().max(254);
export const password=z.string().min(12,'Use at least 12 characters.').max(128);
export const addressSchema=z.object({name:z.string().trim().min(2).max(100),phone:z.string().regex(/^[6-9]\d{9}$/,'Enter a valid 10-digit Indian mobile number.'),line1:z.string().trim().min(5).max(180),line2:z.string().trim().max(180).default(''),city:z.string().trim().min(2).max(100),state:z.string().trim().min(2).max(100),postalCode:z.string().regex(/^[1-9]\d{5}$/,'Enter a valid Indian PIN code.'),country:z.literal('India').default('India')}).strict();
export const itemSchema=z.object({variantId:z.string().uuid(),quantity:z.number().int().min(1).max(20)}).strict();
// `useWallet` is a boolean and nothing more. The client says whether to spend
// coins; the server decides how many and what they are worth. There is
// deliberately no field here for a coin count, a rupee discount or a
// conversion rate, because each would be a number the client could lie about.
export const checkoutSchema=z.object({address:addressSchema,coupon:z.string().trim().max(40).default(''),useWallet:z.boolean().default(false)}).strict();
// Product images are either a path this app serves, or a delivery URL on our
// own Cloudinary cloud. The cloud name is pinned so an admin cannot point the
// catalogue at an arbitrary external host, and the pattern is built from the
// sanitised value in config rather than from the raw environment variable.
// One or more path segments are allowed, because product photography lives in
// /assets/products/. Directory segments exclude '.', so a '..' traversal
// cannot match.
const localImage=/^\/(assets|uploads)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(webp|png|jpg|jpeg)$/;
const cloudImage=config.mediaCloud
  ? new RegExp(`^https://res\\.cloudinary\\.com/${config.mediaCloud}/image/upload/[A-Za-z0-9_,./-]+\\.(webp|png|jpg|jpeg)$`)
  : null;
const image=z.string().trim().max(400).refine(
  v=>localImage.test(v)||Boolean(cloudImage?.test(v)),
  {message:'Images must be an uploaded file or a path under /assets.'},
);
/** An optional image: a real path, or null for "not set". */
const optionalImage=z.union([z.literal(''),image]).nullable().default(null)
  .transform(v=>v||null);

export const productSchema=z.object({
  name:z.string().trim().min(2).max(160),
  slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180),
  description:z.string().trim().min(10).max(6000),
  brand:z.string().trim().min(1).max(80),
  category_id:z.string().uuid(),
  audience:z.enum(['Men','Women','Kids','Unisex']),
  price:z.number().int().min(1).max(100000000),
  compare_price:z.number().int().nullable().default(null),
  images:z.array(image).min(1).max(8),
  published:z.boolean(),
  featured:z.boolean(),

  // ----------------------------------------------------- the homepage rail
  // The hanging-garment hero. These are separate from `images` because the
  // rail needs a cut-out seated on one shared canvas so every piece hangs
  // from the same shoulder line at the same scale -- a catalogue photo
  // dropped straight in is the wrong size and sits at the wrong height.
  //
  // All four default to off/empty, so an existing product is unaffected and
  // a product only joins the rail when an operator puts it there.
  rail_enabled:z.boolean().default(false),
  rail_front:optionalImage,
  // Omitted rather than faked: with no back photograph the rail component
  // reuses the front for the reverse face, which is its documented fallback.
  rail_back:optionalImage,
  // Overrides the hang tag. Blank means the tag shows the product's real
  // price, so a tag can never silently disagree with what checkout charges.
  rail_tag:z.string().trim().max(24).default(''),
}).strict()
  .refine(v=>v.compare_price===null||v.compare_price>=v.price,{message:'Compare price must be greater than or equal to the price.'})
  // A rail entry with no front cut-out would hang an invisible garment.
  .refine(v=>!v.rail_enabled||Boolean(v.rail_front),{
    message:'Add a front rail image before putting this product on the homepage rail.',
    path:['rail_front'],
  });
