async function fetchREAListings(channel) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch('https://lexa.realestate.com.au/graphql?operationName=getSearchResults', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'da2-tqoyjxogtbhjljohnwmomlgyea',
          'x-caller-id': 'rea-search',
          'accept': '*/*',
          'accept-language': 'en-AU,en;q=0.9',
          'origin': 'https://www.realestate.com.au',
          'referer': 'https://www.realestate.com.au/buy/in-willoughby,+nsw+2068/list-1',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site'
        },
        body: JSON.stringify({
          operationName: "getSearchResults",
          variables: {
            query: {
              channel: channel,
              filters: { surroundingSuburbs: false, excludeNoSalePrice: false, furnished: false, petsAllowed: false },
              localities: [{ searchLocation: "Willoughby, NSW 2068" }],
              sort: { sortKey: "LISTED_DATE", direction: "DESCENDING" }
            },
            page: 1,
            pageSize: 25
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: "bf5f7f668de4a4a94e61ea2c6e4cdb97dda4bfac95dfb43d0bd28ad86fa6ffde"
            }
          }
        })
      });

      if (res.status === 429) {
        const wait = attempt * 15000; // 15s, 30s, 45s
        console.log(`Rate limited (429). Waiting ${wait/1000}s before retry ${attempt}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) throw new Error(`Lexa HTTP ${res.status}`);
      const data = await res.json();
      return data?.data?.getLiveListingsWithMap?.results ||
             data?.data?.getSearchResults?.results ||
             data?.data?.results || [];

    } catch (e) {
      if (attempt === maxRetries) throw e;
      console.log(`Attempt ${attempt} failed: ${e.message}. Retrying...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return [];
}
module.exports = { fetchREAListings };
