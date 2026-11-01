const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { Pool } = require("pg");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_CHAT_ID || "");
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !ADMIN_ID || !DATABASE_URL) {
  throw new Error("Missing environment variables");
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const states = new Map();

const products = {
  stars: "⭐ استارز تلگرام",
  gifts: "🎁 گیفت تلگرام",
  services: "🛍 سایر خدمات مجازی"
};

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "⭐ خرید استارز", callback_data: "buy_stars" }],
      [{ text: "🎁 خرید گیفت", callback_data: "buy_gifts" }],
      [{ text: "🛍 سایر خدمات", callback_data: "buy_services" }],
      [{ text: "📞 پشتیبانی", callback_data: "support" }]
    ]
  }
};

const adminMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "💰 تغییر قیمت محصولات", callback_data: "edit_prices" }],
      [{ text: "💳 تغییر شماره کارت", callback_data: "edit_card" }],
      [{ text: "📦 سفارش‌های اخیر", callback_data: "orders" }],
      [{ text: "🏠 منوی اصلی", callback_data: "home" }]
    ]
  }
};

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      code TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      price TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username TEXT,
      product TEXT NOT NULL,
      details TEXT NOT NULL,
      price TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_receipt',
      receipt TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const [code, title] of Object.entries(products)) {
    await db.query(
      `INSERT INTO products (code, title, price)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [code, title, "برای استعلام قیمت پیام بدهید"]
    );
  }

  await db.query(
    `INSERT INTO settings (key, value)
     VALUES ('card', 'شماره کارت هنوز تنظیم نشده')
     ON CONFLICT (key) DO NOTHING`
  );

  console.log("SHOP_UFO database connected");
}

async function getPrice(code) {
  const result = await db.query(
    "SELECT price FROM products WHERE code = $1",
    [code]
  );
  return result.rows[0]?.price || "برای استعلام تماس بگیرید";
}

async function getCard() {
  const result = await db.query(
    "SELECT value FROM settings WHERE key = 'card'"
  );
  return result.rows[0]?.value || "شماره کارت تنظیم نشده";
}

function isAdmin(userId) {
  return String(userId) === ADMIN_ID;
}

bot.onText(/\/start/, async (msg) => {
  states.delete(msg.from.id);

  await bot.sendMessage(
    msg.chat.id,
    "🛸 به فروشگاه SHOP_UFO خوش آمدی!\n\nخدمات موردنظرت رو انتخاب کن:",
    mainMenu
  );
});

bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "⛔ دسترسی غیرمجاز");
  }

  states.delete(msg.from.id);
  bot.sendMessage(
    msg.chat.id,
    "⚙️ پنل مدیریت SHOP_UFO",
    adminMenu
  );
});

bot.onText(/\/cancel/, (msg) => {
  states.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "عملیات لغو شد.", mainMenu);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  try {
    if (data === "home") {
      states.delete(userId);
      return bot.sendMessage(chatId, "منوی اصلی:", mainMenu);
    }

    if (data.startsWith("buy_")) {
      const code = data.replace("buy_", "");
      const title = products[code];

      if (!title) return;

      states.set(userId, { type: "order", code });

      return bot.sendMessage(
        chatId,
        `🛍 محصول: ${title}\n\nلطفاً مقدار و جزئیات سفارش خودت رو بنویس.\n\nبرای لغو /cancel رو بفرست.`
      );
    }

    if (data === "support") {
      states.set(userId, { type: "support" });
      return bot.sendMessage(
        chatId,
        "📞 پیام خودت رو برای پشتیبانی بنویس."
      );
    }

    if (data === "edit_prices" && isAdmin(userId)) {
      const keyboard = Object.entries(products).map(([code, title]) => [
        { text: title, callback_data: "price_" + code }
      ]);

      return bot.sendMessage(chatId, "محصول موردنظر رو انتخاب کن:", {
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (data.startsWith("price_") && isAdmin(userId)) {
      const code = data.replace("price_", "");
      if (!products[code]) return;

      states.set(userId, { type: "set_price", code });

      return bot.sendMessage(
        chatId,
        `قیمت جدید برای ${products[code]} رو بفرست.\nمثلاً: ۱۰۰ هزار تومان`
      );
    }

    if (data === "edit_card" && isAdmin(userId)) {
      states.set(userId, { type: "set_card" });
      return bot.sendMessage(chatId, "شماره کارت جدید رو ارسال کن.");
    }

    if (data === "orders" && isAdmin(userId)) {
      const result = await db.query(
        "SELECT * FROM orders ORDER BY id DESC LIMIT 10"
      );

      if (!result.rows.length) {
        return bot.sendMessage(chatId, "هنوز سفارشی ثبت نشده است.");
      }

      for (const order of result.rows) {
        await bot.sendMessage(
          chatId,
          `📦 سفارش #${order.id}\nمحصول: ${order.product}\nجزئیات: ${order.details}\nمبلغ: ${order.price}\nوضعیت: ${order.status}`
        );
      }
      return;
    }

    if (data.startsWith("approve_") && isAdmin(userId)) {
      const id = Number(data.split("_")[1]);
      const result = await db.query(
        "UPDATE orders SET status = 'completed' WHERE id = $1 AND status = 'awaiting_admin' RETURNING *",
        [id]
      );

      if (!result.rows.length) {
        return bot.sendMessage(chatId, "این سفارش قابل تأیید نیست.");
      }

      await bot.sendMessage(
        result.rows[0].user_id,
        `✅ پرداخت سفارش #${id} تأیید شد.\nسفارش شما تکمیل شد.`
      );

      return bot.sendMessage(chatId, `✅ سفارش #${id} تکمیل شد.`);
    }

    if (data.startsWith("reject_") && isAdmin(userId)) {
      const id = Number(data.split("_")[1]);
      const result = await db.query(
        "UPDATE orders SET status = 'rejected' WHERE id = $1 AND status = 'awaiting_admin' RETURNING *",
        [id]
      );

      if (!result.rows.length) {
        return bot.sendMessage(chatId, "این سفارش قابل رد نیست.");
      }

      await bot.sendMessage(
        result.rows[0].user_id,
        `❌ پرداخت سفارش #${id} تأیید نشد.\nبرای پیگیری با پشتیبانی تماس بگیر.`
      );

      return bot.sendMessage(chatId, `❌ سفارش #${id} رد شد.`);
    }
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, "خطایی رخ داد. دوباره تلاش کن.");
  }
});

bot.on("message", async (msg) => {
  if (!msg.from || msg.from.is_bot) return;
  if (msg.text && msg.text.startsWith("/")) return;

  const userId = msg.from.id;
  const state = states.get(userId);

  if (!state) return;

  try {
    if (state.type === "set_price" && isAdmin(userId)) {
      if (!msg.text) {
        return bot.sendMessage(userId, "لطفاً قیمت را به صورت متن بفرست.");
      }

      await db.query(
        "UPDATE products SET price = $1 WHERE code = $2",
        [msg.text, state.code]
      );

      states.delete(userId);
      return bot.sendMessage(userId, "✅ قیمت با موفقیت تغییر کرد.", adminMenu);
    }

    if (state.type === "set_card" && isAdmin(userId)) {
      if (!msg.text) {
        return bot.sendMessage(userId, "شماره کارت را به صورت متن بفرست.");
      }

      await db.query(
        `INSERT INTO settings (key, value)
         VALUES ('card', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [msg.text]
      );

      states.delete(userId);
      return bot.sendMessage(userId, "✅ شماره کارت ذخیره شد.", adminMenu);
    }

    if (state.type === "order") {
      if (!msg.text) {
        return bot.sendMessage(userId, "لطفاً جزئیات سفارش را به صورت متن بفرست.");
      }

      const price = await getPrice(state.code);
      const title = products[state.code];
      const card = await getCard();

      const result = await db.query(
        `INSERT INTO orders
         (user_id, username, product, details, price)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          userId,
          msg.from.username || "",
          title,
          msg.text,
          price
        ]
      );

      const orderId = result.rows[0].id;
      states.set(userId, { type: "receipt", orderId });

      await bot.sendMessage(
        userId,
        `🧾 سفارش #${orderId} ثبت شد.\n\nمحصول: ${title}\nجزئیات: ${msg.text}\nمبلغ: ${price}\n\n💳 شماره کارت:\n${card}\n\nپس از پرداخت، تصویر رسید یا کد پیگیری را همین‌جا ارسال کن.\n\n⚠️ پرداخت فقط پس از بررسی مدیریت تأیید می‌شود.`
      );

      await bot.sendMessage(
        ADMIN_ID,
        `🛍 سفارش جدید #${orderId}\nمحصول: ${title}\nمشتری: ${msg.from.username ? "@" + msg.from.username : "بدون نام کاربری"}\nجزئیات: ${msg.text}\nمبلغ: ${price}\nوضعیت: در انتظار رسید`
      );

      return;
    }

    if (state.type === "receipt") {
      const receipt = msg.photo
        ? msg.photo[msg.photo.length - 1].file_id
        : msg.text;

      if (!receipt) {
        return bot.sendMessage(userId, "لطفاً تصویر رسید یا کد پیگیری را بفرست.");
      }

      const result = await db.query(
        `UPDATE orders SET receipt = $1, status = 'awaiting_admin'
         WHERE id = $2 AND user_id = $3
         RETURNING *`,
        [receipt, state.orderId, userId]
      );

      if (!result.rows.length) {
        states.delete(userId);
        return bot.sendMessage(userId, "سفارش پیدا نشد. لطفاً با پشتیبانی تماس بگیر.");
      }

      const order = result.rows[0];
      const keyboard = {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ تأیید پرداخت", callback_data: "approve_" + order.id },
            { text: "❌ رد پرداخت", callback_data: "reject_" + order.id }
          ]]
        }
      };

      const caption =
        `🧾 رسید سفارش #${order.id}\nمحصول: ${order.product}\nمشتری: ${userId}\nمبلغ: ${order.price}`;

      if (msg.photo) {
        await bot.sendPhoto(ADMIN_ID, receipt, {
          caption,
          ...keyboard
        });
      } else {
        await bot.sendMessage(
          ADMIN_ID,
          caption + "\nکد پیگیری: " + receipt,
          keyboard
        );
      }

      states.delete(userId);
      return bot.sendMessage(
        userId,
        "✅ رسید دریافت شد.\nسفارش در انتظار بررسی مدیریت است."
      );
    }

    if (state.type === "support") {
      const text = msg.text || "مشتری یک فایل یا رسانه فرستاده است.";

      await bot.sendMessage(
        ADMIN_ID,
        `📞 پیام پشتیبانی\nمشتری: ${userId}\nنام کاربری: @${msg.from.username || "ندارد"}\n\n${text}`
      );

      states.delete(userId);
      return bot.sendMessage(userId, "✅ پیام تو برای پشتیبانی ارسال شد.", mainMenu);
    }
  } catch (error) {
    console.error(error);
    bot.sendMessage(userId, "خطایی رخ داد. لطفاً دوباره تلاش کن.");
  }
});

app.get("/", (req, res) => {
  res.send("SHOP_UFO Bot is running!");
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("SHOP_UFO server is running on port " + PORT);
    });
  })
  .catch((error) => {
    console.error("Database connection failed:", error);
    process.exit(1);
  });
