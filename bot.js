const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- SOZLAMALAR ---
const BOT_TOKEN = process.env.BOT_TOKEN || '8554827007:AAFnRps45xL3A8xS9LBLRsBevEIGyACRZxQ';
const APP_URL = "https://guruh-boshqaruvchi-bot.onrender.com";
const DB_FILE = path.join(__dirname, 'database.json'); // Ma'lumotlar bazasi fayli

// Token tekshiruvi
if (!process.env.BOT_TOKEN && BOT_TOKEN === 'SIZNING_BOT_TOKENINGIZ') {
    console.error("DIQQAT: Bot token kiritilmadi! .env faylni yoki o'zgaruvchini tekshiring.");
}

const bot = new Telegraf(BOT_TOKEN);

// --- 💾 DATABASE TIZIMI (FAYL BILAN ISHLASH) ---
// Bu tizim bot o'chib yonsa ham ma'lumotlarni saqlab qoladi

let db = {
    groups: {}, // Guruh sozlamalari
    users: {}   // Foydalanuvchilar: { "chatId:userId": count }
};

// Bazani yuklash
function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const rawData = fs.readFileSync(DB_FILE);
            db = JSON.parse(rawData);
            console.log("💾 Baza yuklandi.");
        } else {
            saveDatabase(); // Fayl yo'q bo'lsa yaratamiz
        }
    } catch (error) {
        console.error("Baza yuklashda xatolik:", error);
    }
}

// Bazani saqlash
function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("Baza saqlashda xatolik:", error);
    }
}

// Bot ishga tushganda bazani yuklaymiz
loadDatabase();

// --- YORDAMCHI FUNKSIYALAR ---

const defaultSettings = {
    limit: 5,
    deleteServiceMessages: true
};

const getGroupSettings = (chatId) => {
    if (!db.groups[chatId]) {
        db.groups[chatId] = { ...defaultSettings };
        saveDatabase();
    }
    return db.groups[chatId];
};

const getUserInvites = (chatId, userId) => {
    const key = `${chatId}:${userId}`;
    return db.users[key] || 0;
};

const incrementUserInvites = (chatId, userId, amount = 1) => {
    const key = `${chatId}:${userId}`;
    if (!db.users[key]) db.users[key] = 0;
    db.users[key] += amount;
    saveDatabase(); // Har o'zgarishda saqlaymiz
    return db.users[key];
};

// Admin tekshiruvi (Tez va ishonchli)
const isUserAdmin = async (ctx) => {
    if (ctx.chat.type === 'private') return false;
    // Kesh yoki oddiy tekshiruv o'rniga to'g'ridan-to'g'ri so'rov yuboramiz
    try {
        const member = await ctx.getChatMember(ctx.from.id);
        return ['creator', 'administrator'].includes(member.status);
    } catch (e) {
        return false;
    }
};

// Xabarni xatosiz o'chirish
const safeDelete = async (ctx, messageId = null) => {
    try {
        await ctx.deleteMessage(messageId);
    } catch (e) {
        // Xabar allaqachon o'chgan yoki huquq yo'q - e'tibor bermaymiz
    }
};

// --- KOMANDALAR ---

bot.start((ctx) => {
    const botUsername = ctx.botInfo.username;
    const addGroupLink = `https://t.me/${botUsername}?startgroup=true&admin=delete_messages+invite_users`;
    
    ctx.reply(
        `🛡 **Guruh Qo'riqchisi v2.0**\n\n` +
        `Men guruhga odam qo'shmaganlarga yozishni taqiqlayman.\n` +
        `Ma'lumotlar xavfsiz saqlanadi!\n\n` +
        `⚡️ **Ishlatish:**\n` +
        `1. Meni guruhga admin qiling.\n` +
        `2. /sozlamalar ni bosing.\n\n` +
        `👮‍♂️ **Adminlar uchun yangilik:**\n` +
        `Agar bot kimgadir ball bermasa, qo'lda berishingiz mumkin:\n` +
        `/add @user 5 (5 ta ball qo'shish)`,
        Markup.inlineKeyboard([
            [Markup.button.url('➕ Guruhga qo\'shish', addGroupLink)]
        ])
    );
});

// 📊 Statistika
bot.command(['stat', 'me'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Guruhda ishlating.");
    
    const count = getUserInvites(ctx.chat.id, ctx.from.id);
    const settings = getGroupSettings(ctx.chat.id);
    const qolgan = Math.max(0, settings.limit - count);

    let text = `👤 **${ctx.from.first_name}** hisoboti:\n\n`;
    text += `📈 Siz qo'shdingiz: **${count}** ta\n`;
    text += `🎯 Majburiy limit: **${settings.limit}** ta\n`;

    if (qolgan > 0) {
        text += `❌ **Yozish bloklangan.** Yana ${qolgan} ta odam qo'shing.`;
    } else {
        text += `✅ **Siz guruhda yoza olasiz!**`;
    }

    const msg = await ctx.replyWithMarkdown(text);
    setTimeout(() => safeDelete(ctx, msg.message_id), 20000);
});

// 🛠 Sozlamalar (Faqat Admin)
bot.command('sozlamalar', async (ctx) => {
    if (ctx.chat.type === 'private') return;
    if (!(await isUserAdmin(ctx))) {
        const m = await ctx.reply("⛔️ Faqat adminlar uchun!");
        setTimeout(() => safeDelete(ctx, m.message_id), 5000);
        return;
    }
    const settings = getGroupSettings(ctx.chat.id);
    await showSettingsPanel(ctx, settings);
});

// ➕ Qo'lda ball berish (Admin uchun qutqaruvchi komanda)
// Ishlatilishi: javob berib (reply) "/add 5" yoki shunchaki "/add @username 5"
bot.command('add', async (ctx) => {
    if (!(await isUserAdmin(ctx))) return;

    const args = ctx.message.text.split(' ');
    let targetId = null;
    let targetName = "Foydalanuvchi";
    let amount = 1;

    // 1-holat: Reply qilingan bo'lsa
    if (ctx.message.reply_to_message) {
        targetId = ctx.message.reply_to_message.from.id;
        targetName = ctx.message.reply_to_message.from.first_name;
        if (args[1]) amount = parseInt(args[1]) || 1;
    } 
    // 2-holat: Mention (@username) bo'lsa
    else if (ctx.message.entities && ctx.message.entities.length > 1) {
        // Bu murakkabroq, oddiylik uchun reply tavsiya etiladi.
        return ctx.reply("Iltimos, foydalanuvchi xabariga 'Reply' qilib yozing: /add 5");
    } else {
        return ctx.reply("⚠️ Foydalanuvchi xabariga javob (reply) berib yozing: `/add 5`");
    }

    if (targetId) {
        const newCount = incrementUserInvites(ctx.chat.id, targetId, amount);
        const settings = getGroupSettings(ctx.chat.id);
        
        await ctx.reply(`✅ **${targetName}** ga ${amount} ta odam yozildi.\nJami: ${newCount} / ${settings.limit}`);
    }
});

// --- ACTIONS (Tugmalar) ---

bot.action(/set_limit_(\d+)/, async (ctx) => {
    if (!(await isUserAdmin(ctx))) return ctx.answerCbQuery("Admin emassiz!", { show_alert: true });
    const newLimit = parseInt(ctx.match[1]);
    const settings = getGroupSettings(ctx.chat.id);
    settings.limit = newLimit;
    saveDatabase();
    await ctx.answerCbQuery(`Limit ${newLimit} ta qilindi.`);
    await showSettingsPanel(ctx, settings, true);
});

bot.action('toggle_service', async (ctx) => {
    if (!(await isUserAdmin(ctx))) return ctx.answerCbQuery("Admin emassiz!", { show_alert: true });
    const settings = getGroupSettings(ctx.chat.id);
    settings.deleteServiceMessages = !settings.deleteServiceMessages;
    saveDatabase();
    await ctx.answerCbQuery("O'zgartirildi");
    await showSettingsPanel(ctx, settings, true);
});

bot.action('close_panel', (ctx) => safeDelete(ctx));

// --- ASOSIY LOGIKA (Odam qo'shish va tekshirish) ---

bot.on('new_chat_members', async (ctx) => {
    const settings = getGroupSettings(ctx.chat.id);
    
    // Xabarni tozalash
    if (settings.deleteServiceMessages) {
        safeDelete(ctx);
    }

    const members = ctx.message.new_chat_members;
    const inviterId = ctx.from.id;
    const inviterName = ctx.from.first_name;

    // O'zi kirganlarni (link orqali) hisoblamaslik uchun tekshiruv
    // Lekin Telegram API da link orqali kirsa ham ba'zan 'from' maydoni kiruvchini ko'rsatadi.
    // Biz buni to'g'irlay olmaymiz, lekin BOTLARNI filtrlaymiz.

    let addedCount = 0;

    for (const member of members) {
        // 1. Bot o'zini o'zi tabriklamasin
        if (member.id === ctx.botInfo.id) {
            ctx.reply("👋 Men keldim! Adminlar /sozlamalar ni to'g'irlasin.");
            continue;
        }
        
        // 2. Agar qo'shilgan narsa BOT bo'lsa - hisoblamaymiz (Nakrutka himoyasi)
        if (member.is_bot) {
            continue;
        }

        // 3. Agar foydalanuvchi o'zi kirgan bo'lsa (Invite qiluvchi == Kiruvchi)
        // Bu link orqali kirish degani. Buni hisobga olmaymiz.
        if (inviterId === member.id) {
            continue;
        }

        // Hamma tekshiruvdan o'tdi, demak bu haqiqiy taklif
        addedCount++;
    }

    if (addedCount > 0) {
        const currentInvites = incrementUserInvites(ctx.chat.id, inviterId, addedCount);
        
        // Agar endigina limitga yetgan bo'lsa, tabriklaymiz
        if (currentInvites >= settings.limit && (currentInvites - addedCount) < settings.limit) {
            const msg = await ctx.reply(`🎉 **${inviterName}**, tabriklaymiz! Siz ${settings.limit} ta odam qo'shdingiz va endi yoza olasiz!`);
            setTimeout(() => safeDelete(ctx, msg.message_id), 15000);
        }
    }
});

// Chiqib ketganlarni tozalash
bot.on('left_chat_member', async (ctx) => {
    const settings = getGroupSettings(ctx.chat.id);
    if (settings.deleteServiceMessages) safeDelete(ctx);
});

// Asosiy xabarlarni ushlash
bot.on('message', async (ctx) => {
    if (ctx.chat.type === 'private') return;
    
    // Adminlarga tegmaysiz
    if (await isUserAdmin(ctx)) return;

    const settings = getGroupSettings(ctx.chat.id);
    const userInvites = getUserInvites(ctx.chat.id, ctx.from.id);

    // Limitga yetmagan bo'lsa
    if (userInvites < settings.limit) {
        // 1. Xabarni o'chirish
        await safeDelete(ctx);

        // 2. Ogohlantirish (spam bo'lmasligi uchun har safar yozmaslikka harakat qilish mumkin,
        // lekin foydalanuvchi tushunishi uchun yozish kerak)
        const qolgan = settings.limit - userInvites;
        const name = ctx.from.first_name.replace(/[\[\]()~>#+=|{}.!-]/g, ''); // Ismni tozalash
        
        try {
            const warningMsg = await ctx.reply(
                `🚫 **${name}**, uzr!\nGuruhda yozish uchun yana **${qolgan}** ta odam qo'shishingiz shart.\n` +
                `Hozircha: ${userInvites} / ${settings.limit}\n\n` +
                `_Do'stlaringizni qo'shing va avtomatik ochilasiz!_`,
                { parse_mode: 'Markdown' }
            );

            // 10 sekunddan keyin ogohlantirishni o'chirish
            setTimeout(() => safeDelete(ctx, warningMsg.message_id), 10000);
        } catch (e) {
            // console.log("Reply xatosi:", e.message);
        }
    }
});

// Panel funksiyasi
async function showSettingsPanel(ctx, settings, isEdit = false) {
    const buttons = [];
    for (let i = 1; i <= 15; i++) { // 1 dan 15 gacha limit
        const label = settings.limit === i ? `✅ ${i}` : `${i}`;
        buttons.push(Markup.button.callback(label, `set_limit_${i}`));
    }

    const serviceBtnText = settings.deleteServiceMessages 
        ? "🗑 Kirdi-chiqdi: YASHIRILGAN" 
        : "👁 Kirdi-chiqdi: KO'RINADI";

    const text = `⚙️ **Guruh Sozlamalari**\n\n` +
                 `Talab: **${settings.limit} ta** odam.\n` +
                 `O'zgartirish uchun tugmani bosing:`;

    // Tugmalarni 5 tadan qilib bo'lish
    const chunkedButtons = [];
    while (buttons.length) chunkedButtons.push(buttons.splice(0, 5));

    const keyboard = Markup.inlineKeyboard([
        ...chunkedButtons,
        [Markup.button.callback(serviceBtnText, 'toggle_service')],
        [Markup.button.callback("❌ Yopish", "close_panel")]
    ]);

    if (isEdit) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(()=>{});
    } else {
        await ctx.replyWithMarkdown(text, keyboard);
    }
}

// --- SERVER (Render uchun) ---
const app = express();
app.get('/', (req, res) => res.send('Bot Database bilan ishlamoqda (v2.0)'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server ishladi: ${PORT}`);
});

// Anti-Sleep (Render uyquga ketmasligi uchun)
if (APP_URL) {
    setInterval(() => {
        axios.get(APP_URL).catch(() => {});
    }, 14 * 60 * 1000); // 14 daqiqa
}

bot.launch({ dropPendingUpdates: true }).then(() => console.log('Bot ulandi!'));

// Graceful Stop
process.once('SIGINT', () => { saveDatabase(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { saveDatabase(); bot.stop('SIGTERM'); });
