import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readJsonFile, readTextFile, writeJsonFile } from './utils/fs.js';
import { slugify } from './utils/slug.js';
import { logger } from './utils/logger.js';

const FALLBACK_HASHTAGS = ['#Melody4U', '#GiftIdea', '#MusicGift', '#PersonalWish', '#SocialPost'];

function previewText(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function extractJson(rawText) {
  const text = String(rawText ?? '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);

    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
      return JSON.parse(text.slice(objectStart, objectEnd + 1));
    }

    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    }

    throw new Error(`Response was not parseable JSON. First 1000 chars: ${previewText(text)}`);
  }
}

function fallbackPrompts(week, events) {
  return {
    week,
    created_at: new Date().toISOString(),
    items: events.map((event, index) => ({
      event_title: event.title,
      date: event.date,
      category: event.category,
      text_on_image: event.title.replace(/\b\w/g, (character) => character.toUpperCase()).slice(0, 40),
      image_prompt: `Create a vertical 9:16 cinematic social media poster for ${event.title}. Use a ${['close-up smartphone foreground', 'wide warm sunset scene', 'overhead gift-table composition', 'dramatic arena light composition', 'cozy home celebration scene'][index % 5]} with a strong central subject, visible smartphone, subtle glowing music notes, soft sound waves, personal greeting and gift mood. Avoid logos, badges, real athlete faces, celebrity likenesses, and trademarked identities. English text only.`,
      reels_text: `${event.title} is coming. Turn it into a personal Melody4U wish.`,
      hashtags: ['#Melody4U', '#GiftIdea', `#${slugify(event.category).replace(/-/g, '') || 'Event'}`, '#SocialPost', '#MusicGift'],
      slug: slugify(event.title)
    }))
  };
}

function normalizePromptResponse(parsed, week) {
  if (Array.isArray(parsed)) {
    return { week, created_at: new Date().toISOString(), items: parsed };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Prompt JSON must be an object or an array that can be normalized.');
  }

  if (Array.isArray(parsed.items)) {
    return { ...parsed, week: parsed.week || week, created_at: parsed.created_at || new Date().toISOString() };
  }

  for (const key of ['prompts', 'events', 'results']) {
    if (Array.isArray(parsed[key])) {
      return {
        week: parsed.week || week,
        created_at: parsed.created_at || new Date().toISOString(),
        items: parsed[key]
      };
    }
  }

  throw new Error('Prompt JSON must include an items array, or a normalizable prompts/events/results array.');
}

function normalizeHashtags(hashtags) {
  const normalized = Array.isArray(hashtags)
    ? hashtags.filter((hashtag) => typeof hashtag === 'string' && hashtag.trim()).map((hashtag) => hashtag.trim())
    : [];

  for (const hashtag of FALLBACK_HASHTAGS) {
    if (normalized.length >= 5) break;
    if (!normalized.includes(hashtag)) normalized.push(hashtag);
  }

  return normalized.slice(0, 5);
}

function validatePrompts(data, week) {
  const normalized = normalizePromptResponse(data, week);
  normalized.items = normalized.items.map((item, index) => {
    const eventTitle = item.event_title || item.title;
    const promptItem = {
      event_title: eventTitle,
      date: item.date,
      category: item.category,
      text_on_image: item.text_on_image,
      image_prompt: item.image_prompt || item.prompt,
      reels_text: item.reels_text,
      hashtags: normalizeHashtags(item.hashtags),
      slug: item.slug || slugify(eventTitle)
    };

    for (const key of ['event_title', 'date', 'category', 'text_on_image', 'image_prompt', 'reels_text', 'slug']) {
      if (!promptItem[key]) throw new Error(`Prompt item ${index} missing required field: ${key}`);
    }

    if (!Array.isArray(promptItem.hashtags) || promptItem.hashtags.length !== 5 || !promptItem.hashtags.every((hashtag) => typeof hashtag === 'string')) {
      throw new Error(`Prompt item ${index} must include exactly 5 string hashtags.`);
    }

    return promptItem;
  });

  return normalized;
}

async function main() {
  await logger.info('Generate image prompts started');
  let rawResponseText = '';

  try {
    const target = resolveTargetWeek();
    const inputFile = `data/weekly/${target.week}.json`;
    await logger.info(`Reading weekly overview: ${inputFile}`);
    const overview = await readJsonFile(inputFile);
    const events = overview.events.filter((event) => event.generate_image === true && event.status === 'waiting');
    await logger.info(`Found ${events.length} waiting events with generate_image=true for ${target.week}`);
    const style = await readTextFile('prompts/melody4u_style.txt');
    const system = await readTextFile('prompts/image_prompt_system.txt');
    let prompts;

    if (events.length === 0) {
      prompts = { week: target.week, created_at: new Date().toISOString(), items: [] };
      await logger.info('No waiting image events found; writing empty prompts array.');
    } else if (!process.env.OPENAI_API_KEY) {
      await logger.warn('OPENAI_API_KEY is missing; using deterministic local fallback image prompts for testing.');
      prompts = fallbackPrompts(target.week, events);
    } else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
        temperature: 0.2,
        input: [
          { role: 'system', content: `${system}\n\n${style}` },
          { role: 'user', content: JSON.stringify({ week: target.week, events }, null, 2) }
        ]
      });
      rawResponseText = response.output_text ?? '';
      await logger.info(`Raw OpenAI prompt response preview: ${previewText(rawResponseText, 500)}`);
      prompts = validatePrompts(extractJson(rawResponseText), target.week);
    }

    prompts = validatePrompts(prompts, target.week);
    const out = `output/${target.week}/prompts.json`;
    await writeJsonFile(out, prompts);
    await logger.info(`Created image prompts: ${out}`);
    await logger.info('Generate image prompts finished successfully');
  } catch (error) {
    if (rawResponseText) await logger.error(`Raw OpenAI prompt response first 1000 chars: ${previewText(rawResponseText, 1000)}`);
    await logger.error(`Generate image prompts failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
