require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // <-- ДОБАВЛЕНО

const app = express();

// ===== НАСТРОЙКИ =====
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Папка для загрузок
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Статика для загруженных файлов
app.use('/uploads', express.static(UPLOAD_DIR));

// ===== TELEGRAM BOT =====
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const pendingVerifications = new Map();
const failedAttempts = new Map();

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const payload = ctx.startPayload;
  if (!payload) {
    await ctx.reply("👋 Привет! Чтобы получить код, нажмите кнопку 'Получить код в Telegram' в приложении TradeTJ.");
    return;
  }
  const expectedPhone = payload.replace(/\D/g, '');
  if (expectedPhone.length < 10) {
    await ctx.reply("❌ Неверный формат номера.");
    return;
  }
  pendingVerifications.set(chatId, expectedPhone);
  await ctx.reply(
    `👋 Привет! Чтобы получить код для входа в TradeTJ, нажмите кнопку ниже.\n\nМы ожидаем номер: +${expectedPhone}`,
    {
      reply_markup: {
        keyboard: [[{ text: "📱 Поделиться номером телефона", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
});

bot.on('contact', async (ctx) => {
  const chatId = ctx.chat.id;
  const contact = ctx.message.contact;
  if (!contact || !contact.phone_number) {
    await ctx.reply("⚠️ Пожалуйста, поделитесь номером телефона через кнопку.");
    return;
  }
  const sharedPhone = contact.phone_number.replace(/\D/g, '');
  const expectedPhone = pendingVerifications.get(chatId);
  if (!expectedPhone) {
    await ctx.reply("️ Пожалуйста, сначала используйте ссылку из приложения TradeTJ.");
    return;
  }
  const isMatch = sharedPhone.endsWith(expectedPhone.slice(-10)) || sharedPhone === expectedPhone;
  if (isMatch) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await supabase.from('telegram_bindings').upsert(
      { telegram_id: chatId, phone: `+${sharedPhone}` },
      { onConflict: 'phone' }
    );
    await supabase.from('telegram_codes').insert({
      telegram_id: chatId,
      code: code,
      expires_at: expiresAt
    });
    pendingVerifications.delete(chatId);
    await ctx.reply(
      `✅ Ваш код для входа в TradeTJ: *${code}*\n\nВведите его в приложении. Код действителен 10 минут.`,
      { parse_mode: 'Markdown' }
    );
  } else {
    pendingVerifications.delete(chatId);
    await ctx.reply(
      `❌ Номер не совпадает.\nОжидался: +${expectedPhone}\nПолучен: +${sharedPhone}\n\nПожалуйста, начните процесс заново через приложение.`
    );
  }
});

// ===== SMS: Отправка кода =====
app.post('/api/send-sms', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await supabase.from('sms_codes').insert({
      phone: phone,
      code: code,
      expires_at: expiresAt
    });
    console.log(`📱 SMS код для ${phone}: ${code}`);
    res.json({ success: true, testCode: code });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== SMS: Проверка кода =====
app.post('/api/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Телефон и код обязательны' });
    const { data: codes, error: codeError } = await supabase
      .from('sms_codes')
      .select('*')
      .eq('phone', phone)
      .eq('code', code)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (codeError || !codes || codes.length === 0) {
      return res.status(400).json({ error: 'Неверный или истёкший код' });
    }
    const storedCode = codes[0];
    let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    if (!user) {
      const { data: newUser } = await supabase.from('users').insert([{ phone }]).select().single();
      user = newUser;
    }
    await supabase.from('sms_codes').update({ used: true }).eq('id', storedCode.id);
    res.json({ success: true, user: { id: user.id, phone: user.phone } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== TELEGRAM: Проверка кода (с защитой от brute-force) =====
app.post('/api/verify-telegram-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Телефон и код обязательны' });
    const { data: binding, error: bindingError } = await supabase
      .from('telegram_bindings')
      .select('telegram_id')
      .eq('phone', phone)
      .single();
    if (bindingError || !binding) {
      return res.status(400).json({ error: 'Номер не привязан к Telegram. Сначала получите код через бота.' });
    }
    const attempts = failedAttempts.get(binding.telegram_id) || { count: 0, lastAttempt: 0 };
    const now = Date.now();
    if (now - attempts.lastAttempt < 10 * 60 * 1000 && attempts.count >= 5) {
      return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 10 минут или запросите новый код.' });
    }
    const { data: codes, error: codeError } = await supabase
      .from('telegram_codes')
      .select('*')
      .eq('telegram_id', binding.telegram_id)
      .eq('code', code)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (codeError || !codes || codes.length === 0) {
      attempts.count++;
      attempts.lastAttempt = now;
      failedAttempts.set(binding.telegram_id, attempts);
      return res.status(400).json({ error: 'Неверный или истёкший код' });
    }
    const storedCode = codes[0];
    let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    if (!user) {
      const { data: newUser } = await supabase.from('users').insert([{ phone }]).select().single();
      user = newUser;
    }
    await supabase.from('telegram_codes').update({ used: true }).eq('id', storedCode.id);
    await supabase.from('telegram_codes').delete()
      .eq('telegram_id', binding.telegram_id)
      .eq('used', false);
    failedAttempts.delete(binding.telegram_id);
    res.json({ success: true, user: { id: user.id, phone: user.phone } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Пользователь: Получить данные (для аватарки) =====
app.get('/api/users/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Пользователь: Обновить аватарку =====
app.put('/api/users/:userId/avatar', async (req, res) => {
  try {
    const { avatar_url } = req.body;
    if (!avatar_url) return res.status(400).json({ error: 'avatar_url обязателен' });
    
    const { data, error } = await supabase
      .from('users')
      .update({ avatar_url })
      .eq('id', req.params.userId)
      .select()
      .single();
      
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Объявления: Получить список =====
app.get('/api/listings', async (req, res) => {
  try {
    let query = supabase.from('listings').select('*');
    if (req.query.user_id) query = query.eq('user_id', req.query.user_id);
    if (req.query.category) query = query.eq('category', req.query.category);
    if (req.query.search) query = query.ilike('title', `%${req.query.search}%`);
    if (req.query.price_from) query = query.gte('price', req.query.price_from);
    if (req.query.price_to) query = query.lte('price', req.query.price_to);
    if (req.query.sort === 'Дешевле') query = query.order('price', { ascending: true });
    if (req.query.sort === 'Дороже') query = query.order('price', { ascending: false });
    if (req.query.sort === 'По дате') query = query.order('created_at', { ascending: false });
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Объявления: Создать =====
app.post('/api/listings', async (req, res) => {
  try {
    // ДОБАВИЛИ city в конце
    const { user_id, title, price, description, category, images, image_url, phone, latitude, longitude, city } = req.body; 
    if (!user_id || !title || !price) return res.status(400).json({ error: 'user_id, title и price обязательны' });
    const { data, error } = await supabase.from('listings').insert([{
      user_id, title, price, description, category, images, image_url, phone, latitude, longitude, 
      city // <-- ДОБАВИЛИ city сюда
    }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Объявления: Удалить =====
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('listings').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Загрузка файлов в Supabase Storage =====
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    
    const fs = require('fs');
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileName = `${Date.now()}-${req.file.originalname}`;
    
    // Загружаем файл в Supabase Storage
    const { data, error } = await supabase.storage
      .from('listings')
      .upload(fileName, fileBuffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false
      });
    
    // Удаляем временный файл с сервера
    fs.unlinkSync(req.file.path);
    
    if (error) throw error;
    
    // Получаем публичный URL
    const { data: { publicUrl } } = supabase.storage
      .from('listings')
      .getPublicUrl(fileName);
    
    res.json({ url: publicUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Избранное: Получить =====
app.get('/api/favorites/:user_id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('favorites').select('listing_id').eq('user_id', req.params.user_id);
    if (error) throw error;
    res.json(data.map(f => f.listing_id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Избранное: Добавить =====
app.post('/api/favorites', async (req, res) => {
  try {
    const { user_id, listing_id } = req.body;
    if (!user_id || !listing_id) return res.status(400).json({ error: 'user_id и listing_id обязательны' });
    const { data, error } = await supabase.from('favorites').insert([{ user_id, listing_id }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Избранное: Удалить =====
app.delete('/api/favorites/:user_id/:listing_id', async (req, res) => {
  try {
    const { error } = await supabase.from('favorites').delete()
      .eq('user_id', req.params.user_id)
      .eq('listing_id', req.params.listing_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Сообщения: Получить =====
app.get('/api/messages', async (req, res) => {
  try {
    const { user1, user2, listing_id } = req.query;
    if (!user1 || !user2) return res.status(400).json({ error: 'user1 и user2 обязательны' });
    
    const orCondition = `and(sender_id.eq.${user1},receiver_id.eq.${user2}),and(sender_id.eq.${user2},receiver_id.eq.${user1})`;
    
    let query = supabase.from('messages').select('*').or(orCondition);
    
    if (listing_id && listing_id !== 'null' && listing_id !== 'undefined') {
      query = query.eq('listing_id', listing_id);
    }
    
    const { data, error } = await query.order('created_at', { ascending: true });
    
    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }
    
    res.json(data || []);
  } catch (error) {
    console.error('Server error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== Сообщения: Отправить =====
app.post('/api/messages', async (req, res) => {
  try {
    const { sender_id, receiver_id, listing_id, content, image_url, audio_url, audio_duration } = req.body;
    if (!sender_id || !receiver_id) return res.status(400).json({ error: 'sender_id и receiver_id обязательны' });
    const { data, error } = await supabase.from('messages').insert([{
      sender_id, receiver_id, listing_id, content, image_url, audio_url, audio_duration
    }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Диалоги: Получить список =====
app.get('/api/conversations/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`sender_id.eq.${req.params.userId},receiver_id.eq.${req.params.userId}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const conversations = [];
    const seen = new Set();
    for (const msg of (data || [])) {
      const key = `${msg.sender_id}-${msg.receiver_id}-${msg.listing_id}`;
      const reverseKey = `${msg.receiver_id}-${msg.sender_id}-${msg.listing_id}`;
      if (!seen.has(key) && !seen.has(reverseKey)) {
        seen.add(key);
        conversations.push(msg);
      }
    }
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================================
// ===== НЕЙРОСЕТЬ (ИИ): Генерация описания ================
// ==========================================================
app.post('/api/ai/generate', async (req, res) => {
  try {
    const { title, category, price } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Название товара обязательно' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'API ключ нейросети не настроен на сервере' });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

    const prompt = `
      Ты — профессиональный копирайтер маркетплейса TradeTJ (Таджикистан).
      Напиши продающее, но честное описание для объявления.
      
      Название товара: ${title}
      Категория: ${category || 'Не указана'}
      Цена: ${price || 'Не указана'}
      
      Требования:
      1. Длина: 3-4 предложения.
      2. Пиши от первого лица (например, "Продаю...", "Отличное состояние...").
      3. Выдели главные преимущества (состояние, комплектация, причина продажи).
      4. В конце добавь призыв к действию (например, "Пишите в чат", "Звоните").
      5. Без лишних смайликов, максимум 1-2.
      6. Пиши на русском языке.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ text: text.trim() });

  } catch (error) {
    console.error('AI Error:', error);
    res.status(500).json({ error: 'Не удалось сгенерировать описание. Попробуйте позже.' });
  }
});
// ==========================================================

// ===== TELEGRAM WEBHOOK =====
const webhookPath = `/webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
app.use(bot.webhookCallback(webhookPath));

// ===== Тестовый роут =====
app.get('/', (req, res) => {
  res.send(' TradeTJ Backend & Telegram Bot are running!');
});

// ===== ЗАПУСК =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(` Telegram webhook: ${webhookPath}`);
});
