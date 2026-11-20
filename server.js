require('dotenv').config();
const admin = require('firebase-admin');

// Проверяем, есть ли переменная с ключом
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin успешно инициализирован!');
  } catch (error) {
    console.error('❌ Ошибка парсинга ключа Firebase:', error.message);
  }
} else {
  console.log('⚠️ Переменная FIREBASE_SERVICE_ACCOUNT не найдена!');
}
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { Telegraf } = require('telegraf');
const jwt = require('jsonwebtoken'); // <-- ДОБАВЛЕНО
const { GoogleGenerativeAI } = require('@google/generative-ai'); // <-- ДОБАВЛЕНО
const ADMIN_ID = '5dac82e8-6c01-4f5e-865b-69d817a727cc'; // Твой секретный ID

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET not set in environment');
  process.exit(1);
}

// Auth middleware
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен аутентификации не предоставлен' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.sub;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
};

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
const smsCooldowns = new Map();

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
    
    // Убрали testCode из ответа! Теперь код виден только в логах сервера.
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== SMS: Проверка кода =====
app.post('/api/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Телефон и код обязательны' });

    // Ищем по телефону и коду, без привязки к времени в SQL
    const { data: codes, error: codeError } = await supabase
      .from('sms_codes')
      .select('*')
      .eq('phone', phone)
      .eq('code', code)
      .order('created_at', { ascending: false })
      .limit(1);

    if (codeError || !codes || codes.length === 0) {
      return res.status(400).json({ error: 'Неверный код' });
    }

    const storedCode = codes[0];

    // Проверяем, не использован ли он
    if (storedCode.used === true) {
      return res.status(400).json({ error: 'Этот код уже был использован' });
    }

    // Проверяем время истечения на стороне JS (защита от часовых поясов)
    const expiresAt = new Date(storedCode.expires_at);
    if (expiresAt < new Date()) {
      return res.status(400).json({ error: 'Код истёк. Запросите новый.' });
    }

    let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    if (!user) {
      const { data: newUser } = await supabase.from('users').insert([{ phone }]).select().single();
      user = newUser;
    }

    await supabase.from('sms_codes').update({ used: true }).eq('id', storedCode.id);
    const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, user: { id: user.id, phone: user.phone }, token });
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
      .order('created_at', { ascending: false })
      .limit(1);

    if (codeError || !codes || codes.length === 0) {
      attempts.count++;
      attempts.lastAttempt = now;
      failedAttempts.set(binding.telegram_id, attempts);
      return res.status(400).json({ error: 'Неверный код' });
    }

    const storedCode = codes[0];

    if (storedCode.used === true) {
      return res.status(400).json({ error: 'Этот код уже был использован' });
    }

    const expiresAt = new Date(storedCode.expires_at);
    if (expiresAt < new Date()) {
      return res.status(400).json({ error: 'Код истёк. Запросите новый.' });
    }

    let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    if (!user) {
      const { data: newUser } = await supabase.from('users').insert([{ phone }]).select().single();
      user = newUser;
    }

    await supabase.from('telegram_codes').update({ used: true }).eq('id', storedCode.id);

    // Очищаем старые коды
    await supabase.from('telegram_codes').delete()
      .eq('telegram_id', binding.telegram_id)
      .eq('used', false);

    failedAttempts.delete(binding.telegram_id);
    const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, user: { id: user.id, phone: user.phone }, token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Пользователь: Получить данные (для аватарки) =====
app.get('/api/users/:id', requireAuth, async (req, res) => {
  try {
    // Обновляем время последнего визита (если это твой профиль)
    await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', req.params.id);

    const { data, error } = await supabase.from('users').select('id, name, avatar_url, created_at, is_blocked, warnings, last_seen').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ===== Пользователь: Обновить аватарку =====
app.put('/api/users/:userId/avatar', requireAuth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
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

// ===== Пользователь: Обновить имя =====
app.put('/api/users/:userId/name', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().isEmpty) return res.status(400).json({ error: 'Имя обязательно' });
    if (req.userId !== req.params.userId) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ name: name.trim() })
      .eq('id', req.params.userId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Пользователь: Сохранить FCM токен =====
app.post('/api/users/save-token', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token обязателен' });

    const { error } = await supabase
      .from('users')
      .update({ fcm_token: token })
      .eq('id', req.userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Универсальная отправка Push-уведомлений =====
async function sendPushNotification(targetUserId, title, body, dataPayload = {}) {
  try {
    if (!admin.apps.length) return;

    const { data: targetUser } = await supabase
      .from('users')
      .select('fcm_token')
      .eq('id', targetUserId)
      .single();

    if (!targetUser || !targetUser.fcm_token) return;

    // Все значения в data должны быть строками
    const stringData = {};
    for (const [key, val] of Object.entries(dataPayload)) {
      if (val !== null && val !== undefined) {
        stringData[key] = String(val);
      }
    }

    await admin.messaging().send({
      token: targetUser.fcm_token,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel',
          sound: 'default',
        },
      },
    });

    console.log(`✅ Пуш отправлен пользователю ${targetUserId}`);
  } catch (err) {
    console.log('❌ Ошибка отправки пуша:', err.message);
    // Если пользователь удалил приложение или токен устарел — очищаем его в базе
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      await supabase.from('users').update({ fcm_token: null }).eq('id', targetUserId);
    }
  }
}

// ===== Объявления: Получить список =====
app.get('/api/listings', async (req, res) => {
  try {
    let query = supabase.from('listings').select('*, users!listings_user_id_fkey(name, phone, avatar_url)');
    if (req.query.user_id) {
  query = query.eq('user_id', req.query.user_id);
} else {
  // Если это не запрос профиля конкретного пользователя, показываем только непроданные
  query = query.eq('is_sold', false);
}
    if (req.query.category) query = query.eq('category', req.query.category);
    if (req.query.city) query = query.eq('city', req.query.city);
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
app.post('/api/listings', requireAuth, async (req, res) => {
  try {
    // ДОБАВИЛИ city в конце
    const { title, price, description, category, images, image_url, phone, latitude, longitude, city } = req.body;
    if (!title || !price) return res.status(400).json({ error: 'title и price обязательны' });

    const userId = req.userId;

    // ===== ВОТ ЭТИ 3 СТРОЧКИ НУЖНО ДОБАВИТЬ =====
    const { data: user } = await supabase.from('users').select('is_blocked').eq('id', userId).single();
    if (user && user.is_blocked) {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Свяжитесь с поддержкой.' });
    }
    // =============================================

    const { data, error } = await supabase.from('listings').insert([{
      user_id: userId, title, price, description, category, images, image_url, phone, latitude, longitude,
      city
    }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ===== Объявления: Удалить =====
app.delete('/api/listings/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('listings').delete().eq('id', req.params.id).eq('user_id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Объявления: Редактировать =====
app.put('/api/listings/:id', requireAuth, async (req, res) => {
  try {
    const { title, price, description, category, images, image_url, city } = req.body;

    // Собираем объект только с теми полями, которые пришли
    const updateData = {};
    if (title) updateData.title = title;
    if (price) updateData.price = price;
    if (description) updateData.description = description;
    if (category) updateData.category = category;
    if (images) updateData.images = images;
    if (image_url) updateData.image_url = image_url;
    if (city) updateData.city = city;

    // Проверка владельца перед обновлением
    const { data: existing } = await supabase.from('listings').select('user_id').eq('id', req.params.id).single();
    if (!existing) {
      return res.status(404).json({ error: 'Объявление не найдено' });
    }
    if (existing.user_id !== req.userId) {
      return res.status(403).json({ error: 'Нет прав доступа' });
    }

    const { data, error } = await supabase
      .from('listings')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Объявления: Изменить статус (Продано/Активно) =====
app.put('/api/listings/:id/status', requireAuth, async (req, res) => {
  try {
    const { is_sold } = req.body;
    const { data, error } = await supabase
      .from('listings')
      .update({ is_sold })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Объявления: Увеличить счётчик просмотров =====
app.post('/api/listings/:id/view', async (req, res) => {
  try {
    const { data: item, error: fetchError } = await supabase
      .from('listings')
      .select('views')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !item) {
      return res.status(404).json({ error: 'Объявление не найдено' });
    }

    const nextViews = (item.views || 0) + 1;
    const { error: updateError } = await supabase
      .from('listings')
      .update({ views: nextViews })
      .eq('id', req.params.id);

    if (updateError) throw updateError;
    res.json({ views: nextViews });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Загрузка файлов в Supabase Storage =====
app.post('/api/upload', requireAuth, upload.single('photo'), async (req, res) => {
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
app.get('/api/favorites/:user_id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('favorites').select('listing_id').eq('user_id', req.userId);
    if (error) throw error;
    res.json(data.map(f => f.listing_id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Избранное: Добавить =====
app.post('/api/favorites', requireAuth, async (req, res) => {
  try {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id обязателен' });
    const { data, error } = await supabase.from('favorites').insert([{ user_id: req.userId, listing_id }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Избранное: Удалить =====
app.delete('/api/favorites/:user_id/:listing_id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('favorites').delete()
      .eq('user_id', req.userId)
      .eq('listing_id', req.params.listing_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Блокировка: Проверить статус между двумя пользователями =====
app.get('/api/blocks/status/:otherUserId', requireAuth, async (req, res) => {
  try {
    const myId = req.userId;
    const otherId = req.params.otherUserId;

    const { data, error } = await supabase
      .from('blocked_users')
      .select('blocker_id, blocked_id')
      .or(`and(blocker_id.eq.${myId},blocked_id.eq.${otherId}),and(blocker_id.eq.${otherId},blocked_id.eq.${myId})`);

    if (error) throw error;

    const blockedByMe = (data || []).some(row => row.blocker_id === myId);
    const blockedMe = (data || []).some(row => row.blocker_id === otherId);

    res.json({ blockedByMe, blockedMe });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Блокировка: Заблокировать пользователя =====
app.post('/api/blocks', requireAuth, async (req, res) => {
  try {
    const { blocked_id } = req.body;
    if (!blocked_id) return res.status(400).json({ error: 'blocked_id обязателен' });
    if (blocked_id === req.userId) return res.status(400).json({ error: 'Нельзя заблокировать себя' });

    const { error } = await supabase
      .from('blocked_users')
      .upsert([{ blocker_id: req.userId, blocked_id }], { onConflict: 'blocker_id,blocked_id' });

    if (error) throw error;
    res.status(201).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Блокировка: Разблокировать пользователя =====
app.delete('/api/blocks/:blockedUserId', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('blocked_users')
      .delete()
      .eq('blocker_id', req.userId)
      .eq('blocked_id', req.params.blockedUserId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Сообщения: Получить =====
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    // Используем req.userId как первого участника, otherUserId из query как второго
    const { otherUserId, listing_id } = req.query;
    if (!otherUserId) return res.status(400).json({ error: 'otherUserId обязателен' });

    const user1 = req.userId;
    const user2 = otherUserId;

   // Обновляем время последнего визита
    await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', user1);

    // Помечаем входящие сообщения от собеседника как прочитанные
    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('receiver_id', user1)
      .eq('sender_id', user2)
      .eq('is_read', false);

    if (listing_id && listing_id !== 'null' && listing_id !== 'undefined') {
      markReadQuery = markReadQuery.eq('listing_id', listing_id);
    }
    await markReadQuery;

    const orCondition = `and(sender_id.eq.${user1},receiver_id.eq.${user2}),and(sender_id.eq.${user2},receiver_id.eq.${user1})`;

    let query = supabase.from('messages').select('*').or(orCondition);

    // Оставляем фильтр по listing_id (или убираем, если хочешь, чтобы чат был общим)
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

// ===== Сообщения: Удалить чат =====
app.delete('/api/messages/clear', requireAuth, async (req, res) => {
  try {
    const { otherUserId, listing_id } = req.query;
    if (!otherUserId) return res.status(400).json({ error: 'otherUserId обязателен' });

    const user1 = req.userId;
    const user2 = otherUserId;

    const orCondition = `and(sender_id.eq.${user1},receiver_id.eq.${user2}),and(sender_id.eq.${user2},receiver_id.eq.${user1})`;

    let query = supabase.from('messages').delete().or(orCondition);
    if (listing_id && listing_id !== 'null') {
      query = query.eq('listing_id', listing_id);
    }

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Сообщение: Удалить одно =====
app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  try {
    const { data: msg, error: findError } = await supabase
      .from('messages').select('sender_id, receiver_id').eq('id', req.params.id).single();
    if (findError || !msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.sender_id !== req.userId && msg.receiver_id !== req.userId) {
      return res.status(403).json({ error: 'Нет прав' });
    }
    const { error } = await supabase.from('messages').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Сообщения: Отправить =====
app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const { otherUserId, listing_id, content, image_url, audio_url, audio_duration } = req.body;
    if (!otherUserId) return res.status(400).json({ error: 'otherUserId обязателен' });

    const senderId = req.userId;

    // ===== Проверка блокировки между пользователями =====
    const { data: blockCheck } = await supabase
      .from('blocked_users')
      .select('id')
      .or(`and(blocker_id.eq.${senderId},blocked_id.eq.${otherUserId}),and(blocker_id.eq.${otherUserId},blocked_id.eq.${senderId})`)
      .limit(1);

    if (blockCheck && blockCheck.length > 0) {
      return res.status(403).json({ error: 'Отправка сообщений недоступна: пользователь заблокирован' });
    }
    // =====================================================

    const { data, error } = await supabase.from('messages').insert([{
      sender_id: senderId,
      receiver_id: otherUserId,
      listing_id,
      content,
      image_url,
      audio_url,
      audio_duration
    }]).select().single();
    if (error) throw error;

    // ===== ОТПРАВЛЯЕМ ПУШ ПОЛУЧАТЕЛЮ =====
    try {
      const { data: receiver } = await supabase
        .from('users')
        .select('fcm_token')
        .eq('id', otherUserId)
        .single();

      if (receiver && receiver.fcm_token) {
        const messagePush = {
          notification: {
            title: 'Новое сообщение TradeTJ 💬',
            body: content ? content : 'Вам отправили вложение',
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'high_importance_channel',
              sound: 'default',
            },
          },
          token: receiver.fcm_token,
        };
        await admin.messaging().send(messagePush);
        console.log(`✅ Пуш отправлен пользователю ${otherUserId}`);
      }
    } catch (pushError) {
      console.log('❌ Ошибка отправки пуша:', pushError.message);
    }

        // ===== СОЗДАЕМ УВЕДОМЛЕНИЕ В БАЗЕ И ОТПРАВЛЯЕМ ПУШ =====
    try {
      const { data: sender } = await supabase
        .from('users')
        .select('name, phone, avatar_url')
        .eq('id', senderId)
        .single();

      const senderName = sender?.name || sender?.phone || 'Пользователь';

      let listingTitle = '';
      let listingPrice = '';
      if (listing_id) {
        const { data: listing } = await supabase
          .from('listings')
          .select('title, price')
          .eq('id', listing_id)
          .single();
        if (listing) {
          listingTitle = listing.title;
          listingPrice = listing.price;
        }
      }

      const previewText = content
        ? content
        : audio_url
          ? '🎤 Голосовое сообщение'
          : '📷 Фотография';

      await supabase.from('notifications').insert([{
        user_id: otherUserId,
        title: 'Новое сообщение 💬',
        subtitle: `${senderName}: ${previewText}`,
        type: 'message',
        related_user_id: senderId,
        related_listing_id: listing_id,
        other_user_name: senderName,
        other_user_avatar: sender?.avatar_url,
        related_listing_title: listingTitle,
        related_listing_price: listingPrice
      }]);

      await sendPushNotification(
        otherUserId,
        listingTitle ? `${senderName} • ${listingTitle}` : senderName,
        previewText,
        {
          type: 'message',
          otherUserId: senderId,
          otherUserName: senderName,
          otherUserAvatar: sender?.avatar_url || '',
          listingId: listing_id || '',
          listingTitle: listingTitle,
          listingPrice: listingPrice,
        }
      );
    } catch (notifError) {
      console.log('❌ Ошибка уведомления/пуша:', notifError.message);
    }
    // =====================================

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ===== УВЕДОМЛЕНИЯ =====

// 1. Получить уведомления пользователя
app.get('/api/notifications/:userId', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Отметить уведомление как прочитанное
app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Счётчики непрочитанных сообщений и уведомлений =====
app.get('/api/unread-counts', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;

    const [msgRes, notifRes] = await Promise.all([
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('receiver_id', userId)
        .eq('is_read', false),
      supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false),
    ]);

    res.json({
      unreadMessages: msgRes.count || 0,
      unreadNotifications: notifRes.count || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Функция для создания уведомления (будем вызывать её из других роутов)
async function createNotification(userId, title, subtitle, type) {
  try {
    await supabase.from('notifications').insert([{
      user_id: userId,
      title: title,
      subtitle: subtitle,
      type: type
    }]);
  } catch (error) {
    console.error('Ошибка создания уведомления:', error.message);
  }
}

// ===== Диалоги: Получить список =====
app.get('/api/conversations/:userId', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { data, error } = await supabase
      .from('messages')
      .select('*, sender:sender_id(id, name, avatar_url), receiver:receiver_id(id, name, avatar_url), listing:listing_id(id, title, image_url, price)')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const conversations = [];
    const seen = new Set();

    for (const msg of (data || [])) {
      // Группируем только по участникам диалога (без listing_id)
      const key = `${msg.sender_id}-${msg.receiver_id}`;
      const reverseKey = `${msg.receiver_id}-${msg.sender_id}`;

      if (!seen.has(key) && !seen.has(reverseKey)) {
        seen.add(key);

        // Определяем, кто собеседник
        const otherUser = msg.sender_id === userId ? msg.receiver : msg.sender;

        conversations.push({
          ...msg,
          other_user_name: otherUser?.name || 'Пользователь',
          other_user_avatar: otherUser?.avatar_url
        });
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
app.post('/api/ai/generate', requireAuth, async (req, res) => {
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

// ===== АДМИНКА: Получить все объявления =====
app.get('/api/admin/listings', requireAuth, async (req, res) => {
  try {
    if (req.userId !== ADMIN_ID) {
      return res.status(403).json({ error: 'Доступ запрещен. Вы не администратор.' });
    }
    const { data, error } = await supabase.from('listings').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИНКА: Удалить любое объявление =====
app.delete('/api/admin/listings/:id', requireAuth, async (req, res) => {
  try {
    if (req.userId !== ADMIN_ID) {
      return res.status(403).json({ error: 'Доступ запрещен. Вы не администратор.' });
    }
    const { error } = await supabase.from('listings').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Объявление удалено' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИНКА: Получить всех пользователей =====
app.get('/api/admin/users', requireAuth, async (req, res) => {
  try {
    if (req.userId !== ADMIN_ID) {
      return res.status(403).json({ error: 'Доступ запрещен. Вы не администратор.' });
    }
    const { data, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИНКА: Удалить пользователя =====
app.delete('/api/admin/users/:id', requireAuth, async (req, res) => {
  try {
    if (req.userId !== ADMIN_ID) {
      return res.status(403).json({ error: 'Доступ запрещен. Вы не администратор.' });
    }
    if (req.params.id === ADMIN_ID) {
      return res.status(400).json({ error: 'Вы не можете удалить самого себя!' });
    }
    const { error } = await supabase.from('users').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Пользователь удален' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИНКА: Изменить статус пользователя =====
app.put('/api/admin/users/:id/status', requireAuth, async (req, res) => {
  try {
    if (req.userId !== ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
    const { action } = req.body;
    const userId = req.params.id;
    if (userId === ADMIN_ID) return res.status(400).json({ error: 'Вы не можете забанить себя!' });

    if (action === 'block') {
      await supabase.from('users').update({ is_blocked: true }).eq('id', userId);
    } else if (action === 'unblock') {
      await supabase.from('users').update({ is_blocked: false }).eq('id', userId);
    } else if (action === 'warn') {
      const { data: user } = await supabase.from('users').select('warnings').eq('id', userId).single();
      const currentWarnings = user?.warnings || 0;
      await supabase.from('users').update({ warnings: currentWarnings + 1 }).eq('id', userId);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Пользователь: Получить статус онлайн =====
app.get('/api/users/:id/status', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('last_seen').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Отзывы: Получить для продавца =====
app.get('/api/reviews/:sellerId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('*, users!reviews_reviewer_id_fkey(phone, name, avatar_url)')
      .eq('seller_id', req.params.sellerId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Отзывы: Оставить =====
app.post('/api/reviews', requireAuth, async (req, res) => {
  try {
    const { seller_id, rating, comment } = req.body;
    const reviewerId = req.userId;

    if (!seller_id || !rating) {
      return res.status(400).json({ error: 'Заполните все поля' });
    }
    if (seller_id === reviewerId) {
      return res.status(400).json({ error: 'Нельзя оставить отзыв самому себе' });
    }

    // Проверяем, не оставлял ли уже этот пользователь отзыв
    const { data: existing } = await supabase
      .from('reviews')
      .select('id')
      .eq('seller_id', seller_id)
      .eq('reviewer_id', reviewerId);

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Вы уже оставили отзыв этому продавцу' });
    }

    const { data, error } = await supabase
      .from('reviews')
      .insert([{ seller_id, reviewer_id: reviewerId, rating, comment }])
      .select()
      .single();

    if (error) throw error;

    // ===== УВЕДОМЛЕНИЕ В БАЗУ =====
    try {
      await supabase.from('notifications').insert([{
        user_id: seller_id,
        title: 'Новый отзыв ⭐',
        subtitle: `Вам поставили ${rating} звезд(ы)`,
        type: 'review',
        related_user_id: reviewerId
      }]);
      console.log(`✅ Уведомление об отзыве создано для ${seller_id}`);
    } catch (notifError) {
      console.log('❌ Ошибка создания уведомления:', notifError.message);
    }

    // ===== ПУШ В ШТОРКУ =====
    await sendPushNotification(
      seller_id,
      'Новый отзыв ⭐',
      `Вам поставили ${rating} звезд(ы)`,
      { type: 'review', userId: reviewerId }
    );
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Отзывы: Средний рейтинг =====
app.get('/api/users/:id/rating', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('rating')
      .eq('seller_id', req.params.id);
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.json({ average: 0, count: 0 });
    }
    const average = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
    res.json({ average: Math.round(average * 10) / 10, count: data.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Жалобы: Оставить =====
app.post('/api/reports', requireAuth, async (req, res) => {
  try {
    const { listing_id, reason } = req.body;
    const reporterId = req.userId;

    if (!listing_id || !reason) {
      return res.status(400).json({ error: 'Заполните все поля' });
    }

    // Проверяем, не жаловался ли уже этот пользователь на это объявление
    const { data: existing } = await supabase
      .from('reports')
      .select('id')
      .eq('listing_id', listing_id)
      .eq('reporter_id', reporterId);

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Вы уже жаловались на это объявление' });
    }

    const { data, error } = await supabase
      .from('reports')
      .insert([{ listing_id, reporter_id: reporterId, reason }])
      .select()
      .single();

    if (error) throw error;

    // ===== УВЕДОМЛЕНИЕ В БАЗУ =====
    try {
      await supabase.from('notifications').insert([{
        user_id: ADMIN_ID,
        title: 'Новая жалоба ⚠️',
        subtitle: `Причина: ${reason}`,
        type: 'report'
      }]);
      console.log('✅ Уведомление о жалобе создано для админа');
    } catch (notifError) {
      console.log('❌ Ошибка создания уведомления:', notifError.message);
    }

    // ===== ПУШ В ШТОРКУ =====
    await sendPushNotification(
      ADMIN_ID,
      'Новая жалоба ⚠️',
      `Причина: ${reason}`,
      { type: 'report', listingId: listing_id }
    );

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== АДМИНКА: Получить все жалобы =====
app.get('/api/admin/reports', requireAuth, async (req, res) => {
  try {
    if (req.userId !== ADMIN_ID) {
      return res.status(403).json({ error: 'Доступ запрещен. Вы не администратор.' });
    }

    // Получаем жалобы вместе с данными объявления
    const { data, error } = await supabase
      .from('reports')
      .select('*, listings!reports_listing_id_fkey(id, title, image_url, price, user_id)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
