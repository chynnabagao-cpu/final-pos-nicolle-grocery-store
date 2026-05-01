
import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "path";
import cors from "cors";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Types for authentication
interface AuthTokenPayload {
  id: number;
  username: string;
  role: 'admin' | 'user';
  store_name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || "pos-secret-key-123";
const PORT = Number(process.env.PORT || 3000);

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Uploads Management
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(__dirname));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// --- Database Layer with MySQL ---
let pool: mysql.Pool;

const db = {
  execute: async (sql: string, params: any[] = []): Promise<any> => {
    const [result] = await pool.execute(sql, params) as any;
    return { insertId: result.insertId, affectedRows: result.affectedRows };
  },

  query: async <T>(sql: string, params: any[] = []): Promise<T[]> => {
    const [rows] = await pool.query(sql, params);
    return rows as T[];
  },

  get: async <T>(sql: string, params: any[] = []): Promise<T | null> => {
    const [rows] = await pool.query(sql, params) as any[];
    return rows.length > 0 ? rows[0] as T : null;
  },

  beginTransaction: async (): Promise<void> => {
    await pool.query("START TRANSACTION");
  },

  commit: async (): Promise<void> => {
    await pool.query("COMMIT");
  },

  rollback: async (): Promise<void> => {
    await pool.query("ROLLBACK");
  },

  close: async (): Promise<void> => {
    await pool.end();
  }
};

async function connectToDatabase() {
  try {
    console.log("🔌 Connecting to MySQL Database...");
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'lorna_pos',
      port: Number(process.env.MYSQL_PORT || 3306),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });

    // Test connection
    const [rows] = await pool.query("SELECT 1");
    console.log("✔ MySQL Database Online");
    await initializeSchema();
    return true;
  } catch (err: any) {
    console.error(`❌ Database Connection Failed: ${err.message}`);
    console.error("Please ensure MySQL is running and credentials in .env are correct.");
    throw err;
  }
}

async function initializeSchema() {
  console.log("🔍 Verifying database schema...");
  
  const schema = [
    `CREATE TABLE IF NOT EXISTS stores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      address TEXT DEFAULT NULL,
      phone VARCHAR(50) DEFAULT NULL,
      is_active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role VARCHAR(50) NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      phone VARCHAR(20) DEFAULT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      UNIQUE(name)
    );`,

    `CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      barcode VARCHAR(255) NOT NULL,
      category_id INT DEFAULT NULL,
      cost_price DECIMAL(10, 2) NOT NULL,
      selling_price DECIMAL(10, 2) NOT NULL,
      stock_quantity INT DEFAULT 0,
      min_stock_level INT DEFAULT 10,
      expiration_date DATE DEFAULT NULL,
      image_url TEXT DEFAULT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS sales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      total_amount DECIMAL(10, 2) NOT NULL,
      discount_amount DECIMAL(10, 2) DEFAULT 0.00,
      payment_method VARCHAR(50) NOT NULL,
      cash_received DECIMAL(10, 2) DEFAULT NULL,
      change_given DECIMAL(10, 2) DEFAULT NULL,
      payment_details TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS sale_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sale_id INT NOT NULL,
      product_id INT NOT NULL,
      quantity INT NOT NULL,
      unit_price DECIMAL(10, 2) NOT NULL,
      discount_amount DECIMAL(10, 2) DEFAULT 0.00,
      subtotal DECIMAL(10, 2) NOT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS inventory_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      change_amount INT NOT NULL,
      reason TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS discounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      value DECIMAL(10, 2) NOT NULL,
      target_type VARCHAR(50) NOT NULL,
      target_id INT DEFAULT NULL,
      start_date DATE DEFAULT NULL,
      end_date DATE DEFAULT NULL,
      is_active TINYINT DEFAULT 1
    );`,

    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (\`key\`)
    );`
  ];

  for (const statement of schema) {
    await pool.query(statement);
  }

  // Ensure 'sales' table has the required columns (for existing databases)
  try {
    const [salesCols] = await pool.query("SHOW COLUMNS FROM sales") as any[];
    const colNames = salesCols.map((c: any) => c.Field);
    
    if (!colNames.includes('cash_received')) {
      console.log("🛠 Patching 'sales' table: Adding 'cash_received' column...");
      await pool.execute("ALTER TABLE sales ADD COLUMN cash_received DECIMAL(10, 2) DEFAULT NULL AFTER payment_method");
    }
    if (!colNames.includes('change_given')) {
      console.log("🛠 Patching 'sales' table: Adding 'change_given' column...");
      await pool.execute("ALTER TABLE sales ADD COLUMN change_given DECIMAL(10, 2) DEFAULT NULL AFTER cash_received");
    }
    if (!colNames.includes('payment_details')) {
      console.log("🛠 Patching 'sales' table: Adding 'payment_details' column...");
      await pool.execute("ALTER TABLE sales ADD COLUMN payment_details TEXT DEFAULT NULL AFTER change_given");
    }
  } catch (err) {
    console.warn("Could not verify sales table columns automatically. If you see errors, please check your database schema.");
  }

  // Seeding
  const [storeRows] = await pool.query("SELECT id FROM stores LIMIT 1") as any[];
  if (storeRows.length === 0) {
    console.log("🌱 Seeding initial store...");
    await pool.execute("INSERT INTO stores (name, address) VALUES (?, ?)", ["Lorna POS Store", "Main Address"]);
  }

  const [adminRows] = await pool.query("SELECT * FROM users WHERE username = ?", ["admin"]) as any[];
  if (adminRows.length === 0) {
    console.log("🌱 Seeding initial admin user...");
    const hash = bcrypt.hashSync("admin123", 10);
    await pool.execute(
      "INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)",
      ["admin", hash, "admin", "System Administrator"]
    );
    console.log("✔ Admin account created: admin / admin123");
  } else {
    // Force reset admin password to admin123 to ensure login works during setup/dev
    const hash = bcrypt.hashSync("admin123", 10);
    await pool.execute("UPDATE users SET password = ? WHERE username = ?", [hash, "admin"]);
    console.log("✔ Admin account verified and password reset to: admin123");
  }

  console.log("✔ Database schema ready");
}

// --- Authentication Middleware ---
const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: "Access denied. Token missing." });

  jwt.verify(token, JWT_SECRET, async (err: any, decoded: any) => {
    if (err) return res.status(401).json({ error: "Invalid or expired token." });
    
    req.user = decoded as AuthTokenPayload;
    next();
  });
};

const restrictTo = (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: "Permission denied. High-level access required." });
  }
  next();
};

// --- API Routes ---

// Health Check
app.get("/api/health", (req, res) => res.json({ status: "running", database: "mysql", time: new Date() }));

// Authentication
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const user = await db.get<any>(`
      SELECT u.*, (SELECT name FROM stores LIMIT 1) as store_name
      FROM users u 
      WHERE u.username = ?
    `, [username]);

    if (!user) {
      console.warn(`[AUTH] Login failed: User "${username}" not found.`);
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const passwordMatch = bcrypt.compareSync(password, user.password);
    if (!passwordMatch) {
      console.warn(`[AUTH] Login failed: Incorrect password for user "${username}".`);
      return res.status(401).json({ error: "Invalid username or password" });
    }

    console.log(`[AUTH] User "${username}" logged in successfully.`);

    const payload: AuthTokenPayload = { 
      id: user.id, 
      username: user.username, 
      role: user.role, 
      store_name: user.store_name || "Lorna POS"
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

    res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        role: user.role, 
        full_name: user.full_name, 
        store_name: user.store_name || "Lorna POS"
      } 
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Products
app.get("/api/products", authenticate, async (req, res) => {
  try {
    const products = await db.query<any>(`
      SELECT p.*, c.name as category_name
      FROM products p 
      LEFT JOIN categories c ON p.category_id = c.id
    `);
    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/products", authenticate, restrictTo('admin'), async (req, res) => {
  const { name, barcode, category_id, cost_price, selling_price, stock_quantity, min_stock_level, image_url, expiration_date } = req.body;
  try {
    const result = await db.execute(`
      INSERT INTO products (name, barcode, category_id, cost_price, selling_price, stock_quantity, min_stock_level, image_url, expiration_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, barcode, category_id, cost_price, selling_price, stock_quantity, min_stock_level, image_url, expiration_date]);
    res.json({ id: result.insertId });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/products/:id", authenticate, restrictTo('admin'), async (req, res) => {
  const { name, barcode, category_id, cost_price, selling_price, stock_quantity, min_stock_level, image_url, expiration_date } = req.body;
  try {
    await db.execute(`
      UPDATE products 
      SET name = ?, barcode = ?, category_id = ?, cost_price = ?, selling_price = ?, stock_quantity = ?, min_stock_level = ?, image_url = ?, expiration_date = ?
      WHERE id = ?
    `, [name, barcode, category_id, cost_price, selling_price, stock_quantity, min_stock_level, image_url, expiration_date, req.params.id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/products/:id", authenticate, restrictTo('admin'), async (req, res) => {
  try {
    await db.execute("DELETE FROM products WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Categories
app.get("/api/categories", authenticate, async (req, res) => {
  try {
    const categories = await db.query("SELECT * FROM categories");
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/categories", authenticate, restrictTo('admin'), async (req, res) => {
  const { name } = req.body;
  try {
    const result = await db.execute("INSERT INTO categories (name) VALUES (?)", [name]);
    res.json({ id: result.insertId });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/categories/:id", authenticate, restrictTo('admin'), async (req, res) => {
  const { name } = req.body;
  try {
    await db.execute("UPDATE categories SET name = ? WHERE id = ?", [name, req.params.id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/categories/:id", authenticate, restrictTo('admin'), async (req, res) => {
  try {
    await db.execute("DELETE FROM categories WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Sales
app.post("/api/sales", authenticate, async (req, res) => {
  const { items, total_amount, discount_amount, payment_method, cash_received, change_given, payment_details } = req.body;
  const user_id = req.user!.id;

  try {
    await db.beginTransaction();

    const saleResult = await db.execute(`
      INSERT INTO sales (user_id, total_amount, discount_amount, payment_method, cash_received, change_given, payment_details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [user_id, total_amount, discount_amount, payment_method, cash_received, change_given, payment_details]);
    
    const saleId = saleResult.insertId;

    for (const item of items) {
      await db.execute(`
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, discount_amount, subtotal)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [saleId, item.product_id, item.quantity, item.unit_price, item.discount_amount, item.subtotal]);
      
      // Update inventory
      await db.execute("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [item.quantity, item.product_id]);
      
      // Log inventory change
      await db.execute("INSERT INTO inventory_logs (product_id, change_amount, reason) VALUES (?, ?, ?)", [item.product_id, -item.quantity, `Sale #${saleId}`]);
    }

    await db.commit();
    res.json({ id: saleId, success: true });
  } catch (error: any) {
    await db.rollback();
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/sales", authenticate, async (req, res) => {
  try {
    const sales = await db.query(`
      SELECT s.*, u.full_name as user_name 
      FROM sales s 
      LEFT JOIN users u ON s.user_id = u.id 
      ORDER BY s.created_at DESC
    `);
    res.json(sales);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/sales/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  
  try {
    const sale = await db.get<any>(`
      SELECT s.*, u.full_name as user_name, st.name as store_name, st.address as store_address, st.phone as store_phone
      FROM sales s 
      LEFT JOIN users u ON s.user_id = u.id 
      JOIN stores st ON st.id = 1
      WHERE s.id = ?
    `, [id]);

    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    const items = await db.query(`
      SELECT si.*, p.name 
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `, [id]);

    sale.items = items;
    res.json(sale);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Users/Personnel
app.get("/api/users", authenticate, restrictTo('admin'), async (req, res) => {
  try {
    const users = await db.query(`
      SELECT id, username, full_name, role, phone 
      FROM users
    `);
    res.json(users);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/users", authenticate, restrictTo('admin'), async (req, res) => {
  const { username, password, full_name, role, phone } = req.body;
  try {
    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = await db.execute(`
      INSERT INTO users (username, password, full_name, role, phone)
      VALUES (?, ?, ?, ?, ?)
    `, [username, hashedPassword, full_name, role, phone]);
    res.json({ id: result.insertId });
  } catch (error: any) {
    res.status(400).json({ error: "Username already exists or invalid data" });
  }
});

app.put("/api/users/:id", authenticate, restrictTo('admin'), async (req, res) => {
  const { username, password, full_name, role, phone } = req.body;
  const { id } = req.params;
  try {
    if (password) {
      const hashedPassword = bcrypt.hashSync(password, 10);
      await db.execute(`
        UPDATE users SET username = ?, password = ?, full_name = ?, role = ?, phone = ?
        WHERE id = ?
      `, [username, hashedPassword, full_name, role, phone, id]);
    } else {
      await db.execute(`
        UPDATE users SET username = ?, full_name = ?, role = ?, phone = ?
        WHERE id = ?
      `, [username, full_name, role, phone, id]);
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/users/:id", authenticate, restrictTo('admin'), async (req, res) => {
  const { id } = req.params;
  try {
    await db.execute("DELETE FROM users WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Settings
app.get("/api/settings", authenticate, async (req, res) => {
  try {
    const settingsRows = await db.query<any>("SELECT * FROM settings");
    const settings: any = {};
    settingsRows.forEach(row => settings[row.key] = row.value);
    
    // Include store info
    const store = await db.get<any>("SELECT * FROM stores LIMIT 1");
    if (store) {
      settings.store_name = store.name;
      settings.store_address = store.address;
      settings.store_phone = store.phone;
    }
    
    res.json(settings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/settings/store", authenticate, restrictTo('admin'), async (req, res) => {
  const { name, address, phone, gcash_name, gcash_number, gcash_qr } = req.body;

  try {
    await db.execute("UPDATE stores SET name = ?, address = ?, phone = ? WHERE id = 1", [name, address, phone]);
    
    const settingsToUpdate = { gcash_name, gcash_number, gcash_qr };
    for (const [key, value] of Object.entries(settingsToUpdate)) {
      if (value !== undefined) {
        await db.execute(`
          REPLACE INTO settings (\`key\`, value) 
          VALUES (?, ?)
        `, [key, value.toString()]);
      }
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reports
app.get("/api/reports/dashboard", authenticate, async (req, res) => {
  try {
    const todaySales = await db.get<any>("SELECT SUM(total_amount) as total FROM sales WHERE DATE(created_at) = CURDATE()");
    const totalOrders = await db.get<any>("SELECT COUNT(*) as count FROM sales WHERE DATE(created_at) = CURDATE()");
    const lowStock = await db.get<any>("SELECT COUNT(*) as count FROM products WHERE stock_quantity <= min_stock_level");
    const expiringSoon = await db.get<any>("SELECT COUNT(*) as count FROM products WHERE expiration_date IS NOT NULL AND expiration_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)");

    // Sales chart: adjust query for SQLite if needed, but MySQL is fine
    const salesChart = await db.query(`
      SELECT DATE(created_at) as date, SUM(total_amount) as amount 
      FROM sales 
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY date
      ORDER BY date ASC
    `);

    res.json({
      stats: {
        todaySales: todaySales || { total: 0 },
        totalOrders: totalOrders || { count: 0 },
        lowStock: lowStock || { count: 0 },
        expiringSoon: expiringSoon || { count: 0 }
      },
      salesChart
    });
  } catch (error: any) {
    // If DATE() functions fail (MySQL vs SQLite syntax differences), fallback to generic values
    res.json({
      stats: { todaySales: { total: 0 }, totalOrders: { count: 0 }, lowStock: { count: 0 }, expiringSoon: { count: 0 } },
      salesChart: []
    });
  }
});

app.get("/api/reports/analytics", authenticate, restrictTo('admin', 'user'), async (req, res) => {
  try {
    const monthlyTrends = await db.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, SUM(total_amount) as total 
      FROM sales 
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
      GROUP BY month
      ORDER BY month ASC
    `);

    const topProducts = await db.query(`
      SELECT p.name, SUM(si.quantity) as total_qty, SUM(si.subtotal) as total_revenue
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales s ON si.sale_id = s.id
      GROUP BY p.id
      ORDER BY total_qty DESC
      LIMIT 10
    `);

    res.json({ monthlyTrends, topProducts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Discounts
app.get("/api/discounts", authenticate, async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM discounts");
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/discounts", authenticate, restrictTo('admin'), async (req, res) => {
  const { name, type, value, target_type, target_id, start_date, end_date, is_active } = req.body;
  try {
    const result = await db.execute(`
      INSERT INTO discounts (name, type, value, target_type, target_id, start_date, end_date, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, type, value, target_type, target_id, start_date, end_date, is_active]);
    res.json({ id: result.insertId });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/discounts/:id", authenticate, restrictTo('admin'), async (req, res) => {
  const { name, type, value, target_type, target_id, start_date, end_date, is_active } = req.body;
  try {
    await db.execute(`
      UPDATE discounts 
      SET name = ?, type = ?, value = ?, target_type = ?, target_id = ?, start_date = ?, end_date = ?, is_active = ?
      WHERE id = ?
    `, [name, type, value, target_type, target_id, start_date, end_date, is_active, req.params.id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/discounts/:id", authenticate, restrictTo('admin'), async (req, res) => {
  try {
    await db.execute("DELETE FROM discounts WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// File Upload
app.post("/api/upload", authenticate, upload.single("image"), (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file provided" });
  res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

// Single Page Application - Catch All
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "API route not found" });
  res.sendFile(path.join(__dirname, "index.html"));
});

// --- Server Lifecycle ---
async function startServer() {
  await connectToDatabase();
  
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 LORNA POS SYSTEM IS ONLINE`);
    console.log(`🌍 Server active at: http://localhost:${PORT}`);
    console.log(`📡 Database Mode: EXTERNAL MYSQL`);
    console.log(`🔐 Default Login: admin / admin123`);
    console.log(`----------------------------------`);
  });
}

startServer();

