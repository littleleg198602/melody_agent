import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readTextFile, writeJsonFile } from './utils/fs.js';
import { logger } from './utils/logger.js';

function extractJson(text) {
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Response was not parseable JSON. First 500 chars: ${text.slice(0, 500)}`);
  }
}

function validateOverview(data, target) {
  if (!Array.isArray(data.events) || data.events.length < 1) throw new Error('Overview JSON must include a non-empty events array.');
  data.week = target.week; data.date_from = target.date_from; data.date_to = target.date_to; data.generated_at ||= new Date().toISOString();
  data.events = data.events.slice(0, 10).map((event) => ({
    date: event.date,
    category: event.category,
    title: event.title,
    note: event.note,
    priority: Math.min(5, Math.max(1, Number(event.priority) || 3)),
    generate_image: Boolean(event.generate_image),
    status: 'waiting'
  }));
  return data;
}

function fallbackOverview(target) {
  return validateOverview({ ...target, generated_at: new Date().toISOString(), events: [
    { date: target.date_from, category: 'football', title: 'European football summer stories', note: 'Symbolic stadium lights, summer fan mood, no club badges or official logos', priority: 4, generate_image: true, status: 'waiting' },
    { date: target.date_from, category: 'tennis', title: 'Grass court tennis week', note: 'Cinematic grass court atmosphere, symbolic racket and ball, no player likenesses', priority: 4, generate_image: true, status: 'waiting' },
    { date: target.date_to, category: 'cycling', title: 'Summer cycling inspiration', note: 'Open-road cycling scene with Czech countryside feeling, no official race branding', priority: 3, generate_image: true, status: 'waiting' },
    { date: target.date_to, category: 'motorsport', title: 'Summer racing weekend', note: 'Warm racing atmosphere with generic cars and helmets, no Formula 1 or MotoGP identity', priority: 3, generate_image: true, status: 'waiting' },
    { date: target.date_to, category: 'international-day', title: 'Weekly celebration moments', note: 'Gift-like social poster for personal wishes and shared memories', priority: 2, generate_image: true, status: 'waiting' }
  ] }, target);
}

async function main() {
  await logger.info('Create weekly overview started');
  try {
    const target = resolveTargetWeek();
    await logger.info(`Calculated target week: ${target.week}, from ${target.date_from} to ${target.date_to}`);
    const system = await readTextFile('prompts/weekly_overview_system.txt');
    let overview;
    if (!process.env.OPENAI_API_KEY) {
      await logger.warn('OPENAI_API_KEY is missing; using deterministic local fallback overview for testing.');
      overview = fallbackOverview(target);
    } else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
        tools: [{ type: 'web_search_preview' }],
        temperature: 0.2,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: `Create the Melody4U weekly overview JSON for ${target.week} (${target.date_from} to ${target.date_to}).` }
        ]
      });
      overview = validateOverview(extractJson(response.output_text), target);
    }
    const file = `data/weekly/${target.week}.json`;
    await writeJsonFile(file, overview);
    await logger.info(`Created weekly overview: ${file}`);
    await logger.info('Create weekly overview finished successfully');
  } catch (error) {
    await logger.error(`Create weekly overview failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
