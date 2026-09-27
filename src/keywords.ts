// Cheap, local keyword extraction for LightRAG (4.0.0).
//
// LightRAG's `local` / `global` / `hybrid` / `mix` modes start every query
// with an LLM call that extracts high-level and low-level keywords. On our
// deployment that call goes through LiteLLM → OpenRouter free models with
// 20 s timeouts and retries — the single largest latency term of a turn.
// LightRAG skips the call when the request already carries `hl_keywords` or
// `ll_keywords` (`get_keywords_from_query`, HKUDS/LightRAG lightrag/operate.py),
// so this module computes a reasonable pair locally:
//
//   - `ll` (low-level: entities / specific terms): capitalized sequences
//     (proper nouns such as "Projet Hélios"), acronyms, identifiers with
//     digits, then the remaining content words;
//   - `hl` (high-level: themes): multi-word content phrases (runs of 2-3
//     non-stopword tokens), falling back to the longest content words.
//
// Pure and synchronous. Quality is below an LLM extraction for abstract
// themes, which is why the feature is opt-in (`lightragLocalKeywords`).

/** LightRAG caps (lightrag/constants.py): 64 keywords per list, 512 chars each. */
const MAX_LL_KEYWORDS = 12;
const MAX_HL_KEYWORDS = 6;
const MAX_KEYWORD_CHARS = 120;

// Compact FR + EN stopword list: function words, auxiliaries, pronouns and
// the conversational fillers that dominate chat prompts.
const STOPWORDS = new Set<string>(
  (
    // French
    "a à ai aie aient aies ait alors as au aucun aucune aupres auquel aura aurai auraient aurais aurait " +
    "auras aurez auriez aurions aurons auront aussi autre autres aux auxquels avaient avais avait avant " +
    "avec avez aviez avions avoir avons ayant ayez ayons bah bien c ça ca car ce ceci cela celle celles " +
    "celui cependant certain certaine certains ces cet cette ceux chaque chez ci comme comment d dans de " +
    "debout dedans dehors depuis des desquels dessous dessus deux doit doivent donc dont du duquel elle " +
    "elles en encore entre es est et étaient étais était étant été êtes étiez étions être eu eue eues " +
    "eurent eus eusse eut eux fait faire fais faut fois font furent fus fut ici il ils j je jusqu jusque " +
    "l la là laquelle le lequel les lesquelles lesquels leur leurs lors lui m ma mais me même mêmes mes " +
    "moi moins mon n ne ni non nos notre nous on ont ou où oui par parce pas peu peut peuvent peux plus " +
    "plutôt pour pourquoi pourrais pourrait pouvez pouvons qu quand que quel quelle quelles quels qui " +
    "quoi s sa sans se sera serait ses si sien sienne sont sous soyez suis sur t ta tandis te tes toi " +
    "ton tous tout toute toutes très tu un une unes uns va vais vas vers voici voilà vont vos votre " +
    "vous vu y stp svp merci peux-tu pourrais-tu peut-on dis-moi donne-moi montre-moi cherche trouve " +
    "donne dire dis sais savoir besoin veux voudrais aimerais rappelle rappelle-moi est-ce y-a-t-il " +
    // English
    "a about above after again against all am an and any are as at be because been before being below " +
    "between both but by can could did do does doing down during each few for from further had has " +
    "have having he her here hers herself him himself his how i if in into is it its itself just me " +
    "more most my myself no nor not now of off on once only or other our ours ourselves out over own " +
    "please same she should so some such than that the their theirs them themselves then there these " +
    "they this those through to too under until up very was we were what when where which while who " +
    "whom why will with would you your yours yourself yourselves tell show give find know need want " +
    "let's lets thanks thank"
  ).split(/\s+/),
);

// Unicode-aware tokenizer: letters/digits, keeping inner apostrophes,
// hyphens, dots and underscores (identifiers, "Hélios-2", "v3.2", "a_b").
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}_.'’-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;

interface Token {
  raw: string;
  lower: string;
  stop: boolean;
  capitalized: boolean;
  special: boolean;
}

function stripElision(word: string): string {
  // "l'entreprise" → "entreprise", "d'Hélios" → "Hélios".
  const m = /^(?:[ldjmnstc]|qu|jusqu|lorsqu|puisqu)['’](.+)$/iu.exec(word);
  return m ? m[1]! : word;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = stripElision(match[0].replace(/[.'’-]+$/u, ""));
    if (!raw) continue;
    const lower = raw.toLocaleLowerCase("fr");
    const hasDigit = /\p{N}/u.test(raw);
    const isAcronym = raw.length >= 2 && raw === raw.toLocaleUpperCase("fr") && /\p{L}/u.test(raw);
    out.push({
      raw,
      lower,
      stop: STOPWORDS.has(lower) || (raw.length < 3 && !hasDigit && !isAcronym),
      capitalized: /^\p{Lu}/u.test(raw),
      special: hasDigit || isAcronym || /[_.]/.test(raw),
    });
  }
  return out;
}

function pushUnique(list: string[], seen: Set<string>, value: string, max: number): void {
  if (list.length >= max) return;
  const trimmed = value.slice(0, MAX_KEYWORD_CHARS).trim();
  if (!trimmed) return;
  const key = trimmed.toLocaleLowerCase("fr");
  if (seen.has(key)) return;
  seen.add(key);
  list.push(trimmed);
}

/**
 * Extract `{ hl, ll }` keyword lists from a user query. Returns empty lists
 * when nothing meaningful remains (the caller then lets LightRAG extract).
 */
export function extractKeywords(query: string): { hl: string[]; ll: string[] } {
  const tokens = tokenize(query);
  const ll: string[] = [];
  const hl: string[] = [];
  const llSeen = new Set<string>();
  const hlSeen = new Set<string>();

  // 1. Proper-noun sequences: consecutive capitalized non-stopword tokens,
  //    ignoring a capital that only marks the sentence start.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.stop || !(tok.capitalized || tok.special)) continue;
    if (i === 0 && !tok.special && tokens.length > 1 && !tokens[1]!.capitalized) {
      // Sentence-initial capital with a lowercase follower: not an entity.
      continue;
    }
    const run: string[] = [tok.raw];
    let j = i + 1;
    while (j < tokens.length && run.length < 4) {
      const next = tokens[j]!;
      if (next.stop || !(next.capitalized || next.special)) break;
      run.push(next.raw);
      j++;
    }
    pushUnique(ll, llSeen, run.join(" "), MAX_LL_KEYWORDS);
    i = j - 1;
  }

  // 2. Remaining content words (order of appearance).
  for (const tok of tokens) {
    if (!tok.stop) pushUnique(ll, llSeen, tok.raw, MAX_LL_KEYWORDS);
  }

  // 3. High-level phrases: runs of 2-3 consecutive content tokens.
  let run: Token[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      pushUnique(
        hl,
        hlSeen,
        run
          .slice(0, 3)
          .map((t) => t.lower)
          .join(" "),
        MAX_HL_KEYWORDS,
      );
    }
    run = [];
  };
  for (const tok of tokens) {
    if (tok.stop) flush();
    else run.push(tok);
  }
  flush();

  // 4. Fallback: the longest content words carry the theme.
  if (hl.length === 0) {
    const content = tokens
      .filter((t) => !t.stop)
      .map((t) => t.lower)
      .sort((a, b) => b.length - a.length);
    for (const word of content) pushUnique(hl, hlSeen, word, Math.min(3, MAX_HL_KEYWORDS));
  }

  return { hl, ll };
}
