const express = require('express');  
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch'); // ใช้ส่งข้อความ Discord webhook
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000;

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ตัวอย่างเรียก Firestore
const db = admin.firestore();

// Middleware
app.use(cors());
app.use(express.json());

// เสิร์ฟ static ไฟล์จากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// ฟังก์ชันส่งข้อความแจ้งเตือนไป Discord webhook
async function sendDiscordNotification(webhookUrl, message) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });

    if (!response.ok) {
      console.error('Failed to send Discord notification:', response.statusText);
    }
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

async function sendDiscord(message, embed = null) {
  const webhookURL = 'https://discord.com/api/webhooks/1374624597881786439/1SmgQBuaM582kC3E6f0_dDmLKUu-nFxg0XLq2pjC4F7Dd6P3Q6Mj1qATz7jMhYWi-Drt';
  try {
    const body = embed ? { embeds: [embed] } : { content: message };
    await fetch(webhookURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (error) {
    console.error('ส่งข้อความ Discord ล้มเหลว:', error);
  }
}

// รหัสผ่าน admin
const ADMIN_PASSWORD = '7890';

// Middleware ตรวจสอบ admin
function adminAuth(req, res, next) {
  const adminPass = req.headers['x-admin-password'];
  if (!adminPass || adminPass !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, message: 'Forbidden: Admin access required' });
  }
  next();
}

// ข้อมูล admin สำหรับ login
const ADMIN_CREDENTIALS = {
  username: 'admin',
  password: ADMIN_PASSWORD
};

// Route test API
app.get('/test', (req, res) => {
  res.send('API is working!');
});

// Admin login (POST)
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอก username และ password' });
  }

  if (
    username === ADMIN_CREDENTIALS.username &&
    password === ADMIN_CREDENTIALS.password
  ) {
    // อาจจะส่ง token หรือ session ไว้ใช้ในอนาคต
    return res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', token: 'dummy-admin-token' });
  } else {
    return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือไม่ใช่ Admin' });
  }
});

// API สำหรับผู้ใช้ทั่วไป (register, login, info, usepoint, upgrade)
app.post('/proxy', async (req, res) => {
  const { action, username, password, name, pointChange, topgmChange } = req.body;

  if (!action) return res.json({ success: false, message: 'Missing action' });

  try {
    const userRef = db.collection('users').doc(username);
    const userDoc = await userRef.get();

    // ลงทะเบียน
    if (action === 'register') {
      if (!username || !password) return res.json({ success: false, message: 'Missing username or password' });

      if (userDoc.exists) return res.json({ success: false, message: 'Username ซ้ำ' });

      await userRef.set({
        password,
        token: 0,
        topgm: 0,
        warzone: 0,
        point: 0
      });
      return res.json({ success: true });
    }

    // เช็คผู้ใช้และรหัสผ่าน
    if (!userDoc.exists) return res.json({ success: false, message: 'ไม่พบผู้ใช้' });
    const userData = userDoc.data();
    if (userData.password !== password) return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });

    // login หรือ ข้อมูลผู้ใช้
    if (action === 'login' || action === 'userinfo') {
      return res.json({ success: true, ...userData });
    }

    // ใช้พ้อยท์แลก topgm (แจ้งเตือน Discord ด้วยชื่อผู้เล่น)
    if (action === 'usepoint') {
      if (typeof pointChange !== 'number' || typeof topgmChange !== 'number') {
        return res.json({ success: false, message: 'Invalid pointChange or topgmChange' });
      }

      const displayName = name || username;

      const currentPoint = userData.point || 0;
      const currentTopgm = userData.topgm || 0;

      const newPoint = currentPoint + pointChange;
      const newTopgm = currentTopgm + topgmChange;

      if (newPoint < 0) {
        return res.json({ success: false, message: 'POINT ไม่พอ' });
      }

      if (newTopgm < 0) {
        return res.json({ success: false, message: 'ไม่สามารถลบ topgm ได้มากกว่าที่มี' });
      }

      await userRef.update({ point: newPoint, topgm: newTopgm });

      await sendDiscord(`${displayName} แลก ${Math.abs(pointChange)} พ้อยท์ ได้รับไอเท็ม TOPGM จำนวน ${Math.abs(topgmChange)} ชิ้น`);

      return res.json({ success: true });
    }

    // อัปเกรดไอเท็ม topgm เป็น warzone พร้อมแจ้งเตือน Discord
    if (action === 'upgrade') {
      const itemName = 'topgm';
      const hasItem = userData[itemName] || 0;
      let currentToken = userData.token || 0;
      let warzone = userData.warzone || 0;
      let topgm = hasItem;

      if (currentToken <= 0) {
        return res.json({ success: false, message: 'คุณไม่มี PEMTO สำหรับอัปเกรด' });
      }
      if (topgm <= 0) {
        return res.json({ success: false, message: 'คุณไม่มีไอเท็มสำหรับอัพเกรด' });
      }

      const rateDoc = await db.collection('upgraderates').doc(itemName).get();
      if (!rateDoc.exists) return res.json({ success: false, message: 'ไม่มีข้อมูลอัตราอัพเกรด' });

      const { successRate, failRate, breakRate } = rateDoc.data();

      if (
        typeof successRate !== 'number' || typeof failRate !== 'number' || typeof breakRate !== 'number' ||
        successRate < 0 || failRate < 0 || breakRate < 0 ||
        successRate + failRate + breakRate > 1
      ) {
        return res.json({ success: false, message: 'ข้อมูลอัตราอัพเกรดไม่ถูกต้อง' });
      }

      const roll = Math.random();
      let result = '';
      let logResult = '';
      let resultMessage = '';

      currentToken -= 1;

      if (roll < successRate) {
        result = 'success';
        topgm -= 1;
        warzone += 1; // เพิ่ม Warzone
        logResult = `สำเร็จ`;
        resultMessage = `อัพเกรดสำเร็จ: Warzone`;

        // Embed Discord แจ้งผลสำเร็จ
        const embed = { 
          title: `🎉 ${name || username} ได้อัพเกรด สำเร็จ !`,
          description: `ไอเท็มมีระดับสูงขึ้นเป็น "Warzone S.GOD+7"!!`,
          color: 0x00FF00,
          image: {
            url: "https://img5.pic.in.th/file/secure-sv1/image_2025-05-21_025140493-removebg-preview.png"
          },
          footer: {
            text: "ได้รับไอเท็ม Warzone S.GOD+7"
          },
          timestamp: new Date().toISOString()
        };
        await sendDiscord(null, embed);

      } else if (roll < successRate + failRate) {
        result = 'fail';
        logResult = `ล้มเหลว`;
        resultMessage = `อัพเกรดไม่สำเร็จ (TOPGM ยังอยู่)`;
        await sendDiscord(`\u00A0\u00A0\u00A0\u00A0${name || username}\u00A0\u00A0 ⚠️\u00A0\u00A0 ได้อัพเกรด \u00A0\u00A0ปลอกTOPGM ล้มเหลว!\u00A0 ขอให้โชคดีครั้งหน้า`);
      } else {
        result = 'broken';
        topgm -= 1;
        logResult = `แตก`;
        resultMessage = `อัพเกรดล้มเหลว ไอเท็มสูญหาย (TOPGM หาย)`;
        await sendDiscord(`\u00A0\u00A0\u00A0\u00A0${name || username}\u00A0\u00A0 💥\u00A0\u00A0 ได้อัพเกรดล้มเหลว! \u00A0\u00A0ไอเท็ม \u00A0\u00A0ปลอกTOPGM\u00A0\u00A0 ถูกทำลาย`);
      }

      if (topgm < 0) topgm = 0;

      await userRef.update({
        token: currentToken,
        warzone: warzone,
        topgm: topgm
      });

      // บันทึก log
      await db.collection('logs').add({
        Date: admin.firestore.FieldValue.serverTimestamp(),
        Username: username,
        Name: name || '',
        Item: itemName,
        Result: logResult
      });

      return res.json({ success: true, result: logResult, resultMessage });
    }

    return res.json({ success: false, message: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.json({ success: false, message: 'Server Error' });
  }
});

// API ดึงอัตราอัปเกรดทั้งหมด (public)
app.get('/getUpgradeRates', async (req, res) => {
  try {
    const snapshot = await db.collection('upgraderates').get();
    const rates = {};
    snapshot.forEach(doc => {
      rates[doc.id] = doc.data();
    });
    res.json({ success: true, rates });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Server Error' });
  }
});

// API ดึงข้อมูลผู้ใช้ทั้งหมด (Admin) - ต้องมี adminAuth header
app.get('/getUsers', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = [];
    snapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, users });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Server Error' });
  }
});

// API ค้นหาผู้ใช้โดยชื่อ (Admin) - ใช้ query param ?search=
app.get('/searchUsers', adminAuth, async (req, res) => {
  const search = req.query.search;
  if (!search) return res.json({ success: false, message: 'Missing search parameter' });

  try {
    // สมมุติว่า search เป็น prefix ของ username (คุณอาจจะปรับ query ตามต้องการ)
    const snapshot = await db.collection('users')
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(search)
      .endAt(search + '\uf8ff')
      .limit(10)
      .get();

    const users = [];
    snapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));

    res.json({ success: true, users });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Server Error' });
  }
});

// API ดึง log ทั้งหมด (Admin)
app.get('/getLogs', adminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('logs')
      .orderBy('Date', 'desc')
      .limit(100)
      .get();

    const logs = [];
    snapshot.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));

    res.json({ success: true, logs });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Server Error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

