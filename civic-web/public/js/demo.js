// Sample run. Emits the same events the server streams, on timers, with placeholder entries so the
// whole flow can be seen without a key (and so the page can be previewed as a static artifact).
// Everything here is clearly labelled sample data in the UI.

export const SAMPLE_TEXT = `Things everyone knows

Most of what we repeat, we have never checked. Ask anyone: the Great Wall of China is visible to the naked eye from the Moon, and humans use only 10 percent of their brains. Some of the things we repeat happen to be right. Water boils at 100 degrees Celsius at sea level. The Eiffel Tower stands about 330 metres tall. Mount Everest is the tallest mountain above sea level, at 8,849 metres. Other favourites do not survive contact with a thermometer or a ruler. Lightning never strikes the same place twice, we say, and Napoleon Bonaparte was unusually short for a Frenchman of his time. The Amazon is the longest river in the world, or so the schoolbooks said.

Trust itself has a record. In 1976, Gallup found that 72 percent of Americans trusted the mass media. In September 2025, Gallup found that 28 percent did, a record low. Business lore is no cleaner. Salesforce was founded in 1999. Larry Ellison invested $2 million in Salesforce at its founding. And the folk science keeps coming: vaccines cause autism; the adult human body has 206 bones; sugar makes children hyperactive. The speed of light in a vacuum is 299,792,458 metres per second. Goldfish have a three-second memory. Antarctica is the driest continent on Earth. There are more than 8 million species on Earth. Shakespeare wrote 37 plays.

There is more where that came from. Bananas are botanically berries. The Sahara is the largest desert in the world. Bulls are enraged by the colour red. Cracking your knuckles causes arthritis. Einstein failed mathematics at school. A day on Venus is longer than a year on Venus.`;

const CLAIMS = [
  'The Great Wall of China is visible to the naked eye from the Moon.',
  'Humans use only 10 percent of their brains.',
  'Water boils at 100 degrees Celsius at sea level.',
  'The Eiffel Tower stands about 330 metres tall.',
  'Mount Everest is the tallest mountain above sea level, at 8,849 metres.',
  'Lightning never strikes the same place twice.',
  'Napoleon Bonaparte was unusually short for a Frenchman of his time.',
  'The Amazon is the longest river in the world.',
  'In 1976, Gallup found that 72 percent of Americans trusted the mass media.',
  'In September 2025, Gallup found that 28 percent of Americans trusted the mass media, a record low.',
  'Salesforce was founded in 1999.',
  'Larry Ellison invested $2 million in Salesforce at its founding.',
  'Vaccines cause autism.',
  'The adult human body has 206 bones.',
  'Sugar makes children hyperactive.',
  'The speed of light in a vacuum is 299,792,458 metres per second.',
  'Goldfish have a three-second memory.',
  'Antarctica is the driest continent on Earth.',
  'There are more than 8 million species on Earth.',
  'Shakespeare wrote 37 plays.',
  'Bananas are botanically berries.',
  'The Sahara is the largest desert in the world.',
  'Bulls are enraged by the colour red.',
  'Cracking your knuckles causes arthritis.',
  'Einstein failed mathematics at school.',
  'A day on Venus is longer than a year on Venus.',
];

// verdict, inspector, confidence, definitions, evidence, analysis, conclusion
const ENTRIES = [
  ['False', 'Galileo Galilei', 97,
    '"Visible to the naked eye" means resolvable without optical aid. The Moon orbits at a mean distance of about 384,000 km. The Great Wall is typically 5 to 9 metres wide.',
    'The unaided human eye resolves roughly one arcminute, about 3 × 10⁻⁴ radians. A 9-metre-wide object at 384,000 km subtends about 2 × 10⁻⁸ radians, ten thousand times below that threshold. Apollo crew members reported no such sighting; NASA states the wall is not visible from the Moon and is hard to see even from low Earth orbit.',
    'The proposition fails on geometry alone. No witness testimony could overturn an angular-resolution limit, and none exists.',
    'The wall cannot be resolved from lunar distance by any human eye.'],
  ['False', 'Wilder Penfield', 96,
    '"Use" means measurable neural activity or functional contribution. "10 percent" is a proportion of the whole brain.',
    'Functional imaging shows activity distributed across virtually every region over the course of a day. Lesion studies find that damage to almost any area produces a deficit. The brain consumes about 20 percent of the body\'s energy at rest, a cost no organism would pay for tissue nine-tenths idle.',
    'Three independent lines of evidence, imaging, lesion and metabolic, converge. The figure has no traceable empirical origin.',
    'Every region of the brain has a demonstrated function; the 10 percent figure is an invention.'],
  ['True', 'Anders Celsius', 98,
    '"Sea level" is taken as standard atmospheric pressure, 101.325 kPa. "Boils" means the temperature at which vapour pressure equals ambient pressure.',
    'Under the current temperature scale (ITS-90) pure water boils at 99.97 °C at 101.325 kPa. The 100 °C figure was the defining point of the original scale and holds to within a few hundredths of a degree.',
    'The claim is true to the precision at which it is made. Dissolved solids and pressure changes shift the value, but the proposition specifies sea level.',
    'At standard sea-level pressure, water boils at 100 °C to ordinary precision.'],
  ['True', 'Carl Friedrich Gauss', 95,
    '"About 330 metres" is the height to the tip of the antenna, within ordinary rounding.',
    'The tower\'s operator records a height of 330 m since a new broadcast antenna was fitted in March 2022. Before that the figure was 324 m. Both are direct structural measurements, not estimates.',
    'The primary source is the operator\'s own survey. The word "about" absorbs the sub-metre variation from thermal expansion.',
    'The Eiffel Tower is 330 m tall to the tip of its antenna.'],
  ['True', 'Radhanath Sikdar', 97,
    '"Tallest above sea level" is height of the summit above the geoid, distinct from base-to-peak height or distance from Earth\'s centre.',
    'The joint China–Nepal survey announced in December 2020 gives 8,848.86 m, which rounds to 8,849 m. No other summit exceeds 8,700 m above sea level.',
    'The measurement is recent, jointly conducted, and published with its method. Rounding to the metre is faithful.',
    'Everest is the highest summit above sea level, at 8,849 m.'],
  ['False', 'Benjamin Franklin', 99,
    '"Never" is universal; a single counter-instance refutes it. "The same place" is a fixed point on the ground or a structure.',
    'The Empire State Building is struck roughly 20 to 25 times a year, a count kept since instrumented observation began. Lightning rods exist precisely because tall conductive objects are struck repeatedly.',
    'A universal negative is refuted by one documented repeat strike; thousands are on record.',
    'Lightning strikes the same place repeatedly, and preferentially.'],
  ['False', 'Adolphe Quetelet', 90,
    '"Unusually short" means below the typical stature of adult French men of the period, roughly 1.64 to 1.66 m.',
    'The post-mortem record gives 5 pieds 2 pouces in French units, about 1.68 to 1.69 m. In English units the same figure reads as 5 ft 2 in, the likely root of the myth, reinforced by British caricature.',
    'Once the unit conversion is made, Napoleon was of average or slightly above-average height.',
    'Napoleon\'s recorded height was about 1.69 m, not unusually short for his time.'],
  ['Uncertain', 'Alexander von Humboldt', 45,
    '"Longest" depends on where a river is taken to begin and end, and which channel is followed through a delta or estuary.',
    'Standard references give the Nile about 6,650 km and the Amazon about 6,400 km. A 2007 Brazilian expedition traced the Amazon to a more distant source and reported roughly 6,992 km. No international body has fixed a single measurement convention.',
    'The disagreement is definitional, not observational. Both rivers can be made "longest" by a defensible choice of source.',
    'The ordering cannot be settled without a shared measurement standard.'],
  ['True', 'George Gallup', 94,
    '"Trusted the mass media" is Gallup\'s wording for a great deal or a fair amount of trust in newspapers, television and radio.',
    'Gallup\'s published trend shows 72 percent in 1976, the highest reading in the series, after 68 percent in 1972.',
    'The figure comes from the primary source itself and matches the published trend table.',
    'Gallup measured 72 percent trust in 1976.'],
  ['True', 'Leslie Kish', 92,
    '"Record low" means the lowest reading in the same trend, measured with the same question.',
    'Gallup\'s September 2025 survey, published in October 2025, reported 28 percent with a great deal or fair amount of trust, below the previous low of 31 percent.',
    'Same question, same organisation, same trend. The comparison is like for like.',
    'The 28 percent reading is Gallup\'s lowest on record.'],
  ['True', 'Leopold von Ranke', 97,
    '"Founded" means the date of incorporation or documented start of the company.',
    'Salesforce\'s own filings and corporate history state the company was founded in March 1999 in San Francisco.',
    'Primary corporate documents settle the year; no source disputes it.',
    'Salesforce was founded in 1999.'],
  ['True', 'Marc Bloch', 82,
    '"At its founding" means at or near the company\'s start. "Invested $2 million" means a capital contribution of that size.',
    'Benioff\'s own account, and contemporaneous reporting, record a $2 million investment by Ellison and a board seat at the company\'s start. The underlying financing document is not public.',
    'The evidence is documentary and consistent across independent tellings, but rests on testimony rather than a public ledger.',
    'The investment is well documented, with confidence limited by the absence of a public primary record.'],
  ['False', 'John Snow', 99,
    '"Cause" means a demonstrated increase in incidence attributable to exposure.',
    'A Danish cohort of 657,461 children (2019) found no association between MMR vaccination and autism. The 1998 paper that started the claim was retracted in 2010 for data manipulation. Systematic reviews reach the same result.',
    'The dispositive evidence is a very large cohort with no signal. The originating source has been withdrawn.',
    'No causal link exists between vaccines and autism.'],
  ['True', 'Andreas Vesalius', 96,
    '"Adult" means after skeletal fusion is complete. "206" is the standard anatomical count.',
    'Anatomical reference texts count 206 bones in the typical adult skeleton. Individuals vary with extra sesamoids or unfused segments.',
    'The count is a convention that matches the typical body; variation does not falsify the typical case.',
    'The typical adult skeleton has 206 bones.'],
  ['False', 'Ronald Fisher', 90,
    '"Makes hyperactive" means a causal effect on behaviour after sugar intake.',
    'A meta-analysis of 23 double-blind trials (JAMA, 1995) found no effect of sugar on children\'s behaviour or cognition. A blinded study showed parents rated children as more hyperactive when told they had eaten sugar, whether or not they had.',
    'Randomised, blinded evidence shows no effect and identifies the expectancy that produces the belief.',
    'Sugar does not cause hyperactivity in children.'],
  ['True', 'Albert A. Michelson', 100,
    '"Speed of light in a vacuum" is the constant c.',
    'Since 1983 the metre has been defined so that c is exactly 299,792,458 m/s. The value is fixed by definition and consistent with all measurement before it.',
    'A defined constant cannot be off by measurement error; the figure is exact.',
    'The value is exact by international definition.'],
  ['False', 'Ivan Pavlov', 93,
    '"Three-second memory" means no retention of learned associations beyond a few seconds.',
    'Conditioning experiments show goldfish retain learned responses for weeks and months, including time-and-place feeding schedules and avoidance learning.',
    'A retention interval measured in months refutes a claim of seconds.',
    'Goldfish remember for months, not seconds.'],
  ['True', 'Luke Howard', 92,
    '"Driest" is lowest mean annual precipitation across a continent.',
    'Continental precipitation over Antarctica averages roughly 166 mm of water equivalent per year, and the interior plateau receives about 50 mm, lower than any other continent. The McMurdo Dry Valleys are among the driest places on Earth.',
    'Instrumented averages place Antarctica below every other continent.',
    'Antarctica is the driest continent.'],
  ['Uncertain', 'Carl Linnaeus', 40,
    '"Species on Earth" means all living species, described or not; the count is an estimate, not an observation.',
    'A widely cited 2011 model estimates about 8.7 million eukaryotic species, give or take 1.3 million. Roughly 1.2 to 2 million have been described. Other estimates, especially including microbes, range far higher.',
    'The number depends on a statistical extrapolation whose uncertainty spans the threshold in the claim.',
    'The estimate is plausible but not established.'],
  ['Uncertain', 'Edmond Malone', 45,
    '"Wrote" includes sole and collaborative authorship; the count depends on which collaborations are admitted.',
    'The conventional count is 37; scholarly editions range from 37 to 39 depending on the inclusion of The Two Noble Kinsmen, Edward III and contributions to Sir Thomas More. No primary record fixes a number.',
    'The disagreement is about attribution, which the surviving record cannot settle.',
    'The count is a matter of editorial convention, not fact.'],
];

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const id = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});
const rand = (a, b) => a + Math.random() * (b - a);

export function entryMarkdown(claim, [verdict, inspector, confidence, definitions, evidence, analysis, conclusion]) {
  return `0. **Name** : ${inspector}

1. **Definitions**: ${definitions}

2. **Principles**: Non-contradiction; the burden of proof rests on the proposition; primary, traceable artifacts outrank repetition; a proposition settled by a dispositive record is not re-litigated by narrative.

3. **Evidence**: ${evidence} *(Sample entry: placeholder text written for the demonstration, not a live determination.)*

4. **Analysis**: ${analysis}

5. **Are You The Dog Who Cannot Stop Chasing The Cat**: No. The first dispositive artifact settled the proposition and the inspection stopped there.

6. **Conclusion**: ${verdict}. ${conclusion}

7. **Confidence**: ${confidence}%. ${verdict === 'Uncertain' ? 'Confidence is limited by the absence of a settling primary source.' : 'Residual uncertainty reflects only the possibility of an unpublished correction to the primary record.'}`;
}

export async function demoExtract({ onEvent, signal }) {
  const started = Date.now();
  onEvent({ t: 'start', model: 'sample', at: started });
  await sleep(700, signal);
  let chars = 0;
  for (let i = 0; i < CLAIMS.length; i++) {
    await sleep(rand(80, 150), signal);
    chars += CLAIMS[i].length + 4;
    onEvent({ t: 'claim', n: i + 1, text: CLAIMS[i] });
    onEvent({ t: 'progress', chars, found: i + 1 });
  }
  await sleep(300, signal);
  onEvent({
    t: 'done',
    total: CLAIMS.length,
    limit: 20,
    claims: CLAIMS.map((text, i) => ({ n: i + 1, text })),
    model: 'sample',
    usage: { input: 760, output: 540, reasoning: 0, cached: 0 },
    ms: Date.now() - started,
    cost: { usd: 0.0081, priced: true },
  });
}

export async function demoEvaluate({ claims, onEvent, signal }) {
  const started = Date.now();
  const total = claims.length;
  let completed = 0;
  onEvent({ t: 'batch-start', total, at: started, model: 'sample', effort: 'xhigh' });

  const one = async (claim, i) => {
    const entry = ENTRIES[CLAIMS.indexOf(claim)] || ENTRIES[i % ENTRIES.length];
    await sleep(rand(200, 2400), signal);
    onEvent({ t: 'start', i, model: 'sample', at: Date.now() });
    await sleep(rand(600, 1200), signal);
    onEvent({ t: 'phase', i, phase: 'reasoning' });
    await sleep(rand(1200, 4500), signal);
    onEvent({ t: 'phase', i, phase: 'searching', searches: 1 });
    await sleep(rand(500, 1500), signal);
    const text = entryMarkdown(claim, entry);
    const chunks = text.match(/[\s\S]{1,40}/g) || [];
    for (const delta of chunks) {
      onEvent({ t: 'delta', i, text: delta });
      await sleep(rand(12, 40), signal);
    }
    const [verdict, inspector, confidence] = entry;
    completed++;
    const usage = { input: 4200, output: Math.round(rand(6000, 12000)), reasoning: Math.round(rand(5000, 10000)), cached: 0 };
    const usd = Math.round((usage.input * 5 + usage.output * 30) / 1e6 * 10000) / 10000 + 0.01;
    onEvent({
      t: 'done', i,
      verdict: verdict === 'Uncertain' ? 'unverified' : verdict.toLowerCase(),
      confidence, inspector, text, usage,
      model: 'sample', searches: 1, ms: Math.round(rand(48000, 190000)), cost: { usd, priced: true },
    });
    onEvent({ t: 'batch-progress', completed, total });
  };
  await Promise.all(claims.map((c, i) => one(c, i)));
  onEvent({ t: 'complete', total, completed, ms: Date.now() - started });
}

export async function demoIllustrate({ signal }) {
  await sleep(rand(2500, 4500), signal);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe0f2"/><stop offset="1" stop-color="#f7f1e2"/></linearGradient>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9db77a"/><stop offset="1" stop-color="#6f8c55"/></linearGradient></defs>
  <rect width="400" height="400" fill="url(#s)"/>
  <circle cx="290" cy="112" r="46" fill="#ffe9a8" opacity=".95"/>
  <circle cx="290" cy="112" r="78" fill="#ffe9a8" opacity=".25"/>
  <rect y="262" width="400" height="138" fill="url(#g)"/>
  <rect x="120" y="150" width="160" height="112" fill="#dfe3e8" opacity=".85"/>
  <g stroke="#f4f6f8" stroke-width="3" opacity=".8">${Array.from({ length: 21 }, (_, i) => `<line x1="${124 + i * 7.6}" y1="152" x2="${124 + i * 7.6}" y2="262"/>`).join('')}</g>
  <rect x="120" y="150" width="160" height="112" fill="none" stroke="#c3c9d1" stroke-width="2"/>
  <path d="M0 300 C 90 280, 150 320, 200 310 S 330 290, 400 306 L 400 330 C 320 322, 260 340, 200 332 S 80 312, 0 328 Z" fill="#c9bfae"/>
  <circle cx="150" cy="292" r="7" fill="#2b2f36"/><rect x="146" y="299" width="8" height="18" rx="3" fill="#3f4652"/>
  <circle cx="170" cy="294" r="7" fill="#2b2f36"/><rect x="166" y="301" width="8" height="18" rx="3" fill="#6b4a3a"/>
  <g fill="none" stroke="#4874e4" stroke-width="6"><path d="M28 60 v-32 h32"/><path d="M372 60 v-32 h-32"/><path d="M28 340 v32 h32"/><path d="M372 340 v32 h-32"/></g>
</svg>`;
  return { dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, model: 'sample', ms: 3100, cost: { usd: 0.02, priced: true } };
}

export async function demoChallenge({ signal }) {
  await sleep(700, signal);
  return { submitted: false, reason: 'challenge_disabled', attachments: [] };
}
