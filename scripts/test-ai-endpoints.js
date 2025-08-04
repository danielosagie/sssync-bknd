/**
 * Test script to debug AI server endpoints
 */

const EMBEDDING_SERVER_URL = 'https://danielosagie--anora-ai-server-v2-aimodel-web-app-dev.modal.run';

async function testEndpoints() {
  console.log('🧪 Testing AI Server Endpoints...\n');

  // Test health endpoint
  try {
    console.log('1️⃣ Testing health endpoint...');
    const healthResponse = await fetch(`${EMBEDDING_SERVER_URL}/health`);
    console.log(`   Status: ${healthResponse.status}`);
    if (healthResponse.ok) {
      const healthData = await healthResponse.json();
      console.log('   ✅ Health check passed');
      console.log('   Models:', healthData.models);
    } else {
      console.log('   ❌ Health check failed');
    }
  } catch (error) {
    console.log('   ❌ Health check error:', error.message);
  }

  console.log();

  // Test image embedding (should work)
  try {
    console.log('2️⃣ Testing image embedding...');
    
    // Simple 1x1 red pixel as base64
    const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    
    const imageResponse = await fetch(`${EMBEDDING_SERVER_URL}/embed/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_data: testImageBase64,
        instruction: 'Test image encoding'
      })
    });

    console.log(`   Status: ${imageResponse.status}`);
    if (imageResponse.ok) {
      const imageData = await imageResponse.json();
      console.log('   ✅ Image embedding success');
      console.log(`   Dimensions: ${imageData.dimension}`);
      console.log(`   Model: ${imageData.model}`);
    } else {
      const errorText = await imageResponse.text();
      console.log('   ❌ Image embedding failed');
      console.log(`   Error: ${errorText}`);
    }
  } catch (error) {
    console.log('   ❌ Image embedding error:', error.message);
  }

  console.log();

  // Test text embedding (likely failing)
  try {
    console.log('3️⃣ Testing text embedding...');
    
    const textResponse = await fetch(`${EMBEDDING_SERVER_URL}/embed/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts: ['Test product for embedding'],
        instruction: 'Test text encoding',
        normalize: true
      })
    });

    console.log(`   Status: ${textResponse.status}`);
    if (textResponse.ok) {
      const textData = await textResponse.json();
      console.log('   ✅ Text embedding success');
      console.log(`   Dimensions: ${textData.dimension}`);
      console.log(`   Model: ${textData.model}`);
    } else {
      const errorText = await textResponse.text();
      console.log('   ❌ Text embedding failed');
      console.log(`   Error: ${errorText}`);
    }
  } catch (error) {
    console.log('   ❌ Text embedding error:', error.message);
  }

  console.log();

  // Test API endpoints list
  try {
    console.log('4️⃣ Testing root endpoint...');
    const rootResponse = await fetch(`${EMBEDDING_SERVER_URL}/`);
    console.log(`   Status: ${rootResponse.status}`);
    if (rootResponse.ok) {
      const rootData = await rootResponse.json();
      console.log('   ✅ Root endpoint success');
      console.log('   Available endpoints:', Object.keys(rootData.endpoints || {}));
    } else {
      console.log('   ❌ Root endpoint failed');
    }
  } catch (error) {
    console.log('   ❌ Root endpoint error:', error.message);
  }

  console.log('\n🏁 Testing completed!');
}

testEndpoints().catch(console.error);