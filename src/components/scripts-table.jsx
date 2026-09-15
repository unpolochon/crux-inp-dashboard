import { ChartLine } from 'lucide-react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayFR, num } from '@/lib/inp';

export const kb = (bytes) => (bytes == null ? '-' : Math.round(bytes / 1024).toLocaleString('fr-FR'));

/** Variation relative entre le dernier relevé et le plus récent d'il y a 7 jours ou plus. */
export function weekDelta(series, key) {
  const last = series.at(-1);
  const weekAgo = new Date(new Date(last.date).getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const ref = series.filter((p) => p.date <= weekAgo).at(-1);
  return ref?.[key] ? (last[key] - ref[key]) / ref[key] : null;
}

// Au-dela de +-20 % la variation est coloree : en dessous c'est le bruit normal d'un test synthetique.
const DeltaCell = ({ value }) => (
  <TableCell
    className={`hidden text-right tabular-nums sm:table-cell ${
      value == null ? 'text-muted-foreground' : value > 0.2 ? 'text-poor' : value < -0.2 ? 'text-good' : 'text-muted-foreground'
    }`}
  >
    {value == null ? '-' : `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)} %`}
  </TableCell>
);

const Cells = ({ point }) => (
  <>
    <TableCell className="hidden text-right tabular-nums sm:table-cell">{num(point.requests)}</TableCell>
    <TableCell className="text-right tabular-nums">{kb(point.bytes)}</TableCell>
    <TableCell className="text-right font-medium tabular-nums">{num(point.cpu)}</TableCell>
  </>
);

/** Domaines tiers du dernier test, tries par CPU ; total tiers et premiere partie en pied. Sur mobile, seuls poids et CPU restent. */
export function ScriptsTable({ page, onSelect }) {
  const latest = (h) => h.series.at(-1);
  const third = page.hosts.filter((h) => !h.firstParty);
  const first = page.hosts.filter((h) => h.firstParty);
  const total = (hosts) => ({
    requests: hosts.reduce((s, h) => s + latest(h).requests, 0),
    bytes: hosts.reduce((s, h) => s + latest(h).bytes, 0),
    cpu: hosts.reduce((s, h) => s + latest(h).cpu, 0),
  });
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[10rem]">Domaine</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Requêtes</TableHead>
            <TableHead className="text-right">Poids (Ko)</TableHead>
            <TableHead className="text-right">CPU (ms)</TableHead>
            <TableHead className="hidden text-right sm:table-cell">CPU vs J-7</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {third.map((h) => (
            <TableRow key={h.host}>
              {/* TableCell est nowrap par defaut : les hotes longs doivent pouvoir se couper sur mobile. */}
              <TableCell className="p-0 whitespace-normal">
                <button
                  type="button"
                  onClick={(e) => onSelect(e, h)}
                  title="Voir l’historique"
                  className="group flex w-full cursor-pointer items-center gap-1.5 px-2 py-2 text-left font-mono text-xs outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                >
                  <span className="break-all">{h.host}</span>
                  <ChartLine className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                </button>
              </TableCell>
              <Cells point={latest(h)} />
              <DeltaCell value={weekDelta(h.series, 'cpu')} />
            </TableRow>
          ))}
          <TableRow className="bg-muted/40 font-medium hover:bg-muted/40">
            <TableCell className="whitespace-normal">Total tiers · {third.length} domaines</TableCell>
            <Cells point={total(third)} />
            <TableCell className="hidden sm:table-cell" />
          </TableRow>
          <TableRow className="text-muted-foreground hover:bg-transparent">
            <TableCell className="whitespace-normal">Première partie · {first.map((h) => h.host).join(', ') || '-'}</TableCell>
            <Cells point={total(first)} />
            <TableCell className="hidden sm:table-cell" />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

const config = { cpu: { label: 'CPU (ms)', color: 'var(--chart-1)' }, kb: { label: 'Poids (Ko)', color: 'var(--chart-2)' } };
const dayTick = (v) => v.slice(5).split('-').reverse().join('/');

/** CPU (axe gauche) et poids (axe droit) d'un domaine, un point par jour de test. */
export function ScriptChart({ series }) {
  const points = series.map((p) => ({ ...p, kb: Math.round(p.bytes / 1024) }));
  if (points.length < 2) return <p className="text-sm text-muted-foreground">pas d’historique</p>;
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <LineChart data={points} margin={{ left: 4, right: 4, top: 12, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayTick} />
        <YAxis yAxisId="cpu" tickLine={false} axisLine={false} tickMargin={6} width={44} allowDecimals={false} />
        <YAxis yAxisId="kb" orientation="right" tickLine={false} axisLine={false} tickMargin={6} width={44} allowDecimals={false} />
        <ChartTooltip
          cursor={{ stroke: 'var(--border)', strokeDasharray: '3 2' }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => dayFR(payload?.[0]?.payload.date)}
              formatter={(value, name) => (
                <span className="flex w-full items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">{config[name].label}</span>
                  <span className="font-mono font-medium tabular-nums">{num(value)}</span>
                </span>
              )}
            />
          }
        />
        <Line yAxisId="cpu" dataKey="cpu" type="monotone" stroke="var(--color-cpu)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
        <Line yAxisId="kb" dataKey="kb" type="monotone" stroke="var(--color-kb)" strokeWidth={2} strokeDasharray="4 3" dot={false} activeDot={{ r: 5 }} />
        <ChartLegend content={<ChartLegendContent />} />
      </LineChart>
    </ChartContainer>
  );
}
