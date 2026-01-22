const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Store conversations
const conversations = new Map();

// ===== WEBHOOK: When customer sends message =====
app.post('/whatsapp', (req, res) => {
  const customerMessage = req.body.Body;
  const customerNumber = req.body.From; // whatsapp:+254712345678
  const messageSid = req.body.MessageSid;
  
  console.log('\n📨 NEW MESSAGE FROM CUSTOMER:');
  console.log(`From: ${customerNumber}`);
  console.log(`Message: ${customerMessage}`);
  
  // Extract clean phone number
  const cleanPhone = customerNumber.replace('whatsapp:', '');
  const phoneDigits = cleanPhone.replace('+', '');
  
  // Store message
  if (!conversations.has(phoneDigits)) {
    conversations.set(phoneDigits, []);
  }
  
  conversations.get(phoneDigits).push({
    type: 'customer',
    message: customerMessage,
    time: new Date(),
    messageId: messageSid
  });
  
  // Auto-reply
  const twiml = new twilio.twiml.MessagingResponse();
  
  // Customize auto-reply based on message
  const lowerMessage = customerMessage.toLowerCase();
  
  if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
    twiml.message(`Hello! 👋 Welcome to our service. How can I help you?`);
  } 
  else if (lowerMessage.includes('price') || lowerMessage.includes('cost')) {
    twiml.message(`Our pricing starts at $10/month. Interested in more details?`);
  }
  else if (lowerMessage.includes('contact') || lowerMessage.includes('support')) {
    twiml.message(`Contact support: support@example.com or call +254712345678`);
  }
  else if (lowerMessage.includes('menu')) {
    twiml.message(`📋 Menu:\n1. Pricing\n2. Support\n3. Services\n4. About us\n\nReply with number or question.`);
  }
  else {
    twiml.message(`Thanks for your message! An agent will reply soon.`);
  }
  
  res.type('text/xml').send(twiml.toString());
  
  // Log to console
  console.log(`💬 Sent auto-reply to: ${cleanPhone}`);
});

// ===== SEND MESSAGE TO CUSTOMER =====
app.post('/send', async (req, res) => {
  try {
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({ error: 'Missing "to" or "message"' });
    }
    
    // Format: +254712345678 -> whatsapp:+254712345678
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    
    console.log(`\n📤 SENDING MESSAGE TO: ${formattedTo}`);
    console.log(`Message: ${message}`);
    
    const result = await client.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: formattedTo
    });
    
    // Store sent message
    const phoneDigits = to.replace('+', '').replace('whatsapp:', '');
    if (!conversations.has(phoneDigits)) {
      conversations.set(phoneDigits, []);
    }
    
    conversations.get(phoneDigits).push({
      type: 'agent',
      message: message,
      time: new Date(),
      messageId: result.sid
    });
    
    console.log(`✅ Message sent! SID: ${result.sid}`);
    
    res.json({
      success: true,
      messageId: result.sid,
      status: result.status,
      conversationId: phoneDigits
    });
    
  } catch (error) {
    console.error('❌ Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== GET CONVERSATIONS =====
app.get('/conversations', (req, res) => {
  const allConversations = {};
  
  conversations.forEach((messages, phone) => {
    allConversations[phone] = messages;
  });
  
  res.json({
    total: conversations.size,
    conversations: allConversations
  });
});

// ===== WEB INTERFACE =====
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Bot Dashboard</title>
      <style>
        body { font-family: Arial; padding: 20px; max-width: 800px; margin: 0 auto; }
        h1 { color: #25D366; }
        .conversation { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 8px; }
        .customer { background: #f8f9fa; padding: 8px; margin: 5px 0; border-radius: 5px; }
        .agent { background: #e7f3ff; padding: 8px; margin: 5px 0; border-radius: 5px; }
        .customer strong { color: #d63384; }
        .agent strong { color: #0d6efd; }
        form { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
        input, textarea { display: block; margin: 10px 0; padding: 10px; width: 100%; max-width: 400px; }
        button { padding: 10px 20px; background: #25D366; color: white; border: none; border-radius: 5px; cursor: pointer; }
        button:hover { background: #1da851; }
        .status { color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
      <h1>📱 WhatsApp Bot Dashboard</h1>
      <p class="status">Using Twilio Number: ${process.env.TWILIO_WHATSAPP_NUMBER}</p>
      
      <h2>Send Message</h2>
      <form id="sendForm">
        <input type="text" id="to" placeholder="Customer phone (e.g., +254712345678)" required>
        <textarea id="message" placeholder="Your message..." rows="3" required></textarea>
        <button type="submit">📤 Send WhatsApp Message</button>
      </form>
      
      <h2>Recent Conversations (<span id="count">0</span>)</h2>
      <div id="conversations">Loading...</div>
      
      <script>
        // Send message
        document.getElementById('sendForm').onsubmit = async (e) => {
          e.preventDefault();
          const to = document.getElementById('to').value;
          const message = document.getElementById('message').value;
          
          const response = await fetch('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, message })
          });
          
          const result = await response.json();
          if (result.success) {
            alert('✅ Message sent successfully!');
            document.getElementById('message').value = '';
            loadConversations();
          } else {
            alert('❌ Error: ' + result.error);
          }
        };
        
        // Load conversations
        async function loadConversations() {
          try {
            const response = await fetch('/conversations');
            const data = await response.json();
            
            const container = document.getElementById('conversations');
            const countSpan = document.getElementById('count');
            
            countSpan.textContent = data.total || 0;
            
            if (data.total === 0) {
              container.innerHTML = '<p>No conversations yet.</p>';
              return;
            }
            
            let html = '';
            
            for (const [phone, messages] of Object.entries(data.conversations)) {
              html += \`
                <div class="conversation">
                  <h3>📞 +<span>\${phone}</span></h3>
                  \${messages.map(msg => \`
                    <div class="\${msg.type}">
                      <strong>\${msg.type.toUpperCase()}:</strong> 
                      \${msg.message}<br>
                      <small>\${new Date(msg.time).toLocaleString()}</small>
                    </div>
                  \`).join('')}
                  <hr>
                  <input type="text" id="reply-\${phone}" placeholder="Reply to +<span>\${phone}</span>">
                  <button onclick="sendReply('\${phone}')">Reply</button>
                </div>
              \`;
            }
            
            container.innerHTML = html;
          } catch (error) {
            console.error('Error loading conversations:', error);
          }
        }
        
        // Send reply from conversation view
        async function sendReply(phone) {
          const messageInput = document.getElementById('reply-' + phone);
          const message = messageInput.value.trim();
          
          if (!message) {
            alert('Please enter a message');
            return;
          }
          
          const response = await fetch('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: '+' + phone, message })
          });
          
          const result = await response.json();
          if (result.success) {
            alert('✅ Reply sent!');
            messageInput.value = '';
            loadConversations();
          } else {
            alert('❌ Error: ' + result.error);
          }
        }
        
        // Auto-refresh every 5 seconds
        loadConversations();
        setInterval(loadConversations, 5000);
      </script>
    </body>
    </html>
  `);
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 WhatsApp Bot Server Started!
📞 Twilio Number: ${process.env.TWILIO_WHATSAPP_NUMBER}
🌐 Dashboard: http://localhost:${PORT}
📨 Webhook: http://localhost:${PORT}/whatsapp

✅ Test Instructions:
1. Message the sandbox number from WhatsApp
2. See messages appear in console
3. Use dashboard to reply
4. Customer sees messages from Twilio number (not your number)
  `);
});
