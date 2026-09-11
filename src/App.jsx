import { useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { CardGrid, DistributionBar, RatingLegend, Section, StatCard } from '@/components/metrics';
import { ArticlesTable, TopElementsTable } from '@/components/articles-table';
import { InpChart } from '@/components/inp-chart';
import { INP, num, rumDayFR } from '@/lib/inp';

// Sous ce seuil un p75 n'est pas stable : on montre la valeur en note plutot qu'en carte
// coloree, sinon 99 ms sur 6 pages vues se lit comme un bon score.
const RUM_MIN_VIEWS = 50;

// Le groupe agrege porte le label "Tous articles" : "Articles Tous articles" se lit mal.
const groupLabel = (g) => (g.id === 'all' ? 'Tous les articles' : `Articles ${g.label}`);

const rumCard = (label, rum) => {
  const solid = rum?.inpP75 != null && rum.n >= RUM_MIN_VIEWS;
  return (
    <StatCard
      key={label}
      label={label}
      sample={num(rum?.n ?? 0)}
      value={solid ? rum.inpP75 : null}
      note={rum?.inpP75 == null ? 'pas de données terrain' : `${rum.inpP75} ms · échantillon trop faible`}
    />
  );
};
const rumDist = (label, rum) =>
  rum?.inpP75 != null && rum.n >= RUM_MIN_VIEWS ? <DistributionBar key={label} label={label} dist={rum} /> : null;

// Ajoute le p75 courant en dernier point : l'historique CrUX prend ~7 j de retard.
const withToday = (history, current, today) => {
  const series = [...(history ?? [])];
  if (current?.p75 != null && series.at(-1)?.date !== today) series.push({ date: today, ...current });
  return series;
};

const CRUX_HINT = 'Relevés hebdomadaires CrUX, fenêtre glissante de 28 jours.';
const GROUP_HINT = 'Un relevé par collecte : p75 des articles J-2 du jour. Les jours antérieurs sont reconstruits depuis l’API CrUX : p75 actuel des articles publiés ce jour-là (fenêtre 28 j, pas seulement leurs 2 premiers jours).';

export default function App({ data: d }) {
  const key = INP.key;
  const origin = d.origins.PHONE?.[key];
  const rumWindow = d.rumDates?.length ? d.rumDates.map(rumDayFR).join(' + ') : '';
  const today = d.collectedAt.slice(0, 10);
  const series = withToday(d.history.PHONE?.[key], origin, today);

  // Historique ouvert au clic sur une carte CrUX : { title, hint, series } ou null.
  const [selected, setSelected] = useState(null);
  // Sans DialogTrigger, Radix ne sait pas ou rendre le focus a la fermeture : on garde la carte cliquee.
  const triggerRef = useRef(null);
  const open = (e, sel) => {
    triggerRef.current = e.currentTarget;
    setSelected(sel);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-8 px-4 py-6 sm:px-6 sm:py-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">INP mobile — www.leparisien.fr</h1>
        <p className="text-xs text-muted-foreground">
          Collecte {new Date(d.collectedAt).toLocaleString('fr-FR')} · articles J-2 du {d.articlesDate} ·
          CrUX API (p75 sur 28 jours){d.rumDates?.length > 0 && ` + SpeedCurve RUM (${rumWindow})`}
        </p>
        <p className="pt-1 text-xs text-muted-foreground">
          Interaction to Next Paint — réactivité perçue. ≤ 200 ms bon · ≤ 500 ms à améliorer · &gt; 500 ms mauvais.
        </p>
      </header>

      <Section title="Vue globale — mesure CrUX directe par page">
        <CardGrid>
          <StatCard
            label="INP global mobile (origine)" value={origin?.p75} note="pas de données CrUX"
            onSelect={(e) => open(e, { title: 'Origine mobile', hint: CRUX_HINT, series })}
          />
          {d.pages.map((p) => (
            <StatCard
              key={p.id} label={`${p.label} — global mobile`} value={p.metrics?.[key]?.p75} note="pas de données CrUX"
              onSelect={(e) => open(e, {
                title: p.label, hint: CRUX_HINT, series: withToday(p.history, p.metrics?.[key], today),
              })}
            />
          ))}
        </CardGrid>
      </Section>

      <Section title="Vue p75 — agrégat des articles par rubrique">
        <CardGrid>
          {d.articleGroups.map((g) => (
            <StatCard
              key={g.id}
              label={g.id === 'all' ? 'INP p75 articles J-2' : `Articles ${g.label} — p75`}
              sample={num(g.metrics[key]?.samples ?? 0)}
              value={g.metrics[key]?.p75}
              note="pas de données CrUX"
              onSelect={(e) => open(e, { title: `${groupLabel(g)} — p75`, hint: GROUP_HINT, series: g.history ?? [] })}
            />
          ))}
        </CardGrid>
      </Section>

      {d.rumDates?.length > 0 && (
        <Section
          title={`Vue terrain SpeedCurve — INP p75 des pages vues réelles (${rumWindow})`}
          hint={`n = pages vues avec un INP. En dessous de ${RUM_MIN_VIEWS} vues, la valeur reste indicative.`}
        >
          <p className="text-xs font-medium text-muted-foreground">Pages rubrique</p>
          <CardGrid>{d.pages.map((p) => rumCard(p.label, p.rum))}</CardGrid>
          <p className="pt-2 text-xs font-medium text-muted-foreground">Pages article, agrégées par rubrique</p>
          <CardGrid>{d.articleGroups.map((g) => rumCard(groupLabel(g), g.rum))}</CardGrid>
        </Section>
      )}

      <Section title="Distribution Bon / À améliorer / Mauvais — CrUX">
        <Card>
          <CardContent className="space-y-1.5">
            <DistributionBar label="Origine mobile" dist={origin} />
            {d.pages.map((p) => (
              <DistributionBar key={p.id} label={`${p.label} (global)`} dist={p.metrics?.[key]} />
            ))}
            {d.articleGroups.map((g) => (
              <DistributionBar key={g.id} label={`${groupLabel(g)} (p75)`} dist={g.metrics[key]} />
            ))}
            <Separator className="my-3" />
            <RatingLegend />
          </CardContent>
        </Card>
      </Section>

      {d.rumDates?.length > 0 && (
        <Section title={`Distribution Bon / À améliorer / Mauvais — terrain SpeedCurve (${rumWindow})`}>
          <Card>
            <CardContent className="space-y-1.5">
              {d.pages.map((p) => rumDist(p.label, p.rum))}
              {d.articleGroups.map((g) => rumDist(groupLabel(g), g.rum))}
              <Separator className="my-3" />
              <RatingLegend />
            </CardContent>
          </Card>
        </Section>
      )}

      {d.rumElements?.length > 0 && (
        <Section
          title={`Éléments les plus attribués à l’INP — terrain SpeedCurve (${rumWindow})`}
          hint="Sélecteur de l’élément interagi, toutes pages confondues. Trié par nombre d’interactions au-dessus du seuil « bon » (200 ms)."
        >
          <TopElementsTable elements={d.rumElements} />
        </Section>
      )}

      <Section title="Historique p75 — origine mobile" hint="Relevés hebdomadaires, fenêtre glissante de 28 jours.">
        <Card>
          <CardContent>
            <InpChart series={series} />
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Articles — INP p75 par article"
        hint={`${d.articles?.length ?? 0} articles avec données CrUX, les pires en tête.`}
      >
        <ArticlesTable articles={d.articles} />
      </Section>

      <Dialog open={selected != null} onOpenChange={(isOpen) => !isOpen && setSelected(null)}>
        {/* Sans ca Radix focalise le SVG Recharts, qui affiche alors le tooltip du premier point. */}
        <DialogContent
          className="sm:max-w-2xl"
          onOpenAutoFocus={(e) => { e.preventDefault(); e.currentTarget.focus(); }}
          onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}
        >
          <DialogHeader>
            <DialogTitle>Historique INP p75 — {selected?.title}</DialogTitle>
            <DialogDescription>{selected?.hint}</DialogDescription>
          </DialogHeader>
          {selected && <InpChart series={selected.series} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
