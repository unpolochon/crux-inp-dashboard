import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { CardGrid, DistributionBar, RatingLegend, Section, SourceLine, StatCard } from '@/components/metrics';
import { ArticlesTable, TopElementsTable } from '@/components/articles-table';
import { InpChart } from '@/components/inp-chart';
import { ScriptChart, ScriptsTable } from '@/components/scripts-table';
import { INP, RATING_TEXT, dayFR, ms, num, rate, rumDayFR } from '@/lib/inp';

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
const COVERAGE_HINT = 'n = articles avec un INP CrUX / articles trouvés dans les flux (J-2, ou ~3 semaines pour les rubriques peu actives). CrUX ne publie que les URL assez visitées.';
const GROUP_HINT = 'Un relevé par collecte : p75 des articles J-2 du jour. Les jours antérieurs sont reconstruits depuis l’API CrUX : p75 actuel des articles publiés ce jour-là (fenêtre 28 j, pas seulement leurs 2 premiers jours).';
const SCRIPT_HINT = 'Un point par jour de test synthétique (run médian). CPU main thread en ms à gauche, poids transféré en Ko à droite.';

// INP p75 de la page suivie, colore par sa note, pour lire le CPU tiers en regard de la reactivite.
const inpNote = (label, value) =>
  value != null && (
    <span>
      {' · '}{label} <strong className={`font-semibold ${RATING_TEXT[rate(value)]}`}>{ms(value)} ms</strong>
    </span>
  );

// ponytail: navigation par hash (#/articles), trois pages statiques : pas de routeur.
const ROUTES = [['', 'Tableau de bord'], ['articles', 'Articles'], ['scripts', 'Scripts tiers']];
const useRoute = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  const route = hash.replace(/^#\/?/, '');
  return ROUTES.some(([path]) => path === route) ? route : '';
};

function Nav({ route }) {
  return (
    <nav aria-label="Pages" className="-mx-2 flex flex-wrap gap-1">
      {ROUTES.map(([path, label]) => (
        <a
          key={path}
          href={`#/${path}`}
          aria-current={route === path ? 'page' : undefined}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

/** Barres CrUX puis, si disponible, terrain, pour des lignes { key, label, crux, rum }. */
function Distribution({ rows, RUM, rumWindow }) {
  return (
    <Card>
      <CardContent className="space-y-1.5">
        <SourceLine source="CrUX" className="pb-1.5" />
        {rows.map((r) => <DistributionBar key={r.key} label={r.label} dist={r.crux} />)}
        {rumWindow && rows.some((r) => rumDist(r.label, r.rum)) && (
          <>
            <SourceLine source={RUM} className="pt-4 pb-1.5">Terrain ({rumWindow})</SourceLine>
            {rows.map((r) => rumDist(r.label, r.rum))}
          </>
        )}
        <Separator className="my-3" />
        <RatingLegend />
      </CardContent>
    </Card>
  );
}

function Dashboard({ d, open, RUM, rumWindow, today }) {
  const key = INP.key;
  const origin = d.origins.PHONE?.[key];
  const series = withToday(d.history.PHONE?.[key], origin, today);
  // Cartes terrain sous les cartes CrUX de la meme famille.
  const terrain = (cards) =>
    rumWindow && (
      <>
        <SourceLine source={RUM} className="pt-2">
          Terrain — INP p75 des pages vues réelles ({rumWindow}). n = pages vues avec un INP, indicatif sous {RUM_MIN_VIEWS} vues.
        </SourceLine>
        <CardGrid>{cards}</CardGrid>
      </>
    );

  const articleRows = d.articleGroups.map((g) => ({ key: g.id, label: groupLabel(g), crux: g.metrics[key], rum: g.rum }));
  const pageRows = [
    { key: 'origin', label: 'Origine mobile', crux: origin },
    ...d.pages.map((p) => ({ key: p.id, label: p.label, crux: p.metrics?.[key], rum: p.rum })),
  ];

  return (
    <>
      <Section title="Articles — INP p75 par rubrique">
        <SourceLine source="CrUX">{COVERAGE_HINT}</SourceLine>
        <CardGrid>
          {d.articleGroups.map((g) => (
            <StatCard
              key={g.id}
              label={g.id === 'all' ? 'INP p75 articles J-2' : `Articles ${g.label} — p75`}
              sample={`${num(g.metrics[key]?.samples)}/${num(g.queried)}`}
              value={g.metrics[key]?.p75}
              note="pas de données CrUX"
              onSelect={(e) => open(e, { title: `INP p75 — ${groupLabel(g)}`, hint: GROUP_HINT, chart: <InpChart series={g.history ?? []} /> })}
            />
          ))}
        </CardGrid>
        {terrain(d.articleGroups.map((g) => rumCard(groupLabel(g), g.rum)))}
      </Section>

      <Section title="Articles — distribution Bon / À améliorer / Mauvais">
        <Distribution rows={articleRows} RUM={RUM} rumWindow={rumWindow} />
      </Section>

      <Section title="Rubriques — INP p75 par page">
        <SourceLine source="CrUX">Mesure directe de chaque page rubrique et de l’origine.</SourceLine>
        <CardGrid>
          <StatCard
            label="INP global mobile (origine)" value={origin?.p75} note="pas de données CrUX"
            onSelect={(e) => open(e, { title: 'INP p75 — Origine mobile', hint: CRUX_HINT, chart: <InpChart series={series} /> })}
          />
          {d.pages.map((p) => (
            <StatCard
              key={p.id} label={`${p.label} — global mobile`} value={p.metrics?.[key]?.p75} note="pas de données CrUX"
              onSelect={(e) => open(e, {
                title: `INP p75 — ${p.label}`, hint: CRUX_HINT,
                chart: <InpChart series={withToday(p.history, p.metrics?.[key], today)} />,
              })}
            />
          ))}
        </CardGrid>
        {terrain(d.pages.map((p) => rumCard(p.label, p.rum)))}
      </Section>

      <Section title="Rubriques — distribution Bon / À améliorer / Mauvais">
        <Distribution rows={pageRows} RUM={RUM} rumWindow={rumWindow} />
      </Section>

      <Section title="Historique p75 — origine mobile">
        <SourceLine source="CrUX">{CRUX_HINT}</SourceLine>
        <Card>
          <CardContent>
            <InpChart series={series} />
          </CardContent>
        </Card>
      </Section>
    </>
  );
}

function ArticlesPage({ d, RUM, rumWindow }) {
  return (
    <>
      <Section title="Articles — INP p75 par article">
        <SourceLine source={rumWindow ? ['CrUX', ...RUM] : 'CrUX'}>
          {num(d.articles?.length)} articles avec un INP CrUX{d.articlesQueried ? ` sur ${num(d.articlesQueried)} interrogés` : ''}, les pires en tête.
        </SourceLine>
        <ArticlesTable articles={d.articles} />
      </Section>

      {d.rumElements?.length > 0 && (
        <Section title={`Éléments les plus attribués à l’INP (${rumWindow})`}>
          <SourceLine source={RUM}>
            Sélecteur de l’élément interagi, toutes pages confondues. Trié par nombre d’interactions au-dessus du seuil « bon » (200 ms).
          </SourceLine>
          <TopElementsTable elements={d.rumElements} />
        </Section>
      )}
    </>
  );
}

function ScriptsPage({ d, open }) {
  return (
    <Section title="Scripts tiers — poids et CPU par domaine (mobile)">
      <SourceLine source="SpeedCurve synthétique">
        Un test synthétique par jour (Mobile Medium), run médian. CPU = temps main thread des requêtes du domaine (évaluation, compilation, exécution JS) : il bloque les interactions et pèse sur l’INP, sans qu’une attribution INP par script soit possible. Cliquer un domaine pour son historique.
      </SourceLine>
      {d.scripts?.length > 0 ? (
        d.scripts.map((page) => (
          <div key={page.id} className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {page.label} · test du {dayFR(page.dates.at(-1))} · {page.dates.length} jours d’historique
              {inpNote('INP p75 CrUX', page.inp.crux)}
              {inpNote('terrain', page.inp.rum)}
            </p>
            <ScriptsTable
              page={page}
              onSelect={(e, h) => open(e, { title: `${h.host} — ${page.label}`, hint: SCRIPT_HINT, chart: <ScriptChart series={h.series} /> })}
            />
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">Pas de données SpeedCurve synthétique.</p>
      )}
    </Section>
  );
}

export default function App({ data: d }) {
  const route = useRoute();
  // Bloc obligatoire : dans certains Chrome scrollTo renvoie une promesse, que React prendrait pour un nettoyage.
  useEffect(() => { scrollTo(0, 0); }, [route]);

  const rumWindow = d.rumDates?.length ? d.rumDates.map(rumDayFR).join(' + ') : '';
  // Badges de source : le profil d'appareil RUM (cfg.rum.device) est un badge a part, pour passer a la ligne sur mobile.
  const RUM = d.rumDevice ? ['SpeedCurve RUM', d.rumDevice] : ['SpeedCurve RUM'];
  const today = d.collectedAt.slice(0, 10);

  // Historique ouvert au clic sur une carte ou une ligne : { title, hint, chart } ou null.
  const [selected, setSelected] = useState(null);
  // Sans DialogTrigger, Radix ne sait pas ou rendre le focus a la fermeture : on garde la carte cliquee.
  const triggerRef = useRef(null);
  const open = (e, sel) => {
    triggerRef.current = e.currentTarget;
    setSelected(sel);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-8 px-4 py-6 sm:px-6 sm:py-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">INP mobile — www.leparisien.fr</h1>
            <p className="text-xs text-muted-foreground">
              Collecte {new Date(d.collectedAt).toLocaleString('fr-FR')} · articles J-2 du {d.articlesDate} ·
              CrUX API (p75 sur 28 jours){rumWindow && ` + ${RUM.join(' · ')} (${rumWindow})`}
            </p>
            <p className="pt-1 text-xs text-muted-foreground">
              Interaction to Next Paint — réactivité perçue. ≤ 200 ms bon · ≤ 500 ms à améliorer · &gt; 500 ms mauvais.
            </p>
          </div>
          <Nav route={route} />
        </div>
        <Separator />
      </header>

      {route === 'articles' && <ArticlesPage d={d} RUM={RUM} rumWindow={rumWindow} />}
      {route === 'scripts' && <ScriptsPage d={d} open={open} />}
      {route === '' && <Dashboard d={d} open={open} RUM={RUM} rumWindow={rumWindow} today={today} />}

      <Dialog open={selected != null} onOpenChange={(isOpen) => !isOpen && setSelected(null)}>
        {/* Sans ca Radix focalise le SVG Recharts, qui affiche alors le tooltip du premier point. */}
        <DialogContent
          className="sm:max-w-2xl"
          onOpenAutoFocus={(e) => { e.preventDefault(); e.currentTarget.focus(); }}
          onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}
        >
          <DialogHeader>
            <DialogTitle>Historique — {selected?.title}</DialogTitle>
            <DialogDescription>{selected?.hint}</DialogDescription>
          </DialogHeader>
          {selected?.chart}
        </DialogContent>
      </Dialog>
    </div>
  );
}
