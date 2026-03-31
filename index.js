/**
 * SKIN SOCIETE — Meta Lead Ads → Twilio SMS Automation
 *
 * When someone fills out a lead form on Meta (Facebook/Instagram),
 * this server:
 *   1. Receives the webhook from Meta
 *   2. Fetches the lead details from Meta's API
 *   3. Sends an SMS to the lead via Twilio with booking link + treatment info
 *   4. Sends an SMS to the clinic reception so they can follow up fast
 *
 * Deploy to: Railway, Render, Vercel, or any Node.js host
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
  PORT = 3000
} = process.env;

// Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Clinic config ---
const CLINICS = {
  [COTTESLOE_FORM_ID]: {
    name: 'Cottesloe',
    receptionPhone: COTTESLOE_RECEPTION_PHONE,
    bookingUrl: 'https://skinsociete.com.au/skin-needling?location=cottesloe',
    address: 'Cottesloe, Perth WA'
  },
  [ROCKINGHAM_FORM_ID]: {
    name: 'Rockingham',
    receptionPhone: ROCKINGHAM_RECEPTION_PHONE,
    bookingUrl: 'https://skinsociete.com.au/skin-needling?location=rockingham',
    address: 'Rockingham, Perth WA'
  }
};

// Default for unknown forms
const DEFAULT_CLINIC = {
  name: 'SKIN SOCIETE',
  receptionPhone: COTTESLOE_RECEPTION_PHONE,
  bookingUrl: 'https://skinsociete.com.au/skin-needling',
  address: 'Perth WA'
};

// ============================================================
// SMS TEMPLATES
// ============================================================

function getLeadSMS(leadName, clinic, preferredTime) {
  const firstName = leadName ? leadName.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';

  // Personalise based on preferred time
  let timeLine = '';
  if (preferredTime === 'This week') {
    timeLine = `\nWe have availability this week \u2014 `;
  } else if (preferredTime === 'Next week') {
    timeLine = `\nWe'll lock in a time next week for you \u2014 `;
  } else {
    timeLine = `\nWe'd love to find a time that works for you \u2014 `;
  }

  return `${greeting}, thanks for your interest in skin needling at SKIN SOCIETE ${clinic.name}! \u2728
${timeLine}book your $175 nurse-led consultation here: ${clinic.bookingUrl}

WHAT TO EXPECT:
\u2192 30-minute treatment
\u2192 Nurse-led consultation included
\u2192 Triggers your skin's natural renewal
\u2192 Smoother texture, refined pores, lasting glow
\u2192 Minimal downtime \u2014 most clients return to normal activities same day

We'll also give you a call shortly to answer any questions.

SKIN SOCIETE ${clinic.name}
${clinic.address}`;
}

function getReceptionSMS(leadName, leadPhone, leadEmail, clinic, preferredTime) {
  return `\ud83d\udd14 NEW LEAD \u2014 ${clinic.name}

Name: ${leadName || 'Not provided'}
Phone: ${leadPhone || 'Not provided'}
Email: ${leadEmail || 'Not provided'}
Preferred: ${preferredTime || 'Not specified'}
Treatment: Skin Needling $175

\u26a1 Call within 15 mins for best conversion.
Auto-SMS with booking link already sent to client.`;
}

// ============================================================
// META WEBHOOK HANDLERS
// ============================================================

// Raw body parser for signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

/**
 * GET /webhook \u2014 Meta verification endpoint
 * Meta sends a GET request to verify you own this webhook URL
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('\u2705 Webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  console.log('\u274c Webhook verification failed');
  return res.sendStatus(403);
});

/**
 * POST /webhook \u2014 Receive lead events from Meta
 */
app.post('/webhook', async (req, res) => {
  // Always respond 200 quickly (Meta expects fast response)
  res.sendStatus(200);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) :
                 Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;

    // Verify this is a leadgen event
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadData = change.value;
          console.log(`\ud83d\udce9 New lead received \u2014 Form: ${leadData.form_id}, Lead: ${leadData.leadgen_id}`);

          // Process asynchronously
          processLead(leadData).catch(err => {
            console.error('\u274c Error processing lead:', err);
          });
        }
      }
    }
  } catch (err) {
    console.error('\u274c Error parsing webhook:', err);
  }
});

/**
 * Process a single lead \u2014 fetch details from Meta, send SMS
 */
async function processLead(leadData) {
  const { leadgen_id, form_id } = leadData;

  // 1. Fetch lead details from Meta Graph API
  const leadDetails = await fetchLeadDetails(leadgen_id);
  if (!leadDetails) {
    console.error(`\u274c Could not fetch lead details for ${leadgen_id}`);
    return;
  }

  // 2. Extract fields
  const fields = {};
  for (const field of leadDetails.field_data || []) {
    fields[field.name] = field.values?.[0] || '';
  }

  const leadName = fields.full_name || fields.first_name || '';
  const leadPhone = fields.phone_number || '';
  const leadEmail = fields.email || '';
  const preferredTime = fields.preferred_time || '';

  console.log(`\ud83d\udc64 Lead: ${leadName} | Phone: ${leadPhone} | Email: ${leadEmail} | Time: ${preferredTime}`);

  // 3. Determine which clinic
  const clinic = CLINICS[form_id] || DEFAULT_CLINIC;
  console.log(`\ud83c\udfe5 Clinic: ${clinic.name}`);

  // 4. Send SMS to the lead
  if (leadPhone) {
    const formattedPhone = formatAustralianPhone(leadPhone);
    if (formattedPhone) {
      const leadMessage = getLeadSMS(leadName, clinic, preferredTime);
      await sendSMS(formattedPhone, leadMessage);
      console.log(`\u2705 SMS sent to lead: ${formattedPhone}`);
    } else {
      console.log(`\u26a0\ufe0f Could not format phone number: ${leadPhone}`);
    }
  }

  // 5. Send notification to clinic reception
  if (clinic.receptionPhone) {
    const receptionMessage = getReceptionSMS(leadName, leadPhone, leadEmail, clinic, preferredTime);
    await sendSMS(clinic.receptionPhone, receptionMessage);
    console.log(`\u2705 Reception notified: ${clinic.name}`);
  }

  console.log(`\u2705 Lead fully processed: ${leadName} \u2192 ${clinic.name}`);
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Fetch lead details from Meta Graph API
 */
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

/**
 * Send SMS via Twilio
 */
async function sendSMS(to, body) {
  try {
    const message = await twilioClient.messages.create({
      body,
      from: TWILIO_PHONE_NUMBER,
      to
    });
    return message.sid;
  } catch (err) {
    console.error(`\u274c Twilio error sending to ${to}:`, err.message);
    return null;
  }
}

/**
 * Format Australian phone numbers to E.164 format
 * Handles: 0412345678, +61412345678, 61412345678, 412345678
 */
function formatAustralianPhone(phone) {
  if (!phone) return null;

  // Strip spaces, dashes, brackets
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');

  // Already E.164 format
  if (cleaned.startsWith('+61') && cleaned.length === 12) return cleaned;

  // Has country code without +
  if (cleaned.startsWith('61') && cleaned.length === 11) return '+' + cleaned;

  // Local format starting with 0
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+61' + cleaned.slice(1);

  // Just the number without leading 0
  if (cleaned.length === 9 && (cleaned.startsWith('4') || cleaned.startsWith('2') || cleaned.startsWith('3'))) {
    return '+61' + cleaned;
  }

  // If it already has + prefix and looks valid, return as-is
  if (cleaned.startsWith('+') && cleaned.length >= 10) return cleaned;

  console.log(`\u26a0\ufe0f Unrecognised phone format: ${phone}`);
  return null;
}

// ============================================================
// HEALTH CHECK & STATUS
// ============================================================

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'SKIN SOCIETE Lead Automation',
    forms: {
      cottesloe: COTTESLOE_FORM_ID,
      rockingham: ROCKINGHAM_FORM_ID
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * Test endpoint \u2014 simulate a lead (for testing without Meta)
 * POST /test-lead with { name, phone, email, preferred_time, clinic: \"cottesloe\"|\"rockingham\" }
 */
app.post('/test-lead', async (req, res) => {
  const { name, phone, email, preferred_time, clinic: clinicKey } = req.body;

  const formId = clinicKey === 'rockingham' ? ROCKINGHAM_FORM_ID : COTTESLOE_FORM_ID;
  const clinic = CLINICS[formId] || DEFAULT_CLINIC;

  console.log(`\ud83e\uddea TEST LEAD: ${name} | ${phone} | ${clinic.name}`);

  const results = { lead_sms: null, reception_sms: null };

  // Send SMS to lead
  if (phone) {
    const formattedPhone = formatAustralianPhone(phone);
    if (formattedPhone) {
      const leadMsg = getLeadSMS(name, clinic, preferred_time);
      results.lead_sms = await sendSMS(formattedPhone, leadMsg);
    }
  }

  // Send to reception
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

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  SKIN SOCIETE \u2014 Lead Automation Server      \u2551
\u2551  Running on port ${PORT}                        \u2551
\u2551                                              \u2551
\u2551  Webhook: /webhook                           \u2551
\u2551  Test:    POST /test-lead                    \u2551
\u2551  Health:  GET /                              \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
  `);
  console.log('Clinics configured:');
  console.log(`  Cottesloe  \u2014 Form: ${COTTESLOE_FORM_ID}`);
  console.log(`  Rockingham \u2014 Form: ${ROCKINGHAM_FORM_ID}`);
});
