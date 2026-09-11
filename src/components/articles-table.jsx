import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RumAttribution } from '@/components/rum-attribution';
import { RATING_TEXT, dayFR, ms, pct, rate } from '@/lib/inp';

export function ArticlesTable({ articles }) {
  if (!articles?.length) {
    return <p className="text-sm text-muted-foreground">pas d’articles avec données CrUX</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[16rem]">Article</TableHead>
            <TableHead className="text-right">INP p75</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Bon</TableHead>
            <TableHead className="hidden text-right sm:table-cell">À améliorer</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Mauvais</TableHead>
            <TableHead className="hidden text-right md:table-cell">Publié le</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {articles.map((a) => (
            <TableRow key={a.url} className="[&>td]:align-top">
              <TableCell className="whitespace-normal">
                <a
                  href={a.url} target="_blank" rel="noopener"
                  className="group inline-flex items-baseline gap-1 hover:underline"
                >
                  {a.title ?? a.url}
                  <ExternalLink className="size-3 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
                {a.rum && <Badge variant="outline" className="ml-2 font-mono text-[9px] tracking-wider uppercase">rum</Badge>}
                {a.rum && <RumAttribution rum={a.rum} />}
              </TableCell>
              <TableCell className={`text-right text-base font-semibold tabular-nums ${RATING_TEXT[rate(a.p75)]}`}>
                {ms(a.p75)}
              </TableCell>
              <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">{pct(a.good)}</TableCell>
              <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">{pct(a.ni)}</TableCell>
              <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">{pct(a.poor)}</TableCell>
              <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums md:table-cell">
                {dayFR(a.published)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Top des selecteurs, tries par nombre d'interactions au-dessus du seuil "bon". */
export function TopElementsTable({ elements }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Sélecteur</TableHead>
            <TableHead className="text-right">Vues</TableHead>
            <TableHead className="text-right">&gt; 200 ms</TableHead>
            <TableHead className="text-right">INP p75</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {elements.map((el) => (
            <TableRow key={el.selector}>
              <TableCell className="max-w-[28rem] font-mono text-xs break-all whitespace-normal text-muted-foreground">
                {el.selector}
              </TableCell>
              <TableCell className="text-right tabular-nums">{el.n.toLocaleString('fr-FR')}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{el.slow.toLocaleString('fr-FR')}</TableCell>
              <TableCell className={`text-right font-medium tabular-nums ${RATING_TEXT[rate(el.inpP75)]}`}>
                {ms(el.inpP75)} ms
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
