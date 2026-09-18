const ollama = require('ollama').default || require('ollama');

async function testOllamaConnection() {
  console.log('🔄 Testing Ollama Node.js client connection with tinyllama...');
  
  try {
    const response = await ollama.chat({
      model: 'tinyllama',
      messages: [
        {
          role: 'user',
          content: 'Return only this JSON, no other text: {"status": "ok", "note": "test"}'
        }
      ]
    });

    console.log('✅ Ollama Raw Response Received:');
    console.log(response.message.content);
  } catch (error) {
    console.error('❌ Error connecting to Ollama:', error.message);
  }
}

testOllamaConnection();
