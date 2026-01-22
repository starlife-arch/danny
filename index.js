const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Initialize Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Initialize Telegram Bot
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Store conversations and mappings
const conversations = new Map(); // Stores by phone digits without + (254762725066)
const telegramToWhatsAppMap = new Map(); // Maps Telegram message ID -> WhatsApp number with + (+254762725066)

// Helper function to format WhatsApp numbers correctly
function formatWhatsAppNumber(phone) {
  // Remove any existing whatsapp: prefix
  phone = phone.replace('whatsapp:', '');
  
  // Remove any extra plus signs
  phone = phone.replace(/\++/g, '');
  
  // Ensure it starts with exactly one +
  if (!phone.startsWith('+')) {
    phone = '+' + phone;
  }
  
  return `whatsapp:${phone}`;
}

// Helper function to extract phone digits (without +)
function extractPhoneDigits(phone) {
  return phone.replace('whatsapp:', '').replace('+', '');
}

// ===== 1. FORWARD WHATSAPP MESSAGES TO TELEGRAM =====
app.post('/whatsapp', async (req, res) => {
  const customerMessage = req.body.Body;
  const customerNumber = req.body.From; // whatsapp:+254762725066
  const messageSid = req.body.MessageSid;
  
  console.log('\n📨 NEW WHATSAPP MESSAGE:');
  console.log(`Raw From: ${customerNumber}`);
  console.log(`Message: ${customerMessage}`);
  
  // Extract phone number without whatsapp: prefix but with +
  const phoneWithPlus = customerNumber.replace('whatsapp:', ''); // +254762725066
  const phoneDigits = extractPhoneDigits(customerNumber); // 254762725066
  
  console.log(`Phone with +: ${phoneWithPlus}`);
  console.log(`Phone digits: ${phoneDigits}`);
  
  // Store message locally
  if (!conversations.has(phoneDigits)) {
    conversations.set(phoneDigits, []);
  }
  
  conversations.get(phoneDigits).push({
    type: 'customer',
    message: customerMessage,
    time: new Date(),
    messageId: messageSid
  });
  
  // Forward to Telegram
  try {
    const telegramMessage = await telegramBot.sendMessage(
      process.env.TELEGRAM_CHAT_ID,
      `📱 *New WhatsApp Message*\n\n` +
      `*From:* ${phoneWithPlus}\n` +
      `*Message:* ${customerMessage}\n\n` +
      `_Reply to this message to respond_`,
      { parse_mode: 'Markdown' }
    );
    
    // Store mapping: Telegram message ID -> WhatsApp number (with +)
    telegramToWhatsAppMap.set(telegramMessage.message_id, phoneWithPlus);
    
    console.log(`✅ Forwarded to Telegram (Message ID: ${telegramMessage.message_id})`);
    console.log(`Stored mapping: ${telegramMessage.message_id} -> ${phoneWithPlus}`);
  } catch (error) {
    console.error('❌ Failed to forward to Telegram:', error.message);
  }
  
  // Send auto-reply to WhatsApp
  const twiml = new twilio.twiml.MessagingResponse();
  
  const lowerMessage = customerMessage.toLowerCase();
  if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
    twiml.message(`Hello! 👋 Our agent will reply shortly via Telegram.`);
  } else {
    twiml.message(`Thanks for your message! Our support team has been notified and will reply shortly.`);
  }
  
  res.type('text/xml').send(twiml.toString());
});

// ===== 2. LISTEN FOR TELEGRAM REPLIES =====
telegramBot.on('message', async (msg) => {
  // Check if this is a reply to a forwarded WhatsApp message
  if (msg.reply_to_message) {
    const originalMessageId = msg.reply_to_message.message_id;
    const whatsappNumber = telegramToWhatsAppMap.get(originalMessageId);
    
    if (whatsappNumber && msg.text) {
      console.log(`\n📨 TELEGRAM REPLY DETECTED:`);
      console.log(`Original Telegram Message ID: ${originalMessageId}`);
      console.log(`WhatsApp Number from mapping: ${whatsappNumber}`);
      console.log(`Reply text: ${msg.text}`);
      
      try {
        // Format the number correctly
        const formattedNumber = formatWhatsAppNumber(whatsappNumber);
        console.log(`Formatted for Twilio: ${formattedNumber}`);
        
        // Send reply via Twilio WhatsApp
        const result = await client.messages.create({
          body: msg.text,
          from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
          to: formattedNumber
        });
        
        // Extract digits for storage
        const phoneDigits = extractPhoneDigits(whatsappNumber);
        
        // Store in conversations
        if (!conversations.has(phoneDigits)) {
          conversations.set(phoneDigits, []);
        }
        
        conversations.get(phoneDigits).push({
          type: 'agent',
          message: msg.text,
          time: new Date(),
          messageId: result.sid,
          via: 'telegram'
        });
        
        console.log(`✅ Reply sent via WhatsApp (SID: ${result.sid})`);
        
        // Confirm in Telegram
        await telegramBot.sendMessage(
          msg.chat.id,
          `✅ Reply sent to ${whatsappNumber}`,
          { reply_to_message_id: msg.message_id }
        );
        
      } catch (error) {
        console.error('❌ Failed to send WhatsApp reply:', error);
        await telegramBot.sendMessage(
          msg.chat.id,
          `❌ Failed to send: ${error.message}`
        );
      }
    } else {
      console.log(`❌ No mapping found for Telegram message ID: ${originalMessageId}`);
      console.log(`Available mappings:`, Array.from(telegramToWhatsAppMap.entries()));
    }
  }
  
  // Handle commands
  if (msg.text === '/start') {
    await telegramBot.sendMessage(
      msg.chat.id,
      `🤖 *WhatsApp Support Bot*\n\n` +
      `I forward WhatsApp messages here and let you reply via Telegram.\n\n` +
      `*How to use:*\n` +
      `1. Customers message your WhatsApp number\n` +
      `2. Messages appear here\n` +
      `3. Reply to any message to respond\n` +
      `4. Your reply goes back to WhatsApp\n\n` +
      `Active conversations: ${conversations.size}`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (msg.text === '/status') {
    await telegramBot.sendMessage(
      msg.chat.id,
      `📊 *Bot Status*\n\n` +
      `Active conversations: ${conversations.size}\n` +
      `WhatsApp number: ${process.env.TWILIO_WHATSAPP_NUMBER}\n` +
      `Mappings stored: ${telegramToWhatsAppMap.size}`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (msg.text === '/debug') {
    await telegramBot.sendMessage(
      msg.chat.id,
      `🔍 *Debug Info*\n\n` +
      `Conversations: ${JSON.stringify(Array.from(conversations.entries()).slice(0, 3), null, 2)}\n\n` +
      `Mappings: ${JSON.stringify(Array.from(telegramToWhatsAppMap.entries()).slice(0, 5), null, 2)}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ===== 3. SEND MESSAGE VIA API (KEEP EXISTING) =====
app.post('/send', async (req, res) => {
  try {
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({ error: 'Missing "to" or "message"' });
    }
    
    // Format the number correctly
    const formattedTo = formatWhatsAppNumber(to);
    
    console.log(`\n📤 MANUAL SEND TO: ${formattedTo}`);
    console.log(`Message: ${message}`);
    
    const result = await client.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: formattedTo
    });
    
    // Extract digits for storage
    const phoneDigits = extractPhoneDigits(to);
    
    // Store sent message
    if (!conversations.has(phoneDigits)) {
      conversations.set(phoneDigits, []);
    }
    
    conversations.get(phoneDigits).push({
      type: 'agent',
      message: message,
      time: new Date(),
      messageId: result.sid,
      via: 'dashboard'
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

// ===== 4. GET CONVERSATIONS =====
app.get('/conversations', (req, res) => {
  const allConversations = {};
  
  conversations.forEach((messages, phone) => {
    allConversations[phone] = messages;
  });
  
  res.json({
    total: conversations.size,
    conversations: allConversations,
    mappings: telegramToWhatsAppMap.size
  });
});

// ===== 5. WEB INTERFACE =====
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp + Telegram Bot</title>
      <style>
        body { font-family: Arial; padding: 20px; max-width: 800px; margin: 0 auto; }
        h1 { color: #25D366; }
        .telegram-info { background: #0088cc; color: white; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .telegram-info a { color: white; text-decoration: underline; }
        .conversation { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 8px; }
        .customer { background: #f8f9fa; padding: 8px; margin: 5px 0; border-radius: 5px; }
        .agent { background: #e7f3ff; padding: 8px; margin: 5px 0; border-radius: 5px; }
        .customer strong { color: #d63384; }
        .agent strong { color: #0d6efd; }
        .via { font-size: 12px; color: #666; margin-left: 10px; }
        .debug { background: #f8d7da; padding: 10px; border-radius: 5px; margin: 10px 0; }
        form { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
        input, textarea { display: block; margin: 10px 0; padding: 10px; width: 100%; max-width: 400px; }
        button { padding: 10px 20px; background: #25D366; color: white; border: none; border-radius: 5px; cursor: pointer; }
        button:hover { background: #1da851; }
        .secondary { background: #6c757d; }
        .secondary:hover { background: #5a6268; }
      </style>
    </head>
    <body>
      <h1>📱 WhatsApp + Telegram Bot</h1>
      <p>Using Twilio Number: ${process.env.TWILIO_WHATSAPP_NUMBER}</p>
      
      <div class="telegram-info">
        <h3>🤖 Telegram Integration Active</h3>
        <p><strong>How to reply:</strong></p>
        <ol>
          <li>Open Telegram app</li>
          <li>Go to your bot</li>
          <li>Reply to any forwarded message</li>
          <li>Your reply will be sent to WhatsApp automatically</li>
        </ol>
        <p>Commands: /start, /status, /debug</p>
      </div>
      
      <div class="debug">
        <h3>🔧 Debug Info</h3>
        <p><strong>Note:</strong> Fixed double-plus sign issue. Now formatting numbers correctly.</p>
        <p>Expected format: <code>whatsapp:+254762725066</code></p>
        <p>Wrong format (fixed): <code>whatsapp:++254762725066</code></p>
      </div>
      
      <h2>Send Test Message</h2>
      <form id="sendForm">
        <input type="text" id="to" placeholder="Customer phone (e.g., +254712345678)" required>
        <textarea id="message" placeholder="Your message..." rows="3" required></textarea>
        <button type="submit">📤 Send WhatsApp Message</button>
      </form>
      
      <h2>Recent Conversations (<span id="count">0</span>)</h2>
      <div id="conversations">Loading...</div>
      
      <script>
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
                      \${msg.message}
                      \${msg.via ? '<span class="via">(via ' + msg.via + ')</span>' : ''}<br>
                      <small>\${new Date(msg.time).toLocaleString()}</small>
                    </div>
                  \`).join('')}
                </div>
              \`;
            }
            
            container.innerHTML = html;
          } catch (error) {
            console.error('Error loading conversations:', error);
          }
        }
        
        // Send message from form
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
        
        // Auto-refresh every 5 seconds
        loadConversations();
        setInterval(loadConversations, 5000);
      </script>
    </body>
    </html>
  `);
});

// ===== 6. HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date(),
    conversations: conversations.size,
    mappings: telegramToWhatsAppMap.size,
    telegram: telegramBot.isPolling() ? 'connected' : 'disconnected',
    twilio: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'missing'
  });
});

// ===== 7. START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const herokuUrl = process.env.HEROKU_APP_NAME 
    ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`
    : `http://localhost:${PORT}`;
  
  console.log(`
🚀 WhatsApp + Telegram Bot Started!
📞 Twilio Number: ${process.env.TWILIO_WHATSAPP_NUMBER}
🤖 Telegram Bot: Active
🌐 Dashboard: ${herokuUrl}
📨 Webhook: ${herokuUrl}/whatsapp
🏥 Health Check: ${herokuUrl}/health

✅ Setup Instructions:
1. Message your WhatsApp sandbox number
2. Check Telegram for the forwarded message
3. Reply in Telegram (to the specific message)
4. Reply goes back to WhatsApp automatically

📋 Telegram Commands:
/start - Show help
/status - Check bot status
/debug - Show debug info

🔄 Phone Number Formatting Fixed:
- Input: whatsapp:+254762725066
- Stored as digits: 254762725066
- Stored in mapping: +254762725066
- Formatted for Twilio: whatsapp:+254762725066
  `);
});

// Handle errors
telegramBot.on('error', (error) => {
  console.error('Telegram Bot Error:', error);
});
