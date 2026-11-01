
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_CHAT_ID || "");
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !ADMIN_ID || !DATABASE_URL) {
  throw new Error("Missing environment variables");
}

const bot = new TelegramBot(TOKEN, { polling: true });

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

const states = new Map();

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🛍 فروشگاه", callback_data: "shop" }],
      [
        { text: "🛒 سبد خرید", callback_data: "cart" },
        { text: "📦 سفارش‌های من", callback_data: "myorders" }
      ],
      [
        { text: "🎟 کد تخفیف", callback_data: "coupon" },
        { text: "💬 پشتیبانی", callback_data: "support" }
      ]
    ]
  }
};

function isAdmin(id) {
  return String(id) === ADMIN_ID;
}

function money(value) {
  return Number(value).toLocaleString("en-US") + " تومان";
}

async function query(sql, params = []) {
  return db.query(sql, params);
}

// ---------- DATABASE ----------

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT,
      category TEXT,
      price BIGINT DEFAULT 0,
      description TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE
    )
  `);

  // Add missing columns without deleting existing product data.
  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS name TEXT,
    ADD COLUMN IF NOT EXISTS category TEXT,
    ADD COLUMN IF NOT EXISTS price BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ufo_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ufo_cart (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_id, product_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ufo_coupons (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      discount INTEGER NOT NULL,
      max_uses INTEGER DEFAULT 100,
      used_count INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ufo_orders (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username TEXT,
      total BIGINT NOT NULL,
      status TEXT DEFAULT 'pending',
      coupon TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ufo_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES ufo_orders(id),
      product_name TEXT,
      price BIGINT,
      quantity INTEGER
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ufo_support (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      message TEXT,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    INSERT INTO ufo_settings(key, value)
    VALUES ('card', 'اطلاعات کارت هنوز ثبت نشده است'),
           ('welcome', 'به فروشگاه UFO خوش آمدید 👽')
    ON CONFLICT (key) DO NOTHING
  `);

  console.log("SHOP UFO database initialized");
}

async function setting(key) {
  const result = await query(
    "SELECT value FROM ufo_settings WHERE key=$1",
    [key]
  );
  return result.rows[0]?.value || "";
}

async function setSetting(key, value) {
  await query(`
    INSERT INTO ufo_settings(key,value)
    VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
  `, [key, value]);
}

// ---------- MENUS ----------

async function home(chatId) {
  const welcome = await setting("welcome");
  await bot.sendMessage(
    chatId,
    welcome || "به فروشگاه UFO خوش آمدید 👽",
    mainMenu
  );
}

async function showShop(chatId) {
  const result = await query(`
    SELECT DISTINCT category
    FROM products
    WHERE active=TRUE
      AND category IS NOT NULL
    ORDER BY category
  `);

  if (!result.rows.length) {
    return bot.sendMessage(chatId, "فعلاً محصولی در فروشگاه ثبت نشده است.");
  }

  const buttons = result.rows.map(row => [{
    text: "📁 " + row.category,
    callback_data: "cat:" + encodeURIComponent(row.category)
  }]);

  buttons.push([{ text: "🔙 بازگشت", callback_data: "home" }]);

  await bot.sendMessage(chatId, "یک دسته‌بندی انتخاب کن:", {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showProducts(chatId, category) {
  const result = await query(
    `SELECT id,name,price,description
     FROM products
     WHERE active=TRUE AND category=$1
     ORDER BY id DESC`,
    [category]
  );

  if (!result.rows.length) {
    return bot.sendMessage(chatId, "محصولی در این دسته وجود ندارد.");
  }

  for (const p of result.rows) {
    await bot.sendMessage(
      chatId,
      `🛍 ${p.name}\n\n${p.description || "بدون توضیحات"}\n\n💰 قیمت: ${money(p.price)}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ افزودن به سبد", callback_data: "add:" + p.id }]
          ]
        }
      }
    );
  }
}

async function showCart(chatId, userId) {
  const result = await query(`
    SELECT c.product_id,c.quantity,p.name,p.price
    FROM ufo_cart c
    JOIN products p ON p.id=c.product_id
    WHERE c.user_id=$1
  `, [userId]);

  if (!result.rows.length) {
    return bot.sendMessage(chatId, "سبد خریدت خالیه 🛒");
  }

  let total = 0;
  let text = "🛒 سبد خرید شما:\n\n";

  for (const item of result.rows) {
    const sum = Number(item.price) * item.quantity;
    total += sum;
    text += `• ${item.name} × ${item.quantity}\n${money(sum)}\n\n`;
  }

  text += `💰 جمع کل: ${money(total)}`;

  await bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 ثبت سفارش", callback_data: "checkout" }],
        [{ text: "🗑 خالی کردن سبد", callback_data: "clearcart" }],
        [{ text: "🔙 بازگشت", callback_data: "home" }]
      ]
    }
  });
}

// ---------- ORDERS ----------

async function checkout(chatId, user) {
  const result = await query(`
    SELECT c.product_id,c.quantity,p.name,p.price
    FROM ufo_cart c
    JOIN products p ON p.id=c.product_id
    WHERE c.user_id=$1
  `, [user.id]);

  if (!result.rows.length) {
    return bot.sendMessage(chatId, "سبد خرید خالی است.");
  }

  let total = 0;
  for (const item of result.rows) {
    total += Number(item.price) * item.quantity;
  }

  const order = await query(`
    INSERT INTO ufo_orders(user_id,username,total)
    VALUES($1,$2,$3)
    RETURNING id
  `, [user.id, user.username || "", total]);

  const orderId = order.rows[0].id;

  for (const item of result.rows) {
    await query(`
      INSERT INTO ufo_order_items(order_id,product_name,price,quantity)
      VALUES($1,$2,$3,$4)
    `, [orderId, item.name, item.price, item.quantity]);
  }

  await query("DELETE FROM ufo_cart WHERE user_id=$1", [user.id]);

  const card = await setting("card");

  await bot.sendMessage(
    chatId,
    `✅ سفارش شماره ${orderId} ثبت شد.\n\n💰 مبلغ قابل پرداخت: ${money(total)}\n\n💳 اطلاعات پرداخت:\n${card}\n\nپس از پرداخت، تصویر رسید را همین‌جا ارسال کن.`
  );

  await query(
    "UPDATE ufo_orders SET status='awaiting_receipt' WHERE id=$1",
    [orderId]
  );
}

// ---------- ADMIN ----------

async function adminMenu(chatId) {
  if (!isAdmin(chatId)) return;

  await bot.sendMessage(chatId, "⚙️ پنل مدیریت SHOP UFO", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ افزودن محصول", callback_data: "admin_add" }],
        [{ text: "📦 محصولات", callback_data: "admin_products" }],
        [{ text: "🧾 سفارش‌ها", callback_data: "admin_orders" }],
        [{ text: "📊 آمار", callback_data: "admin_stats" }],
        [{ text: "💳 تغییر کارت", callback_data: "admin_card" }],
        [{ text: "📝 تغییر پیام خوش‌آمد", callback_data: "admin_welcome" }]
      ]
    }
  });
}

async function adminProducts(chatId) {
  const result = await query(
    "SELECT id,name,price,active FROM products ORDER BY id DESC"
  );

  if (!result.rows.length) {
    return bot.sendMessage(chatId, "محصولی ثبت نشده است.");
  }

  for (const p of result.rows) {
    await bot.sendMessage(
      chatId,
      `#${p.id} | ${p.name}\nقیمت: ${money(p.price)}\nوضعیت: ${p.active ? "فعال" : "غیرفعال"}`,
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: p.active ? "🔴 غیرفعال کردن" : "🟢 فعال کردن",
              callback_data: "toggle:" + p.id
            }
          ]]
        }
      }
    );
  }
}

async function adminOrders(chatId) {
  const result = await query(`
    SELECT id,user_id,username,total,status,created_at
    FROM ufo_orders
    ORDER BY id DESC
    LIMIT 20
  `);

  if (!result.rows.length) {
    return bot.sendMessage(chatId, "هنوز سفارشی ثبت نشده است.");
  }

  for (const o of result.rows) {
    await bot.sendMessage(
      chatId,
      `سفارش #${o.id}\nکاربر: ${o.username || o.user_id}\nمبلغ: ${money(o.total)}\nوضعیت: ${o.status}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ تأیید پرداخت", callback_data: "approve:" + o.id },
            { text: "❌ رد پرداخت", callback_data: "reject:" + o.id }
          ]]
        }
      }
    );
  }
}

// ---------- START ----------

bot.onText(/\/start/, async msg => {
  try {
    await home(msg.chat.id);
  } catch (err) {
    console.error("START ERROR:", err);
    await bot.sendMessage(msg.chat.id, "مشکلی پیش آمد. لطفاً دوباره تلاش کن.");
  }
});

bot.onText(/\/admin/, async msg => {
  if (!isAdmin(msg.from.id)) return;
  await adminMenu(msg.chat.id);
});

// ---------- CALLBACKS ----------

bot.on("callback_query", async cq => {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const data = cq.data;

  try {
    await bot.answerCallbackQuery(cq.id);

    if (data === "home") return home(chatId);
    if (data === "shop") return showShop(chatId);
    if (data === "cart") return showCart(chatId, userId);
    if (data === "myorders") {
      const r = await query(
        "SELECT id,total,status FROM ufo_orders WHERE user_id=$1 ORDER BY id DESC LIMIT 10",
        [userId]
      );

      if (!r.rows.length) {
        return bot.sendMessage(chatId, "هنوز سفارشی ثبت نکردی.");
      }

      let t = "📦 سفارش‌های شما:\n\n";
      for (const o of r.rows) {
        t += `#${o.id} | ${money(o.total)} | ${o.status}\n`;
      }
      return bot.sendMessage(chatId, t);
    }

    if (data.startsWith("cat:")) {
      return showProducts(chatId, decodeURIComponent(data.slice(4)));
    }

    if (data.startsWith("add:")) {
      const id = Number(data.split(":")[1]);

      await query(`
        INSERT INTO ufo_cart(user_id,product_id,quantity)
        VALUES($1,$2,1)
        ON CONFLICT(user_id,product_id)
        DO UPDATE SET quantity=ufo_cart.quantity+1
      `, [userId, id]);

      return bot.sendMessage(chatId, "✅ به سبد خرید اضافه شد.");
    }

    if (data === "clearcart") {
      await query("DELETE FROM ufo_cart WHERE user_id=$1", [userId]);
      return bot.sendMessage(chatId, "سبد خرید خالی شد.");
    }

    if (data === "checkout") {
      return checkout(chatId, cq.from);
    }

    if (data === "coupon") {
      states.set(userId, { type: "coupon" });
      return bot.sendMessage(chatId, "کد تخفیف را ارسال کن:");
    }

    if (data === "support") {
      states.set(userId, { type: "support" });
      return bot.sendMessage(chatId, "پیامت را برای پشتیبانی ارسال کن:");
    }

    if (!isAdmin(userId)) return;

    if (data === "admin_add") {
      states.set(userId, { type: "add_name" });
      return bot.sendMessage(chatId, "نام محصول را ارسال کن:");
    }

    if (data === "admin_products") return adminProducts(chatId);
    if (data === "admin_orders") return adminOrders(chatId);

    if (data === "admin_stats") {
      const r = await query(`
        SELECT COUNT(*) AS orders,
               COALESCE(SUM(total),0) AS revenue
        FROM ufo_orders
        WHERE status='approved'
      `);

      return bot.sendMessage(
        chatId,
        `📊 آمار فروش\nتعداد سفارش تأییدشده: ${r.rows[0].orders}\nمجموع فروش تأییدشده: ${money(r.rows[0].revenue)}`
      );
    }

    if (data === "admin_card") {
      states.set(userId, { type: "card" });
      return bot.sendMessage(chatId, "اطلاعات کارت جدید را ارسال کن:");
    }

    if (data === "admin_welcome") {
      states.set(userId, { type: "welcome" });
      return bot.sendMessage(chatId, "متن خوش‌آمدگویی جدید را ارسال کن:");
    }

    if (data.startsWith("toggle:")) {
      const id = Number(data.split(":")[1]);
      await query(
        "UPDATE products SET active=NOT active WHERE id=$1",
        [id]
      );
      return bot.sendMessage(chatId, "وضعیت محصول تغییر کرد.");
    }

    if (data.startsWith("approve:")) {
      const id = Number(data.split(":")[1]);
      const r = await query(
        "UPDATE ufo_orders SET status='approved' WHERE id=$1 RETURNING user_id",
        [id]
      );

      if (r.rows[0]) {
        await bot.sendMessage(r.rows[0].user_id, `✅ پرداخت سفارش #${id} تأیید شد.`);
      }
      return bot.sendMessage(chatId, "سفارش تأیید شد.");
    }

    if (data.startsWith("reject:")) {
      const id = Number(data.split(":")[1]);
      const r = await query(
        "UPDATE ufo_orders SET status='rejected' WHERE id=$1 RETURNING user_id",
        [id]
      );

      if (r.rows[0]) {
        await bot.sendMessage(r.rows[0].user_id, `❌ پرداخت سفارش #${id} تأیید نشد. برای پیگیری با پشتیبانی تماس بگیر.`);
      }
      return bot.sendMessage(chatId, "سفارش رد شد.");
    }

  } catch (err) {
    console.error("CALLBACK ERROR:", data, err);
    try {
      await bot.sendMessage(chatId, "خطایی رخ داد. لطفاً دوباره تلاش کن.");
    } catch (_) {}
  }
});

// ---------- USER MESSAGES ----------

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const state = states.get(userId);

  try {
    if (msg.photo) {
      const r = await query(`
        SELECT id FROM ufo_orders
        WHERE user_id=$1 AND status='awaiting_receipt'
        ORDER BY id DESC LIMIT 1
      `, [userId]);

      if (!r.rows.length) return;

      const orderId = r.rows[0].id;
      const photo = msg.photo[msg.photo.length - 1].file_id;

      await bot.sendPhoto(ADMIN_ID, photo, {
        caption: `🧾 رسید سفارش #${orderId}\nکاربر: ${msg.from.username || userId}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ تأیید", callback_data: "approve:" + orderId },
            { text: "❌ رد", callback_data: "reject:" + orderId }
          ]]
        }
      });

      return bot.sendMessage(chatId, "رسیدت برای بررسی ارسال شد.");
    }

    if (!state) return;

    if (state.type === "card") {
      await setSetting("card", msg.text);
      states.delete(userId);
      return bot.sendMessage(chatId, "اطلاعات کارت ذخیره شد.");
    }

    if (state.type === "welcome") {
      await setSetting("welcome", msg.text);
      states.delete(userId);
      return bot.sendMessage(chatId, "پیام خوش‌آمدگویی تغییر کرد.");
    }

    if (state.type === "coupon") {
      const r = await query(`
        SELECT * FROM ufo_coupons
        WHERE UPPER(code)=UPPER($1)
          AND active=TRUE
          AND used_count < max_uses
      `, [msg.text.trim()]);

      states.delete(userId);

      if (!r.rows.length) {
        return bot.sendMessage(chatId, "کد تخفیف معتبر نیست یا ظرفیت استفاده‌اش تمام شده.");
      }

      return bot.sendMessage(
        chatId,
        `کد تخفیف معتبر است: ${r.rows[0].discount}%\nبرای اعمال تخفیف، فعلاً با پشتیبانی هماهنگ کن.`
      );
    }

    if (state.type === "support") {
      await query(
        "INSERT INTO ufo_support(user_id,message) VALUES($1,$2)",
        [userId, msg.text]
      );

      states.delete(userId);
      await bot.sendMessage(chatId, "پیامت برای پشتیبانی ثبت شد.");

      return bot.sendMessage(
        ADMIN_ID,
        `💬 پیام پشتیبانی جدید\nکاربر: ${msg.from.username || userId}\n\n${msg.text}`
      );
    }

    if (state.type === "add_name") {
      states.set(userId, { type: "add_category", name: msg.text });
      return bot.sendMessage(chatId, "دسته‌بندی محصول را ارسال کن:");
    }

    if (state.type === "add_category") {
      states.set(userId, {
        type: "add_price",
        name: state.name,
        category: msg.text
      });
      return bot.sendMessage(chatId, "قیمت محصول را فقط به عدد تومان ارسال کن:");
    }

    if (state.type === "add_price") {
      const price = Number(msg.text.replace(/[^\d]/g, ""));

      if (!Number.isSafeInteger(price) || price <= 0) {
        return bot.sendMessage(chatId, "قیمت معتبر نیست. دوباره عدد قیمت را ارسال کن:");
      }

      states.set(userId, {
        type: "add_description",
        name: state.name,
        category: state.category,
        price
      });

      return bot.sendMessage(chatId, "توضیحات محصول را ارسال کن:");
    }

    if (state.type === "add_description") {
      await query(`
        INSERT INTO products(name,category,price,description,active)
        VALUES($1,$2,$3,$4,TRUE)
      `, [state.name, state.category, state.price, msg.text]);

      states.delete(userId);
      return bot.sendMessage(chatId, "✅ محصول با موفقیت ثبت شد.");
    }

  } catch (err) {
    console.error("MESSAGE ERROR:", err);
    await bot.sendMessage(chatId, "خطایی رخ داد. لطفاً دوباره تلاش کن.");
  }
});

// ---------- ERROR HANDLING ----------

bot.on("polling_error", err => {
  console.error("POLLING ERROR:", err.message);
});

process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION:", err);
});

async function start() {
  try {
    await initDB();
    console.log("👽 SHOP UFO V4 is running");
  } catch (err) {
    console.error("DATABASE START ERROR:", err);
    process.exit(1);
  }
}

start();
