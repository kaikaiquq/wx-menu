// Optional local connectivity check. Never prints the key, headers, or response body.
// Usage: node scripts/check-ai-connection.cjs [path/to/private.env]
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const file = process.argv[2] || path.join(__dirname, '../cloudfunctions/.secrets/aiChatApi.env');
const config = {};
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^(OPENAI_API_KEY|OPENAI_MODEL)=(.*)$/);
    if (match) config[match[1]] = match[2].trim();
  }
}
const key = process.env.OPENAI_API_KEY || config.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || config.OPENAI_MODEL || 'gpt-5.6-luna';
if (!key) {
  console.error('OPENAI_API_KEY is not configured.');
  process.exit(1);
}
const payload = JSON.stringify({
  model, store: false, reasoning: { effort: 'none' }, max_output_tokens: 32,
  input: [{ role: 'user', content: 'Reply with OK.' }],
});
const request = https.request('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
}, (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) request.destroy(Object.assign(new Error(), { code: 'RESPONSE_TOO_LARGE' }));
  });
  response.on('end', () => {
    clearTimeout(deadline);
    let data;
    try { data = JSON.parse(body); } catch { data = {}; }
    const hasText = Array.isArray(data.output) && data.output.some(item =>
      Array.isArray(item.content) && item.content.some(part => part.type === 'output_text' && part.text?.trim()));
    const success = response.statusCode >= 200 && response.statusCode < 300 && hasText;
    const code = data.error?.code;
    console.log(JSON.stringify({
      success, httpStatus: response.statusCode, model, hasText,
      errorCode: typeof code === 'string' && /^[a-z_]{1,60}$/.test(code) ? code : undefined,
    }));
    if (!success) process.exitCode = 1;
  });
});
const deadline = setTimeout(() => request.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })), 30000);
request.on('error', (error) => {
  clearTimeout(deadline);
  console.error(JSON.stringify({ success: false, networkCode: /^[A-Z_0-9]{1,40}$/.test(error.code) ? error.code : 'NETWORK_ERROR' }));
  process.exitCode = 1;
});
request.end(payload);
