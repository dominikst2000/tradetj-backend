require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ===== SMS: Отправка =====
app.post('/api/send-sms', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: 'Номер обязателен' });

        // Удаляем старые коды
        await supabase.from('sms_codes').delete().eq('phone', phone);

        const smsCode = Math.floor(1000 + Math.random() * 9000).toString();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

        const { error: dbError } = await supabase
            .from('sms_codes')
            .insert([{ phone, code: smsCode, expires_at: expiresAt }]);

        if (dbError) return res.status(500).json({ error: 'Ошибка БД: ' + dbError.message });

        const cleanPhone = phone.replace('+', '');
        const message = `Vash kod TradeTJ: ${smsCode}`;
        const smsRuUrl = `https://sms.ru/sms/send?api_id=${process.env.SMS_RU_API_ID}&to=${cleanPhone}&msg=${encodeURIComponent(message)}&json=1`;

        try {
            const response = await axios.get(smsRuUrl);
            console.log(`✅ SMS на ${phone}, код: ${smsCode}`);
        } catch (smsErr) {
            console.log(`⚠️ SMS не отправлено, но код сгенерирован: ${smsCode}`);
        }

        res.json({ success: true, test_code: smsCode });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== SMS: Проверка кода =====
app.post('/api/verify-code', async (req, res) => {
    try {
        const { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: 'Телефон и код обязательны' });

        const { data: codes } = await supabase
            .from('sms_codes')
            .select('*')
            .eq('phone', phone)
            .gte('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(1);

        if (!codes || codes.length === 0) {
            return res.status(400).json({ error: 'Код не найден или истек. Запросите новый.' });
        }

        const storedCode = codes[0];
        if (storedCode.code !== code) {
            return res.status(400).json({ error: 'Неверный код' });
        }

        const { data: existingUser } = await supabase.from('users').select('*').eq('phone', phone).single();
        let user;
        if (!existingUser) {
            const { data: newUser } = await supabase.from('users').insert([{ phone }]).select().single();
            user = newUser;
        } else {
            user = existingUser;
        }

        await supabase.from('sms_codes').delete().eq('id', storedCode.id);
        res.json({ success: true, user: { id: user.id, phone: user.phone } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== TELEGRAM: Проверка кода =====
app.post('/api/verify-telegram-code', async (req, res) => {
    try {
        const { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: 'Телефон и код обязательны' });

        // Находим привязку Telegram ID к номеру телефона
        const { data: binding, error: bindingError } = await supabase
            .from('telegram_bindings')
            .select('telegram_id')
            .eq('phone', phone)
            .single();

        if (bindingError || !binding) {
            return res.status(400).json({ error: 'Номер не привязан к Telegram. Сначала получите код через бота.' });
        }

        // Находим код для этого Telegram ID
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
            return res.status(400).json({ error: 'Неверный или истёкший код' });
        }

        const storedCode = codes[0];

        // Находим или создаём пользователя
        const { data: existingUser } = await supabase.from('users').select('*').eq('phone', phone).single();
        let user;
        if (!existingUser) {
            const { data: newUser } = await supabase.from('users').insert([{ phone }]).select().single();
            user = newUser;
        } else {
            user = existingUser;
        }

        // Помечаем код как использованный
        await supabase.from('telegram_codes').update({ used: true }).eq('id', storedCode.id);

        res.json({ success: true, user: { id: user.id, phone: user.phone } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Объявления: Получить список (с расширенными фильтрами) =====
app.get('/api/listings', async (req, res) => {
    try {
        const { category, search, user_id, price_from, price_to, sort, seller_type, city } = req.query;
        
        let query = supabase.from('listings').select('*');
        
        if (category) query = query.eq('category', category);
        if (search) query = query.ilike('title', `%${search}%`);
        if (user_id) query = query.eq('user_id', user_id);
        
        // ВНИМАНИЕ: Если в твоей таблице listings НЕТ колонки city, эта строка вызовет ошибку 500!
        // Если ты добавлял колонку city в таблицу listings, раскомментируй строку ниже:
        // if (city) query = query.eq('city', city);
        
        if (price_from) query = query.gte('price', parseInt(price_from, 10));
        if (price_to) query = query.lte('price', parseInt(price_to, 10));
        
        if (sort === 'Дешевле') {
            query = query.order('price', { ascending: true });
        } else if (sort === 'Дороже') {
            query = query.order('price', { ascending: false });
        } else if (sort === 'По дате') {
            query = query.order('created_at', { ascending: false });
        } else {
            query = query.order('created_at', { ascending: false });
        }
        
        const { data: listings, error } = await query;

        if (error) {
            console.error('❌ Ошибка Supabase при получении listings:', error);
            return res.status(500).json({ error: error.message });
        }
        
        res.json(listings || []);
    } catch (error) {
        console.error('❌ Критическая ошибка сервера /api/listings:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== Объявления: Создать (с фото и координатами) =====
app.post('/api/listings', async (req, res) => {
    try {
        const { user_id, title, price, description, category, image_url, images, phone, latitude, longitude } = req.body;
        
        const imagesArray = images && Array.isArray(images) && images.length > 0 
            ? images 
            : (image_url ? [image_url] : []);
        
        const { data, error } = await supabase
            .from('listings')
            .insert([{ 
                user_id, 
                title, 
                price, 
                description, 
                category, 
                image_url: imagesArray[0] || null,
                images: imagesArray,
                phone,
                latitude: latitude || null,
                longitude: longitude || null,
            }])
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Объявления: Удалить =====
app.delete('/api/listings/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('listings').delete().eq('id', req.params.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Избранное: Добавить =====
app.post('/api/favorites', async (req, res) => {
    try {
        const { user_id, listing_id } = req.body;
        const { data, error } = await supabase
            .from('favorites')
            .insert([{ user_id, listing_id }])
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Избранное: Удалить =====
app.delete('/api/favorites/:user_id/:listing_id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('favorites')
            .delete()
            .eq('user_id', req.params.user_id)
            .eq('listing_id', req.params.listing_id);

        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Избранное: Получить список =====
app.get('/api/favorites/:user_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('favorites')
            .select('listing_id')
            .eq('user_id', req.params.user_id);

        if (error) return res.status(500).json({ error: error.message });
        res.json(data.map(f => f.listing_id));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Загрузка фото =====
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

        const fileExtension = req.file.originalname.split('.').pop() || 'jpg';
        const fileName = `${Date.now()}.${fileExtension}`;
        
        const { data, error } = await supabase.storage
            .from('listings')
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype,
            });

        if (error) return res.status(500).json({ error: error.message });

        const { data: urlData } = supabase.storage
            .from('listings')
            .getPublicUrl(fileName);

        res.json({ url: urlData.publicUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== ЧАТ: Получить сообщения =====
app.get('/api/messages', async (req, res) => {
    try {
        const { user1, user2, listing_id } = req.query;
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_id.eq.${user1},receiver_id.eq.${user2}),and(sender_id.eq.${user2},receiver_id.eq.${user1})`)
            .eq('listing_id', listing_id)
            .order('created_at', { ascending: true });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== ЧАТ: Отправить сообщение (текст, фото или голосовое) =====
app.post('/api/messages', async (req, res) => {
    try {
        const { sender_id, receiver_id, listing_id, content, image_url, audio_url, audio_duration } = req.body;
        
        const { data, error } = await supabase
            .from('messages')
            .insert([{ sender_id, receiver_id, listing_id, content, image_url, audio_url, audio_duration }])
            .select()
            .single();

        if (error) {
            console.error('❌ Ошибка сохранения сообщения:', error);
            return res.status(500).json({ error: error.message });
        }
        
        res.json(data);
    } catch (error) {
        console.error('❌ Критическая ошибка отправки:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== ЧАТ: Список диалогов =====
app.get('/api/conversations/:user_id', async (req, res) => {
    try {
        const userId = req.params.user_id;
        console.log(' Запрос диалогов для пользователя:', userId);

        // Шаг 1: Получаем все сообщения пользователя
        const { data: messages, error } = await supabase
            .from('messages')
            .select('*')
            .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('❌ Ошибка запроса messages:', error);
            return res.status(500).json({ error: error.message });
        }

        console.log('📨 Найдено сообщений:', messages?.length || 0);

        if (!messages || messages.length === 0) {
            return res.json([]);
        }

        // Шаг 2: Находим уникальные listing_id
        const uniqueListingIds = [...new Set(messages.map(m => m.listing_id))];
        console.log('📋 Уникальные объявления:', uniqueListingIds);

        // Шаг 3: Получаем данные об этих объявлениях
        const { data: listings, error: listingsError } = await supabase
            .from('listings')
            .select('id, title, image_url, price')
            .in('id', uniqueListingIds);

        if (listingsError) {
            console.error('❌ Ошибка запроса listings:', listingsError);
        }

        // Шаг 4: Собираем результат
        const listingsMap = {};
        (listings || []).forEach(l => {
            listingsMap[l.id] = l;
        });

        // Для каждого объявления берём последнее сообщение
        const uniqueChats = {};
        messages.forEach(msg => {
            if (!uniqueChats[msg.listing_id]) {
                uniqueChats[msg.listing_id] = {
                    listing_id: msg.listing_id,
                    listings: listingsMap[msg.listing_id] || null,
                    content: msg.content,
                    created_at: msg.created_at,
                    sender_id: msg.sender_id,
                    receiver_id: msg.receiver_id,
                };
            }
        });

        const result = Object.values(uniqueChats);
        console.log('✅ Отправляем диалогов:', result.length);
        res.json(result);
    } catch (error) {
        console.error('❌ Критическая ошибка conversations:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер на порту ${PORT}`));