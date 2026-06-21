import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readJsonFile, readTextFile, writeJsonFile } from './utils/fs.js';
import { slugify } from './utils/slug.js';
import { logger } from './utils/logger.js';

function extractJson(text) { try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error(`Response was not parseable JSON. First 500 chars: ${text.slice(0, 500)}`); } }
function fallbackPrompts(week, events) { return { week, created_at: new Date().toISOString(), items: events.map((e, i) => ({ event_title: e.title, date: e.date, category: e.category, text_on_image: e.title.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40), image_prompt: `Create a vertical 9:16 cinematic social media poster for ${e.title}. Use a ${['close-up smartphone foreground','wide warm sunset scene','overhead gift-table composition','dramatic arena light composition','cozy home celebration scene'][i % 5]} with a strong central subject, visible smartphone, subtle glowing music notes, soft sound waves, personal greeting and gift mood. Avoid logos, badges, real athlete faces, celebrity likenesses, and trademarked identities. English text only.`, reels_text: `${e.title} is coming. Turn it into a personal Melody4U wish.`, hashtags: ['#Melody4U', '#GiftIdea', `#${slugify(e.category).replace(/-/g, '') || 'Event'}`, '#SocialPoster', '#WeeklyMood'], slug: slugify(e.title) })) }; }
function validatePrompts(data, week) { if (!Array.isArray(data.items)) throw new Error('Prompt JSON must include items array.'); data.week = week; data.created_at ||= new Date().toISOString(); data.items = data.items.map((item) => ({ ...item, hashtags: (item.hashtags || []).slice(0, 5), slug: item.slug || slugify(item.event_title) })); for (const item of data.items) if (item.hashtags.length !== 5) throw new Error(`Item ${item.event_title} must have exactly 5 hashtags.`); return data; }

async function main() {
  await logger.info('Generate image prompts started');
  try {
    const target = resolveTargetWeek();
    const inputFile = `data/weekly/${target.week}.json`;
    await logger.info(`Reading weekly overview: ${inputFile}`);
    const overview = await readJsonFile(inputFile);
    const events = overview.events.filter((e) => e.generate_image === true && e.status === 'waiting');
    await logger.info(`Found ${events.length} waiting events with generate_image=true for ${target.week}`);
    const style = await readTextFile('prompts/melody4u_style.txt');
    const system = await readTextFile('prompts/image_prompt_system.txt');
    let prompts;
    if (events.length === 0) prompts = { week: target.week, created_at: new Date().toISOString(), items: [] };
    else if (!process.env.OPENAI_API_KEY) { await logger.warn('OPENAI_API_KEY is missing; using deterministic local fallback image prompts for testing.'); prompts = fallbackPrompts(target.week, events); }
    else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({ model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini', temperature: 0.2, input: [{ role: 'system', content: `${system}\n\n${style}` }, { role: 'user', content: JSON.stringify({ week: target.week, events }, null, 2) }] });
      prompts = validatePrompts(extractJson(response.output_text), target.week);
    }
    prompts = validatePrompts(prompts, target.week);
    const out = `output/${target.week}/prompts.json`;
    await writeJsonFile(out, prompts);
    await logger.info(`Created image prompts: ${out}`);
    await logger.info('Generate image prompts finished successfully');
  } catch (error) { await logger.error(`Generate image prompts failed: ${error.message}`); process.exitCode = 1; }
}
main();
