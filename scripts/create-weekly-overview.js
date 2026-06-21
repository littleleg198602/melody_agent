import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readTextFile, writeJsonFile } from './utils/fs.js';
import { logger } from './utils/logger.js';

const CZECH_RELEVANCE_WEIGHT = { high: 3, medium: 2, low: 1 };
const ALLOWED_TONES = ['fan_hype', 'celebration', 'respectful_memorial', 'awareness'];
const ALLOWED_EVENT_ORIGINS = ['international_significant_day', 'czech_significant_day', 'sport', 'motorsport', 'seasonal', 'other'];
const ALLOWED_LANGUAGE_POLICIES = ['english', 'czech', 'bilingual_cs_en'];

function previewText(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function extractJson(text) {
  const raw = String(text ?? '').trim();
  try { return JSON.parse(raw); } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Response was not parseable JSON. First 1000 chars: ${previewText(raw)}`);
  }
}

function normalizeCzechRelevance(value) {
  return ['high', 'medium', 'low'].includes(value) ? value : 'low';
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function inferTone(event) {
  const text = `${event.title ?? ''} ${event.category ?? ''}`.toLowerCase();
  if (/drug|awareness|trafficking|abuse/.test(text)) return 'awareness';
  if (/communist|political prisoner|victim|memorial|remembrance|památ|vezn|vězň/.test(text)) return 'respectful_memorial';
  if (/day|midsummer|john|jan|tradition|family|children|music|friendship|love/.test(text) && !/world cup|formula|motogp|wimbledon|hockey|football/.test(text)) return 'celebration';
  return 'fan_hype';
}

function inferEventOrigin(event) {
  const text = `${event.title ?? ''} ${event.category ?? ''}`.toLowerCase();
  if (/international day|drug abuse|trafficking|awareness/.test(text)) return 'international_significant_day';
  if (/communist|political prisoner|czech.*day|memorial|jan|st\.? john|svato/.test(text)) return 'czech_significant_day';
  if (/formula|motogp|grand prix|motorsport|racing/.test(text)) return 'motorsport';
  if (/midsummer|seasonal/.test(text)) return 'seasonal';
  if (/football|world cup|euro|hockey|wimbledon|tennis|sport/.test(text)) return 'sport';
  return 'other';
}

function inferLanguagePolicy(eventOrigin) {
  if (eventOrigin === 'international_significant_day') return 'bilingual_cs_en';
  if (eventOrigin === 'czech_significant_day') return 'czech';
  return 'english';
}

function inferSourcePriority(event, tone, eventOrigin) {
  const text = `${event.title ?? ''} ${event.category ?? ''}`.toLowerCase();
  if ((/world cup|euro|major tournament/.test(text) && /czech/.test(text)) || (/ice hockey world championship/.test(text) && /czech/.test(text))) return 1;
  if (eventOrigin === 'international_significant_day' || eventOrigin === 'czech_significant_day') return tone === 'celebration' ? 6 : 2;
  if (/formula|f1/.test(text)) return 3;
  if (/motogp/.test(text)) return 4;
  if (/wimbledon|hockey|football|tennis|sport/.test(text)) return 5;
  return 6;
}

function clampScore(value, fallback = 3) {
  return Math.min(5, Math.max(1, Number(value) || fallback));
}

function normalizeEvent(event) {
  const priority = clampScore(event.priority);
  const melody4uScore = clampScore(event.melody4u_score ?? event.melody4uScore ?? priority);
  const czechRelevance = normalizeCzechRelevance(event.czech_relevance);
  const eventOrigin = normalizeEnum(event.event_origin, ALLOWED_EVENT_ORIGINS, inferEventOrigin(event));
  const tone = normalizeEnum(event.tone, ALLOWED_TONES, inferTone({ ...event, event_origin: eventOrigin }));
  const languagePolicy = normalizeEnum(event.language_policy, ALLOWED_LANGUAGE_POLICIES, inferLanguagePolicy(eventOrigin));
  const sourcePriority = Math.min(9, Math.max(1, Number(event.source_priority) || inferSourcePriority(event, tone, eventOrigin)));
  const tooWeak = czechRelevance === 'low' && melody4uScore < 3;

  return {
    date: event.date,
    category: event.category,
    title: event.title,
    note: event.note,
    priority,
    source_priority: sourcePriority,
    generate_image: tooWeak ? false : Boolean(event.generate_image ?? true),
    status: 'waiting',
    tone,
    event_origin: eventOrigin,
    language_policy: languagePolicy,
    czech_relevance: czechRelevance,
    melody4u_score: melody4uScore,
    marketing_angle: event.marketing_angle || 'gift for a fan',
    why_selected: event.why_selected || 'Selected for Melody4U social media relevance.'
  };
}


function dateInRange(date, target) {
  return date >= target.date_from && date <= target.date_to;
}

function mergeKnownEditorialEvents(events, target) {
  const merged = [...events];
  const normalizedTitles = new Set(merged.map((event) => String(event.title ?? '').toLowerCase()));
  const addOnce = (event, matchPattern) => {
    if (!dateInRange(event.date, target)) return;
    if ([...normalizedTitles].some((title) => matchPattern.test(title))) return;
    merged.push(event);
    normalizedTitles.add(String(event.title ?? '').toLowerCase());
  };

  addOnce({ date: '2026-06-24', category: 'sport', title: 'FIFA World Cup 2026 + Czech Republic vs Mexico', note: 'Combined main weekly football storyline for a Czech audience: the ongoing World Cup together with the Czech national team match. Keep visuals symbolic, with no official logos, badges, player likenesses, or protected tournament identity.', priority: 5, source_priority: 1, generate_image: true, status: 'waiting', tone: 'fan_hype', event_origin: 'sport', language_policy: 'english', czech_relevance: 'high', melody4u_score: 5, marketing_angle: 'personal football greeting before a big Czech national team match', why_selected: 'Major world tournament plus Czech national team match is the strongest Czech-relevant sport topic of the week and should not be split into generic duplicate World Cup entries.' }, /world cup.*czech|czech republic vs mexico|česko.*mexiko|czech.*mexico/);
  addOnce({ date: '2026-06-26', category: 'international-day', title: 'International Day Against Drug Abuse and Illicit Trafficking', note: 'Important international awareness day for thoughtful Melody4U content. Use hopeful, supportive language and avoid fearmongering, shock visuals, or graphic imagery.', priority: 5, source_priority: 2, generate_image: true, status: 'waiting', tone: 'awareness', event_origin: 'international_significant_day', language_policy: 'bilingual_cs_en', czech_relevance: 'medium', melody4u_score: 5, marketing_angle: 'thoughtful awareness message with hope and support', why_selected: 'A main significant day in the week; serious topics should be handled with awareness tone, not skipped.' }, /drug abuse|illicit trafficking|proti drog|anti.?drug/);
  addOnce({ date: '2026-06-27', category: 'czech-significant-day', title: 'Memorial Day for Victims of the Communist Regime / Political Prisoners', note: 'Czech memorial day requiring calm, dignified and respectful visual language. No hype, no sensationalism, and no disturbing imagery.', priority: 5, source_priority: 2, generate_image: true, status: 'waiting', tone: 'respectful_memorial', event_origin: 'czech_significant_day', language_policy: 'czech', czech_relevance: 'high', melody4u_score: 5, marketing_angle: 'respectful remembrance for a Czech audience', why_selected: 'A major Czech memorial day in the week; it should be included with respectful memorial tone rather than ignored.' }, /communist|political prisoner|obět.*komun|komunistick/);
  addOnce({ date: '2026-06-26', category: 'motorsport', title: 'Formula 1: Austrian Grand Prix', note: 'Top motorsport priority near Czech fans. Use generic racing atmosphere and avoid official F1 branding, team liveries, and real driver likenesses.', priority: 5, source_priority: 3, generate_image: true, status: 'waiting', tone: 'fan_hype', event_origin: 'motorsport', language_policy: 'english', czech_relevance: 'medium', melody4u_score: 5, marketing_angle: 'gift for a racing fan before the weekend', why_selected: 'Formula 1 is the top motorsport storyline after the Czech/world tournament theme and main significant days.' }, /formula 1|f1|austrian grand prix/);
  addOnce({ date: '2026-06-26', category: 'motorsport', title: 'MotoGP: Dutch TT at Assen', note: 'Major motorcycle racing weekend. Keep it after Formula 1 in the editorial order and use generic motorcycle racing energy without official marks.', priority: 4, source_priority: 6, generate_image: true, status: 'waiting', tone: 'fan_hype', event_origin: 'motorsport', language_policy: 'english', czech_relevance: 'medium', melody4u_score: 4, marketing_angle: 'weekend racing spirit for motorcycle fans', why_selected: 'MotoGP is important, but for this editorial policy it belongs behind Formula 1 and the main significant days.' }, /motogp|dutch tt|assen/);

  return merged;
}

function removeDuplicateEditorialEvents(events) {
  const selected = [];
  let hasCombinedCzechWorldCup = false;
  for (const event of events) {
    const title = String(event.title ?? '').toLowerCase();
    if (/world cup/.test(title) && /czech|čes|mexico|mexiko/.test(title)) hasCombinedCzechWorldCup = true;
  }
  for (const event of events) {
    const title = String(event.title ?? '').toLowerCase();
    if (hasCombinedCzechWorldCup && /world cup/.test(title) && !/czech|čes|mexico|mexiko/.test(title)) continue;
    if (selected.some((item) => String(item.title ?? '').toLowerCase() === title)) continue;
    selected.push(event);
  }
  return selected;
}

function validateEvent(event, index) {
  for (const key of ['date', 'category', 'title', 'note', 'source_priority', 'tone', 'event_origin', 'language_policy', 'marketing_angle', 'why_selected']) {
    if (!event[key]) throw new Error(`Weekly event ${index} missing required field: ${key}`);
  }
  if (!['high', 'medium', 'low'].includes(event.czech_relevance)) throw new Error(`Weekly event ${index} has invalid czech_relevance.`);
  if (!ALLOWED_TONES.includes(event.tone)) throw new Error(`Weekly event ${index} has invalid tone.`);
  if (!ALLOWED_EVENT_ORIGINS.includes(event.event_origin)) throw new Error(`Weekly event ${index} has invalid event_origin.`);
  if (!ALLOWED_LANGUAGE_POLICIES.includes(event.language_policy)) throw new Error(`Weekly event ${index} has invalid language_policy.`);
  if (event.priority < 1 || event.priority > 5) throw new Error(`Weekly event ${index} has invalid priority.`);
  if (event.melody4u_score < 1 || event.melody4u_score > 5) throw new Error(`Weekly event ${index} has invalid melody4u_score.`);
  if (typeof event.generate_image !== 'boolean') throw new Error(`Weekly event ${index} generate_image must be boolean.`);
}

async function filterAndRankEvents(events, target) {
  const normalized = removeDuplicateEditorialEvents(mergeKnownEditorialEvents(events, target)).map(normalizeEvent);
  await logger.info(`Raw events returned: ${normalized.length}`);

  const strong = normalized.filter((event) => event.melody4u_score >= 3);
  const candidates = strong.length >= 5 ? strong : normalized;

  for (const event of normalized) {
    if (!candidates.includes(event)) {
      await logger.info(`Skipped event: ${event.title} — melody4u_score ${event.melody4u_score} is below 3.`);
    } else if (event.czech_relevance === 'low' && event.melody4u_score < 3) {
      event.generate_image = false;
      await logger.info(`Skipped image generation for weak event: ${event.title} — low Czech relevance and low Melody4U score.`);
    }
  }

  const selected = candidates
    .sort((a, b) => a.source_priority - b.source_priority || String(a.date).localeCompare(String(b.date)) || b.priority - a.priority || b.melody4u_score - a.melody4u_score || CZECH_RELEVANCE_WEIGHT[b.czech_relevance] - CZECH_RELEVANCE_WEIGHT[a.czech_relevance])
    .slice(0, 7);

  const finalEvents = selected.length >= 5 ? selected : normalized
    .sort((a, b) => a.source_priority - b.source_priority || String(a.date).localeCompare(String(b.date)) || b.priority - a.priority || b.melody4u_score - a.melody4u_score || CZECH_RELEVANCE_WEIGHT[b.czech_relevance] - CZECH_RELEVANCE_WEIGHT[a.czech_relevance])
    .slice(0, 7);

  finalEvents.forEach(validateEvent);
  await logger.info(`Events after filtering: ${finalEvents.length}`);
  await logger.info(`Final selected event order: ${finalEvents.map((event) => `${event.source_priority}. ${event.title}`).join(' | ')}`);
  await logger.info(`Final selected tone values: ${finalEvents.map((event) => `${event.title}: ${event.tone}`).join(' | ')}`);
  await logger.info(`Final selected language_policy values: ${finalEvents.map((event) => `${event.title}: ${event.language_policy}`).join(' | ')}`);
  return finalEvents;
}

async function validateOverview(data, target) {
  if (!Array.isArray(data.events) || data.events.length < 1) throw new Error('Overview JSON must include a non-empty events array.');
  const generatedAt = new Date().toISOString();
  await logger.info(`Overview generated_at set by script: ${generatedAt}`);
  return {
    week: target.week,
    date_from: target.date_from,
    date_to: target.date_to,
    generated_at: generatedAt,
    events: await filterAndRankEvents(data.events, target)
  };
}

function fallbackOverview(target) {
  return {
    events: [
      { date: '2026-06-24', category: 'sport', title: 'FIFA World Cup 2026 + Czech Republic vs Mexico', note: 'Combined main weekly storyline for Czech audience, no official logos or exact tournament branding in visuals.', priority: 5, source_priority: 1, generate_image: true, status: 'waiting', tone: 'fan_hype', event_origin: 'sport', language_policy: 'english', czech_relevance: 'high', melody4u_score: 5, marketing_angle: 'personal greeting before a big Czech World Cup match', why_selected: 'Major world tournament plus Czech national team match is the strongest Czech-relevant social topic of the week.' },
      { date: '2026-06-26', category: 'international-day', title: 'International Day Against Drug Abuse and Illicit Trafficking', note: 'Important international awareness day for thoughtful Melody4U content with no fearmongering.', priority: 5, source_priority: 2, generate_image: true, status: 'waiting', tone: 'awareness', event_origin: 'international_significant_day', language_policy: 'bilingual_cs_en', czech_relevance: 'medium', melody4u_score: 5, marketing_angle: 'thoughtful awareness message with hope and support', why_selected: 'A main significant day where a respectful bilingual message can fit Melody4U social content.' },
      { date: '2026-06-27', category: 'czech-significant-day', title: 'Memorial Day for Victims of the Communist Regime / Political Prisoners', note: 'Czech memorial day requiring calm, dignified and respectful visual language.', priority: 5, source_priority: 2, generate_image: true, status: 'waiting', tone: 'respectful_memorial', event_origin: 'czech_significant_day', language_policy: 'czech', czech_relevance: 'high', melody4u_score: 5, marketing_angle: 'respectful remembrance for Czech audience', why_selected: 'A major Czech memorial day that should be included with the right respectful tone.' },
      { date: '2026-06-26', category: 'motorsport', title: 'Formula 1 Austrian Grand Prix', note: 'Top motorsport priority close to Czech fans, visuals must avoid official F1 branding.', priority: 5, source_priority: 3, generate_image: true, status: 'waiting', tone: 'fan_hype', event_origin: 'motorsport', language_policy: 'english', czech_relevance: 'medium', melody4u_score: 5, marketing_angle: 'gift for a racing fan before the weekend', why_selected: 'Formula 1 is the top motorsport storyline after Czech/world tournament themes and main significant days.' },
      { date: '2026-06-26', category: 'motorsport', title: 'MotoGP Dutch TT Assen', note: 'Major motorcycle racing weekend, below Formula 1 in editorial order.', priority: 4, source_priority: 4, generate_image: true, status: 'waiting', tone: 'fan_hype', event_origin: 'motorsport', language_policy: 'english', czech_relevance: 'medium', melody4u_score: 4, marketing_angle: 'weekend racing spirit for motorcycle fans', why_selected: 'MotoGP is an important major sport but ranks below F1 and Czech national tournament themes.' },
      { date: '2026-06-22', category: 'sport', title: 'Wimbledon qualification', note: 'Recognizable summer tennis storyline with safe symbolic grass-court visuals.', priority: 4, source_priority: 5, generate_image: true, status: 'waiting', tone: 'fan_hype', event_origin: 'sport', language_policy: 'english', czech_relevance: 'medium', melody4u_score: 4, marketing_angle: 'summer sport vibes for tennis fans', why_selected: 'Wimbledon qualification is a recognizable tennis moment if capacity remains after top themes.' },
      { date: '2026-06-24', category: 'seasonal', title: 'St. John’s Day / Jan / midsummer mood', note: 'Czech seasonal and name-day friendly moment, useful only as a softer secondary theme.', priority: 3, source_priority: 6, generate_image: true, status: 'waiting', tone: 'celebration', event_origin: 'czech_significant_day', language_policy: 'czech', czech_relevance: 'high', melody4u_score: 3, marketing_angle: 'warm Czech midsummer greeting', why_selected: 'A Czech tradition and name-day mood can support a warm Melody4U greeting if capacity remains.' }
    ]
  };
}

async function main() {
  await logger.info('Create weekly overview started');
  let rawResponseText = '';
  try {
    const target = resolveTargetWeek();
    await logger.info(`Calculated target week: ${target.week}, from ${target.date_from} to ${target.date_to}`);
    const system = await readTextFile('prompts/weekly_overview_system.txt');
    let overview;
    if (!process.env.OPENAI_API_KEY) {
      await logger.warn('Selected source mode: deterministic local fallback because OPENAI_API_KEY is missing.');
      overview = await validateOverview(fallbackOverview(target), target);
    } else {
      await logger.info('Selected source mode: OpenAI Responses API with web search.');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
        tools: [{ type: 'web_search_preview' }],
        temperature: 0.2,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: `Create candidate Melody4U weekly overview events for ${target.week} (${target.date_from} to ${target.date_to}). Return 5 to 7 strong events with source_priority, tone, event_origin, language_policy, czech_relevance, melody4u_score, marketing_angle, and why_selected.` }
        ]
      });
      rawResponseText = response.output_text ?? '';
      overview = await validateOverview(extractJson(rawResponseText), target);
    }
    const file = `data/weekly/${target.week}.json`;
    await writeJsonFile(file, overview);
    await logger.info(`Created weekly overview: ${file}`);
    await logger.info('Create weekly overview finished successfully');
  } catch (error) {
    if (rawResponseText) await logger.error(`Raw OpenAI overview response first 1000 chars: ${previewText(rawResponseText)}`);
    await logger.error(`Create weekly overview failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
