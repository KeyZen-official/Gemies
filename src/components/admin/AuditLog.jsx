'use client';
import { useState } from 'react';
import { ScrollText, UserX } from 'lucide-react';
import {
  Card, PageHeading, DataTable, EmptyState, SELECT, usePagedResource,
} from './kit.jsx';
import { Pagination } from '../ui/Pagination.jsx';

/**
 * The audit trail.
 *
 * It previously rendered `actor_id` and `entity_id` straight out of the table:
 * two raw UUIDs per row, which told you that something had happened to
 * something, by someone. The endpoint now joins the actor to a real account and
 * resolves the entity to a product name, category, order number or SKU, so a
 * row reads as a sentence.
 *
 * The action filter is built from the actions the log actually contains rather
 * than a hardcoded list, so it cannot drift as new audited operations are added
 * on the server.
 */
export function AuditLog() {
  const [action, setAction] = useState('');
  const list = usePagedResource('/admin/audit', { limit: 50, params: { action } });
  const actions = list.meta?.actions ?? [];

  return (
    <>
      <PageHeading
        title="Audit trail"
        subtitle={`${list.total} recorded ${list.total === 1 ? 'action' : 'actions'}`}
        action={
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <span className="text-admin-text-2">Action</span>
            <select value={action} onChange={(event) => setAction(event.target.value)} className={`${SELECT} w-auto min-w-[200px]`}>
              <option value="">All actions</option>
              {actions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        }
      />

      <Card>
        <DataTable
          head={['Action', 'Subject', 'Administrator', 'When']}
          loading={list.loading}
          isEmpty={!list.rows.length}
          empty={
            <EmptyState
              icon={ScrollText}
              title={action ? `No ${action} entries` : 'Nothing audited yet'}
              text={action ? 'Try a different action, or clear the filter.' : 'Administrator actions are recorded here as they happen.'}
            />
          }
        >
          {list.rows.map((entry) => (
            <tr key={entry.id}>
              <td>
                <code className="rounded-[6px] bg-admin-bg px-2 py-1 text-[12px] font-semibold text-admin-text">{entry.action}</code>
              </td>
              <td>
                {entry.entity_label
                  ? <><span className="font-medium">{entry.entity_label}</span><small>{entry.entity_id}</small></>
                  /* An entity deleted since the entry was written cannot be
                     named by any join, so the raw id is all there is. */
                  : <span className="text-[13px] text-admin-muted [overflow-wrap:anywhere]">{entry.entity_id}</span>}
              </td>
              <td>
                {entry.actor_email
                  ? <><span className="font-medium">{entry.actor_name}</span><small>{entry.actor_email}</small></>
                  /* audit_logs.actor_id is ON DELETE SET NULL, so an entry
                     outlives the administrator who made it. */
                  : <span className="inline-flex items-center gap-1.5 text-[13px] text-admin-muted"><UserX size={13} strokeWidth={2} /> Account removed</span>}
              </td>
              <td className="whitespace-nowrap">{new Date(entry.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </DataTable>
        <div className="px-4 pb-4">
          <Pagination page={list.page} pages={list.pages} total={list.total} onPage={list.setPage} unit="entries" />
        </div>
      </Card>
    </>
  );
}
