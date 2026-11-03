'use client';
import { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { EmptyState } from './kit.jsx';

/**
 * Captured revenue over the selected window, as a hand-drawn SVG line.
 *
 * No charting library. recharts or chart.js would be the obvious reach, but
 * this is one line, one axis pair and a hover readout; a dependency of that
 * size for it is not worth the bundle, and an inline SVG scales with the
 * container without a resize observer.
 *
 * The important behaviour is the empty state. The series comes back with a
 * point for every day in the window, so a store with no paid orders yields a
 * perfectly flat line along zero -- which looks like a real measurement of
 * nothing. When the server reports `hasRevenue: false` this draws no chart at
 * all and says so instead.
 */

const PAD = { top: 16, right: 16, bottom: 28, left: 52 };
const VIEW = { width: 760, height: 220 };

/** A short, readable tick: "Oct 24". */
const dayLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Rounded axis ceiling, so the top gridline is a number a person would pick. */
function ceilNice(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

export function RevenueChart({ series, hasRevenue, currency = 'INR', days }) {
  const [hover, setHover] = useState(null);

  const model = useMemo(() => {
    const points = series ?? [];
    if (points.length === 0) return null;
    // Values are minor units; the axis is drawn in major units.
    const max = ceilNice(Math.max(...points.map((p) => p.revenue)) / 100);
    const plotWidth = VIEW.width - PAD.left - PAD.right;
    const plotHeight = VIEW.height - PAD.top - PAD.bottom;
    const x = (index) => PAD.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const y = (minor) => PAD.top + plotHeight - (max === 0 ? 0 : (minor / 100 / max) * plotHeight);
    return {
      points, max, plotWidth, plotHeight, x, y,
      line: points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.revenue).toFixed(1)}`).join(' '),
      area: `M${x(0).toFixed(1)},${(PAD.top + plotHeight).toFixed(1)} `
        + points.map((p, i) => `L${x(i).toFixed(1)},${y(p.revenue).toFixed(1)}`).join(' ')
        + ` L${x(points.length - 1).toFixed(1)},${(PAD.top + plotHeight).toFixed(1)} Z`,
      // Four ticks including zero, at round fractions of the ceiling.
      ticks: [0, 0.5, 1].map((fraction) => ({ value: max * fraction, y: y(max * fraction * 100) })),
    };
  }, [series]);

  if (!hasRevenue) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No captured revenue yet"
        text={`Nothing has been paid for in the last ${days} days. Once an order is paid, daily revenue appears here.`}
        compact
      />
    );
  }
  if (!model) return null;

  const money = (major) => new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency', currency, maximumFractionDigits: major >= 1000 ? 0 : 2,
  }).format(major);

  // Every nth label, so a 90-day window does not overprint its own axis.
  const stride = Math.max(1, Math.ceil(model.points.length / 7));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        className="h-[220px] w-full"
        role="img"
        aria-label={`Captured revenue per day over the last ${days} days`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="revenue-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#166534" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#166534" stopOpacity="0" />
          </linearGradient>
        </defs>

        {model.ticks.map((tick) => (
          <g key={tick.value}>
            <line x1={PAD.left} x2={VIEW.width - PAD.right} y1={tick.y} y2={tick.y} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PAD.left - 8} y={tick.y + 4} textAnchor="end" fontSize="11" fill="#9ca3af">
              {money(tick.value)}
            </text>
          </g>
        ))}

        <path d={model.area} fill="url(#revenue-fill)" />
        <path d={model.line} fill="none" stroke="#166534" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

        {model.points.map((point, index) => (
          <g key={point.day}>
            {index % stride === 0 && (
              <text x={model.x(index)} y={VIEW.height - 8} textAnchor="middle" fontSize="11" fill="#9ca3af">
                {dayLabel(point.day)}
              </text>
            )}
            <circle
              cx={model.x(index)} cy={model.y(point.revenue)} r={hover === index ? 4.5 : 3}
              fill="#ffffff" stroke="#166534" strokeWidth="2"
            />
            {/* A wide invisible target, so hovering does not require hitting a 3px dot. */}
            <rect
              x={model.x(index) - model.plotWidth / Math.max(1, model.points.length) / 2}
              y={PAD.top}
              width={model.plotWidth / Math.max(1, model.points.length)}
              height={model.plotHeight}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
            />
          </g>
        ))}
      </svg>

      {hover !== null && model.points[hover] && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-[8px] border border-admin-border bg-admin-surface px-2.5 py-1.5 shadow-[0_6px_20px_rgba(15,23,42,0.1)]"
          style={{ left: `${(model.x(hover) / VIEW.width) * 100}%`, top: 0 }}
        >
          <p className="m-0 text-[11px] text-admin-muted">{dayLabel(model.points[hover].day)}</p>
          <p className="m-0 text-[13px] font-semibold text-admin-text">{money(model.points[hover].revenue / 100)}</p>
          <p className="m-0 text-[11px] text-admin-text-2">
            {model.points[hover].orders} paid {model.points[hover].orders === 1 ? 'order' : 'orders'}
          </p>
        </div>
      )}
    </div>
  );
}
