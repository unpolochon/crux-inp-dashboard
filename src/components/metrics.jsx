import { ChartLine } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { INP, RATING_BG, RATING_TEXT, ms, pct, rate } from '@/lib/inp';

const RATING_LABEL = { good: 'Bon', ni: 'À améliorer', poor: 'Mauvais' };

/**
 * Carte p75 : valeur coloree par la note, ou message d'indisponibilite.
 * Avec `onSelect`, la carte devient un bouton (ouvre l'historique de la categorie).
 */
export function StatCard({ label, value, sample, note, onSelect }) {
  const r = rate(value);
  const Body = onSelect ? 'button' : 'div';
  return (
    <Card className="group gap-0 overflow-hidden py-0">
      <div className={`h-1 ${r ? RATING_BG[r] : 'bg-border'}`} />
      <CardContent className="p-0">
        <Body
          type={onSelect ? 'button' : undefined}
          onClick={onSelect}
          title={onSelect ? 'Voir l’historique' : undefined}
          className={`flex w-full flex-col gap-2 px-4 py-3 text-left ${
            onSelect
              ? 'cursor-pointer outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset'
              : ''
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="flex min-w-0 items-baseline gap-1 text-xs leading-tight text-muted-foreground" title={label}>
              {label}
              {onSelect && (
                <ChartLine className="size-3 shrink-0 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
              )}
            </span>
            {sample != null && (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">n={sample}</span>
            )}
          </div>
          {value == null ? (
            <p className="py-1 text-xs text-muted-foreground">{note ?? 'pas de données'}</p>
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
              <span className={`text-2xl font-semibold tabular-nums sm:text-3xl ${RATING_TEXT[r]}`}>{ms(value)}</span>
              <span className="text-sm text-muted-foreground">{INP.unit}</span>
              <Badge variant="outline" className="ml-auto text-[10px]">{RATING_LABEL[r]}</Badge>
            </div>
          )}
        </Body>
      </CardContent>
    </Card>
  );
}

export function CardGrid({ children }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

/** Barre empilee Good / NI / Poor. Les segments < 6 % n'affichent pas leur valeur, faute de place. */
export function DistributionBar({ label, dist }) {
  if (!dist || dist.good == null) return null;
  const segments = [
    ['good', dist.good],
    ['ni', dist.ni],
    ['poor', dist.poor],
  ];
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_1fr] items-center gap-3 sm:grid-cols-[minmax(0,13rem)_1fr]">
      <span className="truncate text-right text-xs text-muted-foreground" title={label}>{label}</span>
      <div className="flex h-6 overflow-hidden rounded-md border">
        {segments.map(([r, v]) => (
          <div
            key={r}
            className={`flex items-center justify-center text-[10px] font-medium text-background ${RATING_BG[r]}`}
            style={{ width: `${(v ?? 0) * 100}%` }}
            title={`${RATING_LABEL[r]} ${pct(v)}`}
          >
            {(v ?? 0) >= 0.06 && `${((v ?? 0) * 100).toFixed(1)} %`}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RatingLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {['good', 'ni', 'poor'].map((r) => (
        <span key={r} className="flex items-center gap-1.5">
          <i className={`size-2 rounded-sm ${RATING_BG[r]}`} />
          {RATING_LABEL[r]}
        </span>
      ))}
    </div>
  );
}

export function Section({ title, hint, children }) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
