
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
const app = express();
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const states = new Map();

const isAdmin = id => String(id) === ADMIN_ID;
const money = n => Number(n).toLocaleString("en-US") + " تومان";

const kb = rows => ({ inline_keyboard: rows });

async function query(sql, values = []) {
  return pool.query(sql, values);
}

async function setting(key) {
  const r = await query(
    "SELECT value FROM ufo_settings WHERE key=$1",
    [key]
  );
  return r.rows[0]?.value || "";
}

async function saveSetting(key, value) {
  await query(`
    INSERT INTO ufo_settings(key,value)
    VALUES($1,$2)
    ON CONFLICT(key)
    DO UPDATE SET value=EXCLUDED.value
  `, [key, value]);
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS ufo_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      price BIGINT NOT NULL,
      description TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS ufo_cart (
      user_id TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(user_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS ufo_coupons (
      code TEXT PRIMARY KEY,
      percent INTEGER NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ufo_orders (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      items JSONB NOT NULL,
      total BIGINT NOT NULL,
      discount BIGINT NOT NULL DEFAULT 0,
      coupon TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_receipt',
      receipt_file_id TEXT,
      delivery_text TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ufo_support (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("SHOP UFO V3 database ready");
}

function homeKeyboard(admin) {
  const rows = [
    [{ text: "🛍 فروشگاه", callback_data: "shop" }],
    [
      { text: "🛒 سبد خرید", callback_data: "cart" },
      { text: "📦 سفارش‌ها", callback_data: "orders" }
    ],
    [
      { text: "🎟 کد تخفیف", callback_data: "coupon" },
      { text: "💬 پشتیبانی", callback_data: "support" }
    ]
  ];

  if (admin) {
    rows.push([
      { text: "⚙️ مدیریت فروشگاه", callback_data: "admin" }
    ]);
  }

  return kb(rows);
}

async function sendHome(chatId, userId) {
  const welcome = await setting("welcome");

  await bot.sendMessage(
    chatId,
    welcome || `🛸 به SHOP UFO خوش آمدید!

✨ فروش خدمات مجازی
⭐ استارز تلگرام
🎁 گیفت تلگرام
💎 خدمات ویژه

از منوی زیر استفاده کنید.`,
    { reply_markup: homeKeyboard(isAdmin(userId)) }
  );
}

async function showShop(chatId) {
  const r = await query(`
    SELECT DISTINCT category FROM products
    WHERE active=TRUE ORDER BY category
  `);

  if (!r.rows.length) {
    return bot.sendMessage(chatId, "فعلاً محصولی موجود نیست.");
  }

  const rows = r.rows.map(x => [{
    text: "📂 " + x.category,
    callback_data: "cat:" + Buffer.from(x.category).toString("base64url")
  }]);

  rows.push([{ text: "🏠 منوی اصلی", callback_data: "home" }]);

  await bot.sendMessage(chatId, "🛍 دسته‌بندی خدمات:", {
    reply_markup: kb(rows)
  });
}

async function showProducts(chatId, category) {
  const r = await query(`
    SELECT id,name,price,description
    FROM products
    WHERE category=$1 AND active=TRUE
    ORDER BY id DESC
  `, [category]);

  if (!r.rows.length) {
    return bot.sendMessage(chatId, "محصولی در این دسته وجود ندارد.");
  }

  for (const p of r.rows) {
    await bot.sendMessage(chatId,
      `✨ ${p.name}\n\n${p.description || "بدون توضیحات"}\n\n💰 ${money(p.price)}`,
      {
        reply_markup: kb([
          [{ text: "➕ افزودن به سبد", callback_data: "add:" + p.id }],
          [{ text: "🛒 مشاهده سبد", callback_data: "cart" }]
        ])
      }
    );
  }
}

async function addToCart(userId, productId) {
  const p = await query(
    "SELECT id FROM products WHERE id=$1 AND active=TRUE",
    [productId]
  );

  if (!p.rows.length) return false;

  await query(`
    INSERT INTO ufo_cart(user_id,product_id,quantity)
    VALUES($1,$2,1)
    ON CONFLICT(user_id,product_id)
    DO UPDATE SET quantity=ufo_cart.quantity+1
  `, [String(userId), productId]);

  return true;
}

async function showCart(chatId, userId) {
  const r = await query(`
    SELECT p.id,p.name,p.price,c.quantity,
           p.price*c.quantity AS subtotal
    FROM ufo_cart c
    JOIN products p ON p.id=c.product_id
    WHERE c.user_id=$1 AND p.active=TRUE
    ORDER BY p.id
  `, [String(userId)]);

  if (!r.rows.length) {
    return bot.sendMessage(chatId, "🛒 سبد خرید شما خالی است.", {
      reply_markup: kb([
        [{ text: "🛍 رفتن به فروشگاه", callback_data: "shop" }],
        [{ text: "🏠 منوی اصلی", callback_data: "home" }]
      ])
    });
  }

  let total = 0;
  const rows = [];

  for (const p of r.rows) {
    total += Number(p.subtotal);

    rows.push([{
      text: `➖ ${p.name} (${p.quantity})`,
      callback_data: "remove:" + p.id
    }]);
  }

  rows.push([{ text: "🎟 اعمال تخفیف", callback_data: "coupon" }]);
  rows.push([{ text: "💳 ثبت سفارش", callback_data: "checkout" }]);
  rows.push([{ text: "🗑 خالی کردن سبد", callback_data: "clearcart" }]);
  rows.push([{ text: "🏠 منوی اصلی", callback_data: "home" }]);

  await bot.sendMessage(chatId,
    `🛒 سبد خرید SHOP UFO\n\n` +
    r.rows.map(p =>
      `▪️ ${p.name} × ${p.quantity} = ${money(p.subtotal)}`
    ).join("\n") +
    `\n\n💰 مجموع: ${money(total)}`,
    { reply_markup: kb(rows) }
  );
}

async function removeCartItem(userId, productId) {
  await query(`
    UPDATE ufo_cart
    SET quantity=quantity-1
    WHERE user_id=$1 AND product_id=$2 AND quantity>1
  `, [String(userId), productId]);

  await query(`
    DELETE FROM ufo_cart
    WHERE user_id=$1 AND product_id=$2 AND quantity<=1
  `, [String(userId), productId]);
}

async function calculateCart(userId) {
  const r = await query(`
    SELECT p.id,p.name,p.price,c.quantity,
           p.price*c.quantity AS subtotal
    FROM ufo_cart c
    JOIN products p ON p.id=c.product_id
    WHERE c.user_id=$1 AND p.active=TRUE
  `, [String(userId)]);

  return {
    rows: r.rows,
    total: r.rows.reduce(
      (sum, p) => sum + Number(p.subtotal), 0
    )
  };
}

async function checkout(user, chatId) {
  const cart = await calculateCart(user.id);

  if (!cart.rows.length) {
    return bot.sendMessage(chatId, "سبد خرید خالی است.");
  }

  const couponCode = states.get(String(user.id))?.coupon || null;
  let discount = 0;

  if (couponCode) {
    const c = await query(`
      SELECT * FROM ufo_coupons
      WHERE code=$1 AND active=TRUE
      FOR UPDATE
    `, [couponCode]);

    if (c.rows.length) {
      const coupon = c.rows[0];

      if (!coupon.max_uses ||
          coupon.used_count < coupon.max_uses) {
        discount = Math.floor(
          cart.total * coupon.percent / 100
        );
      }
    }
  }

  const total = cart.total - discount;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const order = await client.query(`
      INSERT INTO ufo_orders
      (user_id,username,items,total,discount,coupon)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [
      String(user.id),
      user.username || "",
      JSON.stringify(cart.rows),
      total,
      discount,
      couponCode
    ]);

    await client.query(
      "DELETE FROM ufo_cart WHERE user_id=$1",
      [String(user.id)]
    );

    if (couponCode && discount > 0) {
      await client.query(`
        UPDATE ufo_coupons
        SET used_count=used_count+1
        WHERE code=$1
      `, [couponCode]);
    }

    await client.query("COMMIT");

    states.delete(String(user.id));

    const card = await setting("card");

    await bot.sendMessage(chatId,
      `✅ سفارش ثبت شد.

🆔 شماره سفارش: #${order.rows[0].id}
💰 مبلغ اولیه: ${money(cart.total)}
🎟 تخفیف: ${money(discount)}
💳 مبلغ نهایی: ${money(total)}

${card ? "شماره کارت:\n" + card : "شماره کارت هنوز تنظیم نشده است."}

پس از پرداخت، تصویر رسید را ارسال کنید.`,
      {
        reply_markup: kb([
          [{ text: "📦 سفارش‌های من", callback_data: "orders" }],
          [{ text: "🏠 منوی اصلی", callback_data: "home" }]
        ])
      }
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function showOrders(chatId, userId) {
  const r = await query(`
    SELECT * FROM ufo_orders
    WHERE user_id=$1 ORDER BY id DESC LIMIT 15
  `, [String(userId)]);

  if (!r.rows.length) {
    return bot.sendMessage(chatId, "هنوز سفارشی ثبت نکرده‌اید.");
  }

  for (const o of r.rows) {
    await bot.sendMessage(chatId,
      `📦 سفارش #${o.id}\n` +
      `💰 ${money(o.total)}\n` +
      `📌 وضعیت: ${o.status}\n` +
      (o.delivery_text ? `\n🚀 تحویل:\n${o.delivery_text}` : "")
    );
  }
}

function adminKeyboard() {
  return kb([
    [{ text: "➕ افزودن محصول", callback_data: "a:add" }],
    [{ text: "📋 محصولات", callback_data: "a:products" }],
    [{ text: "📦 سفارش‌های جدید", callback_data: "a:orders" }],
    [{ text: "📊 آمار فروش", callback_data: "a:stats" }],
    [{ text: "💳 تنظیم کارت", callback_data: "a:card" }],
    [{ text: "🎟 ساخت تخفیف", callback_data: "a:coupon" }],
    [{ text: "📝 پیام خوشامد", callback_data: "a:welcome" }],
    [{ text: "💬 پیام‌های پشتیبانی", callback_data: "a:support" }],
    [{ text: "🏠 منوی اصلی", callback_data: "home" }]
  ]);
}

async function showAdmin(chatId, userId) {
  if (!isAdmin(userId)) return;

  await bot.sendMessage(chatId,
    "⚙️ پنل مدیریت SHOP UFO\n\nیک بخش را انتخاب کنید:",
    { reply_markup: adminKeyboard() }
  );
}

async function adminProducts(chatId) {
  const r = await query(
    "SELECT * FROM products ORDER BY id DESC LIMIT 40"
  );

  if (!r.rows.length) {
    return bot.sendMessage(chatId, "محصولی ثبت نشده است.");
  }

  for (const p of r.rows) {
    await bot.sendMessage(chatId,
      `#${p.id} | ${p.name}\n` +
      `دسته: ${p.category}\n` +
      `قیمت: ${money(p.price)}\n` +
      `وضعیت: ${p.active ? "فعال" : "غیرفعال"}`,
      {
        reply_markup: kb([
          [{
            text: "✏️ تغییر قیمت",
            callback_data: "a:price:" + p.id
          }],
          [{
            text: p.active ? "🔴 غیرفعال کردن" : "🟢 فعال کردن",
            callback_data: "a:toggle:" + p.id
          }]
        ])
      }
    );
  }
}

async function adminOrders(chatId) {
  const r = await query(`
    SELECT * FROM ufo_orders
    WHERE status IN ('awaiting_receipt','paid')
    ORDER BY id DESC LIMIT 20
  `);

  if (!r.rows.length) {
    return bot.sendMessage(chatId, "سفارش بازی وجود ندارد.");
  }

  for (const o of r.rows) {
    const rows = [];

    if (o.status === "paid") {
      rows.push([{
        text: "🚀 تحویل سفارش",
        callback_data: "a:deliver:" + o.id
      }]);
    }

    await bot.sendMessage(chatId,
      `📦 سفارش #${o.id}\n` +
      `👤 کاربر: ${o.username || o.user_id}\n` +
      `💰 مبلغ: ${money(o.total)}\n` +
      `📌 وضعیت: ${o.status}\n` +
      `🧾 رسید: ${o.receipt_file_id ? "ارسال شده" : "هنوز ارسال نشده"}`,
      {
        reply_markup: kb([
          ...(o.status === "awaiting_receipt" ? [[
            { text: "✅ تأیید پرداخت", callback_data: "a:approve:" + o.id },
            { text: "❌ رد پرداخت", callback_data: "a:reject:" + o.id }
          ]] : []),
          ...rows
        ])
      }
    );
  }
}

async function adminStats(chatId) {
  const r = await query(`
    SELECT
      COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE status='paid' OR status='delivered') AS paid,
      COUNT(*) FILTER (WHERE status='delivered') AS delivered,
      COALESCE(SUM(total) FILTER
        (WHERE status='paid' OR status='delivered'),0) AS revenue
    FROM ufo_orders
  `);

  const s = r.rows[0];

  await bot.sendMessage(chatId,
    `📊 آمار SHOP UFO\n\n` +
    `📦 کل سفارش‌ها: ${s.orders}\n` +
    `✅ پرداخت‌شده: ${s.paid}\n` +
    `🚀 تحویل‌شده: ${s.delivered}\n` +
    `💰 فروش تأییدشده: ${money(s.revenue)}`
  );
}

async function processReceipt(msg) {
  if (!msg.photo && !msg.document) return false;

  const userId = String(msg.from.id);

  const r = await query(`
    SELECT * FROM ufo_orders
    WHERE user_id=$1 AND status='awaiting_receipt'
    ORDER BY id DESC LIMIT 1
  `, [userId]);

  if (!r.rows.length) return false;

  const order = r.rows[0];

  const fileId = msg.photo
    ? msg.photo[msg.photo.length - 1].file_id
    : msg.document.file_id;

  await query(`
    UPDATE ufo_orders
    SET receipt_file_id=$2, updated_at=NOW()
    WHERE id=$1
  `, [order.id, fileId]);

  await bot.sendMessage(msg.chat.id,
    `📨 رسید سفارش #${order.id} ارسال شد.\nمنتظر بررسی مدیر باشید.`
  );

  const caption =
    `🧾 رسید جدید\n\n` +
    `سفارش: #${order.id}\n` +
    `کاربر: ${msg.from.username || userId}\n` +
    `مبلغ: ${money(order.total)}`;

  const options = {
    caption,
    reply_markup: kb([[
      { text: "✅ تأیید", callback_data: "a:approve:" + order.id },
      { text: "❌ رد", callback_data: "a:reject:" + order.id }
    ]])
  };

  if (msg.photo) {
    await bot.sendPhoto(ADMIN_ID, fileId, options);
  } else {
    await bot.sendDocument(ADMIN_ID, fileId, options);
  }

  return true;
}

async function handleAdminAction(q, data) {
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  if (!isAdmin(userId)) return;

  if (data === "a:add") {
    states.set(String(userId), { type: "add" });
    return bot.sendMessage(chatId,
      "اطلاعات محصول را با این قالب ارسال کنید:\n\nدسته|نام|قیمت|توضیحات\n\nمثال:\nStars|100 استارز|150000|تحویل سریع"
    );
  }

  if (data === "a:products") return adminProducts(chatId);
  if (data === "a:orders") return adminOrders(chatId);
  if (data === "a:stats") return adminStats(chatId);

  if (data === "a:card") {
    states.set(String(userId), { type: "card" });
    return bot.sendMessage(chatId, "شماره کارت و نام صاحب حساب را ارسال کنید.");
  }

  if (data === "a:coupon") {
    states.set(String(userId), { type: "coupon" });
    return bot.sendMessage(chatId,
      "قالب ساخت کد تخفیف:\nCODE|درصد|حداکثر استفاده\n\nمثال:\nUFO20|20|100\n\nبرای استفاده نامحدود عدد 0 وارد کنید."
    );
  }

  if (data === "a:welcome") {
    states.set(String(userId), { type: "welcome" });
    return bot.sendMessage(chatId, "متن پیام خوشامدگویی جدید را ارسال کنید.");
  }

  if (data === "a:support") {
    const r = await query(`
      SELECT * FROM ufo_support
      WHERE status='open' ORDER BY id DESC LIMIT 15
    `);

    if (!r.rows.length) {
      return bot.sendMessage(chatId, "پیام پشتیبانی بازی وجود ندارد.");
    }

    for (const s of r.rows) {
      await bot.sendMessage(chatId,
        `🎫 تیکت #${s.id}\nکاربر: ${s.username || s.user_id}\n\n${s.message}`,
        {
          reply_markup: kb([[
            { text: "✉️ پاسخ به کاربر", callback_data: "a:reply:" + s.id }
          ]])
        }
      );
    }

    return;
  }

  const parts = data.split(":");

  if (parts[1] === "price") {
    states.set(String(userId), {
      type: "price",
      productId: Number(parts[2])
    });
    return bot.sendMessage(chatId, "قیمت جدید را به تومان ارسال کنید.");
  }

  if (parts[1] === "toggle") {
    const id = Number(parts[2]);

    await query(`
      UPDATE products SET active=NOT active WHERE id=$1
    `, [id]);

    return bot.sendMessage(chatId, "وضعیت محصول تغییر کرد.");
  }

  if (parts[1] === "approve" || parts[1] === "reject") {
    const id = Number(parts[2]);
    const status = parts[1] === "approve" ? "paid" : "rejected";

    const r = await query(`
      UPDATE ufo_orders
      SET status=$2, updated_at=NOW()
      WHERE id=$1 AND status='awaiting_receipt'
      RETURNING *
    `, [id, status]);

    if (!r.rows.length) {
      return bot.sendMessage(chatId, "این سفارش قبلاً بررسی شده است.");
    }

    const o = r.rows[0];

    await bot.sendMessage(o.user_id,
      status === "paid"
        ? `✅ پرداخت سفارش #${id} تأیید شد.\nسفارش در انتظار تحویل است.`
        : `❌ پرداخت سفارش #${id} تأیید نشد. با پشتیبانی تماس بگیرید.`
    );

    return bot.sendMessage(chatId, "وضعیت سفارش به‌روزرسانی شد.");
  }

  if (parts[1] === "deliver") {
    states.set(String(userId), {
      type: "deliver",
      orderId: Number(parts[2])
    });
    return bot.sendMessage(chatId,
      "متن یا اطلاعات تحویل سفارش را ارسال کنید."
    );
  }

  if (parts[1] === "reply") {
    states.set(String(userId), {
      type: "reply",
      ticketId: Number(parts[2])
    });
    return bot.sendMessage(chatId, "متن پاسخ را ارسال کنید.");
  }
}

async function handleState(msg) {
  const userId = String(msg.from.id);
  const state = states.get(userId);

  if (!state || !msg.text) return false;

  const text = msg.text.trim();

  if (state.type === "add" && isAdmin(msg.from.id)) {
    const p = text.split("|").map(x => x.trim());
    const price = Number(p[2]);

    if (p.length < 3 || !p[0] || !p[1] ||
        !Number.isSafeInteger(price) || price <= 0) {
      await bot.sendMessage(msg.chat.id, "اطلاعات نامعتبر است. دوباره ارسال کنید.");
      return true;
    }

    await query(`
      INSERT INTO products(category,name,price,description)
      VALUES($1,$2,$3,$4)
    `, [p[0], p[1], price, p[3] || ""]);

    states.delete(userId);
    await bot.sendMessage(msg.chat.id, "✅ محصول ثبت شد.");
    return true;
  }

  if (state.type === "card" && isAdmin(msg.from.id)) {
    await saveSetting("card", text);
    states.delete(userId);
    await bot.sendMessage(msg.chat.id, "✅ اطلاعات کارت ذخیره شد.");
    return true;
  }

  if (state.type === "welcome" && isAdmin(msg.from.id)) {
    await saveSetting("welcome", text);
    states.delete(userId);
    await bot.sendMessage(msg.chat.id, "✅ پیام خوشامد ذخیره شد.");
    return true;
  }

  if (state.type === "price" && isAdmin(msg.from.id)) {
    const price = Number(text);

    if (!Number.isSafeInteger(price) || price <= 0) {
      await bot.sendMessage(msg.chat.id, "قیمت معتبر وارد کنید.");
      return true;
    }

    await query(
      "UPDATE products SET price=$1 WHERE id=$2",
      [price, state.productId]
    );

    states.delete(userId);
    await bot.sendMessage(msg.chat.id, "✅ قیمت تغییر کرد.");
    return true;
  }

  if (state.type === "coupon" && isAdmin(msg.from.id)) {
    const p = text.split("|").map(x => x.trim());
    const percent = Number(p[1]);
    const max = Number(p[2]);

    if (!p[0] || !Number.isInteger(percent) ||
        percent < 1 || percent > 100 ||
        !Number.isInteger(max) || max < 0) {
      await bot.sendMessage(msg.chat.id, "قالب کد تخفیف نامعتبر است.");
      return true;
    }

    await query(`
      INSERT INTO ufo_coupons(code,percent,max_uses)
      VALUES($1,$2,$3)
      ON CONFLICT(code)
      DO UPDATE SET percent=EXCLUDED.percent,
        max_uses=EXCLUDED.max_uses,
        active=TRUE
    `, [p[0].toUpperCase(), percent, max]);

    states.delete(userId);
    await bot.sendMessage(msg.chat.id, "✅ کد تخفیف ساخته شد.");
    return true;
  }

  if (state.type === "deliver" && isAdmin(msg.from.id)) {
    const r = await query(`
      UPDATE ufo_orders
      SET status='delivered',
          delivery_text=$2,
          updated_at=NOW()
      WHERE id=$1 AND status='paid'
      RETURNING *
    `, [state.orderId, text]);

    states.delete(userId);

    if (!r.rows.length) {
      await bot.sendMessage(msg.chat.id,
        "سفارش پیدا نشد یا پرداخت آن تأیید نشده است."
      );
      return true;
    }

    await bot.sendMessage(r.rows[0].user_id,
      `🎉 سفارش #${state.orderId} تحویل داده شد!\n\n${text}`
    );

    await bot.sendMessage(msg.chat.id, "✅ تحویل انجام شد.");
    return true;
  }

  if (state.type === "reply" && isAdmin(msg.from.id)) {
    const r = await query(
      "SELECT * FROM ufo_support WHERE id=$1",
      [state.ticketId]
    );

    states.delete(userId);

    if (!r.rows.length) return true;

    await bot.sendMessage(r.rows[0].user_id,
      `💬 پاسخ پشتیبانی SHOP UFO:\n\n${text}`
    );

    await query(
      "UPDATE ufo_support SET status='answered' WHERE id=$1",
      [state.ticketId]
    );

    await bot.sendMessage(msg.chat.id, "✅ پاسخ ارسال شد.");
    return true;
  }

  if (state.type === "coupon") {
    const code = text.toUpperCase();

    const r = await query(`
      SELECT * FROM ufo_coupons
      WHERE code=$1 AND active=TRUE
    `, [code]);

    if (!r.rows.length ||
        (r.rows[0].max_uses > 0 &&
         r.rows[0].used_count >= r.rows[0].max_uses)) {
      await bot.sendMessage(msg.chat.id, "❌ کد تخفیف نامعتبر یا تمام‌شده است.");
      return true;
    }

    states.set(userId, { coupon: code });
    await bot.sendMessage(msg.chat.id,
      `✅ کد ${code} ثبت شد.\nحالا سبد خرید را باز کنید و سفارش دهید.`,
      {
        reply_markup: kb([
          [{ text: "🛒 مشاهده سبد خرید", callback_data: "cart" }]
        ])
      }
    );

    return true;
  }

  if (state.type === "support") {
    const r = await query(`
      INSERT INTO ufo_support(user_id,username,message)
      VALUES($1,$2,$3) RETURNING id
    `, [userId, msg.from.username || "", text]);

    states.delete(userId);

    await bot.sendMessage(msg.chat.id,
      `✅ پیام شما ثبت شد.\nشماره تیکت: #${r.rows[0].id}`
    );

    await bot.sendMessage(ADMIN_ID,
      `💬 پیام پشتیبانی جدید\nتیکت: #${r.rows[0].id}\nکاربر: ${msg.from.username || userId}\n\n${text}`
    );

    return true;
  }

  return false;
}

bot.on("callback_query", async q => {
  const data = q.data;
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  try {
    if (data === "home") {
      await sendHome(chatId, userId);
    } else if (data === "shop") {
      await showShop(chatId);
    } else if (data === "cart") {
      await showCart(chatId, userId);
    } else if (data === "orders") {
      await showOrders(chatId, userId);
    } else if (data === "admin") {
      await showAdmin(chatId, userId);
    } else if (data === "coupon") {
      states.set(String(userId), { type: "coupon" });
      await bot.sendMessage(chatId, "کد تخفیف خود را ارسال کنید.");
    } else if (data === "support") {
      states.set(String(userId), { type: "support" });
      await bot.sendMessage(chatId, "پیام خود را برای پشتیبانی ارسال کنید.");
    } else if (data === "checkout") {
      await checkout(q.from, chatId);
    } else if (data === "clearcart") {
      await query(
        "DELETE FROM ufo_cart WHERE user_id=$1",
        [String(userId)]
      );
      await bot.sendMessage(chatId, "🗑 سبد خرید خالی شد.");
    } else if (data.startsWith("cat:")) {
      const category = Buffer.from(
        data.slice(4), "base64url"
      ).toString("utf8");

      await showProducts(chatId, category);
    } else if (data.startsWith("add:")) {
      const ok = await addToCart(userId, Number(data.slice(4)));
      await bot.sendMessage(chatId,
        ok ? "✅ به سبد خرید اضافه شد." : "این محصول دیگر فعال نیست."
      );
    } else if (data.startsWith("remove:")) {
      await removeCartItem(userId, Number(data.slice(7)));
      await showCart(chatId, userId);
    } else if (data.startsWith("a:")) {
      await handleAdminAction(q, data);
    }
  } catch (e) {
    console.error("Callback error:", e);
    await bot.sendMessage(chatId, "خطایی رخ داد. دوباره تلاش کنید.");
  }

  await bot.answerCallbackQuery(q.id).catch(() => {});
});

bot.on("message", async msg => {
  if (msg.text?.startsWith("/start")) {
    states.delete(String(msg.from.id));
    return sendHome(msg.chat.id, msg.from.id);
  }

  try {
    if (msg.text && await handleState(msg)) return;

    if (msg.photo || msg.document) {
      await processReceipt(msg);
    }
  } catch (e) {
    console.error("Message error:", e);
    await bot.sendMessage(msg.chat.id, "خطایی رخ داد.");
  }
});

app.get("/", (req, res) => {
  res.send("SHOP UFO V3 ONLINE");
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();

  app.listen(PORT, () => {
    console.log("SHOP UFO V3 running on port " + PORT);
  });
}

start().catch(e => {
  console.error("Startup error:", e);
  process.exit(1);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});
