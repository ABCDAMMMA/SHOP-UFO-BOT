const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

if (!ADMIN_ID) {
  throw new Error("ADMIN_CHAT_ID is missing");
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
const orders = new Map();

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "⭐ خرید استارز تلگرام", callback_data: "stars" }],
      [{ text: "🎁 خرید گیفت تلگرام", callback_data: "gifts" }],
      [{ text: "🛍 سایر خدمات مجازی", callback_data: "services" }],
      [{ text: "📞 پشتیبانی", callback_data: "support" }]
    ]
  }
};

const products = {
  stars: "⭐ خرید استارز تلگرام",
  gifts: "🎁 خرید گیفت تلگرام",
  services: "🛍 سایر خدمات مجازی"
};

bot.onText(/\/start/, (msg) => {
  orders.delete(msg.from.id);

  bot.sendMessage(
    msg.chat.id,
    "🛸 به فروشگاه SHOP_UFO خوش آمدی!\n\nاز منوی زیر خدمات موردنظرت رو انتخاب کن:",
    mainMenu
  );
});

bot.onText(/\/cancel/, (msg) => {
  orders.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "سفارش لغو شد.", mainMenu);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const choice = query.data;

  await bot.answerCallbackQuery(query.id);

  if (products[choice]) {
    orders.set(userId, {
      product: products[choice],
      username: query.from.username || "ندارد",
      firstName: query.from.first_name || "نامشخص"
    });

    return bot.sendMessage(
      chatId,
      "📝 لطفاً جزئیات سفارش خودت رو در یک پیام بنویس.\n\nمثلاً مقدار موردنظر و توضیحات لازم.\n\nبرای لغو سفارش /cancel رو بفرست."
    );
  }

  if (choice === "support") {
    return bot.sendMessage(
      chatId,
      "📞 درخواست پشتیبانی ثبت شد. پیام خودت رو ارسال کن تا برای مدیریت فروشگاه فرستاده بشه."
    );
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = msg.from.id;
  const order = orders.get(userId);

  if (order) {
    const username = msg.from.username
      ? "@" + msg.from.username
      : "ندارد";

    const report =
      "🛍 سفارش جدید SHOP_UFO\n\n" +
      "محصول: " + order.product + "\n" +
      "نام: " + order.firstName + "\n" +
      "آیدی تلگرام: " + username + "\n" +
      "شناسه مشتری: " + userId + "\n\n" +
      "جزئیات سفارش:\n" + msg.text;

    try {
      await bot.sendMessage(ADMIN_ID, report);
      await bot.sendMessage(
        msg.chat.id,
        "✅ سفارش شما برای مدیریت فروشگاه ارسال شد.\nبه‌زودی برای هماهنگی با شما تماس گرفته می‌شود.",
        mainMenu
      );
    } catch (error) {
      await bot.sendMessage(
        msg.chat.id,
        "ارسال سفارش با مشکل مواجه شد. لطفاً بعداً دوباره تلاش کن."
      );
    }

    orders.delete(userId);
    return;
  }

  bot.sendMessage(
    msg.chat.id,
    "برای شروع، یکی از گزینه‌های منو رو انتخاب کن.",
    mainMenu
  );
});

app.get("/", (req, res) => {
  res.send("SHOP_UFO Bot is running!");
});

app.listen(PORT, () => {
  console.log("SHOP_UFO server is running on port " + PORT);
});
