'use client';

import type { CSSProperties } from 'react';
import type { Locale } from '@/lib/i18n';
import { wp2026Copy, type BarChartSpec } from './copy';

/* ───────────────────────── Shared bits ───────────────────────── */

function FigHead({ title, caption }: { title: string; caption: string }) {
  return (
    <figcaption className="bl-fig-head">
      <span className="bl-fig-title">{title}</span>
      <span className="bl-eyebrow">{caption}</span>
    </figcaption>
  );
}

const toneClass = (tone?: 'ink' | 'accent' | 'hatch') =>
  tone === 'accent' ? 'is-accent' : tone === 'hatch' ? 'is-hatch' : '';

/* ───────────────────────── Bar chart ───────────────────────── */

function BarChart({ spec }: { spec: BarChartSpec }) {
  return (
    <figure className={`bl-fig bl-bars${spec.diverging ? ' is-diverging' : ''}`}>
      <FigHead title={spec.title} caption={spec.caption} />
      <div className="bl-bars-rows">
        {spec.bars.map((b) => {
          const pct = Math.max((Math.abs(b.value) / spec.max) * 100, 0.8);
          const style: CSSProperties = spec.diverging
            ? b.value >= 0
              ? { left: '50%', width: `${pct / 2}%` }
              : { right: '50%', width: `${pct / 2}%` }
            : { left: 0, width: `${pct}%` };
          return (
            <div className="bl-bar" key={b.label}>
              <span className="bl-bar-label">{b.label}</span>
              <div className="bl-bar-track">
                <div className={`bl-bar-fill ${toneClass(b.tone)}`} style={style} />
                <span
                  className="bl-bar-value"
                  style={
                    spec.diverging
                      ? b.value >= 0
                        ? { left: `calc(50% + ${pct / 2}% + 8px)` }
                        : { left: 'calc(50% + 8px)' }
                      : pct > 80
                        ? { right: 10, color: 'var(--color-bg)' }
                        : { left: `calc(${pct}% + 10px)` }
                  }
                >
                  {b.display}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {spec.axis && (
        <div className="bl-bars-axis" aria-hidden>
          <span />
          <div>
            {spec.axis.map((a) => (
              <span key={a}>{a}</span>
            ))}
          </div>
        </div>
      )}
      {spec.legend && (
        <div className="bl-legend">
          {spec.legend.map((l) => (
            <span key={l.label}>
              <i className={toneClass(l.tone)} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

export function EcommerceBars({ locale }: { locale: Locale }) {
  return <BarChart spec={wp2026Copy(locale).ecommerce} />;
}

export function CoreHoursBars({ locale }: { locale: Locale }) {
  return <BarChart spec={wp2026Copy(locale).coreHours} />;
}

export function CwvBars({ locale }: { locale: Locale }) {
  return <BarChart spec={wp2026Copy(locale).cwv} />;
}

/* ───────────────────────── Share line chart ───────────────────────── */

const Y_MAX = 44;
const Y_MIN = 41;
const X = [8, 50, 92];
const yPos = (v: number) => ((Y_MAX - v) / (Y_MAX - Y_MIN)) * 100;

export function ShareLine({ locale }: { locale: Locale }) {
  const c = wp2026Copy(locale).share;
  const pts = c.points.map((p, i) => ({ ...p, x: X[i], y: yPos(p.value) }));
  const ticks = [44, 43, 42, 41];
  const fmt = (n: number) => `${n}%`;

  return (
    <figure className="bl-fig bl-share">
      <FigHead title={c.title} caption={c.caption} />
      <div className="bl-share-plot" role="img" aria-label={c.ariaLabel}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {ticks.map((t) => (
            <line key={t} className="bl-grid" x1="0" x2="100" y1={yPos(t)} y2={yPos(t)} />
          ))}
          <polyline
            className="bl-line"
            points={`${pts[0].x},${pts[0].y} ${pts[1].x},${pts[1].y}`}
          />
          <polyline
            className="bl-line is-accent"
            points={`${pts[1].x},${pts[1].y} ${pts[2].x},${pts[2].y}`}
          />
        </svg>
        {ticks.map((t) => (
          <span key={t} className="bl-share-tick" style={{ top: `${yPos(t)}%` }}>
            {fmt(t)}
          </span>
        ))}
        {pts.map((p, i) => {
          const last = i === pts.length - 1;
          return (
            <span key={p.label}>
              <i
                className={`bl-share-dot${last ? ' is-accent' : ''}`}
                style={{ left: `${p.x}%`, top: `${p.y}%` }}
              />
              <span
                className={`bl-share-label${last ? ' is-accent' : ''}`}
                style={{
                  left: `${p.x}%`,
                  top: `${p.y}%`,
                  transform:
                    i === 0
                      ? 'translate(-10%, -120%)'
                      : last
                        ? 'translate(-90%, 25%)'
                        : 'translate(-50%, -125%)',
                }}
              >
                <b>{p.display}</b>
                <span>{p.label}</span>
              </span>
            </span>
          );
        })}
      </div>
      <div className="bl-share-foot">
        <span>{c.footLeft}</span>
        <span>{c.footRight}</span>
      </div>
    </figure>
  );
}

/* ───────────────────────── Waffle ───────────────────────── */

export function VulnWaffle({ locale }: { locale: Locale }) {
  const c = wp2026Copy(locale).waffle;
  return (
    <figure className="bl-fig">
      <FigHead title={c.title} caption={c.caption} />
      <div className="bl-waffle" role="img" aria-label={c.ariaLabel}>
        {Array.from({ length: 100 }, (_, i) => (
          <i key={i} className={i >= 96 ? 'is-accent' : undefined} />
        ))}
      </div>
      <div className="bl-legend">
        <span>
          <i />
          {c.plugins}
        </span>
        <span>
          <i className="is-accent" />
          {c.rest}
        </span>
      </div>
    </figure>
  );
}
