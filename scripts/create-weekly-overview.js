import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readJsonFile, readTextFile, writeJsonFile } from './utils/fs.js';
import { logger } from './utils/logger.js';

const CZECH_RELEVANCE_WEIGHT = { high: 3, medium: 2, low: 1 };
const ALLOWED_TONES = ['fan_hype', 'celebration', 'respectful_memorial', 'awareness'];
const ALLOWED_EVENT_ORIGINS = ['international_significant_day', 'czech_significant_day', 'sport', 'motorsport', 'seasonal', 'other'];
const ALLOWED_LANGUAGE_POLICIES = ['english', 'czech', 'bilingual_cs_en'];
const SIGNIFICANT_DAYS_FILE = 'data/editorial/significant-days.json';
const CZECH_FIXTURES_FILE = 'data/editorial/czech-national-team-fixtures.json';
const PRIORITY_EVENTS_FILE = 'data/editorial/priority-events.json';
const MAX_SELECTED_EVENTS = 8;

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
    status: event.status || 'waiting',
    backup_only: Boolean(event.backup_only),
    tone,
    event_origin: eventOrigin,
    language_policy: languagePolicy,
    czech_relevance: czechRelevance,
    melody4u_score: melody4uScore,
    marketing_angle: event.marketing_angle || 'gift for a fan',
    why_selected: event.why_selected || 'Selected for Melody4U social media relevance.'
  };
}



function dateToYearMonthDay(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function canonicalText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasEquivalentEvent(events, candidate) {
  const candidateTitle = canonicalText(candidate.title);
  const aliases = [candidateTitle, ...(Array.isArray(candidate.aliases) ? candidate.aliases.map(canonicalText) : [])]
    .filter(Boolean);

  return events.some((event) => {
    const title = canonicalText(event.title);
    return aliases.some((alias) => title === alias || title.includes(alias) || alias.includes(title));
  });
}


function thirdSundayOfJune(year) {
  const date = new Date(Date.UTC(year, 5, 1));
  const daysUntilSunday = (7 - date.getUTCDay()) % 7;
  date.setUTCDate(1 + daysUntilSunday + 14);
  return dateToYearMonthDay(date);
}

function dateIsInTarget(date, target) {
  return date >= target.date_from && date <= target.date_to;
}

function isKnownOutOfWeekHoliday(event, target) {
  const text = canonicalText(`${event.title ?? ''} ${event.category ?? ''} ${event.note ?? ''}`);
  if (/father s day|fathers day|den otcu/.test(text)) {
    const year = Number(String(target.date_from).slice(0, 4));
    return !dateIsInTarget(thirdSundayOfJune(year), target);
  }
  return false;
}

async function calendarSignificantDaysForTarget(target) {
  const calendar = await readJsonFile(SIGNIFICANT_DAYS_FILE);
  const recurring = Array.isArray(calendar.recurring) ? calendar.recurring : [];
  const start = new Date(`${target.date_from}T00:00:00Z`);
  const end = new Date(`${target.date_to}T00:00:00Z`);
  const selected = [];

  for (let day = start; day <= end; day = addDays(day, 1)) {
    const isoDate = dateToYearMonthDay(day);
    const monthDay = isoDate.slice(5);
    for (const event of recurring.filter((item) => item.month_day === monthDay)) {
      const { aliases, month_day: monthDayValue, ...eventWithoutCalendarOnlyFields } = event;
      selected.push({ ...eventWithoutCalendarOnlyFields, date: isoDate, aliases, calendar_significant_day: true });
    }
  }

  return selected;
}


async function calendarCzechFixturesForTarget(target) {
  const calendar = await readJsonFile(CZECH_FIXTURES_FILE);
  const fixtures = Array.isArray(calendar.fixtures) ? calendar.fixtures : [];
  return fixtures
    .filter((event) => event.date >= target.date_from && event.date <= target.date_to)
    .map((event) => {
      const { aliases, sport, competition, ...eventWithoutCalendarOnlyFields } = event;
      return { ...eventWithoutCalendarOnlyFields, aliases, sport, competition, calendar_czech_fixture: true };
    });
}

async function mergeCalendarCzechFixtures(events, target) {
  const fixtureEvents = await calendarCzechFixturesForTarget(target);
  const merged = [...events];
  for (const event of fixtureEvents) {
    if (!hasEquivalentEvent(merged, event)) merged.push(event);
  }
  if (fixtureEvents.length > 0) {
    await logger.info(`Calendar Czech national-team fixture candidates for ${target.week}: ${fixtureEvents.map((event) => event.title).join(' | ')}`);
  }
  return merged;
}


async function calendarPriorityEventsForTarget(target) {
  const calendar = await readJsonFile(PRIORITY_EVENTS_FILE);
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  return events
    .filter((event) => event.date >= target.date_from && event.date <= target.date_to)
    .map((event) => {
      const { aliases, ...eventWithoutCalendarOnlyFields } = event;
      return { ...eventWithoutCalendarOnlyFields, aliases, calendar_priority_event: true };
    });
}

async function mergeCalendarPriorityEvents(events, target) {
  const priorityEvents = await calendarPriorityEventsForTarget(target);
  const merged = [...events];
  for (const event of priorityEvents) {
    if (!hasEquivalentEvent(merged, event)) merged.push(event);
  }
  if (priorityEvents.length > 0) {
    await logger.info(`Calendar priority-event candidates for ${target.week}: ${priorityEvents.map((event) => event.title).join(' | ')}`);
  }
  return merged;
}

async function mergeCalendarSignificantDays(events, target) {
  const calendarEvents = await calendarSignificantDaysForTarget(target);
  const merged = [...events];
  for (const event of calendarEvents) {
    if (!hasEquivalentEvent(merged, event)) merged.push(event);
  }
  if (calendarEvents.length > 0) {
    await logger.info(`Calendar significant-day candidates for ${target.week}: ${calendarEvents.map((event) => event.title).join(' | ')}`);
  }
  return merged;
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function eventText(event) {
  return `${event.title ?? ''} ${event.category ?? ''} ${event.note ?? ''}`.toLowerCase();
}

function eventHeadlineText(event) {
  return `${event.title ?? ''} ${event.category ?? ''}`.toLowerCase();
}

function isWorldTournamentEvent(event) {
  return includesAny(eventText(event), [/world cup/, /fifa/, /uefa euro/, /euro \d{4}/, /world championship/, /mistrovstv[íi] světa/, /mistrovstv[íi] evropy/]);
}

function isCzechTeamEvent(event) {
  return includesAny(eventText(event), [/czech republic/, /czechia/, /česko/, /česk[áy]\s+reprezentace/, /czech national/]);
}

function isFootballOrHockeyEvent(event) {
  return includesAny(eventText(event), [/football/, /soccer/, /fotbal/, /hockey/, /hokej/, /fifa/, /uefa/]);
}

function isSignificantDayEvent(event) {
  const origin = event.event_origin;
  return origin === 'international_significant_day' || origin === 'czech_significant_day' || includesAny(eventText(event), [/significant day/, /international day/, /memorial day/, /awareness day/, /významn[ýy] den/, /památn[ýy] den/]);
}

function isSeriousSignificantDay(event) {
  return isSignificantDayEvent(event) && (event.tone === 'respectful_memorial' || event.tone === 'awareness' || includesAny(eventText(event), [/victim/, /obět/, /communist/, /komunist/, /political prisoner/, /drug/, /trafficking/, /abuse/, /awareness/]));
}

function isFormulaOneEvent(event) {
  return includesAny(eventHeadlineText(event), [/formula 1/, /\bf1\b/, /grand prix/]);
}

function isMotoGpEvent(event) {
  return includesAny(eventHeadlineText(event), [/motogp/, /moto gp/, /motorcycle racing/]);
}

function combineCzechTournamentThemes(events) {
  const combined = [];
  const consumed = new Set();

  for (let index = 0; index < events.length; index += 1) {
    if (consumed.has(index)) continue;
    const event = events[index];
    if (!isWorldTournamentEvent(event) || !isFootballOrHockeyEvent(event) || isCzechTeamEvent(event)) {
      combined.push(event);
      continue;
    }

    const czechMatchIndex = events.findIndex((candidate, candidateIndex) => (
      candidateIndex !== index
      && !consumed.has(candidateIndex)
      && isCzechTeamEvent(candidate)
      && isFootballOrHockeyEvent(candidate)
      && String(candidate.date ?? '') >= String(event.date ?? '').slice(0, 10)
    ));

    if (czechMatchIndex === -1) {
      combined.push(event);
      continue;
    }

    const czechMatch = events[czechMatchIndex];
    consumed.add(index);
    consumed.add(czechMatchIndex);
    combined.push({
      ...event,
      date: czechMatch.date || event.date,
      title: `${event.title} + ${czechMatch.title}`,
      note: `${event.note || 'Major world tournament.'} Combined with Czech national team match: ${czechMatch.title}. ${czechMatch.note || ''}`.trim(),
      priority: Math.max(Number(event.priority) || 1, Number(czechMatch.priority) || 1, 5),
      source_priority: 1,
      generate_image: true,
      tone: 'fan_hype',
      event_origin: 'sport',
      language_policy: 'english',
      czech_relevance: 'high',
      melody4u_score: 5,
      marketing_angle: czechMatch.marketing_angle || event.marketing_angle || 'personal greeting before a big Czech national team match',
      why_selected: 'Major world tournament combined with a Czech national team match so the topic is not split into duplicate generic and Czech-match entries.'
    });
  }

  events.forEach((event, index) => {
    if (!consumed.has(index) && !combined.includes(event)) combined.push(event);
  });

  return combined;
}

function normalizeEditorialPriority(event) {
  const normalized = { ...event };
  if (isWorldTournamentEvent(normalized) && isCzechTeamEvent(normalized)) {
    normalized.source_priority = 1;
    normalized.priority = Math.max(Number(normalized.priority) || 1, 5);
    normalized.czech_relevance = 'high';
    normalized.melody4u_score = Math.max(Number(normalized.melody4u_score) || 1, 5);
  } else if (isSeriousSignificantDay(normalized)) {
    normalized.source_priority = Math.min(Number(normalized.source_priority) || 9, 2);
    normalized.priority = Math.max(Number(normalized.priority) || 1, 5);
    normalized.melody4u_score = Math.max(Number(normalized.melody4u_score) || 1, 5);
  } else if (isSignificantDayEvent(normalized)) {
    normalized.source_priority = Math.min(Number(normalized.source_priority) || 9, 6);
  } else if (isFormulaOneEvent(normalized)) {
    normalized.source_priority = Math.min(Number(normalized.source_priority) || 9, 3);
    normalized.melody4u_score = Math.max(Number(normalized.melody4u_score) || 1, 5);
  } else if (isMotoGpEvent(normalized)) {
    normalized.source_priority = Math.max(Number(normalized.source_priority) || 8, 8);
    normalized.backup_only = true;
    normalized.generate_image = false;
    normalized.status = 'backup';
  } else if (!normalized.calendar_priority_event && !normalized.calendar_significant_day && !normalized.calendar_czech_fixture) {
    normalized.source_priority = Math.max(Number(normalized.source_priority) || 9, 9);
  }
  return normalized;
}


function editorialTopicKey(event) {
  const text = canonicalText(`${event.title ?? ''} ${event.category ?? ''} ${event.note ?? ''}`);
  if (/world cup|fifa|mistrovstvi sveta/.test(text) && /czech|czechia|cesko|ceska/.test(text) && /mexico|mexiko/.test(text)) return 'czech-world-cup-mexico';
  if (/(formula 1|f1|grand prix|velka cena)/.test(text) && /(austrian|rakouska|spielberg)/.test(text)) return 'f1-austrian-grand-prix';
  if (/motogp/.test(text) && /(assen|netherlands|nizozemska|dutch tt)/.test(text)) return 'motogp-assen';
  if (/motogp/.test(text) && /(brno|ceske republiky|czech grand prix)/.test(text)) return 'motogp-brno';
  if (/(st john|midsummer|svatojan|jan)/.test(text) && /(day|mood|noc|midsummer)/.test(text)) return 'st-john-midsummer';
  if (/(summer solstice|letni slunovrat|zacatek leta)/.test(text)) return 'summer-solstice';
  return canonicalText(event.title);
}

function removeDuplicateEditorialEvents(events) {
  const selected = [];
  const selectedTopics = new Set();
  const hasCzechWorldTournament = events.some((event) => isWorldTournamentEvent(event) && isCzechTeamEvent(event));

  for (const event of events) {
    if (hasCzechWorldTournament && isWorldTournamentEvent(event) && !isCzechTeamEvent(event)) continue;
    const topicKey = editorialTopicKey(event);
    if (selectedTopics.has(topicKey)) continue;
    selected.push(event);
    selectedTopics.add(topicKey);
  }
  return selected;
}

function applyEditorialRules(events) {
  return removeDuplicateEditorialEvents(combineCzechTournamentThemes(events).map(normalizeEditorialPriority));
}


function applyBackupImagePolicy(events) {
  const primaryImageCount = events.filter((event) => event.generate_image === true && event.backup_only !== true).length;
  if (primaryImageCount >= 2) {
    for (const event of events) {
      if (event.backup_only === true) {
        event.generate_image = false;
        event.status = 'backup';
      }
    }
  }
  return events;
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
  const normalized = applyEditorialRules(events.filter((event) => !isKnownOutOfWeekHoliday(event, target))).map(normalizeEvent);
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
    .slice(0, MAX_SELECTED_EVENTS);

  const finalEvents = selected.length >= 5 ? selected : normalized
    .sort((a, b) => a.source_priority - b.source_priority || String(a.date).localeCompare(String(b.date)) || b.priority - a.priority || b.melody4u_score - a.melody4u_score || CZECH_RELEVANCE_WEIGHT[b.czech_relevance] - CZECH_RELEVANCE_WEIGHT[a.czech_relevance])
    .slice(0, MAX_SELECTED_EVENTS);

  applyBackupImagePolicy(finalEvents);
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
    events: await filterAndRankEvents(await mergeCalendarSignificantDays(await mergeCalendarPriorityEvents(await mergeCalendarCzechFixtures(data.events, target), target), target), target)
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
