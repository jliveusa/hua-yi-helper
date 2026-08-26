/**
 * 现场登录华医网（MiMo 验证码识别）→ 登录成功后导出新 storage-state.json
 * 用法: cd scripts && node login-and-save-state.js
 * 产出: local/storage-state.json（新快照，覆盖前自动备份旧文件）
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SD = path.join(ROOT, 'test-screenshots');
const STATE = path.join(ROOT, 'local', 'storage-state.json');
if (!fs.existsSync(SD)) fs.mkdirSync(SD, { recursive: true });

const account = JSON.parse(fs.readFileSync(path.join(ROOT, 'local', 'yhw_account.json'), 'utf-8'));

// 从 scripts/.env.local 读 MIMO_API_KEY（不硬编码密钥）
function loadEnv() {
  try {
    const c = fs.readFileSync(path.join(ROOT, 'scripts', '.env.local'), 'utf-8');
    for (const line of c.split('\n')) {
      const t = line.trim();
      if (t.startsWith('MIMO_API_KEY=')) return t.slice('MIMO_API_KEY='.length).trim();
    }
  } catch (e) {}
  return '';
}
const MIMO_API_KEY = loadEnv();
if (!MIMO_API_KEY) { console.log('❌ MIMO_API_KEY 未在 scripts/.env.local 找到'); process.exit(1); }

/** MiMo v2.5 vision 识别验证码 */
async function recognizeCaptcha(imageBase64) {
  const body = {
    model: 'mimo-v2.5',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是一张登录验证码图片。请只回答图片中的验证码文字（数字或字母），不要有任何解释、标点或多余内容。' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } },
      ],
    }],
    max_completion_tokens: 50,
    temperature: 0.1,
    stream: false,
  };
  const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'api-key': MIMO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim().replace(/[^a-zA-Z0-9]/g, '');
}

(async () => {
  console.log('🧪 启动 Chromium...');
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await ctx.newPage();

  console.log('🌐 打开登录页...');
  await page.goto('https://cme28.91huayi.com/secure/login.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 切密码登录 tab
  console.log('🔑 切换到密码登录...');
  await page.evaluate(() => {
    const t = document.getElementById('type_pwd');
    if (t) { t.style.display = ''; t.click(); }
    document.querySelectorAll('.card_box').forEach(c => { if (c.querySelector('#txt_user_pwd')) c.style.display = 'block'; });
  });
  await page.waitForTimeout(1500);

  // ⚠️ 显眼的"自动运行中"横幅：防止用户凭旧印象误判为半自动而手动操作
  await page.evaluate(() => {
    const banner = document.createElement('div');
    banner.id = '__auto_login_banner__';
    banner.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;z-index:2147483647!important;background:#ff1744!important;color:#fff!important;text-align:center!important;padding:12px!important;font:bold 16px/1.4 "Microsoft YaHei",sans-serif!important;box-shadow:0 2px 8px rgba(0,0,0,.4)!important;';
    banner.innerHTML = '🤖 华医网小助手·自动登录中（MiMo 识别图形验证码）<br><span style="font-size:13px;font-weight:normal;opacity:.95;">请勿操作键盘鼠标！脚本会在 5~15 秒内完成登录，浏览器窗口会自动关闭。</span>';
    (document.body || document.documentElement).appendChild(banner);
  });

  // 填账号密码（input 事件触发页面同步 + 直写 hidden 域兜底）
  console.log('📝 填入账号密码...');
  await page.evaluate((acc) => {
    const u = document.getElementById('txt_user_name');
    if (u) { u.value = acc.hyw_account; u.dispatchEvent(new Event('input', { bubbles: true })); }
    const p = document.getElementById('txt_user_pwd');
    if (p) { p.value = acc.hyw_password; p.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new Event('change', { bubbles: true })); }
    const r = document.getElementById('txt_user_pwd_real');
    if (r) r.value = acc.hyw_password;
  }, account);
  await page.waitForTimeout(500);

  // 勾协议
  await page.evaluate(() => {
    const cb = document.getElementById('agree1');
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  });

  // 验证码识别 + 登录循环（最多 5 次）
  let loggedIn = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`\n🔄 第 ${attempt} 次识别验证码...`);
    const captchaImg = await page.$('#yzm_img');
    if (!captchaImg) { console.log('❌ 找不到验证码元素 #yzm_img'); break; }
    const buf = await captchaImg.screenshot();
    fs.writeFileSync(path.join(SD, `relogin-captcha-${attempt}.png`), buf);

    let code = '';
    try {
      code = await recognizeCaptcha(buf.toString('base64'));
      console.log(`🤖 AI识别: "${code}"`);
    } catch (e) { console.log(`❌ API失败: ${e.message}`); break; }

    if (!code) { await page.click('#yzm_img'); await page.waitForTimeout(1500); continue; }

    await page.evaluate((c) => {
      const inp = document.getElementById('txt_img_code');
      if (inp) { inp.value = c; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }, code);
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const btns = document.querySelectorAll('button.btn_login');
      for (const b of btns) { const r = b.getBoundingClientRect(); if (r.width > 100 && r.y > 100) { b.click(); return; } }
    });
    await page.waitForTimeout(4000);

    if (!page.url().includes('login.aspx')) { loggedIn = true; break; }

    // 错误弹窗关闭 + 刷新验证码
    await page.evaluate(() => { document.querySelectorAll('.layui-layer-btn0').forEach(b => b.click()); });
    await page.click('#yzm_img');
    await page.waitForTimeout(1500);
  }

  if (!loggedIn) {
    await page.screenshot({ path: path.join(SD, 'relogin-failed.png'), fullPage: false });
    console.log('❌ 登录失败（5 次验证码都未通过）');
    await browser.close();
    process.exit(1);
  }

  console.log('\n✅ 登录成功! 跳转到:', page.url());
  // 登录成功后移除横幅（避免影响后续主页截图）
  await page.evaluate(() => { const b = document.getElementById('__auto_login_banner__'); if (b) b.remove(); });

  // 关掉可能弹窗
  await page.evaluate(() => { document.querySelectorAll('.layui-layer-btn0').forEach(b => b.click()); });
  await page.waitForTimeout(1000);

  // 打开课程主页确认"已登录视图"
  console.log('🌐 验证登录态：打开课程主页...');
  await page.goto('https://cme28.91huayi.com/cme/index', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  const homeState = await page.evaluate(() => {
    const t = (document.body.textContent || '');
    return {
      url: location.href,
      isGuest: t.includes('登录') && t.includes('注册') && !t.includes('退出') && !t.includes('注销'),
      hasUserActions: t.includes('退出') || t.includes('注销') || t.includes('修改信息'),
    };
  });
  console.log('主页状态:', JSON.stringify(homeState, null, 2));
  if (homeState.isGuest) {
    console.log('⚠️ 注意：主页仍为游客视图，导出快照可能无效');
  }
  await page.screenshot({ path: path.join(SD, 'relogin-home.png'), fullPage: false });

  // 导出 storageState（先备份旧文件）
  if (fs.existsSync(STATE)) {
    const bak = STATE + '.bak-' + new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(bak)) fs.copyFileSync(STATE, bak);
    console.log('🗂️ 旧快照已备份:', bak);
  }
  await ctx.storageState({ path: STATE });
  console.log('💾 新 storage-state.json 已导出');

  await browser.close();
  console.log('🏁 完成');
})();
