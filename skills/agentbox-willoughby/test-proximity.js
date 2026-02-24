const { getProximityContacts } = require('./get-contacts.js');

async function runTest() {
  const address = '30 Rosewall Street, Willoughby';
  console.log('--- Starting Sequential Proximity Test ---');
  console.log('Target:', address);
  console.log('Timestamp:', new Date().toISOString());
  
  try {
    const results = await getProximityContacts(address, 3);
    
    console.log('\n--- Results ---');
    results.forEach((c, i) => {
      console.log(`${i + 1}. ${c.name}`);
      console.log(`   Address: ${c.address}`);
      console.log(`   Distance: ${c.distance}m`);
      console.log(`   Score: ${c.score}`);
    });
    console.log('\nTest completed successfully at:', new Date().toISOString());
  } catch (err) {
    console.error('Test failed:', err);
  }
}

runTest();
