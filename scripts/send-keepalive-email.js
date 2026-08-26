// 临时脚本：发送华医网刷课保活/进度邮件（模板 A）
// 用法: node scripts/send-keepalive-email.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const envPath = path.join(__dirname, '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
const match = env.match(/^RESEND_API_KEY=(.+)$/m);
if (!match) { console.error('RESEND_API_KEY not found'); process.exit(1); }
const RESEND_API_KEY = match[1].trim();
// 收件人/发件人从 .env.local 读取（避免硬编码隐私）
const fromMatch = env.match(/^RESEND_FROM=(.+)$/m);
const toMatch = env.match(/^RESEND_TO=(.+)$/m);
const RESEND_FROM = fromMatch ? fromMatch[1].trim() : '';
const RESEND_TO = toMatch ? toMatch[1].trim() : '';
if (!RESEND_FROM || !RESEND_TO) { console.error('RESEND_FROM / RESEND_TO not found in .env.local'); process.exit(1); }

const subject = process.env.MAIL_SUBJECT || '华医网刷课邮件';
const body = process.env.MAIL_BODY || '';

const payload = JSON.stringify({
  from: RESEND_FROM,
  to: RESEND_TO.split(',').map(s => s.trim()),
  subject,
  text: body
});

const req = https.request({
  hostname: 'api.resend.com',
  path: '/emails',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${RESEND_API_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}`);
    console.log(data);
    if (res.statusCode >= 200 && res.statusCode < 300) process.exit(0);
    process.exit(2);
  });
});
req.on('error', (e) => { console.error('ERROR', e.message); process.exit(1); });
req.write(payload);
req.end();
