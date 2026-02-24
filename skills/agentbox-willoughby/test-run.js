require('dotenv').config({ path: '../../.env' });
const { getProximityContacts } = require('./get-contacts.js');
const { loadRPData, normalise, normaliseSuburb, calculatePropensityScore, categorizePropertyType } = require('./data-merger.js');
const { OpenAI } = require('openai');
const https = require('https');
const fs = require('fs');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return console.log('Telegram not configured');
  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resolve);
    req.write(body);
    req.end();
  });
}

async function generateCallStrategy(contact, listingAddress, details) {
  const distStr = contact.distance !== null ? `${contact.distance}m` : 'nearby';
  const prompt = `
You are a highly strategic real estate analyst. Generate a punchy, 1-sentence strategic reason to call this contact because a new property has just been listed/sold nearby.

LISTING DETAILS:
- Address: ${listingAddress}
- Suburb: Willoughby
- Type: ${details.bedrooms} bed, ${details.bathrooms} bath, ${details.carspaces} car
- Price: ${details.price}
- Status: NEW LISTING

CONTACT DATA:
- Name: ${contact.name}
- Address: ${contact.address || 'Unknown'}
- Proximity: ${distStr}
- Tenure: ${contact.tenure} years owned
- Occupancy: ${contact.occupancy}
- Classification: ${contact.contactClass}

GOAL: Provide exactly ONE punchy, strategic reason to call them. Focus on their tenure or occupancy. Output ONLY the 1-sentence strategy.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.7
    });
    return response.choices[0].message.content.trim().replace(/^"|"$/g, '');
  } catch (e) {
    return `Owned for ${contact.tenure} years; check if they're considering their next move given the proximity of ${listingAddress}.`;
  }
}

async function runTest() {
  const mockProperty = {
    address: "41 Tyneside Avenue, Willoughby, NSW",
    propertyType: "House",
    bedrooms: 5,
    bathrooms: 3,
    carspaces: 2,
    price: "Auction"
  };

  console.log("Starting Mock Test Run (with Willoughby Synonym Matching)...");
  const rpMap = await loadRPData();
  console.log(`Loaded ${rpMap.size} properties from RP Data.`);

  const listingCategory = categorizePropertyType(mockProperty.propertyType);
  console.log(`Listing Category: ${listingCategory}`);

  // Fetch contacts within 1500m
  const proximityContacts = await getProximityContacts(mockProperty.address, 200);
  console.log(`Found ${proximityContacts.length} contacts within 1500m.`);

  const scoredContacts = proximityContacts.map(c => {
    // Correctly using normaliseSuburb to match synonymous suburbs
    const key = normalise(c.address) + '|' + normaliseSuburb(c.suburb || 'Willoughby');
    const rpData = rpMap.get(key);
    
    if (!rpData) return null;
    const contactCategory = categorizePropertyType(rpData.propertyType);
    if (contactCategory !== listingCategory) return null;

    const { score, tenure, occupancy } = calculatePropensityScore(c, rpData, c.score);
    return { ...c, propensityScore: score, tenure, occupancy, propertyType: rpData.propertyType };
  }).filter(Boolean);

  const top30 = scoredContacts
    .sort((a, b) => b.propensityScore - a.propensityScore)
    .slice(0, 30);

  console.log(`Matched ${top30.length} contacts after filters. Generating strategies...`);

  const contactBlocks = [];
  for (let i = 0; i < top30.length; i++) {
    const c = top30[i];
    const distStr = c.distance !== null ? ` (${c.distance}m)` : '';
    const angle = await generateCallStrategy(c, mockProperty.address, mockProperty);
    
    contactBlocks.push(
      `<b>${c.name}</b> | <code>${c.mobile}</code>\n` +
      `${c.address || '—'}${distStr}\n` +
      `📊 Intel: ${c.tenure}yrs owned | ${c.occupancy}\n` +
      `🎯 Angle: ${angle}`
    );
    process.stdout.write('.');
  }
  console.log('\nDone generating strategies.');

  const divider = '──────────────────';
  const headerMsg =
    `🏠 <b>MOCK TEST: NEW LISTING</b>\n` +
    `${divider}\n` +
    `📍 <b>${mockProperty.address}</b>\n` +
    `💰 <b>${mockProperty.price}</b>\n` +
    `🛏 ${mockProperty.bedrooms} bed  │  🚿 ${mockProperty.bathrooms} bath  │  🚗 ${mockProperty.carspaces} car\n` +
    `${divider}\n\n` +
    `📋 <b>Top ${top30.length} Strategic Contacts:</b>`;

  await sendTelegram(headerMsg);

  for (let i = 0; i < contactBlocks.length; i += 5) {
    const chunk = contactBlocks.slice(i, i + 5).join('\n\n');
    await sendTelegram(chunk);
  }

  console.log("Test results sent to Telegram.");
}

runTest().catch(console.error);
