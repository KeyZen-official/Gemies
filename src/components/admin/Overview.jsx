'use client';
import { useState } from 'react';
import Link from 'next/link';
import {
  IndianRupee, DollarSign, ShoppingCart, Package, Users, Mail, BarChart3,
  ArrowUpRight, ArrowDownRight, Minus, RefreshCw, ChevronRight, CreditCard, Truck,
  FileText, Clock, Inbox, Settings as SettingsIcon,
} from 'lucide-react';
import { api, money } from '../../api.js';
import { useStore, useResource } from '../../components.jsx';
import {
  Card, CARD, SectionCard, PageHeading, Btn, Badge, StatusBadge, DataTable,
  EmptyState, CardsSkeleton, Skeleton, TINTS, SELECT,
} from './kit.jsx';
import { RevenueChart } from './RevenueChart.jsx';

/**
 * The overview screen.
 *
 * Every number on it comes from GET /admin/dashboard, which derives all of them
 * from real rows -- the KPI values, the period-over-period deltas, the daily
 * revenue series and the integration health. Nothing here is a placeholder, and
 * where there is no data to show (no paid orders, no orders at all) the screen
 * says so rather than drawing a flat line or an invented percentage.
 */

const WINDOW_LABELS = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' };

const INTEGRATION_META = {
  payments: { label: 'Payments', icon: CreditCard, detail: 'Razorpay' },
  shipping: { label: 'Shipping', icon: Truck, detail: 'Shiprocket' },
  email: { label: 'Email', icon: Mail, detail: 'Resend' },
  invoices: { label: 'Invoices', icon: FileText, detail: 'Business details' },
};

const HEALTH = {
  configured: { tone: 'success', text: 'Configured' },
  unconfigured: { tone: 'warning', text: 'Needs configuration' },
  error: { tone: 'danger', text: 'Error' },
};

export function Overview({ onTab }) {
  const [days, setDays] = useState(7);
  const { config, notify } = useStore();
  const dashboard = useResource(`/admin/dashboard?days=${days}`);
  const orders = useResource('/admin/orders?page=1&limit=5');
  const data = dashboard.data;

  const range = (() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - (days - 1));
    const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `${fmt(start)} – ${fmt(end)}`;
  })();

  const currencyIcon = config.currency === 'INR' ? IndianRupee : DollarSign;

  const cards = data ? [
    { key: 'revenue', label: 'Captured revenue', value: money(data.revenue, config.currency), icon: currencyIcon, tone: 'green', delta: data.deltas.revenue },
    { key: 'orders', label: 'Orders', value: data.orders, icon: ShoppingCart, tone: 'blue', delta: data.deltas.orders, target: 'orders' },
    { key: 'products', label: 'Products', value: data.products, icon: Package, tone: 'orange', delta: data.deltas.products, target: 'products' },
    { key: 'customers', label: 'Customers', value: data.customers, icon: Users, tone: 'purple', delta: data.deltas.customers, target: 'customers' },
    { key: 'enquiries', label: 'Open enquiries', value: data.open_enquiries, icon: Mail, tone: 'red', delta: data.deltas.open_enquiries, target: 'enquiries' },
  ] : [];

  return (
    <>
      <PageHeading
        title="Overview"
        subtitle="Here's what's happening with your store today."
        action={
          <label className={`${CARD} inline-flex h-10 items-center gap-2 px-3`}>
            <Clock size={15} strokeWidth={2} className="shrink-0 text-admin-text-2" />
            <span className="sr-only">Date range</span>
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="h-full border-0 bg-transparent pr-1 text-[13px] font-medium text-admin-text focus-visible:outline-none"
            >
              {(data?.windows ?? [7, 30, 90]).map((value) => (
                <option key={value} value={value}>{WINDOW_LABELS[value] ?? `Last ${value} days`}</option>
              ))}
            </select>
            <span className="hidden border-l border-admin-border pl-2 text-[12px] whitespace-nowrap text-admin-muted xl:inline">{range}</span>
          </label>
        }
      />

      {dashboard.loading ? <CardsSkeleton /> : dashboard.error ? (
        <Card className="mb-6 p-5">
          <p className="m-0 text-[14px] text-admin-danger">{dashboard.error}</p>
          <Btn className="mt-3" icon={RefreshCw} onClick={dashboard.reload}>Try again</Btn>
        </Card>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {cards.map((card) => <KpiCard key={card.key} card={card} days={days} onTab={onTab} />)}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard
          title="Revenue"
          subtitle={`Captured revenue over the ${WINDOW_LABELS[days]?.toLowerCase() ?? `last ${days} days`}`}
          icon={BarChart3}
          tone="green"
          bodyClassName="p-4"
        >
          {dashboard.loading
            ? <Skeleton className="h-[220px] w-full" />
            : <RevenueChart series={data?.series} hasRevenue={data?.hasRevenue} currency={config.currency} days={days} />}
        </SectionCard>

        <SectionCard
          title="Recent orders"
          subtitle="Latest orders from your store"
          icon={ShoppingCart}
          tone="blue"
          bodyClassName="p-0"
          action={<Btn size="sm" onClick={() => onTab('orders')}>View all</Btn>}
        >
          {orders.loading ? (
            <div className="p-4"><Skeleton className="h-4 w-full" /><Skeleton className="mt-4 h-4 w-3/4" /><Skeleton className="mt-4 h-4 w-5/6" /></div>
          ) : !orders.data?.rows?.length ? (
            <EmptyState icon={Inbox} title="No orders yet" text="Orders placed by customers will appear here." compact />
          ) : (
            <ul className="m-0 list-none p-0">
              {orders.data.rows.map((order) => (
                <li key={order.id} className="border-b border-admin-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onTab('orders')}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-admin-bg"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-semibold">#{order.number} · {order.customer}</span>
                      <span className="mt-0.5 block text-[12px] text-admin-text-2">
                        {new Date(order.created_at).toLocaleDateString()} · {order.status}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[14px] font-semibold">{money(order.total, order.currency)}</span>
                      <StatusBadge value={order.payment_status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <IntegrationCard data={data} loading={dashboard.loading} onTab={onTab} />

      <JobsCard data={data} loading={dashboard.loading} reload={dashboard.reload} notify={notify} />
    </>
  );
}

/* ----------------------------------------------------------------- KPI cards */

function KpiCard({ card, days, onTab }) {
  const Icon = card.icon;
  const body = (
    <>
      <span className={`grid size-11 place-items-center rounded-[11px] ${TINTS[card.tone]}`}>
        <Icon size={19} strokeWidth={2} />
      </span>
      <span className="mt-3 block text-[13px] font-medium text-admin-text-2">{card.label}</span>
      <span className="mt-1 block text-[30px] leading-none font-bold tracking-[-0.02em] text-admin-text">{card.value}</span>
      <Delta delta={card.delta} days={days} />
    </>
  );
  const shell = `${CARD} p-[18px] text-left`;
  return card.target
    ? <button type="button" onClick={() => onTab(card.target)} className={`${shell} transition-colors hover:border-admin-muted/50 hover:bg-[#fcfcfd]`}>{body}</button>
    : <div className={shell}>{body}</div>;
}

/**
 * Period-over-period change.
 *
 * `percent` is null when the previous window had nothing to compare against,
 * which the server reports as `fresh` rather than dividing by zero and calling
 * it +100%. That case is labelled "new in this period", because it is.
 */
function Delta({ delta, days }) {
  if (!delta) return null;
  const since = `vs previous ${days} days`;

  if (delta.direction === 'fresh') {
    return (
      <span className="mt-2.5 flex items-center gap-1.5 text-[12px]">
        <ArrowUpRight size={13} strokeWidth={2.4} className="text-admin-success" />
        <span className="font-semibold text-admin-success">{delta.current} new</span>
        <span className="text-admin-muted">in this period</span>
      </span>
    );
  }
  if (delta.percent === null || delta.direction === 'flat') {
    return (
      <span className="mt-2.5 flex items-center gap-1.5 text-[12px]">
        <Minus size={13} strokeWidth={2.4} className="text-admin-muted" />
        <span className="font-semibold text-admin-text-2">No change</span>
        <span className="text-admin-muted">{since}</span>
      </span>
    );
  }
  const up = delta.direction === 'up';
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="mt-2.5 flex items-center gap-1.5 text-[12px]">
      <Arrow size={13} strokeWidth={2.4} className={up ? 'text-admin-success' : 'text-admin-danger'} />
      <span className={`font-semibold ${up ? 'text-admin-success' : 'text-admin-danger'}`}>
        {Math.abs(delta.percent)}%
      </span>
      <span className="text-admin-muted">{since}</span>
    </span>
  );
}

/* ------------------------------------------------------------- integrations */

function IntegrationCard({ data, loading, onTab }) {
  const items = data?.integrationHealth ?? [];
  return (
    <SectionCard
      title="Integration configuration"
      subtitle="Status of third-party services"
      icon={SettingsIcon}
      action={<Btn size="sm" onClick={() => onTab('settings')}>Manage settings</Btn>}
      className="mb-6"
    >
      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[72px]" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {items.map((item) => {
              const meta = INTEGRATION_META[item.name] ?? { label: item.name, icon: SettingsIcon };
              const Icon = meta.icon;
              const health = HEALTH[item.health];
              return (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => onTab('settings')}
                  className="flex items-center gap-3 rounded-[11px] border border-admin-border px-3.5 py-3 text-left transition-colors hover:bg-admin-bg"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-[#f1f5f9] text-admin-text-2">
                    <Icon size={16} strokeWidth={2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold">{meta.label}</span>
                    <span className="mt-1 block">
                      <Badge tone={health.tone} dot>
                        {item.health === 'error' ? `${health.text} · ${item.failures} failed` : health.text}
                      </Badge>
                    </span>
                  </span>
                  <ChevronRight size={15} strokeWidth={2} className="shrink-0 text-admin-muted" />
                </button>
              );
            })}
          </div>
          {/* The same caveat the previous dashboard carried, kept because it is
              still true: presence of credentials is not proof of a working
              integration. What is new is that a configured service with failed
              jobs against it reports as an error rather than as healthy. */}
          <p className="m-0 mt-4 text-[13px] leading-relaxed text-admin-text-2">
            Configuration shows whether credentials are present, and turns red when the queue has
            recorded real failures against a service. Full production readiness still requires an
            actual test transaction.
          </p>
        </>
      )}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------- jobs */

function JobsCard({ data, loading, reload, notify }) {
  const [busy, setBusy] = useState('');
  const jobs = data?.jobs ?? [];

  async function retry(job) {
    setBusy(job.id);
    try {
      await api(`/admin/jobs/${job.id}/retry`, { method: 'POST' });
      notify('Job queued for retry.');
      reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <SectionCard
      title="Background jobs"
      subtitle="Latest execution status of scheduled jobs"
      icon={Clock}
      bodyClassName="p-0"
      action={<Btn size="sm" icon={RefreshCw} onClick={reload}>Refresh</Btn>}
    >
      <DataTable
        head={['Type', 'Status', 'Attempts', 'Last error', 'Last run', '']}
        loading={loading}
        isEmpty={!jobs.length}
        empty={<EmptyState icon={Clock} title="Nothing queued" text="Pending and failed jobs appear here. Completed jobs are cleared after 30 days." compact />}
      >
        {jobs.map((job) => (
          <tr key={job.id}>
            <td className="font-medium">{job.kind}</td>
            <td><StatusBadge value={job.status} /></td>
            <td>{job.attempts}</td>
            <td className="max-w-[320px] text-[13px] text-admin-text-2 [overflow-wrap:anywhere]">{job.last_error || '—'}</td>
            <td className="text-[13px] whitespace-nowrap text-admin-text-2">
              {/* ran_at is stamped by the worker when it claims a job. Null means
                  it has never run, which is different from "ran and failed". */}
              {job.ran_at
                ? new Date(job.ran_at).toLocaleString()
                : <span className="text-admin-muted">Not yet run</span>}
              {job.status === 'pending' && job.available_at && new Date(job.available_at) > new Date() && (
                <small className="mt-0.5 block text-[12px] text-admin-muted">
                  Next attempt {new Date(job.available_at).toLocaleTimeString()}
                </small>
              )}
            </td>
            <td>
              {job.status === 'failed' && (
                <Btn size="sm" busy={busy === job.id} onClick={() => retry(job)}>Retry</Btn>
              )}
            </td>
          </tr>
        ))}
      </DataTable>
    </SectionCard>
  );
}
