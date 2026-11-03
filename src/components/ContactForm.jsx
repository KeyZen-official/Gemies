'use client';
import {useState} from 'react';
import {api} from '../api.js';
import {useStore, Field} from '../components.jsx';
import {Button} from './ui/Button.jsx';

/**
 * The Contact Us form.
 *
 * Posts to POST /api/contact, which validates every field again with zod,
 * rate-limits by IP, stores the enquiry, then queues two emails: the enquiry
 * to the business inbox and an acknowledgement to the customer. Nothing is
 * sent from the browser and no API key is involved here.
 *
 * `website` is a honeypot. It is hidden from the viewport and from the
 * accessibility tree, and the server rejects any submission that fills it in,
 * which removes most automated spam without a captcha.
 *
 * On success the form is replaced by the confirmation rather than cleared, so
 * a second click cannot submit the same enquiry again. The server also
 * collapses a duplicate by fingerprint, so a retry is harmless either way.
 */
export function ContactForm() {
  const {user, config} = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  if (done) {
    return (
      <div role="status" className="mt-8 rounded-[10px] bg-[#eaf0e6] px-5 py-5 text-[14px] leading-relaxed text-[#3d5b2d]">
        {done}
      </div>
    );
  }

  // Nothing can be delivered without a sender configured, so say so rather
  // than accepting a message that would sit in a queue.
  if (!config.email) {
    return (
      <p className="mt-8 rounded-[10px] border border-[#e6ddcb] bg-[#f5efe4] px-5 py-4 text-[13px] leading-relaxed text-[#765e35]">
        The contact form is awaiting email configuration. Please use the address above in the meantime.
      </p>
    );
  }

  return (
    <form
      className="mt-9 max-w-[560px]"
      onSubmit={async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(e.currentTarget));
        setError('');
        setBusy(true);
        try {
          const result = await api('/contact', {method: 'POST', body: values});
          setDone(result.message || 'Thank you — your message has been received.');
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="mb-5 text-[21px] md:text-[22px]">Send us a message</h2>

      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <Field label="Your name" name="name" autoComplete="name" minLength="2" maxLength="100" defaultValue={user?.name || ''} required />
        <Field label="Email address" name="email" type="email" autoComplete="email" maxLength="254" defaultValue={user?.email || ''} required />
      </div>
      <Field label="Subject" name="subject" minLength="3" maxLength="140" required />
      <Field label="Order number (optional)" name="orderNumber" maxLength="32" inputMode="numeric" />
      <Field label="Message">
        <textarea name="message" minLength="20" maxLength="4000" rows="6" required
          className="text-xs md:text-[13px]"
          placeholder="Tell us how we can help. Please include your order number if your question is about an order." />
      </Field>

      {/* Honeypot: hidden from sight and from screen readers, and never
          autofilled, so only an automated submitter fills it in. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      {error && <p role="alert" className="mb-4 text-xs text-[#a83329]">{error}</p>}

      <Button variant="dark" disabled={busy}>{busy ? 'Sending…' : 'Send message'}</Button>
      <p className="mt-4 mb-0 text-[11px] leading-relaxed">
        We use your message only to answer your enquiry. We usually reply within one working day.
      </p>
    </form>
  );
}
