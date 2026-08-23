const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const axios = require('axios');

// --- SOZLAMALAR ---
// Tokenni shu yerga yozing yoki Render Environment Variable ga 'BOT_TOKEN' nomi bilan qo'shing
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || "https://guruh-boshqaruvchi-bot.onrender.com"; // Render avtomatik beradi

if (!BOT_TOKEN) {
    console.error("❌ DIQQAT: Bot token kiritilmadi! BOT_TOKEN environment variable'ini o'rnating.");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- ODDAY XOTIRA (DATABASE) ---
const db = {
    groups: {}, // Guruh sozlamalari
    users: {}   // Foydalanuvchilar statistikasi
};

// Standart sozlamalar
const defaultSettings = {
    limit: 5, // Standart 5 ta odam
    deleteServiceMessages: true // Kirdi-chiqdilarni o'chirish
};

// --- YORDAMCHI FUNKSIYALAR ---
const getGroupSettings = (chatId) => {
    if (!db.groups[chatId]) {
        db.groups[chatId] = { ...defaultSettings };
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
    return db.users[key];
};

const decrementUserInvites = (chatId, userId, amount = 1) => {
    const key = `${chatId}:${userId}`;
    if (!db.users[key]) db.users[key] = 0;
    db.users[key] = Math.max(0, db.users[key] - amount);
    return db.users[key];
};

const isUserAdmin = async (ctx) => {
    if (ctx.chat.type === 'private') return false;
    try {
        const member = await ctx.getChatMember(ctx.from.id);
        return ['creator', 'administrator'].includes(member.status);
    } catch (e) {
        console.log("Admin tekshirishdagi xatolik:", e.message);
        return false;
    }
};

// --- START VA COMMANDLAR ---

bot.start(async (ctx) => {
    const botUsername = ctx.botInfo.username;
    
    // Admin huquqlari bilan guruhga qo'shish havolasi
    const addGroupLink = `https://t.me/${botUsername}?startgroup=true&admin=delete_messages+invite_users`;

    ctx.reply(
        `👋 Salom! Men Guruh Nazoratchisiman.\n\n` +
        `Mening vazifam guruhni faollashtirish! A'zo qo'shmaganlarga yozishni taqiqlayman.\n\n` +
        `✅ Ishlatish uchun:\n` +
        `1. Meni guruhga qo'shing (Admin qilib).\n` +
        `2. Guruhda /sozlamalar ni bosing.\n` +
        `3. Kerakli limitni belgilang.`,
        Markup.inlineKeyboard([
            [Markup.button.url('➕ Meni Guruhingizga Admin qilib qo\'shish', addGroupLink)]
        ])
    );
});

// Statistikani ko'rish (/stat va /stats ikkala buyruq ham ishlaydi)
bot.command('stat', async (ctx) => {
    await showUserStats(ctx);
});

bot.command('stats', async (ctx) => {
    await showUserStats(ctx);
});

async function showUserStats(ctx) {
    if (ctx.chat.type === 'private') return ctx.reply("Bu buyruq faqat guruhda ishlaydi.");
    
    const count = getUserInvites(ctx.chat.id, ctx.from.id);
    const settings = getGroupSettings(ctx.chat.id);
    const qolgan = Math.max(0, settings.limit - count);

    let text = `📊 *Foydalanuvchi:* ${ctx.from.first_name}\n`;
    text += `👤 Qo'shgan odamlaringiz: ${count} ta\n`;
    text += `🎯 Guruh talabi: ${settings.limit} ta\n\n`;

    if (qolgan > 0) {
        text += `⚠️ Yozish uchun yana ${qolgan} ta odam qo'shishingiz kerak.`;
    } else {
        text += `✅ Siz guruhda bemalol yoza olasiz!`;
    }

    // Statistika xabarini ham keyinchalik o'chirib yuborish (tozalik uchun)
    const msg = await ctx.replyWithMarkdown(text);
    setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 30000);
}

// Admin Panel (/sozlamalar)
bot.command('sozlamalar', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Sozlamalar faqat guruh ichida ishlaydi.");
    
    if (!(await isUserAdmin(ctx))) {
        const msg = await ctx.reply("⛔️ Bu buyruq faqat adminlar uchun!");
        setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 5000);
        return;
    }

    const settings = getGroupSettings(ctx.chat.id);
    await showSettingsPanel(ctx, settings);
});

// Yordam buyrugi
bot.command('help', async (ctx) => {
    const helpText = `🤖 *Bot Buyruqlari:*\n\n` +
        `/stat yoki /stats - Sizning statistikani ko'rish\n` +
        `/sozlamalar - Guruh sozlamalarini o'zgartirish (admin uchun)\n` +
        `/help - Bu matn`;
    
    await ctx.replyWithMarkdown(helpText);
});

// --- ACTIONS (Tugmalar bosilganda) ---

// Limitni o'zgartirish
bot.action(/set_limit_(\d+)/, async (ctx) => {
    if (!(await isUserAdmin(ctx))) return ctx.answerCbQuery("Siz admin emassiz!", { show_alert: true });

    const newLimit = parseInt(ctx.match[1]);
    const settings = getGroupSettings(ctx.chat.id);
    settings.limit = newLimit;

    // Muvaffaqiyatli xabar (tepada toast bo'lib chiqadi)
    await ctx.answerCbQuery(`✅ Limit ${newLimit} taga muvaffaqiyatli faollashtirildi!`);
    
    // Menyuni yangilash (yozuvni o'zgartirish)
    await showSettingsPanel(ctx, settings, true);
});

// Kirdi-chiqdi o'chirishni yoqish/o'chirish
bot.action('toggle_service', async (ctx) => {
    // 1. Admin tekshiruvi
    if (!(await isUserAdmin(ctx))) {
        return ctx.answerCbQuery("⛔️ Siz admin emassiz! Sozlamalarni o'zgartira olmaysiz.", { show_alert: true });
    }

    // 2. Sozlamani o'zgartirish
    const settings = getGroupSettings(ctx.chat.id);
    settings.deleteServiceMessages = !settings.deleteServiceMessages;

    // 3. Status matnini tayyorlash
    const statusText = settings.deleteServiceMessages 
        ? "✅ Tozalash rejimi YOQILDI.\nEndi kirdi-chiqdi xabarlari o'chiriladi." 
        : "❌ Tozalash rejimi O'CHIRILDI.\nKirdi-chiqdi xabarlari ko'rinib turadi.";

    // 4. Foydalanuvchiga xabar berish (Toast)
    await ctx.answerCbQuery(settings.deleteServiceMessages ? "Tozalash yoqildi!" : "Tozalash o'chirildi!");

    // 5. Menyuni yangilash (yangi holat bilan)
    await showSettingsPanel(ctx, settings, true);
});

bot.action('close_panel', (ctx) => ctx.deleteMessage().catch(() => {}));

// --- EVENTLAR ---

// --- UNIVERSAL TOZALOVCHI VA HISOB KITOB ---

// 1. Yangi kirganlar (Link orqali, birov qo'shgan, va h.k.)
bot.on('new_chat_members', async (ctx) => {
    const settings = getGroupSettings(ctx.chat.id);

    // --- TOZALASH QISMI ---
    // Agar tozalash yoqilgan bo'lsa, "Falonchi qo'shildi" xabarini darhol o'chiramiz
    if (settings.deleteServiceMessages) {
        try {
            await ctx.deleteMessage(); 
        } catch (e) {
            // Agar bot admin bo'lmasa yoki xabar allaqachon o'chgan bo'lsa, xatolik bermasligi uchun
            console.log("Kirdi xabarini o'chirishda xatolik:", e.message);
        }
    }

    // --- HISOB-KITOB QISMI (Botning asosiy ishi) ---
    const inviterId = ctx.from.id; // Kim harakat qildi?
    const botId = ctx.botInfo.id;
    
    // Bot o'zi qo'shilgan bo'lsa, salom beradi
    const botUser = ctx.message.new_chat_members.find(u => u.id === botId);
    if (botUser) {
        return ctx.reply("🤖 Men ishga tushdim!\nAdminlar /sozlamalar orqali limitni belgilasin.");
    }

    // Yangi qo'shilganlarni tahlil qilamiz
    const newMembersCount = ctx.message.new_chat_members.length;
    const addedUser = ctx.message.new_chat_members[0];
    
    // MANTIQ: Agar "Harakat qilgan odam" (from) "Qo'shilgan odam" (member) bilan bir xil bo'lmasa
    // Demak, kimdir kimnidir qo'shdi. (Link orqali kirsa from va member bir xil bo'ladi - sanalmaydi)
    if (inviterId !== addedUser.id) {
        const currentInvites = incrementUserInvites(ctx.chat.id, inviterId, newMembersCount);
        
        // Tabriklash (Agar limitga yetgan bo'lsa) - Bu xabarni ham 15 sekunddan keyin o'chiramiz
        if (currentInvites >= settings.limit) {
            const msg = await ctx.reply(`🎉 *${ctx.from.first_name}*, raxmat! Siz ${settings.limit} ta odam qo'shish talabini bajardingiz. Endi guruhda yoza olasiz.`);
            setTimeout(() => ctx.deleteMessage(msg.message_id).catch(()=>{}), 15000);
        }
    }
});

// 2. Chiqib ketganlar (Left member) - Hisob-kitobdan ham kamaytirish
bot.on('left_chat_member', async (ctx) => {
    const settings = getGroupSettings(ctx.chat.id);
    
    // Xabarni o'chirish
    if (settings.deleteServiceMessages) {
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log("Chiqib ketish xabarini o'chirishda xatolik:", e.message);
        }
    }
    
    // Agar bot adminlar o'chgan foydalanuvchini bilsa, uning qo'shgan sonini qaytaramiz
    try {
        const leftUser = ctx.message.left_chat_member;
        if (leftUser && leftUser.id !== ctx.botInfo.id) {
            // Uni o'chirganning statistikasini qaytarish
            const members = await ctx.getChatMemberCount();
            console.log(`${leftUser.first_name} guruhdan chiqib ketdi (Jami a'zolar: ${members})`);
        }
    } catch (e) {
        console.log("Chiqib ketuvchini qayta hisoblashda xatolik:", e.message);
    }
});

// 3. QO'SHIMCHA: Pinned Messages (Qadalgan xabarlar)
// Ko'pincha adminlar "Pin" qilganda ham "Falonchi xabarni qadadi" degan kulrang yozuv chiqadi. 
// To'liq tozalik uchun buni ham o'chirish tavsiya qilinadi.
bot.on('pinned_message', async (ctx) => {
    const settings = getGroupSettings(ctx.chat.id);
    if (settings.deleteServiceMessages) {
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log("Qadalgan xabar xabarini o'chirishda xatolik:", e.message);
        }
    }
});

// Xabarlar nazorati (Asosiy logika)
bot.on('message', async (ctx) => {
    if (ctx.chat.type === 'private') return;

    // Adminlarga tegmaysiz
    if (await isUserAdmin(ctx)) return;

    // Bot buyruqlari va botsiz shunga o'xshashlarni shu'ormaysiz
    if (ctx.message.text && ctx.message.text.startsWith('/')) return;

    const settings = getGroupSettings(ctx.chat.id);
    const userInvites = getUserInvites(ctx.chat.id, ctx.from.id);

    // Agar limitga yetmagan bo'lsa
    if (userInvites < settings.limit) {
        try {
            // 1. Foydalanuvchi xabarini darhol o'chirish
            await ctx.deleteMessage();

            // 2. Ogohlantirish yuborish
            const qolgan = settings.limit - userInvites;
            const name = ctx.from.first_name.replace(/[\[\]()~>#+=|{}.!-]/g, '\\$&');
            
            const warningMsg = await ctx.replyWithMarkdown(
                `🚫 *${name}*, uzr!\n` +
                `Guruhda yozish uchun yana *${qolgan}* ta odam qo'shishingiz shart.\n\n` +
                `_Hozircha: ${userInvites} / ${settings.limit}_\n` +
                `_Tepadagi "Add Members" tugmasi orqali do'stlaringizni chaqiring._`
            );

            // 3. Xabarni 20 soniyadan keyin o'chirish (o'qib olishi uchun)
            setTimeout(() => {
                ctx.deleteMessage(warningMsg.message_id).catch(() => {});
            }, 20000); // 20000 ms = 20 sekund

        } catch (error) {
            console.log("Xabar o'chirishda xatolik:", error.message);
        }
    }
});

// --- YORDAMCHI FUNKSIYALAR ---

function chunkArray(myArray, chunk_size){
    var results = [];
    while (myArray.length) {
        results.push(myArray.splice(0, chunk_size));
    }
    return results;
}

// Sozlamalar panelini chiqarish funksiyasi
async function showSettingsPanel(ctx, settings, isEdit = false) {
    const buttons = [];
    // 1 dan 20 gacha tugmalar
    for (let i = 1; i <= 20; i++) {
        // Tanlangan raqamni belgilab qo'yish (masalan ✅)
        const label = settings.limit === i ? `✅ ${i}` : `${i}`;
        buttons.push(Markup.button.callback(label, `set_limit_${i}`));
    }

    const serviceBtnText = settings.deleteServiceMessages 
        ? "🗑 Kirdi-chiqdini o'chirish: O'CHDI" 
        : "👁 Kirdi-chiqdini o'chirish: ✅YONDI";

    const text = `⚙️ *Guruh Sozlamalari*\n\n` +
                 `Hozirgi holat: *${settings.limit} ta* odam qo'shish majburiy.\n` +
                 `O'zgartirish uchun raqamni tanlang:`;

    const keyboard = Markup.inlineKeyboard([
        ...chunkArray(buttons, 5), // 5 qator
        [Markup.button.callback(serviceBtnText, 'toggle_service')],
        [Markup.button.callback("❌ Yopish", "close_panel")]
    ]);

    if (isEdit) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
        await ctx.replyWithMarkdown(text, keyboard);
    }
}

// --- SERVER (RENDER UCHUN) ---
const app = express();

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Bot faol ishlamoqda.',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', bot: 'running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server ${PORT} portida ishga tushdi.`);
});

// --- ANTI-SLEEP (UXLAB QOLMASLIK UCHUN) ---
if (APP_URL) {
    setInterval(() => {
        axios.get(APP_URL)
            .then(() => console.log('✅ Ping yuborildi (Anti-sleep)'))
            .catch(err => console.error('❌ Ping xatosi:', err.message));
    }, 10 * 60 * 1000); // Har 10 daqiqada
}

bot.launch().then(() => console.log('✅ Bot muvaffaqiyatli ishga tushdi!'));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
