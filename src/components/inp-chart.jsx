import { Area, AreaChart, CartesianGrid, Dot, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { INP, dayFR, ms, rate } from '@/lib/inp';

const config = { p75: { label: 'INP p75', color: 'var(--chart-1)' } };

// Point colore selon la note du releve, pour lire d'un coup ou la courbe passe au-dessus du seuil.
const RatedDot = ({ cx, cy, payload }) =>
  cx == null ? null : <Dot cx={cx} cy={cy} r={3} fill={`var(--${rate(payload.p75)})`} stroke="none" />;

export function InpChart({ series }) {
  const points = series.filter((p) => p.p75 != null);
  if (points.length < 2) return <p className="text-sm text-muted-foreground">pas d’historique</p>;

  // Echelle sur les donnees seules + 12 % de marge : cadrer sur 0 ou sur le seuil
  // ecraserait une courbe qui varie de 150 a 190 ms.
  const values = points.map((p) => p.p75);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = (max - min || max || 1) * 0.12;
  const domain = [Math.floor((min - pad) / 10) * 10, Math.ceil((max + pad) / 10) * 10];
  const showThreshold = INP.good >= domain[0] && INP.good <= domain[1];

  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <AreaChart data={points} margin={{ left: 4, right: 12, top: 12, bottom: 0 }}>
        <defs>
          <linearGradient id="inp-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-p75)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-p75)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24}
          tickFormatter={(v) => v.slice(5).split('-').reverse().join('/')}
        />
        <YAxis
          domain={domain} tickCount={6} allowDecimals={false}
          tickLine={false} axisLine={false} tickMargin={6} width={44}
          tickFormatter={(v) => `${Math.round(v)}`}
        />
        {showThreshold && (
          <ReferenceLine
            y={INP.good} stroke="var(--good)" strokeDasharray="4 3"
            label={{ value: 'seuil bon 200 ms', position: 'insideTopRight', fill: 'var(--good)', fontSize: 10 }}
          />
        )}
        <ChartTooltip
          cursor={{ stroke: 'var(--color-p75)', strokeDasharray: '3 2' }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => dayFR(payload?.[0]?.payload.date)}
              formatter={(value) => (
                <span className="flex w-full items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">INP p75</span>
                  <span className="font-mono font-medium tabular-nums">{ms(value)} ms</span>
                </span>
              )}
            />
          }
        />
        <Area
          dataKey="p75" type="monotone" stroke="var(--color-p75)" strokeWidth={2}
          fill="url(#inp-fill)" dot={<RatedDot />} activeDot={{ r: 5 }}
        />
      </AreaChart>
    </ChartContainer>
  );
}
