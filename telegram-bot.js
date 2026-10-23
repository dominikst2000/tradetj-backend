require('dotenv').config();
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Инициализация
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Временное хранилище ожидаемых номеров (в памяти)
const pendingVerifications = new Map();

// 1. Обработка команды /start с параметром (номером телефона)
bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const payload = ctx.startPayload; // То, что идет после /start

    if (!payload) {
        await ctx.reply("👋 Привет! Чтобы получить код, нажмите кнопку 'Получить код в Telegram' в приложении TradeTJ.");
        return;
    }

    // Очищаем номер от всего, кроме цифр
    const expectedPhone = payload.replace(/\D/g, '');

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

// 2. Обработка получения контакта от пользователя
bot.on('contact', async (ctx) => {
    const chatId = ctx.chat.id;
    const contact = ctx.message.contact;
    
    if (!contact || !contact.phone_number) {
        await ctx.reply("⚠️ Пожалуйста, поделитесь номером телефона через кнопку.");
        return;
    }

    const sharedPhone = contact.phone_number.replace(/\D/g, ''); // Очищаем от +, пробелов
    const expectedPhone = pendingVerifications.get(chatId);

    if (!expectedPhone) {
        await ctx.reply("⚠️ Пожалуйста, сначала используйте ссылку из приложения TradeTJ.");
        return;
    }

    // Проверяем совпадение (сравниваем последние 10 цифр)
    const isMatch = sharedPhone.endsWith(expectedPhone.slice(-10)) || sharedPhone === expectedPhone;

    if (isMatch) {
        // Генерируем 4-значный код
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 минут

        // 1. Сохраняем привязку Telegram ID к номеру телефона
        await supabase.from('telegram_bindings').upsert(
            { telegram_id: chatId, phone: `+${sharedPhone}` },
            { onConflict: 'phone' }
        );

        // 2. Сохраняем код для проверки
        await supabase.from('telegram_codes').insert({
            telegram_id: chatId,
            code: code,
            expires_at: expiresAt
        });

        // Очищаем ожидание
        pendingVerifications.delete(chatId);

        // Отправляем код пользователю
        await ctx.reply(
            `✅ Ваш код для входа в TradeTJ: *${code}*\n\nВведите его в приложении. Код действителен 10 минут.`,
            { parse_mode: 'Markdown' }
        );
    } else {
        await ctx.reply(
            `❌ Номер не совпадает.\nОжидался: +${expectedPhone}\nПолучен: +${sharedPhone}\n\nПожалуйста, начните процесс заново через приложение.`
        );
        pendingVerifications.delete(chatId);
    }
});

// Запуск бота
console.log('🚀 Запускаем бота...');
bot.launch()
    .then(() => {
        console.log('🤖 Telegram бот запущен и слушает сообщения...');
    })
    .catch((error) => {
        console.error('❌ Ошибка запуска бота:', error);
    });

// Остановка бота при завершении
process.once('SIGINT', () => {
    console.log('⏹️ Останавливаем бота (SIGINT)...');
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    console.log('⏹️ Останавливаем бота (SIGTERM)...');
    bot.stop('SIGTERM');
});