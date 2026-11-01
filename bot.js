
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const express = require("express");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_CHAT_ID || "");
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !ADMIN_ID || !DATABASE_URL) {
  throw new Error("Missing environment variables");
}

const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.get("/", (_, res) => res.send("SHOP_UFO is running"));
app.get("/health", (_, res) => res.send("OK"));

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price BIGINT NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      price BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      receipt_file_id TEXT,
      delivery TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      user_id BIGINT PRIMARY KEY,
      action TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'
    );
  `);

  for (const name of ["تلگرام استارز", "گیفت تلگرام", "سایر خدمات مجازی"]) {
    await db.query(
      `INSERT INTO products(name,price)
       SELECT $1,0
       WHERE NOT EXISTS (SELECT 1 FROM products WHERE name=$1)`,
      [name]
    );
  }
}

async function sessionSet(id, action, data = {}) {
  await db.query(
    `INSERT INTO user_sessions(user_id,action,data)
     VALUES($1,$2,$3)
     ON CONFLICT(user_id)
     DO UPDATE SET action=$2,data=$3`,
    [id, action, JSON.stringify(data)]
  );
}

async function sessionGet(id) {
  const r = await db.query(
    "SELECT action,data FROM user_sessions WHERE user_id=$1",
    [id]
  );
  return r.rows[0] || null;
}

async function sessionClear(id) {
  await db.query("DELETE FROM user_sessions WHERE user_id=$1", [id]);
}

function admin(id) {
  return String(id) === ADMIN_ID;
}

function menu(id) {
  const rows = [
    [{ text: "🛍 خدمات فروشگاه", callback_data: "products" }],
    [{ text: "📦 سفارش‌های من", callback_data: "orders" }],
    [{ text: "💬 پشتیبانی", callback_data: "support" }]
  ];

  if (admin(id)) {
    rows.push([{ text: "⚙️ مدیریت", callback_data: "admin" }]);
  }

  return { inline_keyboard: rows };
}

bot.onText(/^\/start$/, async msg => {
  await sessionClear(msg.from.id);
  await bot.sendMessage(
    msg.chat.id,
    "🛸 به فروشگاه SHOP_UFO خوش آمدید.",
    { reply_markup: menu(msg.from.id) }
  );
});

bot.onText(/^\/cancel$/, async msg => {
  await sessionClear(msg.from.id);
  await bot.sendMessage(msg.chat.id, "عملیات لغو شد.");
});

bot.on("callback_query", async q => {
  const id = q.from.id;
  const chat = q.message.chat.id;
  const d = q.data;

  await bot.answerCallbackQuery(q.id).catch(() => {});

  try {
    if (d === "products") {
      const r = await db.query(
        "SELECT * FROM products WHERE active=true ORDER BY id"
      );

      if (!r.rows.length) return bot.sendMessage(chat, "محصولی موجود نیست.");

      return bot.sendMessage(chat, "خدمات فروشگاه:", {
        reply_markup: {
          inline_keyboard: r.rows.map(p => [{
            text: `${p.name} | ${Number(p.price).toLocaleString("en-US")} تومان`,
            callback_data: `buy_${p.id}`
          }])
        }
      });
    }

    if (d.startsWith("buy_")) {
      const pid = Number(d.slice(4));
      const r = await db.query(
        "SELECT * FROM products WHERE id=$1 AND active=true", [pid]
      );

      if (!r.rows.length) return bot.sendMessage(chat, "محصول پیدا نشد.");

      const p = r.rows[0];
      if (Number(p.price) <= 0) {
        return bot.sendMessage(chat, "قیمت این محصول هنوز تنظیم نشده است.");
      }

      const order = await db.query(
        `INSERT INTO orders(user_id,product_id,product_name,price)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [id, p.id, p.name, p.price]
      );

      await sessionSet(id, "receipt", { orderId: order.rows[0].id });

      const card = await db.query(
        "SELECT value FROM settings WHERE key='card_number'"
      );

      return bot.sendMessage(
        chat,
        `سفارش #${order.rows[0].id}\nمحصول: ${p.name}\nمبلغ: ${Number(p.price).toLocaleString("en-US")} تومان\nشماره کارت:\n${card.rows[0]?.value || "تنظیم نشده"}\n\nپس از پرداخت تصویر رسید را ارسال کنید.`
      );
    }

    if (d === "orders") {
      const r = await db.query(
        "SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 10",
        [id]
      );

      if (!r.rows.length) return bot.sendMessage(chat, "هنوز سفارشی ندارید.");

      const status = {
        pending_payment: "در انتظار رسید",
        receipt_submitted: "در انتظار بررسی رسید",
        awaiting_delivery: "در انتظار تحویل",
        completed: "تکمیل شده",
        rejected: "رد شده"
      };

      return bot.sendMessage(chat, r.rows.map(o =>
        `#${o.id} | ${o.product_name}\n${status[o.status] || o.status}`
      ).join("\n\n"));
    }

    if (d === "support") {
      return bot.sendMessage(chat, "برای پشتیبانی با مدیریت فروشگاه تماس بگیرید.");
    }

    if (d === "admin" && admin(id)) {
      return bot.sendMessage(chat, "پنل مدیریت SHOP_UFO", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 آمار", callback_data: "stats" }],
            [{ text: "💳 شماره کارت", callback_data: "card" }],
            [{ text: "💰 قیمت محصولات", callback_data: "prices" }]
          ]
        }
      });
    }

    if (d === "stats" && admin(id)) {
      const r = await db.query(
        "SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='completed') completed FROM orders"
      );
      return bot.sendMessage(
        chat,
        `کل سفارش‌ها: ${r.rows[0].total}\nتکمیل‌شده: ${r.rows[0].completed}`
      );
    }

    if (d === "card" && admin(id)) {
      await sessionSet(id, "setcard");
      return bot.sendMessage(chat, "شماره کارت ۱۶ رقمی را بفرستید.");
    }

    if (d === "prices" && admin(id)) {
      const r = await db.query("SELECT * FROM products ORDER BY id");
      return bot.sendMessage(chat, "محصول را انتخاب کنید:", {
        reply_markup: {
          inline_keyboard: r.rows.map(p => [{
            text: p.name,
            callback_data: `price_${p.id}`
          }])
        }
      });
    }

    if (d.startsWith("price_") && admin(id)) {
      await sessionSet(id, "setprice", { productId: Number(d.slice(6)) });
      return bot.sendMessage(chat, "قیمت جدید را به تومان وارد کنید.");
    }

    if (d.startsWith("approve_") && admin(id)) {
      const oid = Number(d.slice(8));
      const r = await db.query(
        `UPDATE orders SET status='awaiting_delivery'
         WHERE id=$1 AND status='receipt_submitted' RETURNING user_id`,
        [oid]
      );

      if (!r.rows.length) return bot.sendMessage(chat, "این سفارش قبلاً بررسی شده است.");

      await sessionSet(id, "delivery", { orderId: oid });
      await bot.sendMessage(r.rows[0].user_id, "پرداخت تأیید شد؛ سفارش در حال آماده‌سازی است.");
      return bot.sendMessage(chat, "متن اطلاعات تحویل را ارسال کنید.");
    }

    if (d.startsWith("reject_") && admin(id)) {
      const oid = Number(d.slice(7));
      const r = await db.query(
        `UPDATE orders SET status='rejected'
         WHERE id=$1 AND status='receipt_submitted' RETURNING user_id`,
        [oid]
      );

      if (!r.rows.length) return bot.sendMessage(chat, "این سفارش قبلاً بررسی شده است.");

      await bot.sendMessage(r.rows[0].user_id, "رسید پرداخت تأیید نشد. برای پشتیبانی پیام دهید.");
      return bot.sendMessage(chat, "سفارش رد شد.");
    }
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chat, "خطایی رخ داد.");
  }
});

bot.on("photo", async msg => {
  try {
    const s = await sessionGet(msg.from.id);
    if (!s || s.action !== "receipt") return;

    const oid = s.data.orderId;
    const photo = msg.photo[msg.photo.length - 1];

    const r = await db.query(
      `UPDATE orders SET receipt_file_id=$1,status='receipt_submitted'
       WHERE id=$2 AND user_id=$3 AND status='pending_payment'
       RETURNING *`,
      [photo.file_id, oid, msg.from.id]
    );

    await sessionClear(msg.from.id);
    if (!r.rows.length) return bot.sendMessage(msg.chat.id, "سفارش در انتظار رسید نیست.");

    await bot.sendMessage(msg.chat.id, "رسید دریافت شد و برای بررسی ارسال شد.");

    await bot.sendPhoto(ADMIN_ID, photo.file_id, {
      caption: `رسید سفارش #${oid}\nمحصول: ${r.rows[0].product_name}\nمبلغ: ${r.rows[0].price} تومان\nمشتری: ${msg.from.id}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "تأیید پرداخت", callback_data: `approve_${oid}` },
          { text: "رد پرداخت", callback_data: `reject_${oid}` }
        ]]
      }
    });
  } catch (e) {
    console.error(e);
    await bot.sendMessage(msg.chat.id, "خطا در دریافت رسید.");
  }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const id = msg.from.id;
  const s = await sessionGet(id);
  if (!s) return;

  if (s.action === "setcard" && admin(id)) {
    const card = msg.text.replace(/\s/g, "");
    if (!/^\d{16}$/.test(card)) {
      return bot.sendMessage(msg.chat.id, "شماره کارت باید ۱۶ رقم باشد.");
    }

    await db.query(
      `INSERT INTO settings(key,value) VALUES('card_number',$1)
       ON CONFLICT(key) DO UPDATE SET value=$1`, [card]
    );
    await sessionClear(id);
    return bot.sendMessage(msg.chat.id, "شماره کارت ذخیره شد.");
  }

  if (s.action === "setprice" && admin(id)) {
    const price = Number(msg.text.replace(/[,\s]/g, ""));
    if (!Number.isSafeInteger(price) || price <= 0) {
      return bot.sendMessage(msg.chat.id, "قیمت معتبر وارد کنید.");
    }

    await db.query("UPDATE products SET price=$1 WHERE id=$2",
      [price, s.data.productId]
    );
    await sessionClear(id);
    return bot.sendMessage(msg.chat.id, "قیمت تغییر کرد.");
  }

  if (s.action === "delivery" && admin(id)) {
    const oid = s.data.orderId;
    const r = await db.query(
      `UPDATE orders SET delivery=$1,status='completed'
       WHERE id=$2 AND status='awaiting_delivery' RETURNING user_id`,
      [msg.text, oid]
    );

    await sessionClear(id);
    if (!r.rows.length) return bot.sendMessage(msg.chat.id, "سفارش آماده تحویل نیست.");

    await bot.sendMessage(r.rows[0].user_id,
      `اطلاعات تحویل سفارش #${oid}:\n\n${msg.text}`
    );
    return bot.sendMessage(msg.chat.id, "اطلاعات تحویل ارسال شد.");
  }
});

async function main() {
  await initDB();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("SHOP_UFO server running on " + port));
  console.log("SHOP_UFO bot started");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
