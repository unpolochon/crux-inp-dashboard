import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ms, num } from '@/lib/inp';

const PHASES = [
  ['Délai d’entrée', 'input', 'bg-phase-input'],
  ['Traitement', 'processing', 'bg-phase-processing'],
  ['Présentation', 'presentation', 'bg-phase-presentation'],
];

/** Decomposition input / processing / presentation de l'INP median. */
function PhaseBar({ phases = {} }) {
  const total = PHASES.reduce((sum, [, k]) => sum + (phases[k] ?? 0), 0);
  if (!total) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-6 overflow-hidden rounded-md border">
        {PHASES.map(([label, k, bg]) => (
          <div
            key={k}
            className={`flex items-center justify-center overflow-hidden whitespace-nowrap text-[10px] text-background ${bg}`}
            style={{ width: `${((phases[k] ?? 0) / total) * 100}%` }}
            title={`${label} : ${phases[k] ?? 0} ms`}
          >
            {(phases[k] ?? 0) / total >= 0.08 && `${phases[k]} ms`}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        {PHASES.map(([label, k, bg]) => (
          <span key={k} className="flex items-center gap-1.5">
            <i className={`size-2 rounded-sm ${bg}`} />
            {label} {phases[k] ?? '-'} ms
          </span>
        ))}
      </div>
    </div>
  );
}

export function RumAttribution({ rum }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        Voir l’attribution terrain
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="my-2 space-y-3 rounded-md border-l-2 border-l-chart-1 bg-muted/40 p-3">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span><strong className="font-semibold text-foreground">{num(rum.n)}</strong> pages vues avec INP</span>
            <span>INP terrain p75 <strong className="font-semibold text-foreground">{ms(rum.inpP75)} ms</strong></span>
            <span>Phases <strong className="font-semibold text-foreground">médianes</strong></span>
          </div>
          <PhaseBar phases={rum.phases} />
          {rum.elements?.length ? (
            <div className="space-y-1">
              <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Éléments des interactions mesurées
              </p>
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Sélecteur</TableHead>
                    <TableHead className="w-16 text-right">Vues</TableHead>
                    <TableHead className="w-24 text-right">INP médian</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rum.elements.map((el) => (
                    <TableRow key={el.selector}>
                      <TableCell className="font-mono break-all whitespace-normal text-muted-foreground">
                        {el.selector}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(el.n)}</TableCell>
                      <TableCell className="text-right tabular-nums">{el.inpMedian} ms</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">aucun sélecteur d’interaction disponible</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
