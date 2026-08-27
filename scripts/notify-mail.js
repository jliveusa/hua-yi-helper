// 华医网刷课 · 邮件通知发送器（可选功能，未配置时优雅降级）
//
// 设计原则：邮件通知是【可选】的。凡是收件人、发件人、API Key 一律从
// scripts/.env.local 读取，代码里不硬编码任何邮箱地址或密钥。
// 未配置时不视为错误，而是返回专用退出码 3，由调用方（skill / 自动任务）
// 决定降级行为（例如改为写本地日志）。
//
// 用法:
//   node scripts/notify-mail.js --check          # 只自检配置，不发信
//   MAIL_SUBJECT="标题" MAIL_BODY="正文" node scripts/notify-mail.js
//
// 退出码:
//   0 = 发送成功（或 --check 且配置完整）
//   2 = 已配置但发送失败（网络/API 错误）
//   3 = 未配置邮件通知（缺 key/发件人/收件人）——非错误，调用方应降级
//   1 = 其它意外错误
//
// 所需 scripts/.env.local 配置项（三者缺一即视为未配置）:
//   RESEND_API_KEY=re_xxxxxxxx
//   RESEND_FROM=显示名 <发件地址>
//   RESEND_TO=收件地址（多个用英文逗号分隔）

const fs = require('fs');
const path = require('path');
const https = require('https');

const ENV_PATH = path.join(__dirname, '.env.local');
const CHECK_ONLY = process.argv.includes('--check');

/** 读取 .env.local 中的单个键；文件不存在或键缺失均返回 '' */
function readEnvKey(env, key) {
  const m = env.match(new RegExp('^' + key + '=(.+)$', 'm'));
  return m ? m[1].trim() : '';
}

let env = '';
try {
  env = fs.readFileSync(ENV_PATH, 'utf8');
} catch (e) {
  // 配置文件本身不存在 —— 同样属于"未配置"，不是错误
  console.log('MAIL_DISABLED');
  console.log('未找到配置文件: ' + ENV_PATH);
  console.log('邮件通知未启用。如需启用，请在该文件中添加 RESEND_API_KEY / RESEND_FROM / RESEND_TO 三项。');
  process.exit(3);
}

const RESEND_API_KEY = readEnvKey(env, 'RESEND_API_KEY');
const RESEND_FROM = readEnvKey(env, 'RESEND_FROM');
const RESEND_TO = readEnvKey(env, 'RESEND_TO');

const missing = [];
if (!RESEND_API_KEY) missing.push('RESEND_API_KEY');
if (!RESEND_FROM) missing.push('RESEND_FROM');
if (!RESEND_TO) missing.push('RESEND_TO');

if (missing.length) {
  console.log('MAIL_DISABLED');
  console.log('缺少配置项: ' + missing.join(', '));
  console.log('邮件通知未启用。补齐上述项写入 ' + ENV_PATH + ' 即可开启；不配置则仅记录本地日志。');
  process.exit(3);
}

// 配置完整：脱敏展示，便于确认配的是哪个地址而不泄露完整信息
function maskAddr(s) {
  return s.replace(/([^\s<@]{1,3})[^\s<@]*(@[^\s>]+)/g, (_, head, domain) => head + '***' + domain);
}

if (CHECK_ONLY) {
  console.log('MAIL_ENABLED');
  console.log('发件人: ' + maskAddr(RESEND_FROM));
  console.log('收件人: ' + maskAddr(RESEND_TO));
  process.exit(0);
}

const subject = process.env.MAIL_SUBJECT || '华医网刷课通知';
const body = process.env.MAIL_BODY || '';

const payload = JSON.stringify({
  from: RESEND_FROM,
  to: RESEND_TO.split(',').map((s) => s.trim()).filter(Boolean),
  subject,
  text: body,
});

const req = https.request(
  {
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('MAIL_SENT');
        console.log(`HTTP ${res.statusCode} → ${maskAddr(RESEND_TO)}`);
        process.exit(0);
      }
      console.error('MAIL_FAILED');
      console.error(`HTTP ${res.statusCode}: ${data}`);
      process.exit(2);
    });
  }
);
req.on('error', (e) => {
  console.error('MAIL_FAILED');
  console.error('网络错误: ' + e.message);
  process.exit(2);
});
req.write(payload);
req.end();
