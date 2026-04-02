/**
 * SKIN SOCIETE — Meta Lead Ads → Twilio SMS Automation
 * v3.0 — RESTART-SAFE POLLING + WEBHOOK
 *
 * PRIMARY: Polls Meta Graph API every 2 minutes for new leads
 * BACKUP:  Webhook endpoint still active (for when app gets published)
 *
 * v3.0 FIX: On startup, only seeds leads older than SEED_THRESHOLD_MS.
 * Any lead created within the threshold window gets SMS'd immediately.
 * This means restarts/redeploys NEVER silently swallow recent leads.
 *
 * Also adds a self-ping keep-alive to prevent Railway from sleeping.
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const twilio = require('twilio');

const app = express();

// --- Config ---
const {
  META_APP_SECRET,
  META_ACCESS_TOKEN,
  META_VERIFY_TOKEN,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  COTTESLOE_RECEPTION_PHONE,
  ROCKINGHAM_RECEPTION_PHONE,
  NOTIFICATION_EMAIL,
  COTTESLOE_FORM_ID,
  ROCKINGHAM_FORM_ID,
  PORT = 3000,
  POLL_INTERVAL_MS = 120000, // 2 minutes default
  SEED_THRESHOLD_MS = 600000, // 10 minutes — leads newer than this get SMS on restart
  RAILWAY_URL // set this to your Railway public URL for keep-alive pings
} = process.env;

// Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Clinic config ---
const CLINICS = {
  [COTTESLOE_FORM_ID]: {
    name: 'Cottesloe',
    receptionPhone: COTTESLOE_RECEPTION_PHONE,
    bookingUrl: 'http://phr.st/T5Bby',
    address: 'Cottesloe, Perth WA'
  },
  [ROCKINGHAM_FORM_ID]: {
    name: 'Rockingham',
    receptionPhone: ROCKINGHAM_RECEPTION_PHONE,
    bookingUrl: 'http://phore.st/jhoV9',
    address: 'Rockingham, Perth WA'
  }
};

const DEFAULT_CLINIC = {
  name: 'SKIN SOCIETE',
  receptionPhone: COTTESLOE_RECEPTION_PHONE,
  bookingUrl: 'http://phr.st/T5Bby',
  address: 'Perth WA'
};

// ============================================================
// LEAD TRACKING — in-memory store of processed lead IDs
// ============================================================
const processedLeads = new Set();
let pollCount = 0;
let lastPollTime = null;
let totalLeadsSent = 0;
let serverStartTime = null;

// ============================================================
// SMS TEMPLATES
// ============================================================

function getLeadSMS(leadName, clinic, preferredTime) {
  const firstName = leadName ? leadName.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';

  let timeLine = '';
  if (preferredTime === 'this_week' || preferredTime === 'This week') {
    timeLine = `\nWe have availability this week — `;
  } else if (preferredTime === 'next_week' || preferredTime === 'Next week') {
    timeLine = `\nWe'll lock in a time next week for you — `;
  } else {
    timeLine = `\nWe'd love to find a time that works for you — `;
  }

  return `${greeting}, thanks for your interest in skin needling at SKIN SOCIETE ${clinic.name}! ✨
${timeLine}book your $175 nurse-led consultation here: ${clinic.bookingUrl}

WHAT TO EXPECT:
→ 30-minute treatment
→ Nurse-led consultation included
→ Triggers your skin's natural renewal
→ Smoother texture, refined pores, lasting glow
→ Minimal downtime — most clients return to normal activities same day

We'll also give you a call shortly to answer any questions.

SKIN SOCIETE ${clinic.name}
${clinic.address}`;
}

function getReceptionSMS(leadName, leadPhone, leadEmail, clinic, preferredTime) {
  return `🔔 NEW LEAD — ${clinic.name}

Name: ${leadName || 'Not provided'}
Phone: ${leadPhone || 'Not provided'}
Email: ${leadEmail || 'Not provided'}
Preferred: ${preferredTime || 'Not specified'}
Treatment: Skin Needling $175

⚡ Call within 15 mins for best conversion.
Auto-SMS with booking link already sent to client.`;
}

// ============================================================
// CORE: Send SMS to a lead + notify reception
// ============================================================

async function processLead(extracted, clinic, source) {
  console.log(`\n🆕 NEW LEAD DETECTED — ${source}`);
  console.log(`   Clinic: ${clinic.name}`);
  console.log(`   Name: ${extracted.fullName}`);
  console.log(`   Phone: ${extracted.phone}`);
  console.log(`   Email: ${extracted.email}`);
  console.log(`   Preferred: ${extracted.preferredTime}`);
  console.log(`   Created: ${extracted.createdTime}`);
  console.log(`   Lead ID: ${extracted.id}`);

  let leadSmsSent = false;
  let receptionSmsSent = false;

  // Send SMS to the lead
  if (extracted.phone) {
    const formattedPhone = formatAustralianPhone(extracted.phone);
    if (formattedPhone) {
      const leadMessage = getLeadSMS(extracted.fullName, clinic, extracted.preferredTime);
      const sid = await sendSMS(formattedPhone, leadMessage);
      if (sid) {
        console.log(`   ✅ SMS sent to lead: ${formattedPhone} (${sid})`);
        leadSmsSent = true;
      } else {
        console.log(`   ❌ FAILED to send SMS to lead: ${formattedPhone}`);
      }
    } else {
      console.log(`   ⚠️ Could not format phone: ${extracted.phone}`);
    }
  } else {
    console.log(`   ⚠️ No phone number — cannot SMS lead`);
  }

  // Send notification to reception
  if (clinic.receptionPhone) {
    const receptionMessage = getReceptionSMS(
      extracted.fullName,
      extracted.phone,
      extracted.email,
      clinic,
      extracted.preferredTime
    );
    const sid = await sendSMS(clinic.receptionPhone, receptionMessage);
    if (sid) {
      console.log(`   ✅ Reception notified (${sid})`);
      receptionSmsSent = true;
    } else {
      console.log(`   ❌ FAILED to notify reception`);
    }
  }

  totalLeadsSent++;
  console.log(`   ✅ Lead fully processed (lead SMS: ${leadSmsSent}, reception SMS: ${receptionSmsSent})\n`);
  return { leadSmsSent, receptionSmsSent };
}

// ============================================================
// POLLING SYSTEM — checks Meta API for new leads
// ============================================================

/**
 * Fetch all leads for a specific form from Meta Graph API
 */
async function fetchFormLeads(formId) {
  try {
    const url = `https://graph.facebook.com/v19.0/${formId}/leads?access_token=${META_ACCESS_TOKEN}&limit=50`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error(`❌ Meta API error for form ${formId}:`, data.error.message);
      return [];
    }

    return data.data || [];
  } catch (err) {
    console.error(`❌ Error fetching leads for form ${formId}:`, err.message);
    return [];
  }
}

/**
 * Extract standard fields from a lead object
 */
function extractLeadFields(lead) {
  const fields = {};
  for (const field of lead.field_data || []) {
    fields[field.name] = field.values?.[0] || '';
  }
  return {
    id: lead.id,
    createdTime: lead.created_time,
    fullName: fields.full_name || fields.first_name || '',
    phone: fields.phone_number || '',
    email: fields.email || '',
    preferredTime: fields.preferred_time || ''
  };
}

/**
 * v3.0 RESTART-SAFE SEED
 *
 * Only seeds leads OLDER than SEED_THRESHOLD_MS (default 10 mins).
 * Recent leads (within threshold) are treated as NEW and get SMS.
 * This prevents the bug where a restart silently swallows all pending leads.
 */
async function seedAndCatchUp() {
  const seedThreshold = parseInt(SEED_THRESHOLD_MS) || 600000;
  const now = new Date();
  const cutoff = new Date(now.getTime() - seedThreshold);

  console.log('🌱 Smart seed starting...');
  console.log(`   Current time: ${now.toISOString()}`);
  console.log(`   Seed threshold: ${seedThreshold / 1000}s`);
  console.log(`   Cutoff: ${cutoff.toISOString()}`);
  console.log(`   Leads OLDER than cutoff → mark as processed (no SMS)`);
  console.log(`   Leads NEWER than cutoff → send SMS now (catch-up)\n`);

  const forms = [
    { id: COTTESLOE_FORM_ID, name: 'Cottesloe' },
    { id: ROCKINGHAM_FORM_ID, name: 'Rockingham' }
  ];

  let totalSeeded = 0;
  let totalCaughtUp = 0;

  for (const form of forms) {
    if (!form.id) {
      console.warn(`⚠️ No form ID configured for ${form.name}`);
      continue;
    }

    const leads = await fetchFormLeads(form.id);
    const clinic = CLINICS[form.id] || DEFAULT_CLINIC;
    let seeded = 0;
    let caughtUp = 0;

    for (const lead of leads) {
      const leadTime = new Date(lead.created_time);

      if (leadTime < cutoff) {
        // Old lead — seed as processed, no SMS
        processedLeads.add(lead.id);
        seeded++;
      } else {
        // Recent lead — might have been missed during downtime
        if (!processedLeads.has(lead.id)) {
          processedLeads.add(lead.id);
          const extracted = extractLeadFields(lead);
          console.log(`   🔄 CATCH-UP: ${extracted.fullName} (${form.name}) — created ${lead.created_time}`);
          await processLead(extracted, clinic, `Startup catch-up (${form.name})`);
          caughtUp++;
        }
      }
    }

    console.log(`   ${form.name}: ${seeded} seeded (old) | ${caughtUp} caught up (recent)`);
    totalSeeded += seeded;
    totalCaughtUp += caughtUp;
  }

  console.log(`\n✅ Smart seed complete — ${totalSeeded} old leads seeded, ${totalCaughtUp} recent leads caught up with SMS`);
  if (totalCaughtUp > 0) {
    console.log(`   ⚡ ${totalCaughtUp} lead(s) received SMS that would have been missed in v2.0!`);
  }
}

/**
 * Main polling function — runs every POLL_INTERVAL_MS
 */
async function pollForNewLeads() {
  pollCount++;
  const pollStart = new Date();
  lastPollTime = pollStart.toISOString();

  const forms = [
    { id: COTTESLOE_FORM_ID, name: 'Cottesloe' },
    { id: ROCKINGHAM_FORM_ID, name: 'Rockingham' }
  ];

  let newLeadsThisPoll = 0;

  for (const form of forms) {
    if (!form.id) continue;

    const leads = await fetchFormLeads(form.id);
    const clinic = CLINICS[form.id] || DEFAULT_CLINIC;

    for (const lead of leads) {
      if (processedLeads.has(lead.id)) continue;

      // NEW LEAD FOUND
      processedLeads.add(lead.id);
      newLeadsThisPoll++;

      const extracted = extractLeadFields(lead);
      await processLead(extracted, clinic, `Poll #${pollCount}`);
    }
  }

  // Log summary
  if (newLeadsThisPoll === 0 && pollCount % 10 === 0) {
    console.log(`📊 Poll #${pollCount} — No new leads | ${processedLeads.size} tracked | ${totalLeadsSent} SMS sent total | ${pollStart.toISOString()}`);
  } else if (newLeadsThisPoll > 0) {
    console.log(`📊 Poll #${pollCount} — ${newLeadsThisPoll} new lead(s) processed | ${processedLeads.size} tracked total`);
  }
}

/**
 * Start the polling loop
 */
function startPolling() {
  const intervalMs = parseInt(POLL_INTERVAL_MS) || 120000;
  console.log(`\n⏰ Starting lead polling — every ${intervalMs / 1000} seconds`);
  console.log(`   Cottesloe form: ${COTTESLOE_FORM_ID}`);
  console.log(`   Rockingham form: ${ROCKINGHAM_FORM_ID}\n`);

  // First poll immediately
  pollForNewLeads().catch(err => {
    console.error('❌ Polling error:', err.message);
  });

  // Then every interval
  setInterval(() => {
    pollForNewLeads().catch(err => {
      console.error('❌ Polling error:', err.message);
    });
  }, intervalMs);
}

// ============================================================
// KEEP-ALIVE — prevents Railway from sleeping the server
// ============================================================

function startKeepAlive() {
  const railwayUrl = RAILWAY_URL || `http://localhost:${PORT}`;
  const pingInterval = 10 * 60 * 1000; // every 10 minutes

  setInterval(async () => {
    try {
      await fetch(`${railwayUrl}/`);
      // Silent — no log spam for keep-alive
    } catch (err) {
      console.error('⚠️ Keep-alive ping failed:', err.message);
    }
  }, pingInterval);

  console.log(`🏓 Keep-alive enabled — pinging ${railwayUrl} every 10 minutes`);
}

// ============================================================
// META WEBHOOK HANDLERS (backup — still active)
// ============================================================

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  console.log('❌ Webhook verification failed');
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) :
                 Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;

    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadData = change.value;
          console.log(`📩 Webhook received — Form: ${leadData.form_id}, Lead: ${leadData.leadgen_id}`);

          if (processedLeads.has(leadData.leadgen_id)) {
            console.log(`   ⏭️ Already processed by polling — skipping`);
            continue;
          }

          processWebhookLead(leadData).catch(err => {
            console.error('❌ Error processing webhook lead:', err);
          });
        }
      }
    }
  } catch (err) {
    console.error('❌ Error parsing webhook:', err);
  }
});

async function processWebhookLead(leadData) {
  const { leadgen_id, form_id } = leadData;

  processedLeads.add(leadgen_id);

  const leadDetails = await fetchLeadDetails(leadgen_id);
  if (!leadDetails) {
    console.error(`❌ Could not fetch lead details for ${leadgen_id}`);
    return;
  }

  const fields = {};
  for (const field of leadDetails.field_data || []) {
    fields[field.name] = field.values?.[0] || '';
  }

  const clinic = CLINICS[form_id] || DEFAULT_CLINIC;
  const extracted = {
    id: leadgen_id,
    createdTime: leadDetails.created_time,
    fullName: fields.full_name || fields.first_name || '',
    phone: fields.phone_number || '',
    email: fields.email || '',
    preferredTime: fields.preferred_time || ''
  };

  await processLead(extracted, clinic, 'Webhook');
}

async function fetchLeadDetails(leadgenId) {
  try {
    const url = `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${META_ACCESS_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error('Meta API error:', data.error);
      return null;
    }

    return data;
  } catch (err) {
    console.error('Error fetching lead:', err);
    return null;
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function sendSMS(to, body) {
  try {
    const message = await twilioClient.messages.create({
      body,
      from: TWILIO_PHONE_NUMBER,
      to
    });
    return message.sid;
  } catch (err) {
    console.error(`❌ Twilio error sending to ${to}:`, err.message);
    return null;
  }
}

function formatAustralianPhone(phone) {
  if (!phone) return null;

  let cleaned = phone.replace(/[\s\-\(\)]/g, '');

  if (cleaned.startsWith('+61') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('61') && cleaned.length === 11) return '+' + cleaned;
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+61' + cleaned.slice(1);
  if (cleaned.length === 9 && (cleaned.startsWith('4') || cleaned.startsWith('2') || cleaned.startsWith('3'))) {
    return '+61' + cleaned;
  }
  if (cleaned.startsWith('+') && cleaned.length >= 10) return cleaned;

  console.log(`⚠️ Unrecognised phone format: ${phone}`);
  return null;
}

// ============================================================
// HEALTH CHECK & STATUS
// ============================================================

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'SKIN SOCIETE Lead Automation v3.0',
    mode: 'POLLING + WEBHOOK (restart-safe)',
    server_started: serverStartTime,
    polling: {
      interval_seconds: (parseInt(POLL_INTERVAL_MS) || 120000) / 1000,
      polls_completed: pollCount,
      last_poll: lastPollTime,
      leads_tracked: processedLeads.size,
      leads_sms_sent: totalLeadsSent
    },
    forms: {
      cottesloe: COTTESLOE_FORM_ID,
      rockingham: ROCKINGHAM_FORM_ID
    },
    seed_threshold_minutes: (parseInt(SEED_THRESHOLD_MS) || 600000) / 60000,
    timestamp: new Date().toISOString()
  });
});

app.post('/test-lead', async (req, res) => {
  const { name, phone, email, preferred_time, clinic: clinicKey } = req.body;

  const formId = clinicKey === 'rockingham' ? ROCKINGHAM_FORM_ID : COTTESLOE_FORM_ID;
  const clinic = CLINICS[formId] || DEFAULT_CLINIC;

  console.log(`🧪 TEST LEAD: ${name} | ${phone} | ${clinic.name}`);

  const results = { lead_sms: null, reception_sms: null };

  if (phone) {
    const formattedPhone = formatAustralianPhone(phone);
    if (formattedPhone) {
      const leadMsg = getLeadSMS(name, clinic, preferred_time);
      results.lead_sms = await sendSMS(formattedPhone, leadMsg);
    }
  }

  if (clinic.receptionPhone) {
    const recMsg = getReceptionSMS(name, phone, email, clinic, preferred_time);
    results.reception_sms = await sendSMS(clinic.receptionPhone, recMsg);
  }

  res.json({
    success: true,
    clinic: clinic.name,
    results,
    message: `Test lead processed for ${clinic.name}`
  });
});

app.post('/poll-now', async (req, res) => {
  console.log('🔄 Manual poll triggered via /poll-now');
  try {
    await pollForNewLeads();
    res.json({
      success: true,
      pollCount,
      leadsTracked: processedLeads.size,
      leadsSMSSent: totalLeadsSent,
      lastPoll: lastPollTime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/leads-status', (req, res) => {
  res.json({
    processedLeadIds: Array.from(processedLeads),
    count: processedLeads.size,
    smsSent: totalLeadsSent,
    pollCount,
    lastPoll: lastPollTime,
    serverStarted: serverStartTime
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, async () => {
  serverStartTime = new Date().toISOString();

  console.log(`
╔══════════════════════════════════════════════════╗
║  SKIN SOCIETE — Lead Automation Server v3.0     ║
║  Running on port ${PORT}                            ║
║                                                  ║
║  MODE: POLLING (primary) + WEBHOOK (backup)      ║
║  Poll interval: ${(parseInt(POLL_INTERVAL_MS) || 120000) / 1000}s                              ║
║  Seed threshold: ${(parseInt(SEED_THRESHOLD_MS) || 600000) / 60000} minutes                        ║
║  RESTART-SAFE: Recent leads get SMS on reboot    ║
║                                                  ║
║  Endpoints:                                      ║
║    GET  /           — Health check + stats        ║
║    GET  /webhook    — Meta verification           ║
║    POST /webhook    — Meta webhook (backup)       ║
║    POST /test-lead  — Test SMS                    ║
║    POST /poll-now   — Force immediate poll        ║
║    GET  /leads-status — View all tracked leads    ║
╚══════════════════════════════════════════════════╝
  `);
  console.log('Clinics configured:');
  console.log(`  Cottesloe  — Form: ${COTTESLOE_FORM_ID}`);
  console.log(`  Rockingham — Form: ${ROCKINGHAM_FORM_ID}`);

  // STEP 1: Smart seed + catch up on recent leads
  await seedAndCatchUp();

  // STEP 2: Start polling for new leads
  startPolling();

  // STEP 3: Keep-alive to prevent Railway sleep
  startKeepAlive();
});