/**
 * Discord webhook error reporter.
 *
 * Design goals (per project spec):
 *  - Errors during a crawl should NOT stop the whole run. Each anime fetch
 *    failure is caught upstream and pushed into an `errors` array.
 *  - At the end of a run, this module sends ONE organized report to Discord
 *    (a summary embed + a full JSON log file attachment) instead of spamming
 *    the channel with one message per failure.
 *  - Failures are also written to retryQueue.json so the NEXT run retries
 *    them first ("even if error happens, it should still do it later").
 *
 * The webhook URL must come from process.env.DISCORD_WEBHOOK_URL.
 * Do NOT hardcode it in source or commit it to the repo - set it as a
 * GitHub Actions secret (Settings -> Secrets and variables -> Actions) and
 * pass it to the workflow step as an env var. Webhook URLs are bearer
 * credentials: anyone holding the URL can post to your channel.
 *
 * Discord limits reference:
 *  - content (plain text):     2 000 chars
 *  - embed title:                256 chars
 *  - embed description:        4 096 chars
 *  - embed field name:           256 chars
 *  - embed field value:        1 024 chars
 *  - embeds per message:          10
 *  - total chars across embeds: 6 000
 *  - file attachment:           25 MB (free servers)
 *
 * When the error list is too long for one embed description we split it into
 * multiple embeds (up to 10 per message) and send as many messages as needed.
 */

const COLOR_ERROR = 0xed4245; // Discord "red"
const COLOR_WARN  = 0xfaa61a; // Discord "orange"

// Hard Discord limits
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_VALUE_LIMIT  = 1024;
const EMBED_FIELD_NAME_LIMIT   =  256;
const EMBED_TITLE_LIMIT        =  256;
const EMBEDS_PER_MESSAGE       =   10;
const TOTAL_EMBED_CHARS        = 6000;

// How many error lines we attempt to fit per embed description.
// Each line is typically 60-200 chars; 20 lines ≈ safe upper bound.
const LINES_PER_EMBED = 20;

/**
 * Truncate a string to `max` chars, appending "…" if cut.
 * @param {string|null|undefined} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  if (!str) return '(no message)';
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

/**
 * Format one error into a single log line.
 * @param {{ id: string|number, source: string, message: string, status?: number }} e
 * @returns {string}
 */
function formatLine(e) {
  const status = e.status ? ` ${e.status}` : '';
  return `\`${e.id}\` (${e.source}${status}): ${truncate(e.message, 150)}`;
}

/**
 * Split an array into chunks of `size`.
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Build embed description from error lines, respecting Discord's 4096-char limit.
 * Returns the description string and how many lines were consumed.
 *
 * @param {string[]} lines       - pre-formatted error lines
 * @param {number}   startIndex  - index of first line to include
 * @param {number}   totalErrors - total error count (for "…and N more" suffix)
 * @returns {{ description: string, consumed: number }}
 */
function buildDescription(lines, startIndex, totalErrors) {
  const available = lines.slice(startIndex);
  const suffix    = (startIndex + available.length < totalErrors)
    ? `\n…and ${totalErrors - startIndex - available.length} more (see attached log).`
    : '';

  let description = '';
  let consumed    = 0;

  for (const line of available) {
    const candidate = description
      ? `${description}\n${line}`
      : line;

    const withSuffix = candidate + suffix;
    if (withSuffix.length > EMBED_DESCRIPTION_LIMIT) break;

    description = candidate;
    consumed++;
  }

  // If nothing fit at all (single line > limit), force-truncate it.
  if (consumed === 0 && available.length > 0) {
    description = truncate(available[0], EMBED_DESCRIPTION_LIMIT - suffix.length);
    consumed    = 1;
  }

  return { description: description + suffix, consumed };
}

/**
 * Send a single Discord webhook POST (multipart for the first message,
 * plain JSON for continuation messages).
 *
 * @param {string}      webhookUrl
 * @param {object[]}    embeds        - array of embed objects (max 10)
 * @param {string|null} [jsonLog]     - if provided, attach as error-log.json
 * @returns {Promise<void>}
 */
async function sendWebhookMessage(webhookUrl, embeds, jsonLog = null) {
  let body;
  let headers = {};

  const payload = {
    username: 'Anime Pipeline',
    embeds,
  };

  if (jsonLog) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append(
      'files[0]',
      new Blob([jsonLog], { type: 'application/json' }),
      'error-log.json'
    );
    body = form;
    // FormData sets its own Content-Type with boundary automatically
  } else {
    body    = JSON.stringify(payload);
    headers = { 'Content-Type': 'application/json' };
  }

  const res = await fetch(webhookUrl, { method: 'POST', body, headers });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[discord] webhook responded ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * Build all the embed objects needed to display every error line.
 *
 * Rules:
 *  - First embed gets the title, colour, footer, timestamp, and source-breakdown fields.
 *  - Additional embeds just carry overflow description lines (same colour, no fields).
 *  - Each embed description respects the 4096-char limit.
 *  - Total embeds per message capped at 10 (Discord hard limit).
 *
 * Returns an array-of-arrays: each inner array is one message's worth of embeds.
 *
 * @param {string[]} lines       - pre-formatted error lines
 * @param {number}   totalErrors
 * @param {object}   context
 * @param {string}   runUrl      - nullable
 * @param {object[]} sourceFields - embed fields for the source breakdown
 * @returns {object[][]}
 */
function buildEmbedBatches(lines, totalErrors, context, runUrl, sourceFields) {
  const color      = totalErrors >= 10 ? COLOR_ERROR : COLOR_WARN;
  const titleText  = truncate(
    `Anime pipeline: ${totalErrors} error${totalErrors === 1 ? '' : 's'} during "${context.runLabel || 'run'}"`,
    EMBED_TITLE_LIMIT
  );
  const footerText = context.totalProcessed
    ? `${totalErrors}/${context.totalProcessed} anime failed — queued for retry next run`
    : 'Failed items have been queued for retry next run';

  const allEmbeds  = [];
  let   lineIndex  = 0;
  let   isFirst    = true;

  while (lineIndex < lines.length || isFirst) {
    const { description, consumed } = buildDescription(lines, lineIndex, totalErrors);
    lineIndex += consumed;

    if (isFirst) {
      allEmbeds.push({
        title:       titleText,
        description,
        color,
        timestamp:   new Date().toISOString(),
        fields:      sourceFields,
        footer:      { text: footerText },
        url:         runUrl || undefined,
      });
      isFirst = false;
    } else {
      allEmbeds.push({ description, color });
    }

    // Safety: if consumed === 0 somehow (empty lines array), break to avoid infinite loop.
    if (consumed === 0) break;
  }

  // Group embeds into batches of EMBEDS_PER_MESSAGE, also respecting the
  // 6000-char total-per-message limit.
  const batches = [];
  let   current = [];
  let   currentChars = 0;

  for (const embed of allEmbeds) {
    const embedChars =
      (embed.title       || '').length +
      (embed.description || '').length +
      (embed.footer?.text || '').length +
      (embed.fields || []).reduce(
        (sum, f) => sum + (f.name || '').length + (f.value || '').length,
        0
      );

    const wouldExceedCount = current.length >= EMBEDS_PER_MESSAGE;
    const wouldExceedChars = currentChars + embedChars > TOTAL_EMBED_CHARS;

    if ((wouldExceedCount || wouldExceedChars) && current.length > 0) {
      batches.push(current);
      current      = [];
      currentChars = 0;
    }

    current.push(embed);
    currentChars += embedChars;
  }

  if (current.length > 0) batches.push(current);

  return batches;
}

/**
 * Sleep for `ms` milliseconds (used to avoid Discord rate-limits between
 * consecutive webhook messages).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Report pipeline errors to Discord.
 *
 * @param {Array<{ id: string|number, source: string, message: string, status?: number }>} errors
 * @param {{ runLabel?: string, totalProcessed?: number }} [context]
 * @returns {Promise<void>}
 */
export async function reportErrorsToDiscord(errors, context = {}) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn(
      '[discord] DISCORD_WEBHOOK_URL not set — skipping Discord report. ' +
      'Errors were still written to the local error log / retry queue.'
    );
    return;
  }

  if (!errors || errors.length === 0) return;

  const runUrl =
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  // --- Source breakdown fields (shown in first embed) ---
  const bySource = errors.reduce((acc, e) => {
    acc[e.source] = (acc[e.source] || 0) + 1;
    return acc;
  }, {});

  // Reserve 2 slots for potential "…and N more" overflow; cap the rest.
  const MAX_SOURCE_FIELDS = EMBEDS_PER_MESSAGE - 2;
  const sourceFields = Object.entries(bySource)
    .slice(0, MAX_SOURCE_FIELDS)
    .map(([source, count]) => ({
      name:   truncate(source, EMBED_FIELD_NAME_LIMIT),
      value:  truncate(`${count} failure${count === 1 ? '' : 's'}`, EMBED_FIELD_VALUE_LIMIT),
      inline: true,
    }));

  // --- Format every error as a line ---
  const lines = errors.map(formatLine);

  // --- Build embed batches ---
  const batches = buildEmbedBatches(
    lines,
    errors.length,
    context,
    runUrl,
    sourceFields
  );

  // --- Full JSON log (attached to the FIRST message only) ---
  const fullLog = JSON.stringify(
    {
      runLabel:    context.runLabel,
      runUrl,
      generatedAt: new Date().toISOString(),
      errorCount:  errors.length,
      errors,
    },
    null,
    2
  );

  // --- Send all batches ---
  try {
    for (let i = 0; i < batches.length; i++) {
      // Attach the JSON log only to the first message.
      const log = i === 0 ? fullLog : null;

      await sendWebhookMessage(webhookUrl, batches[i], log);

      // Avoid Discord rate-limit (5 messages per 2 s per webhook).
      // 500 ms gap is conservative but safe.
      if (i < batches.length - 1) {
        await sleep(500);
      }
    }
  } catch (err) {
    // Never let a Discord delivery failure break the pipeline run.
    console.error(`[discord] failed to deliver report: ${err.message}`);
  }
}