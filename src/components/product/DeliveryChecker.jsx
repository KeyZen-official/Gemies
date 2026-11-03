'use client';
import { useState } from 'react';
import { api, money } from '../../api.js';
import { useStore } from '../../components.jsx';

const PIN = /^[1-9][0-9]{5}$/;

/**
 * Delivery serviceability for an Indian PIN code.
 *
 * Every figure here is the courier's own. The store's configured Shiprocket
 * account is queried through the existing /shipping/serviceability route,
 * which only reads coverage and creates nothing, and each courier's quoted
 * rate and estimate are printed exactly as returned. Where a courier gives no
 * estimate, that is said rather than filled in with a plausible date, and
 * until the store connects a shipping account the section says so instead of
 * showing a delivery promise nobody can keep.
 */
export function DeliveryChecker() {
  const { config } = useStore();
  const [pin, setPin] = useState('');
  const [state, setState] = useState({ status: 'idle' });

  const configured = Boolean(config.shipping);

  async function onCheck(event) {
    event.preventDefault();
    if (!PIN.test(pin)) {
      setState({ status: 'invalid', message: 'Enter a valid 6-digit Indian PIN code.' });
      return;
    }
    setState({ status: 'checking' });
    try {
      const result = await api(`/shipping/serviceability?pin=${pin}`);
      const couriers = result.couriers ?? [];
      setState(couriers.length
        ? { status: 'available', couriers: couriers.slice(0, 3) }
        : { status: 'unavailable', message: `No courier currently delivers to ${pin}.` });
    } catch (error) {
      setState({ status: 'error', message: error.message });
    }
  }

  return (
    <section className="mt-6 border-t border-rule pt-5">
      <h3 className="mb-1 text-[15px] font-medium tracking-normal">Check delivery date</h3>

      {!configured ? (
        <p className="m-0 text-[13px] leading-relaxed text-ink-soft">
          Delivery dates and charges become available once the store connects its shipping
          account. Nothing is estimated until then.
        </p>
      ) : (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-ink-soft">
            Enter your PIN code to see exact delivery dates and charges.
          </p>

          <form onSubmit={onCheck} className="relative mt-3.5 max-w-[340px]">
            <input
              value={pin}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, '').slice(0, 6));
                setState({ status: 'idle' });
              }}
              inputMode="numeric"
              maxLength={6}
              placeholder="PIN code"
              aria-label="Delivery PIN code"
              aria-invalid={state.status === 'invalid' ? 'true' : undefined}
              className="pr-20"
              required
            />
            <button
              className="absolute top-1/2 right-3 -translate-y-1/2 text-[13px] text-ink-soft underline underline-offset-4 hover:text-ink disabled:no-underline"
              disabled={state.status === 'checking' || pin.length < 6}
            >
              {state.status === 'checking' ? 'Checking…' : 'Check'}
            </button>
          </form>

          <div role="status" className="mt-3 text-[13px] [&>p]:m-0 [&>p]:text-[13px]">
            {state.status === 'checking' && <p>Checking couriers for {pin}…</p>}
            {(state.status === 'invalid' || state.status === 'error') && (
              <p className="text-[#a83329]">{state.message}</p>
            )}
            {state.status === 'unavailable' && <p>{state.message}</p>}
            {state.status === 'available' && (
              <ul className="m-0 grid list-none gap-2 p-0">
                {state.couriers.map((courier) => (
                  <li key={courier.name} className="rounded-md bg-[#f5f5f2] px-3 py-2.5">
                    <div className="flex justify-between gap-3.5">
                      <strong className="text-[13px]">{courier.name}</strong>
                      <span className="text-[13px] text-ink-soft">
                        {Number.isFinite(Number(courier.rate))
                          ? money(Number(courier.rate), config.currency)
                          : 'Rate not quoted'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-soft">
                      {courier.estimatedDays || 'No delivery estimate provided by this courier'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
