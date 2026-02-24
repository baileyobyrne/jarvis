const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = '/root/.openclaw/workspace/geo-cache.json';
let cache = {};

if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE));
  } catch (e) {
    console.error('Error reading geo-cache:', e);
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocode(address) {
  if (!address) return null;
  const cleanAddr = address.trim();
  if (cache[cleanAddr]) return cache[cleanAddr];

  // Nominatim API requires a User-Agent and 1 req/sec limit
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanAddr + ', NSW, Australia')}&limit=1`;
  
  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'WilloughbyRealEstateBot/1.0 (mhenderson.property@gmail.com)'
        }
      };
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json && json.length > 0) {
              resolve({
                lat: parseFloat(json[0].lat),
                lon: parseFloat(json[0].lon)
              });
            } else {
              resolve(null);
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });

    if (result) {
      cache[cleanAddr] = result;
      saveCache();
    }
    
    // Respect rate limit
    await sleep(1100); 
    
    return result;
  } catch (error) {
    console.error(`Geocoding error for "${cleanAddr}":`, error.message);
    return null;
  }
}

function getDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c); // in metres
}

module.exports = { geocode, getDistance };
