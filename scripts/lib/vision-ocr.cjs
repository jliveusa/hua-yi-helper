// 通用「OpenAI 兼容」视觉识别模块 —— 用于登录图形验证码 OCR
//
// 设计原则：
//   1. 不内置任何 baseURL / model / API Key，全部从 scripts/.env.local 读取。
//   2. 验证码自动识别是【可选功能】。未配置时 enabled=false，调用方必须降级为
//      「弹出可见浏览器窗口，由人工输入验证码」，而不是报错退出。
//   3. 只依赖 OpenAI Chat Completions 的通用图文接口，任何兼容该格式且具备
//      多模态（图片输入）能力的服务都能用。
//
// scripts/.env.local 配置项：
//   VISION_BASE_URL=https://api.openai.com/v1     必填。到 /v1 为止，不要带 /chat/completions
//   VISION_MODEL=gpt-4o-mini                      必填。必须是有图片识别能力的多模态模型
//   VISION_API_KEY=sk-xxxxxxxx                    必填。
//   VISION_AUTH_STYLE=bearer                      选填。bearer(默认) | api-key
//   VISION_MAX_TOKENS=                            选填。留空则不发送该字段（兼容性最好）
//   VISION_TOKEN_PARAM=max_tokens                 选填。max_tokens(默认) | max_completion_tokens
//
// 三个必填项缺任意一个 => enabled=false（视为「未配置」，不是错误）。

const fs = require('fs');

const PROMPT =
  '这是一张登录验证码图片。请只回答图片中的验证码文字（数字或字母），不要有任何解释、标点或多余内容。';

/** 解析 .env.local 为纯对象；文件不存在返回 {} */
function parseEnvFile(envPath) {
  const env = {};
  try {
    const c = fs.readFileSync(envPath, 'utf-8');
    for (const line of c.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch (e) {}
  return env;
}

/**
 * 读取视觉识别配置。
 * @returns {{enabled:boolean, missing:string[], baseUrl:string, model:string,
 *            apiKey:string, authStyle:string, endpoint:string,
 *            maxTokens:string, tokenParam:string, envPath:string}}
 */
function loadVisionConfig(envPath) {
  const env = parseEnvFile(envPath);
  const baseUrl = (env.VISION_BASE_URL || '').replace(/\/+$/, '');
  const model = env.VISION_MODEL || '';
  const apiKey = env.VISION_API_KEY || '';
  const authStyle = (env.VISION_AUTH_STYLE || 'bearer').toLowerCase();
  const maxTokens = env.VISION_MAX_TOKENS || '';
  const tokenParam = env.VISION_TOKEN_PARAM || 'max_tokens';

  const missing = [];
  if (!baseUrl) missing.push('VISION_BASE_URL');
  if (!model) missing.push('VISION_MODEL');
  if (!apiKey) missing.push('VISION_API_KEY');

  // 容错：用户可能把完整的 /chat/completions 也填进 BASE_URL
  const endpoint = /\/chat\/completions$/.test(baseUrl)
    ? baseUrl
    : baseUrl + '/chat/completions';

  return {
    enabled: missing.length === 0,
    missing,
    baseUrl,
    model,
    apiKey,
    authStyle,
    endpoint,
    maxTokens,
    tokenParam,
    envPath,
  };
}

/** 人类可读的配置说明（不泄露 Key 明文） */
function describeVisionConfig(cfg) {
  if (!cfg.enabled) {
    return (
      '验证码自动识别：未启用（缺少 ' +
      cfg.missing.join(', ') +
      '）\n' +
      '→ 将弹出浏览器窗口，请人工输入验证码后点击登录。\n' +
      '→ 如需自动识别，在 ' +
      cfg.envPath +
      ' 中配置 VISION_BASE_URL / VISION_MODEL / VISION_API_KEY（模型需具备图片识别能力）。'
    );
  }
  const tail = cfg.apiKey.length > 4 ? cfg.apiKey.slice(-4) : '****';
  return (
    '验证码自动识别：已启用\n' +
    '  接口: ' +
    cfg.endpoint +
    '\n  模型: ' +
    cfg.model +
    '\n  鉴权: ' +
    cfg.authStyle +
    ' (Key ****' +
    tail +
    ')'
  );
}

/**
 * 调用多模态模型识别验证码。
 * @param {object} cfg loadVisionConfig 的返回值
 * @param {string} imageBase64 验证码图片的 base64（不含 data: 前缀）
 * @returns {Promise<string>} 只含字母数字的识别结果
 */
async function recognizeCaptcha(cfg, imageBase64) {
  if (!cfg.enabled) {
    throw new Error('验证码自动识别未配置（缺少 ' + cfg.missing.join(', ') + '）');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.authStyle === 'api-key') headers['api-key'] = cfg.apiKey;
  else headers['Authorization'] = 'Bearer ' + cfg.apiKey;

  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } },
        ],
      },
    ],
    temperature: 0,
    stream: false,
  };
  // 仅在用户显式配置时才发送 token 上限字段：不同服务对
  // max_tokens / max_completion_tokens 的支持不一致，默认不发兼容性最好。
  if (cfg.maxTokens) body[cfg.tokenParam] = Number(cfg.maxTokens);

  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`视觉接口 ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return String(content || '').trim().replace(/[^a-zA-Z0-9]/g, '');
}

module.exports = { loadVisionConfig, describeVisionConfig, recognizeCaptcha, parseEnvFile };
