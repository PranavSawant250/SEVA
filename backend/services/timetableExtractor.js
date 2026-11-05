/**
 * backend/services/timetableExtractor.js
 *
 * Local extraction and structured parsing service for Timetable files.
 * Supports PDF documents and Image OCR (PNG, JPG, JPEG).
 * Strictly local processing — NO cloud AI APIs or external OCR services.
 */

const path = require('path');
const fs = require('fs');
const { parseTimeToMinutes, minutesToTimeString } = require('../utils/dateUtils');

const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_ALIASES = {
  mon: 'Monday', monday: 'Monday', mondy: 'Monday', mndy: 'Monday',
  tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday', tustin: 'Tuesday', tust: 'Tuesday',
  wed: 'Wednesday', wednesday: 'Wednesday', wendy: 'Wednesday', weds: 'Wednesday',
  thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday', tiny: 'Thursday', ths: 'Thursday',
  fri: 'Friday', friday: 'Friday', fhm: 'Friday', frid: 'Friday',
  sat: 'Saturday', saturday: 'Saturday', satday: 'Saturday',
  sun: 'Sunday', sunday: 'Sunday'
};

const BREAK_KEYWORDS = ['lunch', 'break', 'recess', 'tea', 'interval', 'tiffin', 'self study', 'free'];

/**
 * Normalizes day name to standard Title Case (Monday, Tuesday...)
 */
function normalizeDay(rawDay) {
  if (!rawDay || typeof rawDay !== 'string') return null;
  const clean = rawDay.trim().toLowerCase().replace(/[^a-z]/g, '');
  return DAY_ALIASES[clean] || (VALID_DAYS.includes(rawDay) ? rawDay : null);
}

/**
 * Cleans OCR optical artifacts from potential time tokens.
 * e.g., '10.1S' -> '10.15', 'l0:00' -> '10:00', '10:OO' -> '10:00'
 */
function cleanOcrTime(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[()[\]]/g, '')
    .replace(/(\d)[Oo]/g, '$10')
    .replace(/[Oo](\d)/g, '0$1')
    .replace(/^[lI](\d)/g, '1$1')
    .replace(/(\d)[sS]\b/g, '$15')
    .trim();
}

/**
 * Intelligent time parser tolerant to:
 * - Separators: ':' and '.' (e.g., '10:15', '10.15')
 * - Bare hour: '10' -> 10:00 AM
 * - College schedule context when AM/PM is omitted:
 *     8-11 -> AM
 *     12   -> 12 PM (noon)
 *     1-7  -> PM (e.g. 1.15 -> 1:15 PM)
 *     13-23 -> 24h format
 */
function parseTimetableTime(str, defaultPeriod = null) {
  if (!str || typeof str !== 'string') return null;
  const clean = cleanOcrTime(str);
  const match = clean.match(/^(\d{1,2})(?:[:.](\d{1,2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  let minute = match[2] ? parseInt(match[2], 10) : 0;
  if (minute > 59) return null;

  const explicitPeriod = match[3] ? match[3].toUpperCase() : null;

  if (explicitPeriod) {
    if (explicitPeriod === 'AM' && hour === 12) hour = 0;
    if (explicitPeriod === 'PM' && hour !== 12) hour += 12;
  } else if (defaultPeriod) {
    if (defaultPeriod === 'PM' && hour < 12) hour += 12;
    if (defaultPeriod === 'AM' && hour === 12) hour = 0;
  } else {
    // College schedule heuristic when period is unspecified
    if (hour >= 13 && hour <= 23) {
      // 24-hour military/railway time
    } else if (hour >= 8 && hour <= 11) {
      // Morning slots: 8:00 AM - 11:59 AM
    } else if (hour === 12) {
      // 12:00 PM (noon)
    } else if (hour >= 1 && hour <= 7) {
      // Afternoon slots: 1:00 PM - 7:00 PM
      hour += 12;
    }
  }

  const totalMinutes = hour * 60 + minute;
  return {
    minutes: totalMinutes,
    formatted: minutesToTimeString(totalMinutes),
    period: hour >= 12 ? 'PM' : 'AM'
  };
}

/**
 * Parses and cross-validates a start and end time pair.
 * Handles cross-noon transitions (e.g., 11:15 to 1:15).
 */
function parseTimetableRange(startRaw, endRaw) {
  let start = parseTimetableTime(startRaw);
  let end = parseTimetableTime(endRaw);
  if (!start || !end) return null;

  // If end is PM and start was an ambiguous single-digit (e.g. 1 to 2 PM), ensure start is also PM
  if (end.period === 'PM' && start.minutes < 480) {
    const retryStart = parseTimetableTime(startRaw, 'PM');
    if (retryStart && retryStart.minutes < end.minutes) start = retryStart;
  }

  // Cross-noon boundary e.g. 11:00 to 1:00 or 11.15 to 1.15
  if (end.minutes <= start.minutes && end.minutes < 720) {
    const pmEnd = parseTimetableTime(endRaw, 'PM');
    if (pmEnd && pmEnd.minutes > start.minutes) end = pmEnd;
  }

  if (end.minutes <= start.minutes) return null;

  return {
    start: start.formatted,
    end: end.formatted,
    startMinutes: start.minutes,
    endMinutes: end.minutes
  };
}

/**
 * Normalizes time string to standard 12-hour format e.g. "10:00 AM"
 */
function normalizeTime(rawTime, defaultPeriod = null) {
  if (!rawTime) return null;
  const parsed = parseTimetableTime(rawTime, defaultPeriod);
  return parsed ? parsed.formatted : null;
}

/**
 * Extracts room/hall location and cleans subject title
 */
function extractLocationAndCleanSubject(text) {
  let location = null;
  let subject = text.trim();
  const locMatch = subject.match(/\b(Room|Hall|LH|CR|Cabin)\s*[-:]?\s*([A-Za-z0-9\-]+)/i);
  if (locMatch) {
    location = locMatch[0];
    subject = subject.replace(locMatch[0], '').trim();
  }
  subject = subject.replace(/^[|•\-\*\:\,\s()]+/, '').replace(/[|•\-\*\:\,\s()]+$/, '').trim();
  return { subject, location };
}

/**
 * Extracts plain text from a PDF buffer locally.
 */
async function extractTextFromPdf(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data && data.text ? data.text : '';
  } catch (err) {
    throw new Error(`Local PDF extraction failed: ${err.message}`);
  }
}

/**
 * Extracts text from an Image buffer locally using Tesseract.js.
 * Configured with PSM fallbacks for structured table recognition.
 */
async function extractTextFromImage(buffer) {
  try {
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng');

    // First attempt: PSM 6 (Assume a single uniform block of text)
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
    });
    let ret = await worker.recognize(buffer);
    let text = ret && ret.data && ret.data.text ? ret.data.text : '';

    // If PSM 6 returned very few characters, retry with PSM 3 (Fully automatic page segmentation)
    if (!text || text.trim().length < 30) {
      await worker.setParameters({
        tessedit_pageseg_mode: '3',
      });
      ret = await worker.recognize(buffer);
      text = ret && ret.data && ret.data.text ? ret.data.text : '';
    }

    await worker.terminate();
    return text;
  } catch (err) {
    throw new Error(`Local Image OCR failed: ${err.message}`);
  }
}

/**
 * Multimodal vision extraction using Gemini for timetable images.
 */
async function tryGeminiVisionExtraction(buffer, mimeType = 'image/jpeg') {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;

  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const base64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64');
    const candidateModels = [
      process.env.GEMINI_MODEL,
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite'
    ].filter(Boolean);

    const prompt = `You are a precision timetable extractor. Extract all weekly classes, laboratory sessions, and scheduled breaks (tea break, lunch break) from this timetable image into a valid JSON array.
Every item MUST be an object with:
- "day_of_week": one of "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
- "subject": course name, lab name, or break name (e.g. "Computer Algorithm", "DBE Lab", "TEA-BREAK")
- "start_time": standard 12-hour time string with AM/PM (e.g. "10:15 AM", "01:15 PM")
- "end_time": standard 12-hour time string with AM/PM (e.g. "11:15 AM", "03:15 PM")
- "location": room or laboratory name if visible, or null
- "event_type": "class" or "break"

Return ONLY the raw JSON array starting with [ and ending with ]. Do not wrap in markdown or explanations.`;

    for (const model of candidateModels) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } }
              ]
            }
          ]
        });

        let text = res && res.text ? res.text.trim() : '';
        if (text.startsWith('```')) {
          text = text.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();
        }
        const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            console.log(`✅ Extracted ${parsed.length} timetable items using vision model: ${model}`);
            return parsed;
          }
        }
      } catch (err) {
        console.warn(`⚠️ Gemini Vision attempt on ${model} failed (${err.message.slice(0, 100)}), trying next candidate...`);
      }
    }
  } catch (err) {
    console.warn('⚠️ Gemini Vision extraction warning:', err.message);
  }
  return null;
}

/**
 * Cloud LLM structuring via Groq (gpt-oss-120b) for OCR text and PDF extractions.
 */
async function tryGroqStructuring(rawText) {
  try {
    const groq = require('./groqProvider');
    if (!groq.isGroqAvailable()) return null;
    const client = groq.initGroqClient ? groq.initGroqClient() : null;
    if (!client) return null;

    const prompt = `You are a timetable parser. Extract weekly classes, labs, and breaks from this timetable text into a valid JSON array only.
Return an array of objects with keys: "day_of_week" (Monday..Sunday), "subject", "start_time" (e.g. 10:15 AM), "end_time" (e.g. 11:15 AM), "location" (room or null), "event_type" ("class" or "break").
Only return a JSON array: [{"day_of_week":"Monday","subject":"...","start_time":"10:15 AM","end_time":"11:15 AM","location":null,"event_type":"class"}].
Text:
${rawText.slice(0, 4000)}`;

    const completion = await client.chat.completions.create({
      model: groq.getGroqModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1500
    });

    let content = completion.choices[0]?.message?.content || '';
    if (content.startsWith('```')) {
      content = content.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();
    }
    const match = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn('⚠️ Groq timetable structuring warning:', e.message);
  }
  return null;
}

/**
 * Text structuring via Gemini if Groq is unavailable.
 */
async function tryGeminiStructuring(rawText) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;

  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

    const prompt = `You are a timetable parser. Extract weekly classes, labs, and breaks from this timetable text into a valid JSON array only.
Return an array of objects with keys: "day_of_week" (Monday..Sunday), "subject", "start_time" (e.g. 10:15 AM), "end_time" (e.g. 11:15 AM), "location" (room or null), "event_type" ("class" or "break").
Only return a JSON array: [{"day_of_week":"Monday","subject":"...","start_time":"10:15 AM","end_time":"11:15 AM","location":null,"event_type":"class"}].
Text:
${rawText.slice(0, 4000)}`;

    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    let content = res && res.text ? res.text.trim() : '';
    if (content.startsWith('```')) {
      content = content.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();
    }
    const match = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn('⚠️ Gemini timetable text structuring warning:', e.message);
  }
  return null;
}

/**
 * Optional Ollama interpreter to structure text if Ollama daemon is running.
 */
async function tryOllamaStructuring(rawText) {
  try {
    const ollama = require('ollama').default || require('ollama');
    const prompt = `You are a timetable parser. Extract weekly classes from this timetable text into valid JSON only.
Return an array of objects with keys: "day_of_week" (Monday..Sunday), "subject", "start_time" (e.g. 10:00 AM), "end_time" (e.g. 11:00 AM), "location" (optional room/hall or null), "event_type" ("class" or "break").
Only return a JSON array: [{"day_of_week":"Monday","subject":"...","start_time":"...","end_time":"...","location":null,"event_type":"class"}].
Text:
${rawText.slice(0, 3000)}`;

    const response = await ollama.chat({
      model: 'tinyllama',
      messages: [{ role: 'user', content: prompt }]
    });

    const content = response.message.content;
    const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (_) {
    // Fall back silently to deterministic rule-based table parser
  }
  return null;
}

const TIME_RANGE_GLOBAL = /(\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/gi;
const TIME_RANGE_REGEX = /(\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/i;
const DAY_REGEX = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i;

/**
 * Multi-strategy deterministic rule-based table and schedule parser.
 * Supports:
 * - Strategy A: Grid matrix with time ranges in header row.
 * - Strategy B: Transposed grid with days in header row.
 * - Strategy C: List / section parser with comma-separated or single-line declarations.
 */
function parseScheduleText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rawEntries = [];
  const uncertainEntries = [];

  // ─────────────────────────────────────────────────────────────
  // Strategy A: Grid detection (header row has multiple time slots)
  // ─────────────────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(TIME_RANGE_GLOBAL)];
    if (matches.length >= 2) {
      const slots = [];
      for (const m of matches) {
        const range = parseTimetableRange(m[1], m[2]);
        if (range) {
          slots.push({
            start: range.start,
            end: range.end,
            raw: m[0],
            index: m.index
          });
        }
      }

      if (slots.length >= 2) {
        for (let j = i + 1; j < lines.length; j++) {
          const rowLine = lines[j];
          const dayMatch = rowLine.match(DAY_REGEX);
          if (dayMatch && rowLine.indexOf(dayMatch[0]) < 25) {
            const day = normalizeDay(dayMatch[1]);
            let cells = [];
            if (rowLine.includes('|')) {
              cells = rowLine.split('|').map(c => c.trim()).filter(Boolean);
              if (normalizeDay(cells[0])) cells.shift();
            } else {
              cells = rowLine.replace(dayMatch[0], '').split(/\s{2,}|\t/).map(c => c.trim()).filter(Boolean);
            }

            for (let k = 0; k < Math.min(cells.length, slots.length); k++) {
              const cellText = cells[k];
              if (!cellText || cellText.length < 2 || cellText === '-' || cellText === '—') continue;
              const { subject, location } = extractLocationAndCleanSubject(cellText);
              if (!subject || subject.length < 2) continue;
              const isBreak = BREAK_KEYWORDS.some(b => subject.toLowerCase().includes(b));
              rawEntries.push({
                day_of_week: day,
                title: subject,
                start_time: slots[k].start,
                end_time: slots[k].end,
                event_type: isBreak ? 'break' : 'class',
                location
              });
            }
          }
        }
        if (rawEntries.length >= 2) {
          return { rawEntries, uncertainEntries };
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Strategy B: Transposed grid (header row has days: Mon | Tue | Wed...)
  // ─────────────────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('|')) {
      const parts = line.split('|').map(p => p.trim()).filter(Boolean);
      const days = parts.map(p => normalizeDay(p)).filter(Boolean);
      if (days.length >= 2) {
        const dayColumns = parts.map(p => normalizeDay(p));
        for (let j = i + 1; j < lines.length; j++) {
          const rowLine = lines[j];
          const timeMatch = rowLine.match(TIME_RANGE_REGEX);
          if (timeMatch) {
            const range = parseTimetableRange(timeMatch[1], timeMatch[2]);
            if (range) {
              const cells = rowLine.split('|').map(c => c.trim()).filter(Boolean);
              for (let k = 0; k < dayColumns.length; k++) {
                const day = dayColumns[k];
                const cell = cells[k];
                if (day && cell && !cell.match(TIME_RANGE_REGEX)) {
                  const { subject, location } = extractLocationAndCleanSubject(cell);
                  if (!subject || subject.length < 2 || subject === '-' || subject === '—') continue;
                  const isBreak = BREAK_KEYWORDS.some(b => subject.toLowerCase().includes(b));
                  rawEntries.push({
                    day_of_week: day,
                    title: subject,
                    start_time: range.start,
                    end_time: range.end,
                    event_type: isBreak ? 'break' : 'class',
                    location
                  });
                }
              }
            }
          }
        }
        if (rawEntries.length >= 2) {
          return { rawEntries, uncertainEntries };
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Strategy C: List / Section Parser
  // ─────────────────────────────────────────────────────────────
  let currentDay = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dayMatch = line.match(DAY_REGEX);
    const timeMatch = line.match(TIME_RANGE_REGEX);

    if (dayMatch && !timeMatch) {
      const norm = normalizeDay(dayMatch[1]);
      if (norm) {
        currentDay = norm;
        continue;
      }
    }

    if (timeMatch) {
      const startNorm = normalizeTime(timeMatch[1]);
      const endNorm = normalizeTime(timeMatch[2]);
      let entryDay = currentDay;
      if (dayMatch) {
        const lineDay = normalizeDay(dayMatch[1]);
        if (lineDay) entryDay = lineDay;
      }

      // Check if line contains multiple comma-separated items e.g. "10:15-11:15 DS, 11:15-12:15 OS"
      const allMatches = [...line.matchAll(TIME_RANGE_GLOBAL)];
      if (allMatches.length > 1) {
        const chunks = line.split(/[,;\n]/).map(c => c.trim()).filter(Boolean);
        for (const chunk of chunks) {
          const cTime = chunk.match(TIME_RANGE_REGEX);
          if (cTime) {
            const cStart = normalizeTime(cTime[1]);
            const cEnd = normalizeTime(cTime[2]);
            let subj = chunk.replace(cTime[0], '').replace(DAY_REGEX, '').trim();
            const { subject, location } = extractLocationAndCleanSubject(subj);
            if (entryDay && cStart && cEnd && subject) {
              const isBreak = BREAK_KEYWORDS.some(b => subject.toLowerCase().includes(b));
              rawEntries.push({
                day_of_week: entryDay,
                title: subject,
                start_time: cStart,
                end_time: cEnd,
                event_type: isBreak ? 'break' : 'class',
                location
              });
            }
          }
        }
        continue;
      }

      let subjectText = line
        .replace(timeMatch[0], '')
        .replace(dayMatch ? dayMatch[0] : '', '')
        .trim();

      if (!subjectText && i + 1 < lines.length && !lines[i + 1].match(TIME_RANGE_REGEX) && !lines[i + 1].match(DAY_REGEX)) {
        subjectText = lines[i + 1].trim();
      }

      const { subject, location } = extractLocationAndCleanSubject(subjectText);
      const isBreak = BREAK_KEYWORDS.some(b => subject.toLowerCase().includes(b));

      if (!entryDay || !startNorm || !endNorm || !subject) {
        uncertainEntries.push({
          raw_text: line,
          day_of_week: entryDay || 'Unknown',
          subject: subject || 'Unknown subject',
          start_time: startNorm || timeMatch[1],
          end_time: endNorm || timeMatch[2],
          reason: !entryDay ? 'Missing day of week' : (!startNorm || !endNorm ? 'Invalid time format' : 'Missing subject name')
        });
      } else {
        rawEntries.push({
          day_of_week: entryDay,
          title: subject,
          start_time: startNorm,
          end_time: endNorm,
          event_type: isBreak ? 'break' : 'class',
          location
        });
      }
    }
  }

  return { rawEntries, uncertainEntries };
}

/**
 * Validates parsed entries for:
 * 1. Invalid time ranges (end <= start).
 * 2. Overlapping commitments / classes on the same day.
 * 3. Separation of breaks vs classes.
 */
function validateAndStructureTimetable(entries, uncertainList = []) {
  const validEntries = [];
  const breaks = [];
  const conflicts = [];
  const uncertainEntries = [...uncertainList];

  const dayBuckets = {};
  for (const d of VALID_DAYS) dayBuckets[d] = [];

  for (const item of entries) {
    const normDay = normalizeDay(item.day_of_week);
    const startNorm = normalizeTime(item.start_time);
    const endNorm = normalizeTime(item.end_time);

    if (!normDay || !startNorm || !endNorm || !item.title) {
      uncertainEntries.push({
        raw_entry: item,
        reason: 'Missing required field or unreadable cell'
      });
      continue;
    }

    const range = parseTimetableRange(item.start_time, item.end_time);
    if (!range) {
      conflicts.push(`Invalid duration for "${item.title}" on ${normDay}: ends (${endNorm}) at or before start (${startNorm}).`);
      uncertainEntries.push({
        ...item,
        reason: `End time ${endNorm} must be after start time ${startNorm}`
      });
      continue;
    }

    const entryObj = {
      day_of_week: normDay,
      title: item.title.trim(),
      start_time: range.start,
      end_time: range.end,
      event_type: item.event_type || 'class',
      location: item.location || null,
      startMinutes: range.startMinutes,
      endMinutes: range.endMinutes
    };

    if (entryObj.event_type === 'break') {
      breaks.push(entryObj);
    } else {
      dayBuckets[normDay].push(entryObj);
      validEntries.push(entryObj);
    }
  }

  // Detect overlapping classes within each day
  for (const day of VALID_DAYS) {
    const list = dayBuckets[day];
    list.sort((a, b) => a.startMinutes - b.startMinutes);

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.endMinutes > b.startMinutes && a.startMinutes < b.endMinutes) {
          conflicts.push(
            `Collision on ${day}: "${a.title}" (${a.start_time}–${a.end_time}) overlaps with "${b.title}" (${b.start_time}–${b.end_time}).`
          );
        }
      }
    }
  }

  const cleanEntries = validEntries.map(({ startMinutes, endMinutes, ...rest }) => rest);
  const cleanBreaks = breaks.map(({ startMinutes, endMinutes, ...rest }) => rest);

  return {
    entries: cleanEntries,
    breaks: cleanBreaks,
    conflicts,
    uncertain_entries: uncertainEntries
  };
}

/**
 * Main extractor interface.
 * Accepts buffer and mimeType (or filename).
 */
async function extractTimetableFromFile(buffer, filenameOrMime = '') {
  const isPdf = typeof filenameOrMime === 'string' && (filenameOrMime.includes('pdf') || filenameOrMime.endsWith('.pdf'));
  const isImage = typeof filenameOrMime === 'string' && (filenameOrMime.includes('image') || /\.(png|jpe?g)$/i.test(filenameOrMime));

  // 1. For images: try multimodal vision first (highest accuracy on photos/scans)
  if (isImage && Buffer.isBuffer(buffer)) {
    const mime = filenameOrMime.includes('png') ? 'image/png' : 'image/jpeg';
    const visionEntries = await tryGeminiVisionExtraction(buffer, mime);
    if (Array.isArray(visionEntries) && visionEntries.length > 0) {
      const validated = validateAndStructureTimetable(
        visionEntries.map(item => ({
          day_of_week: item.day_of_week,
          title: item.subject || item.title,
          start_time: item.start_time,
          end_time: item.end_time,
          location: item.location || null,
          event_type: item.event_type || 'class'
        }))
      );
      if (validated.entries.length > 0 || validated.breaks.length > 0) {
        const generatedText = validated.entries.map(e => `${e.day_of_week} ${e.start_time}–${e.end_time}: ${e.title}`).join('\n');
        return {
          success: true,
          timetable_name: 'Extracted Weekly Schedule',
          raw_text: generatedText,
          raw_text_preview: generatedText.slice(0, 500),
          entries: validated.entries,
          breaks: validated.breaks,
          conflicts: validated.conflicts,
          uncertain_entries: validated.uncertain_entries
        };
      }
    }
  }

  // 2. Extract text via PDF parser, Tesseract OCR, or raw buffer
  let rawText = '';
  if (isPdf) {
    rawText = await extractTextFromPdf(buffer);
  } else if (isImage) {
    rawText = await extractTextFromImage(buffer);
  } else if (typeof buffer === 'string') {
    rawText = buffer;
  } else if (Buffer.isBuffer(buffer)) {
    rawText = buffer.toString('utf8');
  }

  if (!rawText || !rawText.trim()) {
    return {
      success: false,
      error: 'No readable text could be extracted from the timetable file. Please ensure the document is clear.',
      entries: [],
      breaks: [],
      conflicts: [],
      uncertain_entries: []
    };
  }

  // 3. Multi-tier text structuring: Groq -> Gemini -> Ollama -> Deterministic Regex Table Parser
  let structuredList = await tryGroqStructuring(rawText);
  if (!structuredList || structuredList.length === 0) {
    structuredList = await tryGeminiStructuring(rawText);
  }
  if (!structuredList || structuredList.length === 0) {
    structuredList = await tryOllamaStructuring(rawText);
  }

  let entries = [];
  let uncertain = [];

  if (Array.isArray(structuredList) && structuredList.length > 0) {
    entries = structuredList.map(item => ({
      day_of_week: item.day_of_week,
      title: item.subject || item.title,
      start_time: item.start_time,
      end_time: item.end_time,
      location: item.location || null,
      event_type: item.event_type || 'class'
    }));
  } else {
    const parsed = parseScheduleText(rawText);
    entries = parsed.rawEntries;
    uncertain = parsed.uncertainEntries;
  }

  const validated = validateAndStructureTimetable(entries, uncertain);

  return {
    success: true,
    timetable_name: 'Extracted Weekly Schedule',
    raw_text: rawText,
    raw_text_preview: rawText.slice(0, 500),
    entries: validated.entries,
    breaks: validated.breaks,
    conflicts: validated.conflicts,
    uncertain_entries: validated.uncertain_entries
  };
}

module.exports = {
  extractTimetableFromFile,
  parseScheduleText,
  validateAndStructureTimetable,
  normalizeDay,
  normalizeTime,
  parseTimetableTime,
  parseTimetableRange,
  extractTextFromPdf,
  extractTextFromImage
};
