import { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ExternalLink, FileDown, FileText,
  PackageCheck, RefreshCw, Truck, XCircle,
} from 'lucide-react';
import { api, money } from '../../api.js';
import { useStore, useResource } from '../../components.jsx';
import { AdminField, Badge, Btn, SELECT, Skeleton, StatusBadge } from './kit.jsx';

/**
 * Shiprocket shipping for one order.
 *
 * Reads /admin/orders/:id/shipment, which returns the shipment, its tracking
 * history and a `can` map of the operations its current state allows. Buttons
 * are rendered from that map rather than from logic repeated here: the server
 * refuses anything else anyway, so duplicating the rules in the browser would
 * only create a second place for them to disagree.
 *
 * Every action reports the provider's own message on failure. A Shiprocket
 * refusal usually explains itself ("Pickup location is not serviceable for
 * this courier"), and swallowing that in favour of "something went wrong"
 * leaves an operator with nothing to act on.
 *
 * Rendered inside the order Modal, so it uses flat tinted tiles rather than
 * nested Cards, matching PaymentPanel.
 */
export function ShippingPanel({ orderId, onChange }) {
  const { data, loading, error, reload } = useResource(`/admin/orders/${orderId}/shipment`);
  const { notify } = useStore();
  const [busy, setBusy] = useState('');
  const [couriers, setCouriers] = useState(null);
  const [courierId, setCourierId] = useState('');

  if (loading) {
    return (
      <section className="mt-5 border-t border-admin-border pt-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-4 h-24 w-full" />
      </section>
    );
  }
  if (error) {
    return (
      <section className="mt-5 border-t border-admin-border pt-5">
        <p className="m-0 text-[13px] text-admin-danger">{error}</p>
      </section>
    );
  }

  const { shipment, can, history, stages } = data;

  /** One shipping action, with its own busy state so buttons disable individually. */
  async function run(name, label, body) {
    setBusy(name);
    try {
      const result = await api(`/admin/orders/${orderId}/${name}`, { method: 'POST', body: body ?? {} });
      notify(result.message || `${label} completed.`);
      reload();
      onChange?.();
      return result;
    } catch (requestError) {
      // The provider's words, not ours.
      notify(requestError.message);
      reload();
      return null;
    } finally {
      setBusy('');
    }
  }

  async function loadCouriers() {
    setBusy('couriers');
    try {
      const result = await api(`/admin/orders/${orderId}/couriers`);
      setCouriers(result);
      if (!result.serviceable) notify('No courier services this PIN code for the configured parcel.');
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="mt-5 border-t border-admin-border pt-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 text-[15px] font-semibold text-admin-text">Shipping</h3>
        {shipment
          ? <StatusBadge value={shipment.stage} label={stages[shipment.stage] ?? shipment.stage} />
          : <Badge tone="neutral">No shipment</Badge>}
      </div>

      {/* The exact variables, not a generic "not configured". Credentials and
          the parcel measurements fail in completely different ways -- the
          first is a login error, the second a 503 at booking time -- and an
          operator reading this needs to know which one they are looking at. */}
      {!data.shippingConfigured && (
        <Tile tone="warning" icon={AlertTriangle}>
          <strong className="font-semibold">Shipping cannot book a parcel yet.</strong>{' '}
          {data.shippingMissing?.length
            ? <>Set {data.shippingMissing.join(', ')} in the environment, then restart the API.</>
            : <>Set SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD and SHIPROCKET_PICKUP_LOCATION, then restart the API.</>}
          {data.shippingMissing?.some((name) => name.startsWith('PACKAGE_')) && (
            <span className="mt-1 block text-admin-text-2">
              Measure a packed parcel for the PACKAGE_ values. Shiprocket prices on volumetric
              weight, so these are not estimated.
            </span>
          )}
        </Tile>
      )}

      {/* A parked shipment is the one state that needs a human, so it is said
          first and in full rather than being inferred from a disabled button. */}
      {shipment?.last_error && ['reconciliation_required', 'assignment_review'].includes(shipment.status) && (
        <Tile tone="danger" icon={AlertTriangle}>
          <strong className="font-semibold">Needs reconciliation.</strong>{' '}
          {shipment.last_error}
          <span className="mt-1 block text-admin-text-2">
            Check this order in the Shiprocket dashboard before retrying, so a second parcel is not booked.
          </span>
        </Tile>
      )}

      {shipment && (
        <dl className="m-0 mb-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[13px] [&_dd]:m-0 [&_dt]:text-admin-text-2">
          <dt>Booking</dt><dd>{String(shipment.status).replace(/_/g, ' ')}</dd>
          {shipment.awb && <><dt>AWB</dt><dd className="font-semibold">{shipment.awb}</dd></>}
          {shipment.courier && <><dt>Courier</dt><dd>{shipment.courier}</dd></>}
          {shipment.provider_status && <><dt>Provider status</dt><dd>{shipment.provider_status}</dd></>}
          {typeof shipment.freight_charge === 'number' && (
            <><dt>Freight</dt><dd>{money(shipment.freight_charge)}</dd></>
          )}
          {shipment.pickup_token && <><dt>Pickup token</dt><dd>{shipment.pickup_token}</dd></>}
          {shipment.estimated_delivery && (
            <><dt>Estimated delivery</dt><dd>{new Date(shipment.estimated_delivery).toLocaleDateString()}</dd></>
          )}
          {shipment.delivered_at && (
            <><dt>Delivered</dt><dd>{new Date(shipment.delivered_at).toLocaleString()}</dd></>
          )}
          {shipment.last_synced && (
            <><dt>Last synced</dt><dd className="text-admin-text-2">{new Date(shipment.last_synced).toLocaleString()}</dd></>
          )}
        </dl>
      )}

      {/* Courier selection. A quote, shown before anything is booked. */}
      {can.couriers && !shipment?.awb && (
        <div className="mb-4 rounded-[10px] border border-admin-border p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Btn size="sm" icon={Truck} busy={busy === 'couriers'} disabled={Boolean(busy)} onClick={loadCouriers}>
              Check couriers
            </Btn>
            {couriers?.couriers?.length > 0 && (
              <AdminField label="Courier" className="mb-0 min-w-[240px] flex-1">
                <select value={courierId} onChange={(event) => setCourierId(event.target.value)} className={SELECT}>
                  <option value="">Let Shiprocket choose</option>
                  {couriers.couriers.map((option) => (
                    <option key={option.courier_id} value={option.courier_id}>
                      {option.name} — {money(option.rate)}
                      {option.estimated_days ? ` · ${option.estimated_days} days` : ''}
                    </option>
                  ))}
                </select>
              </AdminField>
            )}
          </div>
          {couriers && !couriers.serviceable && (
            <p className="m-0 mt-3 text-[13px] text-admin-danger">
              No courier services {couriers.pincode} for a {couriers.weight} kg parcel.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {can.create && (
          <Btn variant="primary" icon={Truck} busy={busy === 'shipment'} disabled={Boolean(busy)}
            onClick={() => run('shipment', 'Shipment creation', { courierId: courierId || undefined })}>
            Create shipment
          </Btn>
        )}
        {can.assign && (
          <Btn variant="primary" icon={PackageCheck} busy={busy === 'awb'} disabled={Boolean(busy)}
            onClick={() => run('awb', 'AWB assignment', { courierId: courierId || undefined })}>
            Assign AWB
          </Btn>
        )}
        {can.pickup && (
          <Btn icon={CheckCircle2} busy={busy === 'pickup'} disabled={Boolean(busy)}
            onClick={() => run('pickup', 'Pickup scheduling')}>
            {shipment?.pickup_scheduled_at ? 'Reschedule pickup' : 'Schedule pickup'}
          </Btn>
        )}
        {can.label && (
          <Btn icon={FileDown} busy={busy === 'label'} disabled={Boolean(busy)}
            onClick={() => run('label', 'Label generation')}>
            Generate label
          </Btn>
        )}
        {can.manifest && (
          <Btn icon={FileText} busy={busy === 'manifest'} disabled={Boolean(busy)}
            onClick={() => run('manifest', 'Manifest generation')}>
            Generate manifest
          </Btn>
        )}
        {can.track && (
          <Btn icon={RefreshCw} busy={busy === 'track'} disabled={Boolean(busy)}
            onClick={() => run('track', 'Tracking refresh')}>
            Refresh tracking
          </Btn>
        )}
        {can.cancel && (
          <Btn variant="danger" icon={XCircle} busy={busy === 'cancel-shipment'} disabled={Boolean(busy)}
            onClick={() => run('cancel-shipment', 'Cancellation')}>
            Cancel shipment
          </Btn>
        )}
      </div>

      {(shipment?.label_url || shipment?.manifest_url || shipment?.tracking_url) && (
        <div className="mt-3 flex flex-wrap gap-4 text-[13px]">
          {shipment.label_url && <Download href={shipment.label_url}>Shipping label</Download>}
          {shipment.manifest_url && <Download href={shipment.manifest_url}>Manifest</Download>}
          {shipment.tracking_url && <Download href={shipment.tracking_url}>Courier tracking</Download>}
        </div>
      )}

      {!data.webhookConfigured && shipment && (
        <p className="m-0 mt-4 text-[12px] leading-relaxed text-admin-text-2">
          Shiprocket webhooks are not configured, so tracking updates arrive on the worker&apos;s
          sweep rather than immediately. Set SHIPROCKET_WEBHOOK_SECRET and the matching header in
          the Shiprocket dashboard to speed that up.
        </p>
      )}

      {history.length > 0 && (
        <div className="mt-5">
          <h4 className="m-0 mb-2.5 text-[13px] font-semibold text-admin-text">Tracking history</h4>
          <ol className="m-0 list-none space-y-2.5 p-0">
            {history.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex gap-3 text-[13px]">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-admin-border" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium text-admin-text">{entry.status || entry.label}</span>
                  <span className="mt-0.5 block text-[12px] text-admin-text-2">
                    {[entry.location, entry.at ? new Date(entry.at).toLocaleString() : null]
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

const TILE_TONES = {
  warning: 'border-[#fcd34d] bg-[#fffbeb] text-[#92400e]',
  danger: 'border-[#fca5a5] bg-[#fef2f2] text-[#991b1b]',
};

function Tile({ tone, icon: IconComponent, children }) {
  return (
    <div className={`mb-4 flex gap-3 rounded-[10px] border p-3.5 text-[13px] leading-relaxed ${TILE_TONES[tone]}`}>
      <IconComponent size={16} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
      <p className="m-0">{children}</p>
    </div>
  );
}

function Download({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1.5 font-semibold text-admin-text underline underline-offset-4">
      {children} <ExternalLink size={13} strokeWidth={2} aria-hidden />
    </a>
  );
}
