require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB Connection
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'blood_access'
};

let pool;

async function connectDB() {
    try {
        pool = await mysql.createPool(dbConfig);
        console.log('MySQL Connected...');
    } catch (err) {
        console.error('MySQL Connection Error:', err.message);
        process.exit(1);
    }
}

connectDB();

// Helper for JWT
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// Routes

// Register
app.post('/api/register', async (req, res) => {
    const { name, email, role, blood_group, location, phone } = req.body;
    try {
        const [result] = await pool.execute(
            'INSERT INTO users (name, email, role, blood_group, location, phone) VALUES (?, ?, ?, ?, ?, ?)',
            [name, email, role, blood_group || null, location || null, phone || null]
        );

        if (role === 'hospital') {
            const hospitalId = result.insertId;
            const groups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
            for (const g of groups) {
                await pool.execute('INSERT INTO blood_stock (hospital_id, blood_group, quantity) VALUES (?, ?, 0)', [hospitalId, g]);
            }
        }
        res.status(201).json({ message: 'User registered successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    const { email, role } = req.body;
    try {
        let query = 'SELECT * FROM users WHERE email = ?';
        const params = [email];
        if (role) {
            query += ' AND role = ?';
            params.push(role);
        }
        query += ' ORDER BY id DESC LIMIT 1';

        const [users] = await pool.execute(query, params);
        if (users.length === 0) return res.status(400).json({ error: 'No account found with this email and role.' });

        const user = users[0];
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, role: user.role, name: user.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Blood Stock (Filtered)
app.get('/api/stock', async (req, res) => {
    const { blood_group, location } = req.query;
    try {
        let query = 'SELECT bs.*, u.name as hospital_name, u.location, u.phone as hospital_phone FROM blood_stock bs JOIN users u ON bs.hospital_id = u.id WHERE bs.quantity > 0';
        const params = [];

        if (blood_group) {
            query += ' AND bs.blood_group = ?';
            params.push(blood_group);
        }
        if (location) {
            query += ' AND u.location LIKE ?';
            params.push(`%${location}%`);
        }

        const [stock] = await pool.execute(query, params);
        res.json(stock);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Donors (Filtered)
app.get('/api/donors', async (req, res) => {
    const { blood_group, location } = req.query;
    try {
        let query = 'SELECT id, name, blood_group, location, phone FROM users WHERE role = "donor" AND is_available = TRUE';
        const params = [];

        if (blood_group) {
            query += ' AND blood_group = ?';
            params.push(blood_group);
        }
        if (location) {
            query += ' AND location LIKE ?';
            params.push(`%${location}%`);
        }

        const [donors] = await pool.execute(query, params);
        res.json(donors);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update H//ospital Stock
app.post('/api/update-stock', authenticateToken, async (req, res) => {
    if (req.user.role !== 'hospital') return res.sendStatus(403);
    const { blood_group, quantity } = req.body;
    try {
        const [exists] = await pool.execute('SELECT id FROM blood_stock WHERE hospital_id = ? AND blood_group = ?', [req.user.id, blood_group]);
        if (exists.length > 0) {
            await pool.execute('UPDATE blood_stock SET quantity = ? WHERE hospital_id = ? AND blood_group = ?', [quantity, req.user.id, blood_group]);
        } else {
            await pool.execute('INSERT INTO blood_stock (hospital_id, blood_group, quantity) VALUES (?, ?, ?)', [req.user.id, blood_group, quantity]);
        }
        res.json({ message: 'Stock updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Blood Request (Notify Donor/Hospital)
app.post('/api/requests', authenticateToken, async (req, res) => {
    const { recipient_id, message } = req.body;
    try {
        await pool.execute('INSERT INTO notifications (user_id, message) VALUES (?, ?)', [recipient_id, message]);
        res.status(201).json({ message: 'Request sent successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get My Notifications
app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get My Hospital Stock
app.get('/api/hospital/stock', authenticateToken, async (req, res) => {
    if (req.user.role !== 'hospital') return res.sendStatus(403);
    try {
        const [stock] = await pool.execute('SELECT * FROM blood_stock WHERE hospital_id = ?', [req.user.id]);
        res.json(stock);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

 //Get My Profile
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, name, email, role, blood_group, location, phone, is_available, created_at FROM users WHERE id = ?', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Donor Availability
app.post('/api/donor/availability', authenticateToken, async (req, res) => {
    if (req.user.role !== 'donor') return res.sendStatus(403);
    const { is_available } = req.body;
    try {
        await pool.execute('UPDATE users SET is_available = ? WHERE id = ?', [is_available, req.user.id]);
        res.json({ message: 'Availability updated.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Simple Notifications
app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const [notifications] = await pool.execute('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [req.user.id]);
        res.json(notifications);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Blood Request
app.post('/api/request-blood', authenticateToken, async (req, res) => {
    const { blood_group, location } = req.body;
    try {
        await pool.execute('INSERT INTO blood_requests (patient_id, blood_group, location) VALUES (?, ?, ?)', [req.user.id, blood_group, location]);
        res.json({ message: 'Blood request submitted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Get all users
app.get('/api/admin/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    try {
        const [users] = await pool.execute('SELECT id, name, email, role, phone, location, blood_group FROM users');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Delete user
app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { id } = req.params;
    try {
        await pool.execute('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'User deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Broadcast Message
app.post('/api/admin/broadcast', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { message } = req.body;
    try {
        const [users] = await pool.execute('SELECT id FROM users');
        for (const user of users) {
            await pool.execute('INSERT INTO notifications (user_id, message) VALUES (?, ?)', [user.id, `SYSTEM: ${message}`]);
        }
        res.json({ message: 'Broadcast sent to all users.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fallback for HTML5 rooting (Optional if using simple structure)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
