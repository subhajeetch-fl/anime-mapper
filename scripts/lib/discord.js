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
 */

const COLOR_ERROR = 0xed4245; // Discord "red"
const COLOR_WARN = 0xfaa61a; // Discord "orange"
const MAX_EMBED_FIELDS = 25; // Discord hard limit per embed
const MAX_FIELD_VALUE = 1000; // keep under Discord's 1024 char field limit

function truncate(str, max) {
  if (!str) return '(no message)';
  return str.length > max ? `${str.slice(0, max - 3)}...` : str;
}

/**
 * @param {Array<{id: string|number, source: string, message: string, status?: number}>} errors
 * @param {object} context
 * @param {string} context.runLabel - e.g. "update-airing" or "add-new-anime"
 * @param {number} [context.totalProcessed]
 */
export async function reportErrorsToDiscord(errors, context = {}) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn(
      '[discord] DISCORD_WEBHOOK_URL not set - skipping Discord report. ' +
        'Errors were still written to the local error log / retry queue.'
    );
    return;
  }

  if (!errors || errors.length === 0) {
    return;
  }

  const runUrl =
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const bySource = errors.reduce((acc, e) => {
    acc[e.source] = (acc[e.source] || 0) + 1;
    return acc;
  }, {});

  const summaryFields = Object.entries(bySource)
    .slice(0, MAX_EMBED_FIELDS - 2)
    .map(([source, count]) => ({
      name: source,
      value: `${count} failure${count === 1 ? '' : 's'}`,
      inline: true,
    }));

  const sampleLines = errors
    .slice(0, 8)
    .map((e) => `\`${e.id}\` (${e.source}${e.status ? ` ${e.status}` : ''}): ${truncate(e.message, 150)}`)
    .join('\n');

  const embed = {
    title: `Anime pipeline: ${errors.length} error${errors.length === 1 ? '' : 's'} during "${context.runLabel || 'run'}"`,
    description: truncate(
      `${sampleLines}${errors.length > 8 ? `\n...and ${errors.length - 8} more (see attached log).` : ''}`,
      MAX_FIELD_VALUE * 2
    ),
    color: errors.length >= 10 ? COLOR_ERROR : COLOR_WARN,
    timestamp: new Date().toISOString(),
    fields: summaryFields,
    footer: {
      text: context.totalProcessed
        ? `${errors.length}/${context.totalProcessed} anime failed - they have been queued for retry next run`
        : 'Failed items have been queued for retry next run',
    },
    url: runUrl || undefined,
  };

  const fullLog = JSON.stringify(
    {
      runLabel: context.runLabel,
      runUrl,
      generatedAt: new Date().toISOString(),
      errorCount: errors.length,
      errors,
    },
    null,
    2
  );

  // Send as multipart so we can attach the full JSON log alongside the embed.
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      username: 'Anime Pipeline',
      embeds: [embed],
    })
  );
  form.append('files[0]', new Blob([fullLog], { type: 'application/json' }), 'error-log.json');

  try {
    const res = await fetch(webhookUrl, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[discord] webhook responded ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    // Never let a Discord delivery failure break the pipeline run.
    console.error(`[discord] failed to deliver report: ${err.message}`);
  }
}
