'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Plus, Pencil, ShoppingCart, Users, Tag, X, ExternalLink, Truck,
  PlayCircle, FileDown, RefreshCw,
} from 'lucide-react';
import { api, money } from './api.js';
import { useStore, useResource, Loading } from './components.jsx';
import { Pagination } from './components/ui/Pagination.jsx';
import { PaymentPanel } from './components/admin/PaymentPanel.jsx';
import { ShippingPanel } from './components/admin/ShippingPanel.jsx';
import { Products } from './components/admin/Products.jsx';
import { Exchanges } from './components/admin/Exchanges.jsx';
import { WalletAdmin } from './components/admin/WalletAdmin.jsx';
import { Enquiries } from './components/admin/Enquiries.jsx';
import { CategoryManager } from './components/admin/CategoryManager.jsx';
import { AuditLog } from './components/admin/AuditLog.jsx';
import { Overview } from './components/admin/Overview.jsx';
import { AdminShell, AdminDenied, ADMIN_TABS } from './components/admin/AdminShell.jsx';
import {
  Card, SectionCard, PageHeading, Btn, Badge, StatusBadge, DataTable, EmptyState,
  AdminField, SearchField, Modal, ConfirmDelete, INPUT, Skeleton, usePagedResource,
} from './components/admin/kit.jsx';

/**
 * Store administration.
 *
 * The section lives in the URL. The route is an optional catch-all,
 * `/admin/[[...section]]`, which once read nothing: every panel was selected by
 * `useState('overview')`, so there were no deep links, the back button did
 * nothing, and a refresh always returned to Overview.
 *
 * The client check below is for the operator's benefit only. Authorisation is
 * enforced on the server, where `adminRoutes.use(auth,admin)` guards all of it
 * and the role is read from the database on every request -- so this rendering
 * for a signed-out visitor exposes nothing but an empty frame. The cached
 * session the store hydrates from is a hint for painting, never a permission.
 */
export function Admin() {
  const { user, ready } = useStore();
  const pathname = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState('');

  const segment = pathname.replace(/^\/admin\/?/, '').split('/')[0];
  const tab = ADMIN_TABS.includes(segment) ? segment : 'overview';
  const setTab = (id) => {
    setSearch('');
    router.push(id === 'overview' ? '/admin' : `/admin/${id}`, { scroll: false });
  };

  if (!ready) return <Loading />;
  if (user?.role !== 'admin') return <AdminDenied />;

  // The header search is scoped to whichever list is open, which is why it is
  // threaded down rather than being a global index this app does not have.
  const scoped = { search, onSearch: setSearch };

  return (
    <AdminShell tab={tab} onTab={setTab} search={search} onSearch={setSearch}>
      {tab === 'overview' ? <Overview onTab={setTab} />
        : tab === 'products' ? <Products {...scoped} />
        : tab === 'orders' ? <Orders {...scoped} />
        : tab === 'enquiries' ? <Enquiries {...scoped} />
        : tab === 'categories' ? <CategoryManager {...scoped} />
        : tab === 'exchanges' ? <Exchanges {...scoped} />
        : tab === 'wallets' ? <WalletAdmin {...scoped} />
        : tab === 'customers' ? <Customers {...scoped} />
        : tab === 'coupons' ? <Coupons />
        : tab === 'settings' ? <Settings />
        : <AuditLog />}
    </AdminShell>
  );
}

/* -------------------------------------------------------------------- orders */

function Orders({ search, onSearch }) {
  const [selected, setSelected] = useState('');
  const list = usePagedResource('/admin/orders', { limit: 20, params: { q: search } });

  return (
    <>
      <PageHeading
        title="Orders"
        subtitle={`${list.total} ${list.total === 1 ? 'order' : 'orders'}`}
        action={<SearchField value={search} onSubmit={onSearch} placeholder="Email or order number" label="Search orders" className="w-full sm:w-[300px]" />}
      />

      <Card>
        <DataTable
          head={['Order', 'Customer', 'Total', 'Payment', 'Fulfilment', '']}
          loading={list.loading}
          isEmpty={!list.rows.length}
          empty={<EmptyState icon={ShoppingCart} title={search ? 'No orders match that search' : 'No orders yet'} text={search ? 'Search by customer email or order number.' : 'Orders placed by customers will appear here.'} />}
        >
          {list.rows.map((order) => (
            <tr key={order.id}>
              <td><span className="font-semibold">#{order.number}</span><small>{new Date(order.created_at).toLocaleDateString()}</small></td>
              <td><span className="font-medium">{order.customer}</span><small>{order.email}</small></td>
              <td className="font-medium whitespace-nowrap">{money(order.total, order.currency)}</td>
              <td><StatusBadge value={order.payment_status} /></td>
              <td><StatusBadge value={order.status} /></td>
              <td className="text-right"><Btn size="sm" onClick={() => setSelected(order.id)}>Manage</Btn></td>
            </tr>
          ))}
        </DataTable>
        <div className="px-4 pb-4">
          <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} unit="orders" />
        </div>
      </Card>

      {selected && <OrderAdmin id={selected} onClose={() => setSelected('')} onChange={list.reload} />}
    </>
  );
}

function OrderAdmin({ id, onClose, onChange }) {
  const { data: o, loading, error, reload } = useResource(`/orders/${id}`);
  const { notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [gatewayId, setGatewayId] = useState('');
  const [shipmentId, setShipmentId] = useState('');

  async function action(name, body) {
    setBusy(true);
    try {
      const r = await api(`/admin/orders/${id}/${name}`, { method: 'POST', body });
      notify(r.message || 'Operation completed.');
      reload();
      onChange();
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={o ? `Order #${o.number}` : 'Order'} subtitle={o?.email} width="max-w-[720px]">
      {loading ? (
        <><Skeleton className="h-4 w-2/3" /><Skeleton className="mt-3 h-4 w-1/2" /><Skeleton className="mt-6 h-24 w-full" /></>
      ) : error ? (
        <p className="m-0 text-[14px] text-admin-danger">{error}</p>
      ) : (
        <>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[14px] [&_dd]:m-0 [&_dt]:text-admin-text-2">
            <dt>Customer</dt><dd className="font-medium">{o.address.name}</dd>
            <dt>Total</dt><dd className="font-medium">{money(o.total, o.currency)}</dd>
            <dt>Address</dt><dd>{Object.values(o.address).filter(Boolean).join(', ')}</dd>
            <dt>Payment</dt><dd><StatusBadge value={o.payment_status} /></dd>
            <dt>Fulfilment</dt><dd><StatusBadge value={o.status} /></dd>
            {o.shipment && (
              <>
                <dt>Shipment</dt>
                <dd>{o.shipment.status} Â· AWB {o.shipment.awb || 'pending'} Â· {o.shipment.courier || 'courier pending'}</dd>
              </>
            )}
          </dl>

          <div className="my-5 flex flex-wrap gap-2 border-y border-admin-border py-4">
            <Link href={`/orders/${o.id}`} className="inline-flex h-9 items-center gap-2 rounded-[9px] border border-admin-border px-3.5 text-[13px] font-semibold hover:bg-admin-bg">
              Invoice <ExternalLink size={13} strokeWidth={2} />
            </Link>
            {o.status === 'confirmed' && (
              <Btn icon={PlayCircle} disabled={busy} onClick={() => action('status', { status: 'processing' })}>Start processing</Btn>
            )}
            {/* Queues the same work ShippingPanel does synchronously below.
                Kept for the case where an operator wants it handed to the
                worker rather than waiting on Shiprocket. */}
            {o.payment_status === 'paid' && ['confirmed', 'processing'].includes(o.status) && !o.shipment && (
              <Btn icon={Truck} disabled={busy} onClick={() => action('fulfill')}>Queue fulfillment</Btn>
            )}
          </div>

          {/* Shipping before payment: once an order is paid, fulfilment is the
              next thing an operator acts on, and the refund panel is the
              exception rather than the routine. */}
          <ShippingPanel orderId={id} onChange={() => { reload(); onChange(); }} />

          <PaymentPanel orderId={id} blocked={Boolean(o.shipment)} onChange={() => { reload(); onChange(); }} />

          {o.payment && !o.payment.gateway_order_id && (
            <form className="mt-5 border-t border-admin-border pt-5" onSubmit={(e) => { e.preventDefault(); action('reconcile-payment', { gatewayOrderId: gatewayId }); }}>
              <AdminField label="Reconcile payment" hint="The exact Razorpay order ID. Verified against this order's amount and receipt before it is attached." value={gatewayId} onChange={(e) => setGatewayId(e.target.value)} required />
              <Btn type="submit" disabled={busy}>Verify and attach</Btn>
            </form>
          )}

          {o.shipment && ['reconciliation_required', 'assignment_review', 'creating', 'assigning'].includes(o.shipment.status) && (
            <form className="mt-5 border-t border-admin-border pt-5" onSubmit={(e) => { e.preventDefault(); action('reconcile-shipment', { providerOrderId: shipmentId }); }}>
              <AdminField label="Reconcile shipment" hint="The exact Shiprocket order ID. Verified against this order before it is attached." value={shipmentId} onChange={(e) => setShipmentId(e.target.value)} required />
              <Btn type="submit" disabled={busy}>Verify and attach</Btn>
            </form>
          )}
        </>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------- customers */

function Customers({ search, onSearch }) {
  const list = usePagedResource('/admin/customers', { limit: 20, params: { q: search } });
  const { config } = useStore();

  return (
    <>
      <PageHeading
        title="Customers"
        subtitle={`${list.total} ${list.total === 1 ? 'account' : 'accounts'}`}
        action={<SearchField value={search} onSubmit={onSearch} placeholder="Name or email" label="Search customers" className="w-full sm:w-[300px]" />}
      />
      <Card>
        <DataTable
          head={['Name', 'Email', 'Orders', 'Lifetime spend', 'Verified', 'Joined']}
          loading={list.loading}
          isEmpty={!list.rows.length}
          empty={<EmptyState icon={Users} title={search ? 'No customers match that search' : 'No accounts yet'} text={search ? 'Search by name or email address.' : 'Customer accounts appear here after registration.'} />}
        >
          {list.rows.map((customer) => (
            <tr key={customer.id}>
              <td>
                <span className="font-medium">{customer.name}</span>
                {customer.role === 'admin' && <small>Administrator</small>}
              </td>
              <td>{customer.email}</td>
              <td>{customer.orders}</td>
              <td className="font-medium whitespace-nowrap">{money(customer.spend, config.currency)}</td>
              <td>{customer.verified ? <Badge tone="success" dot>Verified</Badge> : <Badge tone="warning" dot>Unverified</Badge>}</td>
              <td className="whitespace-nowrap">{new Date(customer.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </DataTable>
        <div className="px-4 pb-4">
          <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} unit="customers" />
        </div>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------- coupons */

function Coupons() {
  const { data, loading, reload } = useResource('/admin/coupons');
  const { notify } = useStore();
  const blank = { code: '', percent: 10, minimum: 0, active: true, expires_at: null };
  const [coupon, setCoupon] = useState(blank);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');

  async function remove(code) {
    setBusy(code);
    try {
      await api(`/admin/coupons/${encodeURIComponent(code)}`, { method: 'DELETE' });
      notify(`${code} deleted.`);
      reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy('');
    }
  }

  async function save(event) {
    event.preventDefault();
    setBusy('save');
    try {
      await api('/admin/coupons', { method: 'PUT', body: coupon });
      notify('Discount code saved.');
      setOpen(false);
      reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy('');
    }
  }

  const expired = (c) => c.expires_at && new Date(c.expires_at) < new Date();

  return (
    <>
      <PageHeading
        title="Discount codes"
        subtitle={`${data?.length ?? 0} ${data?.length === 1 ? 'code' : 'codes'}`}
        action={<Btn variant="primary" icon={Plus} onClick={() => { setCoupon(blank); setOpen(true); }}>New code</Btn>}
      />

      <Card>
        <DataTable
          head={['Code', 'Discount', 'Minimum spend', 'Expires', 'Status', '']}
          loading={loading}
          isEmpty={!data?.length}
          empty={<EmptyState icon={Tag} title="No discount codes" text="Create a code to offer a percentage discount at checkout." action={<Btn variant="primary" icon={Plus} onClick={() => { setCoupon(blank); setOpen(true); }}>New code</Btn>} />}
        >
          {(data ?? []).map((c) => (
            <tr key={c.code}>
              <td><span className="font-semibold tracking-[0.02em]">{c.code}</span></td>
              <td className="font-medium">{c.percent}% off</td>
              <td>{c.minimum > 0 ? money(c.minimum) : <span className="text-admin-muted">None</span>}</td>
              <td className="whitespace-nowrap">{c.expires_at ? new Date(c.expires_at).toLocaleDateString() : <span className="text-admin-muted">Never</span>}</td>
              <td>
                {!c.active ? <Badge tone="danger" dot>Inactive</Badge>
                  : expired(c) ? <Badge tone="warning" dot>Expired</Badge>
                  : <Badge tone="success" dot>Active</Badge>}
              </td>
              <td>
                <div className="flex items-center justify-end gap-3">
                  <Btn size="sm" icon={Pencil} onClick={() => { setCoupon(c); setOpen(true); }}>Edit</Btn>
                  <ConfirmDelete onConfirm={() => remove(c.code)} busy={busy === c.code} />
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={coupon.code ? `Edit ${coupon.code}` : 'New discount code'}
        subtitle="Percentage discounts applied at checkout"
        footer={
          <>
            <Btn onClick={() => setOpen(false)}>Cancel</Btn>
            <Btn variant="primary" busy={busy === 'save'} onClick={save}>Save code</Btn>
          </>
        }
      >
        <form onSubmit={save}>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <AdminField label="Code" hint="Letters, digits and hyphens." value={coupon.code} onChange={(e) => setCoupon({ ...coupon, code: e.target.value.toUpperCase() })} required />
            <AdminField label="Percent off" type="number" min="1" max="90" value={coupon.percent} onChange={(e) => setCoupon({ ...coupon, percent: Number(e.target.value) })} required />
            <AdminField label="Minimum spend" hint="Minor units. 0 for no minimum." type="number" min="0" value={coupon.minimum} onChange={(e) => setCoupon({ ...coupon, minimum: Number(e.target.value) })} required />
            <AdminField label="Expiry date" hint="Optional. Expires at the end of the chosen day." type="date" value={coupon.expires_at?.slice(0, 10) || ''} onChange={(e) => setCoupon({ ...coupon, expires_at: e.target.value ? `${e.target.value}T23:59:59.000Z` : null })} />
          </div>
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={coupon.active} onChange={(e) => setCoupon({ ...coupon, active: e.target.checked })} className="size-4 accent-admin-text" />
            Active
          </label>
        </form>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ settings */

/** Exactly the fields PUT /admin/settings accepts. Its schema is strict. */
const STORE_FIELDS = [
  'shipping', 'free_shipping_threshold', 'tax_bps', 'support_email',
  'returns_policy', 'privacy_policy', 'terms',
  'social_x', 'social_facebook', 'social_instagram', 'social_linkedin',
];

/** Exactly the fields PUT /admin/settings/wallet accepts. */
const WALLET_FIELDS = [
  'wallet_enabled', 'wallet_paise_per_coin', 'wallet_min_redeem_coins',
  'wallet_max_order_percent', 'wallet_min_order_value', 'wallet_partial_redemption',
  'wallet_coins_expire', 'wallet_expiry_days', 'wallet_promo_enabled',
  'exchange_enabled', 'exchange_window_days', 'exchange_credit_shipping',
];

function Settings() {
  const { data, loading, error } = useResource('/admin/settings');
  const { notify, setConfig, config } = useStore();
  const [settings, setSettings] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);

  // The two groups are picked by name rather than taken as "everything except
  // id". PUT /admin/settings is `.strict()`, so sending the wallet columns to
  // it is a 400 â€” and GET /admin/settings returns the whole row, including
  // them. Splitting explicitly is what keeps the two endpoints independent.
  useEffect(() => {
    if (!data) return;
    setSettings(Object.fromEntries(STORE_FIELDS.map((key) => [key, data[key]])));
    setWallet(Object.fromEntries(WALLET_FIELDS.map((key) => [key, data[key]])));
  }, [data]);

  if (loading || !settings || !wallet) {
    return (
      <>
        <PageHeading title="Settings" subtitle="Checkout charges, contact details and policies" />
        <Card className="p-5"><Skeleton className="h-4 w-1/3" /><Skeleton className="mt-4 h-10 w-full" /><Skeleton className="mt-3 h-10 w-full" /></Card>
      </>
    );
  }
  if (error) return <Card className="p-5"><p className="m-0 text-[14px] text-admin-danger">{error}</p></Card>;

  const set = (key) => (e) => setSettings({ ...settings, [key]: e.target.value });
  const setNumber = (key) => (e) => setSettings({ ...settings, [key]: Number(e.target.value) });

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/admin/settings', { method: 'PUT', body: settings });
      setConfig({ ...config, settings: { ...config.settings, ...settings } });
      notify('Store settings saved.');
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  /** Posts only the wallet fields, to the endpoint that accepts them. */
  async function saveWallet() {
    setWalletBusy(true);
    try {
      await api('/admin/settings/wallet', { method: 'PUT', body: wallet });
      setConfig({ ...config, settings: { ...config.settings, ...wallet } });
      notify('Wallet settings saved.');
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setWalletBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <PageHeading
        title="Settings"
        subtitle="Checkout charges, contact details and policies"
        action={<Btn variant="primary" type="submit" busy={busy}>Save settings</Btn>}
      />

      <SectionCard title="Checkout & charges" subtitle="Amounts in minor units. Tax is a flat exclusive rate in basis points, so 100 = 1%." className="mb-4">
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <AdminField label="Shipping charge" type="number" min="0" value={settings.shipping} onChange={setNumber('shipping')} required />
          <AdminField label="Free shipping threshold" hint="0 means shipping is always free." type="number" min="0" value={settings.free_shipping_threshold} onChange={setNumber('free_shipping_threshold')} required />
          <AdminField label="Tax rate" hint="Basis points â€” 100 = 1%." type="number" min="0" value={settings.tax_bps} onChange={setNumber('tax_bps')} required />
          <AdminField label="Support email" type="email" value={settings.support_email} onChange={set('support_email')} />
        </div>
        <p className="m-0 text-[13px] leading-relaxed text-admin-text-2">
          Confirm the correct tax treatment for your business before enabling checkout.
        </p>
      </SectionCard>

      {/* Saved by its own endpoint, so the storefront settings above keep the
          exact body their strict schema already accepted. The nested form is
          avoided by using a button that calls saveWallet directly. */}
      <SectionCard
        title="Wallet & exchanges"
        subtitle="GEMIES store coins. Everything here is off until you switch it on."
        className="mb-4"
        action={<Btn variant="primary" type="button" busy={walletBusy} onClick={saveWallet}>Save wallet settings</Btn>}
      >
        <div className="mb-4 grid gap-3">
          {[
            ['wallet_enabled', 'Wallet enabled', 'Customers can see their balance and redeem coins at checkout.'],
            ['exchange_enabled', 'Exchanges enabled', 'Customers can request an exchange on an eligible order.'],
            ['wallet_partial_redemption', 'Allow partial redemption', 'Off means coins must cover the whole order or cannot be used.'],
            ['wallet_promo_enabled', 'Allow promotional credits', 'Permits goodwill credits that are not tied to an exchange.'],
            ['wallet_coins_expire', 'Coins expire', 'Off means coins never expire.'],
            ['exchange_credit_shipping', 'Credit shipping on a full return', 'Only applies when every item on the order comes back.'],
          ].map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={Boolean(wallet[key])}
                onChange={(e) => setWallet({ ...wallet, [key]: e.target.checked })}
                className="mt-0.5 size-4 shrink-0 accent-admin-text"
              />
              <span>
                <span className="block text-[14px] font-medium text-admin-text">{label}</span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-admin-text-2">{hint}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <AdminField
            label="Coin value"
            hint={`Paise per coin. ${wallet.wallet_paise_per_coin === 100 ? '100 means 1 coin = â‚¹1.' : `${wallet.wallet_paise_per_coin} paise = ${money(wallet.wallet_paise_per_coin, config.currency)} per coin.`}`}
            type="number" min="1" value={wallet.wallet_paise_per_coin}
            onChange={(e) => setWallet({ ...wallet, wallet_paise_per_coin: Number(e.target.value) })}
            required
          />
          <AdminField
            label="Maximum share of an order"
            hint="Percent of the order total that coins may pay for."
            type="number" min="0" max="100" value={wallet.wallet_max_order_percent}
            onChange={(e) => setWallet({ ...wallet, wallet_max_order_percent: Number(e.target.value) })}
            required
          />
          <AdminField
            label="Minimum coins to redeem"
            hint="0 means any balance can be spent."
            type="number" min="0" value={wallet.wallet_min_redeem_coins}
            onChange={(e) => setWallet({ ...wallet, wallet_min_redeem_coins: Number(e.target.value) })}
            required
          />
          <AdminField
            label="Minimum order value"
            hint="Minor units. 0 means coins can be used on any order."
            type="number" min="0" value={wallet.wallet_min_order_value}
            onChange={(e) => setWallet({ ...wallet, wallet_min_order_value: Number(e.target.value) })}
            required
          />
          <AdminField
            label="Expiry duration"
            hint="Days after crediting. Required when coins expire."
            type="number" min="0" value={wallet.wallet_expiry_days}
            error={wallet.wallet_coins_expire && wallet.wallet_expiry_days <= 0 ? 'Set a duration, or turn expiry off.' : undefined}
            onChange={(e) => setWallet({ ...wallet, wallet_expiry_days: Number(e.target.value) })}
            required
          />
          <AdminField
            label="Exchange window"
            hint="Days from delivery in which a customer may request an exchange."
            type="number" min="0" max="365" value={wallet.exchange_window_days}
            error={wallet.exchange_enabled && wallet.exchange_window_days <= 0 ? 'Set a window, or turn exchanges off.' : undefined}
            onChange={(e) => setWallet({ ...wallet, exchange_window_days: Number(e.target.value) })}
            required
          />
        </div>

        <p className="m-0 text-[13px] leading-relaxed text-admin-text-2">
          Coins are credited only after a returned item passes inspection, and can be spent only on
          this store â€” there is no cash withdrawal. Changing the coin value affects future
          transactions only; completed ones keep the rate they were made at.
        </p>
      </SectionCard>

      <SectionCard title="Social links" subtitle="Shown in the storefront footer. Leave blank to hide a platform." className="mb-4">
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {[['social_x', 'X (Twitter)'], ['social_facebook', 'Facebook'], ['social_instagram', 'Instagram'], ['social_linkedin', 'LinkedIn']].map(([key, label]) => (
            <AdminField key={key} label={label} type="url" placeholder="https://" value={settings[key] || ''} onChange={set(key)} />
          ))}
        </div>
        <p className="m-0 text-[13px] text-admin-text-2">Only https links are accepted.</p>
      </SectionCard>

      <SectionCard title="Policies" subtitle="Shown on the customer-facing policy pages. Line breaks are preserved.">
        {[['returns_policy', 'Returns policy'], ['privacy_policy', 'Privacy policy'], ['terms', 'Terms & conditions']].map(([key, label]) => (
          <AdminField key={key} label={label}>
            <textarea value={settings[key]} onChange={set(key)} className={`${INPUT} h-auto min-h-[140px] py-2.5`} />
          </AdminField>
        ))}
        <Btn variant="primary" type="submit" busy={busy}>Save settings</Btn>
      </SectionCard>
    </form>
  );
}
