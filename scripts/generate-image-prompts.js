import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readJsonFile, readTextFile, writeJsonFile } from './utils/fs.js';
import { slugify } from './utils/slug.js';
import { logger } from './utils/logger.js';

const FALLBACK_HASHTAGS = ['#Melody4U', '#MusicGift', '#PersonalWish', '#GiftIdea', '#ForTheFans', '#GameNight', '#RaceWeekend', '#FamilyMoment', '#SocialPost'];
const ALLOWED_COMPOSITION_TYPES = ['fan_with_phone', 'family_at_home', 'stadium_atmosphere', 'closeup_phone_gift', 'city_event_mood', 'motorsport_track', 'child_or_family_moment', 'seasonal_symbolic_scene'];

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

function chooseCompositionType(event, index) {
  const category = String(event.category ?? '').toLowerCase();
  const angle = String(event.marketing_angle ?? '').toLowerCase();
  if (category.includes('motor') || category.includes('racing')) return 'motorsport_track';
  if (angle.includes('family') || angle.includes('watching')) return 'family_at_home';
  if (angle.includes('child') || category.includes('children')) return 'child_or_family_moment';
  if (category.includes('day') || angle.includes('celebration')) return 'closeup_phone_gift';
  if (category.includes('football') || category.includes('hockey') || category.includes('tennis')) return index % 2 === 0 ? 'stadium_atmosphere' : 'fan_with_phone';
  if (category.includes('cycling') || angle.includes('season')) return 'seasonal_symbolic_scene';
  return ALLOWED_COMPOSITION_TYPES[index % ALLOWED_COMPOSITION_TYPES.length];
}

function sanitizeTextOnImage(value, event = {}) {
  const title = String(value || event.title || event.event_title || 'Make the Moment Sing');
  const category = String(event.category ?? '').toLowerCase();
  const angle = String(event.marketing_angle ?? '').toLowerCase();
  const protectedPattern = /\b(formula\s*1|fifa|uefa|motogp|nhl|olympic|olympics|champions league|world cup|grand prix|wimbledon)\b/i;

  let safe = title.replace(/\s+/g, ' ').replace(/[\r\n]+/g, ' ').trim();
  if (category.includes('football') && /european|world|cup|league|championship/i.test(safe)) safe = 'Game Night Feeling';
  if (category.includes('cycling') && /summer|weekend/i.test(safe)) safe = 'Summer Sport Vibes';
  if (category.includes('day') && /family|celebration/i.test(safe)) safe = 'Family Moment';
  if (protectedPattern.test(safe)) {
    if (category.includes('motor') || /formula|grand prix|motogp/i.test(safe)) safe = 'Race Weekend Energy';
    else if (category.includes('football') || /fifa|uefa|world cup|champions league/i.test(safe)) safe = angle.includes('kickoff') ? 'A Wish Before Kickoff' : 'World Football Night';
    else if (category.includes('tennis') || /wimbledon/i.test(safe)) safe = 'Summer Sport Vibes';
    else if (/olympic/i.test(safe)) safe = 'For the Biggest Fan';
  }

  if (safe.length > 45) {
    if (category.includes('motor')) safe = 'Race Weekend Energy';
    else if (category.includes('football')) safe = 'Game Night Feeling';
    else if (angle.includes('fan')) safe = 'For the Biggest Fan';
    else if (angle.includes('family')) safe = 'Family Moment';
    else safe = 'Make the Moment Sing';
  }

  return safe.replace(/[^\x20-\x7E]/g, '').slice(0, 45).trim() || 'Make the Moment Sing';
}

function buildImagePrompt(event, compositionType) {
  const compositionDescriptions = {
    fan_with_phone: 'a joyful fan holding a smartphone in the foreground, soft arena lights in the distance, warm cinematic depth of field',
    family_at_home: 'a family gathered on a cozy sofa at home, a smartphone showing a personal music gift, warm lamp light and soft celebration mood',
    stadium_atmosphere: 'a symbolic stadium atmosphere with blurred crowd silhouettes, dramatic lights, no identifiable teams, and a smartphone in the lower foreground',
    closeup_phone_gift: 'a close-up of hands presenting a smartphone like a gift, glowing music notes and gentle sound waves around it',
    city_event_mood: 'a warm evening city scene with people celebrating together, a smartphone visible, posters and lights kept generic',
    motorsport_track: 'a symbolic racing track scene with generic cars as motion streaks, a fan smartphone in view, warm sunset lighting and no official branding',
    child_or_family_moment: 'a tender child or family celebration moment with a smartphone greeting, glowing notes, and soft playful colors',
    seasonal_symbolic_scene: 'a seasonal symbolic outdoor scene with warm light, a smartphone gift moment, subtle music notes, and emotional social poster energy'
  };

  return `Create a vertical 9:16 cinematic Melody4U social media poster using composition_type ${compositionType}: ${compositionDescriptions[compositionType]}. Theme: ${event.title}. Marketing angle: ${event.marketing_angle || 'personal music gift'}. Add subtle glowing music notes, gentle sound waves, a personal greeting and gift feeling, clean composition, strong central subject, modern warm atmosphere, and English poster text. Explicit restrictions: no official logos, no official badges, no trademarked visual identity, no real athlete or celebrity faces, no copyrighted mascots, no team badges. For protected sports or events, use symbolic generic visuals instead of exact official identity.`;
}

function fallbackPrompts(week, events) {
  return {
    week,
    created_at: new Date().toISOString(),
    items: events.map((event, index) => {
      const compositionType = chooseCompositionType(event, index);
      const textOnImage = sanitizeTextOnImage(event.title, event);
      return {
        event_title: event.title,
        date: event.date,
        category: event.category,
        text_on_image: textOnImage,
        image_prompt: buildImagePrompt(event, compositionType),
        reels_text: `${textOnImage} — turn the moment into a personal Melody4U music wish.`,
        hashtags: normalizeHashtags(['#Melody4U', '#MusicGift', '#GiftIdea', compositionType === 'motorsport_track' ? '#RaceWeekend' : '#ForTheFans', compositionType === 'family_at_home' ? '#FamilyMoment' : '#PersonalWish']),
        slug: slugify(event.title),
        composition_type: compositionType
      };
    })
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
    return { ...parsed, week, created_at: new Date().toISOString() };
  }

  for (const key of ['prompts', 'events', 'results']) {
    if (Array.isArray(parsed[key])) {
      return {
        week,
        created_at: new Date().toISOString(),
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

  if (!normalized.includes('#Melody4U')) normalized.unshift('#Melody4U');

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
    const eventForSanitizing = { title: eventTitle, category: item.category, marketing_angle: item.marketing_angle };
    const compositionType = ALLOWED_COMPOSITION_TYPES.includes(item.composition_type) ? item.composition_type : chooseCompositionType(item, index);
    const promptItem = {
      event_title: eventTitle,
      date: item.date,
      category: item.category,
      text_on_image: sanitizeTextOnImage(item.text_on_image, eventForSanitizing),
      image_prompt: item.image_prompt || item.prompt || buildImagePrompt(eventForSanitizing, compositionType),
      reels_text: item.reels_text,
      hashtags: normalizeHashtags(item.hashtags),
      slug: item.slug || slugify(eventTitle),
      composition_type: compositionType
    };

    if (!/no official logos/i.test(promptItem.image_prompt)) {
      promptItem.image_prompt += ' No official logos, no official badges, no trademarked visual identity, no real athlete or celebrity faces.';
    }

    for (const key of ['event_title', 'date', 'category', 'text_on_image', 'image_prompt', 'reels_text', 'slug', 'composition_type']) {
      if (!promptItem[key]) throw new Error(`Prompt item ${index} missing required field: ${key}`);
    }

    if (!Array.isArray(promptItem.hashtags) || promptItem.hashtags.length !== 5 || !promptItem.hashtags.every((hashtag) => typeof hashtag === 'string')) {
      throw new Error(`Prompt item ${index} must include exactly 5 string hashtags.`);
    }

    return promptItem;
  });

  if (normalized.items.length > 1 && new Set(normalized.items.map((item) => item.composition_type)).size === 1) {
    normalized.items = normalized.items.map((item, index) => ({
      ...item,
      composition_type: ALLOWED_COMPOSITION_TYPES[index % ALLOWED_COMPOSITION_TYPES.length]
    }));
  }

  normalized.week = week;
  normalized.created_at = new Date().toISOString();
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
    await logger.info(`Prompt count after validation: ${prompts.items.length}`);
    await logger.info(`Prompts created_at set by script: ${prompts.created_at}`);
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
