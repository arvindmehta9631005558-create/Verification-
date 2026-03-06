import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fetch from "node-fetch";

const db = new Database("database.sqlite");

const TELEGRAM_BOT_TOKEN = "8361871081:AAFRVzYMzt3Z7GwYBKltiYqC9wEdk6JgSkA";
const TELEGRAM_OWNER_ID = "6601602327";

async function sendTelegramMessage(text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_OWNER_ID,
        text: text,
        parse_mode: "HTML",
      }),
    });
  } catch (error) {
    console.error("Telegram error:", error);
  }
}

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firebase_uid TEXT UNIQUE,
    username TEXT,
    balance REAL DEFAULT 0,
    is_banned INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firebase_uid TEXT,
    code TEXT,
    FOREIGN KEY(firebase_uid) REFERENCES users(firebase_uid)
  );
  CREATE TABLE IF NOT EXISTS surprise_codes (
    code TEXT PRIMARY KEY,
    amount REAL,
    max_claims INTEGER,
    current_claims INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Seed default settings
const maintenance = db.prepare("SELECT * FROM settings WHERE key = 'maintenance'").get();
if (!maintenance) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('maintenance', 'off')").run();
}

const minWithdrawal = db.prepare("SELECT * FROM settings WHERE key = 'min_withdrawal'").get();
if (!minWithdrawal) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('min_withdrawal', '100')").run();
}

const maxWithdrawal = db.prepare("SELECT * FROM settings WHERE key = 'max_withdrawal'").get();
if (!maxWithdrawal) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('max_withdrawal', '10000')").run();
}

const transferTax = db.prepare("SELECT * FROM settings WHERE key = 'transfer_tax'").get();
if (!transferTax) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('transfer_tax', '2')").run();
}

async function startServer() {
  const app = express();
  app.use(express.json());
  const PORT = 3000;

  // Middleware to check maintenance mode
  app.use((req, res, next) => {
    const maintenanceSetting = db.prepare("SELECT value FROM settings WHERE key = 'maintenance'").get() as any;
    const isMaintenance = maintenanceSetting?.value === "on";
    
    // Allow admin routes and certain checks even in maintenance
    if (isMaintenance && !req.path.startsWith("/api/admin") && req.path !== "/api/settings") {
      return res.status(503).json({ success: false, error: "MAINTENANCE" });
    }
    next();
  });

  // API Routes
  app.get("/api/settings", (req, res) => {
    const maintenanceSetting = db.prepare("SELECT value FROM settings WHERE key = 'maintenance'").get() as any;
    const minWithdrawal = db.prepare("SELECT value FROM settings WHERE key = 'min_withdrawal'").get() as any;
    const maxWithdrawal = db.prepare("SELECT value FROM settings WHERE key = 'max_withdrawal'").get() as any;
    const transferTax = db.prepare("SELECT value FROM settings WHERE key = 'transfer_tax'").get() as any;
    res.json({ 
      success: true, 
      maintenance: maintenanceSetting?.value === "on",
      minWithdrawal: Number(minWithdrawal?.value || 100),
      maxWithdrawal: Number(maxWithdrawal?.value || 10000),
      transferTax: Number(transferTax?.value || 2)
    });
  });

  app.post("/api/sync-user", async (req, res) => {
    const { firebaseUid, username, email } = req.body;
    try {
      let user = db.prepare("SELECT * FROM users WHERE firebase_uid = ?").get(firebaseUid) as any;
      if (!user) {
        const stmt = db.prepare("INSERT INTO users (firebase_uid, username, balance) VALUES (?, ?, 0)");
        stmt.run(firebaseUid, username);
        user = db.prepare("SELECT * FROM users WHERE firebase_uid = ?").get(firebaseUid);
        
        // Notify Telegram on new registration
        await sendTelegramMessage(`
👤 <b>New User Registered</b>
🔹 Username: ${username}
📧 Email: ${email || "N/A"}
🆔 UID: <code>${firebaseUid}</code>
        `);
      }

      if (user.is_banned) {
        return res.status(403).json({ success: false, error: "BANNED" });
      }

      res.json({ success: true, user });
    } catch (error: any) {
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  app.get("/api/user/:uid", (req, res) => {
    const user = db.prepare("SELECT firebase_uid as id, username, balance, is_banned FROM users WHERE firebase_uid = ?").get(req.params.uid) as any;
    if (user) {
      if (user.is_banned) return res.status(403).json({ success: false, error: "BANNED" });
      res.json({ success: true, user });
    } else {
      res.status(404).json({ success: false, error: "User not found" });
    }
  });

  app.post("/api/redeem", async (req, res) => {
    const { firebaseUid, code } = req.body;
    
    const surpriseCode = db.prepare("SELECT * FROM surprise_codes WHERE code = ?").get(code) as any;
    if (!surpriseCode) {
      return res.status(400).json({ success: false, error: "Invalid code" });
    }

    if (surpriseCode.current_claims >= surpriseCode.max_claims) {
      return res.status(400).json({ success: false, error: "Code claim limit reached" });
    }

    const alreadyRedeemed = db.prepare("SELECT * FROM redemptions WHERE firebase_uid = ? AND code = ?").get(firebaseUid, code);
    if (alreadyRedeemed) {
      return res.status(400).json({ success: false, error: "Code already redeemed" });
    }

    try {
      const user = db.prepare("SELECT username FROM users WHERE firebase_uid = ?").get(firebaseUid) as any;
      
      const redeemStmt = db.prepare("INSERT INTO redemptions (firebase_uid, code) VALUES (?, ?)");
      const updateBalanceStmt = db.prepare("UPDATE users SET balance = balance + ? WHERE firebase_uid = ?");
      const updateCodeStmt = db.prepare("UPDATE surprise_codes SET current_claims = current_claims + 1 WHERE code = ?");
      
      const transaction = db.transaction(() => {
        redeemStmt.run(firebaseUid, code);
        updateBalanceStmt.run(surpriseCode.amount, firebaseUid);
        updateCodeStmt.run(code);
      });
      
      transaction();
      
      const updatedUser = db.prepare("SELECT balance FROM users WHERE firebase_uid = ?").get(firebaseUid) as any;
      
      // Notify Telegram
      await sendTelegramMessage(`
🎁 <b>New User Claimed a Surprise Code</b>
🔸 Code: <code>${code}</code>
🙂 User: ${user.username}
✅ User ID: <code>${firebaseUid}</code>
⚡️ Amount: ₹${surpriseCode.amount}
🕒 Remaining Claims: ${surpriseCode.max_claims - (surpriseCode.current_claims + 1)}
      `);

      res.json({ success: true, newBalance: updatedUser.balance });
    } catch (error) {
      res.status(500).json({ success: false, error: "Server error" });
    }
  });

  app.post("/api/transfer", async (req, res) => {
    const { senderFirebaseUid, recipientUsername, amount } = req.body;
    
    if (amount <= 0) return res.status(400).json({ success: false, error: "Invalid amount" });

    const sender = db.prepare("SELECT * FROM users WHERE firebase_uid = ?").get(senderFirebaseUid) as any;
    if (!sender) return res.status(404).json({ success: false, error: "Sender not found" });

    const recipient = db.prepare("SELECT * FROM users WHERE username = ?").get(recipientUsername) as any;
    if (!recipient) return res.status(404).json({ success: false, error: "Recipient not found" });

    if (sender.firebase_uid === recipient.firebase_uid) {
      return res.status(400).json({ success: false, error: "Cannot transfer to yourself" });
    }

    const taxSetting = db.prepare("SELECT value FROM settings WHERE key = 'transfer_tax'").get() as any;
    const taxPercent = Number(taxSetting?.value || 2);
    const taxAmount = (amount * taxPercent) / 100;
    const totalDeduction = amount + taxAmount;

    if (sender.balance < totalDeduction) {
      return res.status(400).json({ success: false, error: `Insufficient balance. Total needed: ₹${totalDeduction.toFixed(2)} (Amount: ₹${amount} + Tax: ₹${taxAmount.toFixed(2)})` });
    }

    try {
      const transferTransaction = db.transaction(() => {
        db.prepare("UPDATE users SET balance = balance - ? WHERE firebase_uid = ?").run(totalDeduction, senderFirebaseUid);
        db.prepare("UPDATE users SET balance = balance + ? WHERE firebase_uid = ?").run(amount, recipient.firebase_uid);
      });
      transferTransaction();

      const updatedSender = db.prepare("SELECT balance FROM users WHERE firebase_uid = ?").get(senderFirebaseUid) as any;

      // Notify Telegram
      await sendTelegramMessage(`
💸 <b>P2P Transfer Successful</b>
👤 Sender: ${sender.username}
👤 Recipient: ${recipient.username}
💰 Amount: ₹${amount}
📉 Tax (${taxPercent}%): ₹${taxAmount.toFixed(2)}
💳 Total Deducted: ₹${totalDeduction.toFixed(2)}
      `);

      res.json({ success: true, newBalance: updatedSender.balance });
    } catch (error) {
      res.status(500).json({ success: false, error: "Transfer failed" });
    }
  });

  app.post("/api/withdraw", async (req, res) => {
    const { firebaseUid, amount, method, details } = req.body;
    const user = db.prepare("SELECT username, balance FROM users WHERE firebase_uid = ?").get(firebaseUid) as any;
    
    const minWithdrawal = db.prepare("SELECT value FROM settings WHERE key = 'min_withdrawal'").get() as any;
    const maxWithdrawal = db.prepare("SELECT value FROM settings WHERE key = 'max_withdrawal'").get() as any;
    
    const min = Number(minWithdrawal?.value || 2);
    const max = Number(maxWithdrawal?.value || 10000);

    if (amount < min) {
      return res.status(400).json({ success: false, error: `Minimum withdrawal is ₹${min}` });
    }
    if (amount > max) {
      return res.status(400).json({ success: false, error: `Maximum withdrawal is ₹${max}` });
    }

    if (!user || user.balance < amount) {
      return res.status(400).json({ success: false, error: "Insufficient balance" });
    }

    try {
      db.prepare("UPDATE users SET balance = balance - ? WHERE firebase_uid = ?").run(amount, firebaseUid);
      const updatedUser = db.prepare("SELECT balance FROM users WHERE firebase_uid = ?").get(firebaseUid) as any;
      
      // Notify Telegram
      await sendTelegramMessage(`
💸 <b>New Withdrawal Request</b>
👤 User: ${user.username}
💰 Amount: ₹${amount}
🏦 Method: ${method?.toUpperCase()}
📝 Details: <code>${details}</code>
🆔 UID: <code>${firebaseUid}</code>
      `);

      res.json({ success: true, newBalance: updatedUser.balance });
    } catch (error) {
      res.status(500).json({ success: false, error: "Server error" });
    }
  });

  // Admin Routes
  app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;
    const normalizedUser = username?.toLowerCase().trim();
    // Support both the original and the user-provided (likely typo) admin email
    if ((normalizedUser === "admin@gmail.com" || normalizedUser === "gimal admin@gmail.com") && password === "admin@96kpg") {
      res.json({ success: true, token: "admin-secret-token" });
    } else {
      res.status(401).json({ success: false, error: "Invalid admin credentials" });
    }
  });

  app.post("/api/admin/settings", (req, res) => {
    const { key, value } = req.body;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    res.json({ success: true });
  });

  app.post("/api/admin/ban", (req, res) => {
    const { username, ban } = req.body;
    const result = db.prepare("UPDATE users SET is_banned = ? WHERE username = ?").run(ban ? 1 : 0, username);
    if (result.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: "User not found" });
    }
  });

  app.post("/api/admin/create-code", (req, res) => {
    const { code, amount, maxClaims } = req.body;
    try {
      db.prepare("INSERT INTO surprise_codes (code, amount, max_claims, current_claims) VALUES (?, ?, ?, 0)").run(code, amount, maxClaims);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: "Code already exists" });
    }
  });

  app.get("/api/admin/stats", (req, res) => {
    const usersCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as any;
    const codes = db.prepare("SELECT * FROM surprise_codes").all();
    res.json({ success: true, usersCount: usersCount.count, codes });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
