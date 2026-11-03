'use client';
import { useState } from 'react';
import { Mail, MailOpen, CheckCircle2, RotateCcw, Inbox } from 'lucide-react';
import { api } from '../../api.js';
import { useStore } from '../../components.jsx';
import {
  Card, PageHeading, Btn, Badge, SearchField, Segmented, EmptyState, Modal,
  Skeleton, usePagedResource,
} from './kit.jsx';
import { Pagination } from '../ui/Pagination.jsx';

/**
 * The Contact Us inbox.
 *
 * `contact_messages` was written by server/contact.mjs and read by nothing:
 * every enquiry went into the database where no one could see it, and the only
 * copy anyone read was the notification email. If that email failed, or nobody
 * was watching the business mailbox, the enquiry was simply lost.
 *
 * Defaults to the open enquiries rather than all of them, because the useful
 * question is "what still needs answering", not "what has ever been asked".
 * Marking one handled stamps who did it and when, so a second administrator
 * does not answer it again.
 *
 * There is no reply box. Replying belongs in a real mailbox with threading and
 * a record of what was sent; a textarea here would look like it had emailed the
 * customer without any of that. The address is a mailto link instead, which
 * hands the enquiry to whatever the administrator already uses.
 */
export function Enquiries({ search, onSearch }) {
  const { notify } = useStore();
  const [status, setStatus] = useState('open');
  const [busy, setBusy] = useState('');
  const [reading, setReading] = useState(null);

  const list = usePagedResource('/admin/contact', { limit: 20, params: { status, q: search } });
  const open = list.meta?.open ?? 0;

  async function setHandled(enquiry, handled) {
    setBusy(enquiry.id);
    try {
      await api(`/admin/contact/${enquiry.id}/handled`, { method: 'POST', body: { handled } });
      notify(handled ? 'Enquiry marked handled.' : 'Enquiry reopened.');
      setReading(null);
      list.reload();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <PageHeading
        title="Enquiries"
        subtitle={open > 0 ? `${open} awaiting a reply` : 'Everything has been handled'}
        action={
          <>
            <Segmented
              label="Filter by status"
              value={status}
              onChange={setStatus}
              options={[['open', 'Open', open], ['handled', 'Handled'], ['all', 'All']]}
            />
            <SearchField value={search} onSubmit={onSearch} placeholder="Name, email or subject" label="Search enquiries" className="w-full sm:w-[260px]" />
          </>
        }
      />

      <Card className="p-0">
        {list.loading ? (
          <div className="p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="border-b border-admin-border py-4 last:border-b-0">
                <Skeleton className="h-4 w-1/3" /><Skeleton className="mt-2 h-3 w-1/2" /><Skeleton className="mt-3 h-3 w-full" />
              </div>
            ))}
          </div>
        ) : !list.rows.length ? (
          <EmptyState
            icon={status === 'open' ? CheckCircle2 : Inbox}
            title={search ? 'No enquiries match that search'
              : status === 'open' ? 'Nothing waiting' : 'No enquiries yet'}
            text={search ? 'Search by name, email, subject or order number.'
              : status === 'open' ? 'Every enquiry has been marked handled.'
              : 'Messages from the contact form appear here.'}
          />
        ) : (
          <ul className="m-0 list-none p-0">
            {list.rows.map((enquiry) => (
              <li key={enquiry.id} className="border-b border-admin-border last:border-b-0">
                <div className="flex items-start gap-3 px-5 py-4">
                  <span className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-[9px] ${enquiry.handled_at ? 'bg-[#f1f5f9] text-admin-muted' : 'bg-[#fee2e2] text-admin-danger'}`}>
                    {enquiry.handled_at ? <MailOpen size={16} strokeWidth={1.9} /> : <Mail size={16} strokeWidth={1.9} />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setReading(enquiry)}
                        className="min-w-0 text-left text-[15px] font-semibold hover:underline hover:underline-offset-4"
                      >
                        {enquiry.subject}
                      </button>
                      <span className="text-[12px] whitespace-nowrap text-admin-muted">
                        {new Date(enquiry.created_at).toLocaleString()}
                      </span>
                    </div>

                    <p className="m-0 mt-1 text-[13px] text-admin-text-2 [overflow-wrap:anywhere]">
                      {enquiry.name} ·{' '}
                      <a className="underline underline-offset-2 hover:text-admin-text" href={`mailto:${enquiry.email}?subject=${encodeURIComponent(`Re: ${enquiry.subject}`)}`}>
                        {enquiry.email}
                      </a>
                      {enquiry.order_number && <> · order #{enquiry.order_number}</>}
                      {enquiry.from_account && <> · signed in</>}
                    </p>

                    <p className="m-0 mt-2 line-clamp-2 text-[14px] leading-relaxed text-admin-text">{enquiry.message}</p>

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Btn size="sm" onClick={() => setReading(enquiry)}>Read</Btn>
                      {enquiry.handled_at ? (
                        <>
                          <Badge tone="success" dot>Handled</Badge>
                          <span className="text-[12px] text-admin-muted">
                            {enquiry.handled_by_email ? `by ${enquiry.handled_by_email}` : ''}
                          </span>
                          <Btn size="sm" variant="ghost" icon={RotateCcw} busy={busy === enquiry.id} onClick={() => setHandled(enquiry, false)}>Reopen</Btn>
                        </>
                      ) : (
                        <Btn size="sm" variant="primary" icon={CheckCircle2} busy={busy === enquiry.id} onClick={() => setHandled(enquiry, true)}>
                          Mark handled
                        </Btn>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {list.rows.length > 0 && (
          <div className="px-5 pb-4">
            <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} unit="enquiries" />
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(reading)}
        onClose={() => setReading(null)}
        title={reading?.subject ?? ''}
        subtitle={reading ? `${reading.name} · ${reading.email}` : ''}
        footer={reading && (
          <>
            <a
              href={`mailto:${reading.email}?subject=${encodeURIComponent(`Re: ${reading.subject}`)}`}
              className="inline-flex h-9 items-center gap-2 rounded-[9px] border border-admin-border px-3.5 text-[13px] font-semibold hover:bg-admin-bg"
            >
              Reply by email
            </a>
            {reading.handled_at
              ? <Btn icon={RotateCcw} busy={busy === reading.id} onClick={() => setHandled(reading, false)}>Reopen</Btn>
              : <Btn variant="primary" icon={CheckCircle2} busy={busy === reading.id} onClick={() => setHandled(reading, true)}>Mark handled</Btn>}
          </>
        )}
      >
        {reading && (
          <>
            <dl className="m-0 mb-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[13px] [&_dd]:m-0 [&_dt]:text-admin-text-2">
              <dt>Received</dt><dd>{new Date(reading.created_at).toLocaleString()}</dd>
              {reading.order_number && <><dt>Order</dt><dd>#{reading.order_number}</dd></>}
              <dt>Status</dt>
              <dd>
                {reading.handled_at
                  ? <Badge tone="success" dot>Handled {new Date(reading.handled_at).toLocaleDateString()}{reading.handled_by_email ? ` by ${reading.handled_by_email}` : ''}</Badge>
                  : <Badge tone="warning" dot>Open</Badge>}
              </dd>
            </dl>
            <p className="m-0 rounded-[9px] bg-admin-bg p-4 text-[14px] leading-relaxed whitespace-pre-wrap text-admin-text">
              {reading.message}
            </p>
          </>
        )}
      </Modal>
    </>
  );
}
