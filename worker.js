/**
 * ============================================================
 *  Messenger bot — เว็บเบอร์มงคล (Cloudflare Worker)
 *  ลูกค้าจองเสร็จ → เปิด m.me/1483206458199772?ref=<รหัสจอง>
 *  → Facebook ส่ง ref มาที่ Worker นี้ → ขอข้อมูลจาก Apps Script → ส่งการ์ดคำสั่งซื้อเข้าแชทลูกค้า
 *
 *  ตัวแปร (Worker › Settings › Variables and Secrets)
 *   PAGE_TOKEN     Page access token ของเพจ                  (Secret)
 *   APP_SECRET     App secret ของ Facebook App               (Secret)
 *   VERIFY_TOKEN   คำลับอะไรก็ได้ ใช้ตอนผูก Webhook           (Secret)
 *   BOT_SECRET     ค่า BOT_SECRET จาก log ของ luckyUpgradeV13 (Secret)
 *   SETUP_KEY      คำลับสำหรับเปิด /setup ครั้งเดียว          (Secret)
 *   GAS_URL        URL /exec ของ Apps Script                 (Text)
 *   GRAPH_VERSION  ไม่บังคับ เช่น v21.0 (เว้นว่าง = เวอร์ชันตั้งต้นของแอป)
 * ============================================================
 */

const REF_RE = /^\d{3,5}-\d{6}-\d{2,5}-[A-Z0-9]{3,6}$/i;   // รหัสจอง เช่น 1213-261108-1199-K7Q

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/setup') return setup(url, env);

    if (req.method === 'GET') {   // Facebook ยืนยัน Webhook
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN) {
        return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
      }
      return new Response('Lucky Messenger bot OK');
    }
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const body = await req.text();
    if (!(await validSignature(req, body, env.APP_SECRET))) return new Response('bad signature', { status: 401 });
    let data;
    try { data = JSON.parse(body); } catch (e) { return new Response('bad json', { status: 400 }); }
    if (data.object === 'page') ctx.waitUntil(handle(data, env));
    return new Response('EVENT_RECEIVED');   // ต้องตอบเร็ว ไม่อย่างนั้น Facebook จะส่งซ้ำ
  }
};

async function handle(data, env) {
  for (const entry of data.entry || []) {
    for (const ev of entry.messaging || []) {
      const psid = ev.sender && ev.sender.id;
      // แชทเดิม → messaging_referrals / แชทใหม่ → ปุ่มเริ่มต้นใช้งาน (postback) พร้อม referral
      const ref = (ev.referral && ev.referral.ref) || (ev.postback && ev.postback.referral && ev.postback.referral.ref) || '';
      if (!psid || !REF_RE.test(ref)) continue;
      try { await sendBooking(env, psid, ref.toUpperCase()); }
      catch (e) { console.log('send error', ref, e && e.message); }
    }
  }
}

async function sendBooking(env, psid, code) {
  await graph(env, 'me/messages', { recipient: { id: psid }, sender_action: 'typing_on' }).catch(() => {});
  const q = new URLSearchParams({ action: 'botBooking', p: JSON.stringify({ code, secret: env.BOT_SECRET }) });
  const res = await fetch(env.GAS_URL + '?' + q.toString(), { redirect: 'follow' });
  const r = await res.json();
  if (!r.ok) {
    await sendText(env, psid, 'ขออภัยค่ะ ไม่พบรายการจองรหัส ' + code + ' พนักงานจะช่วยตรวจสอบให้ในแชทนี้ค่ะ');
    return;
  }
  const b = r.data;
  const el = { title: b.title, subtitle: b.subtitle };
  if (b.siteUrl) el.buttons = [{ type: 'web_url', url: b.siteUrl, title: 'ดูเบอร์อื่น' }];
  await graph(env, 'me/messages', {
    recipient: { id: psid }, messaging_type: 'RESPONSE',
    message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [el] } } }
  });
  await sendText(env, psid, b.text);
}

function sendText(env, psid, text) {
  return graph(env, 'me/messages', { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } });
}

async function graph(env, path, payload) {
  const v = env.GRAPH_VERSION ? String(env.GRAPH_VERSION).replace(/\/$/, '') + '/' : '';
  const res = await fetch(`https://graph.facebook.com/${v}${path}?access_token=${encodeURIComponent(env.PAGE_TOKEN)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

/** เปิดครั้งเดียว: https://<worker>/setup?key=SETUP_KEY → ตั้งปุ่ม "เริ่มต้นใช้งาน" + ข้อความต้อนรับ */
async function setup(url, env) {
  if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return new Response('forbidden', { status: 403 });
  try {
    const r = await graph(env, 'me/messenger_profile', {
      get_started: { payload: 'GET_STARTED' },
      greeting: [{ locale: 'default', text: 'สวัสดีค่ะ กดเริ่มต้นใช้งาน แล้วระบบจะส่งรายละเอียดการจองเบอร์ให้ทันทีค่ะ' }]
    });
    return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response('setup error: ' + e.message, { status: 500 });
  }
}

async function validSignature(req, body, secret) {
  if (!secret) return false;
  const sig = req.headers.get('x-hub-signature-256') || '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return sig === 'sha256=' + hex;
}
