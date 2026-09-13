// Deterministic offline "model": extractive heuristics (lead sentences, proper nouns,
// frequent words) so the whole pipeline runs with no network or cost. Labelled
// live:false; validates the harness, never comparable to live models on answer quality.

const { sentences, topWords, properNouns } = require('../util');

function extractUnderstandingJSON(ctx) {
  // If the context carries a DaiDocs `# Understanding` block, read it like a model would.
  const m = ctx.match(/# Understanding\s*(?:```json\s*)?({[\s\S]*?})\s*(?:```|# )/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

function frontmatterSummary(ctx) {
  const m = ctx.match(/^summary:\s*("?)([\s\S]*?)\1\s*$/m) || ctx.match(/"summary"\s*:\s*"([^"]+)"/);
  return m ? (m[2] || m[1]) : null;
}

function create() {
  return {
    id: 'mock', model: 'extractive-heuristic-v1', live: false,
    available: () => true,
    async complete({ system = '', prompt = '', maxTokens = 1024 }) {
      const qm = prompt.match(/QUESTION:\s*([^\n]{1,400})/i);
      const cm = prompt.match(/\n(?:CONTEXT|DOCUMENT|EXCERPTS|SOURCE):\s*\n?([\s\S]*)$/i);
      const ctx = cm ? cm[1] : prompt;
      const sents = sentences(ctx);

      if (!qm) {
        // Ingestion-style request (no QUESTION line).
        if (/"entities"/.test(prompt)) {
          const prefs = /"preferences"/.test(prompt)
            ? sents.filter(s => /\b(prefer|favou?rite|love|hate|allergic|always|never|really (like|enjoy))\b/i.test(s)).slice(0, 4)
            : undefined;
          // extraction asks for dated, typed fact objects
          const srcDate = (prompt.match(/SOURCE DATE:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
          const wantsWho = /"who"/.test(prompt);
          const facts = /"kind"/.test(prompt)
            ? sents.slice(0, 6).map(s => ({
              fact: s.slice(0, 160),
              date: (s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/) || [])[0] || srcDate,
              kind: /\b(prefer|favou?rite|love|hate|allergic)\b/i.test(s) ? 'preference'
                : /\b(i am|i'm a|my (job|degree|house|apartment|wife|husband))\b/i.test(s) ? 'attribute' : 'event',
              ...(wantsWho ? {
                who: (s.match(/^([A-Z][a-z]{2,})\b/) || [])[1] || 'user',
                status: /\b(will|plan|going to|hope to)\b/i.test(s) ? 'planned' : 'experienced',
                ...(/\b(i am|i'm a|my (job|degree|house|apartment))\b/i.test(s) ? { slot: (s.toLowerCase().match(/my (\w+ ?\w*)/) || [null, 'attribute'])[1] } : {})
              } : {})
            }))
            : sents.slice(0, 4);
          // pick tags from the offered candidate list; infer simple preference signals
          const tagCand = (prompt.match(/ONLY from:\s*([^)]+)\)/) || [])[1];
          const tags = tagCand ? tagCand.split(',').map(t => t.trim()).filter(t => t.includes('.')).slice(0, 3) : undefined;
          const inferred = /"inferred_preferences"/.test(prompt)
            ? sents.filter(s => /\b(enjoyed|loved|liked|amazing|awful|hated|disappointing|great experience)\b/i.test(s)).slice(0, 3).map(s => 'prefers: ' + s.slice(0, 100))
            : undefined;
          return JSON.stringify({
            entities: { people: properNouns(ctx, 6), orgs: [], dates: [...new Set((ctx.match(/\b(1[5-9]\d\d|20\d\d)\b/g) || []).slice(0, 5))], amounts: [] },
            actions: [], decisions: [],
            facts,
            topics: topWords(ctx, 6),
            ...(/"summary"/.test(prompt) ? { summary: sents.slice(0, 2).join(' ').slice(0, 280) } : {}),
            ...(/"events"/.test(prompt) ? {
              events: sents.filter(s => /\b(went|visited|bought|attended|saw|had (a|an)|appointment|trip|dinner|workout|watched)\b/i.test(s)).slice(0, 8)
                .map(s => ({ date: (s.match(/\b20\d{2}-\d{2}-\d{2}\b/) || [])[0] || (prompt.match(/SOURCE DATE:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null, cat: 'other', what: s.slice(0, 70) }))
            } : {}),
            ...(prefs ? { preferences: prefs } : {}),
            ...(tags ? { tags } : {}),
            ...(inferred ? { inferred_preferences: inferred } : {}),
            ...(/"persona"/.test(prompt) ? {
              persona: {
                tastes: sents.filter(s => /\b(prefer|favou?rite|love|enjoy)\b/i.test(s)).slice(0, 3),
                constraints: sents.filter(s => /\b(allergic|never|can't|avoid)\b/i.test(s)).slice(0, 2),
                habits: sents.filter(s => /\b(always|every (day|week|morning)|usually)\b/i.test(s)).slice(0, 2)
              }
            } : {}),
            sentiment: 'neutral', open_questions: []
          }, null, 1);
        }
        if (/one-sentence summary/i.test(prompt)) return sents.slice(0, 2).join(' ');
        return sents.slice(0, 3).join(' ').slice(0, maxTokens * 4);
      }

      const q = qm[1].toLowerCase();
      const u = extractUnderstandingJSON(ctx);

      if (q.includes('summary')) {
        return frontmatterSummary(ctx) || (u && u.facts ? u.facts.slice(0, 2).join(' ') : sents.slice(0, 2).join(' '));
      }
      if (q.includes('fact') || q.includes('entit')) {
        if (u) {
          const ents = u.entities ? Object.values(u.entities).flat().filter(x => typeof x === 'string') : [];
          return ents.join(', ') + '. ' + (u.facts || []).join(' ');
        }
        return properNouns(ctx, 10).join(', ') + '. ' + sents.slice(0, 4).join(' ');
      }
      if (q.includes('topic')) {
        return u && u.topics ? u.topics.join(', ') : topWords(ctx, 8).join(', ');
      }
      // Detail question: return the context sentence sharing the most distinctive words
      // with the question.
      const qWords = new Set(topWords(qm[1], 12));
      let best = '', bestScore = -1;
      for (const s of sents) {
        const score = topWords(s, 25).filter(w => qWords.has(w)).length;
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return best || sents[0] || '';
    }
  };
}

module.exports = { create };
