import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readTextFile, writeJsonFile } from './utils/fs.js';
import { logger } from './utils/logger.js';

const CZECH_RELEVANCE_WEIGHT = { high: 3, medium: 2, low: 1 };

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

function clampScore(value, fallback = 3) {
  return Math.min(5, Math.max(1, Number(value) || fallback));
}

function normalizeEvent(event) {
  const priority = clampScore(event.priority);
  const melody4uScore = clampScore(event.melody4u_score ?? event.melody4uScore ?? priority);
  const czechRelevance = normalizeCzechRelevance(event.czech_relevance);
  const tooWeak = czechRelevance === 'low' && melody4uScore < 3;

  return {
    date: event.date,
    category: event.category,
    title: event.title,
    note: event.note,
    priority,
    generate_image: tooWeak ? false : Boolean(event.generate_image ?? true),
    status: 'waiting',
    czech_relevance: czechRelevance,
    melody4u_score: melody4uScore,
    marketing_angle: event.marketing_angle || 'gift for a fan',
    why_selected: event.why_selected || 'Selected for Melody4U social media relevance.'
  };
}

function validateEvent(event, index) {
  for (const key of ['date', 'category', 'title', 'note', 'marketing_angle', 'why_selected']) {
    if (!event[key]) throw new Error(`Weekly event ${index} missing required field: ${key}`);
  }
  if (!['high', 'medium', 'low'].includes(event.czech_relevance)) throw new Error(`Weekly event ${index} has invalid czech_relevance.`);
  if (event.priority < 1 || event.priority > 5) throw new Error(`Weekly event ${index} has invalid priority.`);
  if (event.melody4u_score < 1 || event.melody4u_score > 5) throw new Error(`Weekly event ${index} has invalid melody4u_score.`);
  if (typeof event.generate_image !== 'boolean') throw new Error(`Weekly event ${index} generate_image must be boolean.`);
}

async function filterAndRankEvents(events) {
  const normalized = events.map(normalizeEvent);
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
    .sort((a, b) => b.priority - a.priority || b.melody4u_score - a.melody4u_score || CZECH_RELEVANCE_WEIGHT[b.czech_relevance] - CZECH_RELEVANCE_WEIGHT[a.czech_relevance])
    .slice(0, 7);

  const finalEvents = selected.length >= 5 ? selected : normalized
    .sort((a, b) => b.priority - a.priority || b.melody4u_score - a.melody4u_score || CZECH_RELEVANCE_WEIGHT[b.czech_relevance] - CZECH_RELEVANCE_WEIGHT[a.czech_relevance])
    .slice(0, 7);

  finalEvents.forEach(validateEvent);
  await logger.info(`Events after filtering: ${finalEvents.length}`);
  await logger.info(`Final selected events: ${finalEvents.map((event) => event.title).join(' | ')}`);
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
    events: await filterAndRankEvents(data.events)
  };
}

function fallbackOverview(target) {
  return {
    events: [
      { date: target.date_from, category: 'motorsport', title: 'Formula 1 Austrian Grand Prix weekend', note: 'Major racing weekend near Czech audiences, described symbolically with no official logos.', priority: 5, generate_image: true, status: 'waiting', czech_relevance: 'medium', melody4u_score: 5, marketing_angle: 'gift for a racing fan before the weekend', why_selected: 'Recognizable mainstream motorsport event with strong social media potential.' },
      { date: target.date_from, category: 'tennis', title: 'Wimbledon opening week mood', note: 'Grand Slam tennis atmosphere with symbolic grass-court visuals and no player likenesses.', priority: 5, generate_image: true, status: 'waiting', czech_relevance: 'medium', melody4u_score: 5, marketing_angle: 'summer sport vibes for tennis fans', why_selected: 'A globally recognized tennis moment that can be turned into emotional fan gifting content.' },
      { date: target.date_to, category: 'football', title: 'European football summer night', note: 'Mainstream football atmosphere for fans, no club badges or official competition identity.', priority: 4, generate_image: true, status: 'waiting', czech_relevance: 'medium', melody4u_score: 4, marketing_angle: 'family watching sport together', why_selected: 'Football is widely recognizable and works well for family and fan greetings.' },
      { date: target.date_to, category: 'cycling', title: 'Summer cycling weekend', note: 'Symbolic open-road summer cycling scene with Czech countryside feeling.', priority: 3, generate_image: true, status: 'waiting', czech_relevance: 'medium', melody4u_score: 4, marketing_angle: 'weekend emotion', why_selected: 'Seasonal outdoor sport can support warm, personal Melody4U messages.' },
      { date: target.date_to, category: 'international-day', title: 'Family celebration day', note: 'Emotional gift-ready moment for family wishes, music, and personal greetings.', priority: 4, generate_image: true, status: 'waiting', czech_relevance: 'low', melody4u_score: 4, marketing_angle: 'celebration day', why_selected: 'Family and celebration themes match Melody4U gift messaging.' }
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
      await logger.warn('OPENAI_API_KEY is missing; using deterministic local fallback overview for testing.');
      overview = await validateOverview(fallbackOverview(target), target);
    } else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
        tools: [{ type: 'web_search_preview' }],
        temperature: 0.2,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: `Create candidate Melody4U weekly overview events for ${target.week} (${target.date_from} to ${target.date_to}). Return 5 to 7 strong events with czech_relevance, melody4u_score, marketing_angle, and why_selected.` }
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
