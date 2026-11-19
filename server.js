const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'data', 'database.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets from workspace root
app.use(express.static(path.join(__dirname)));

// Helper: Read Database
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return { meals: [], orders: [], notifications: [], user: {} };
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading database:', err);
    return { meals: [], orders: [], notifications: [], user: {} };
  }
}

// Helper: Write Database (Atomic)
function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Error writing database:', err);
    return false;
  }
}

/* ==========================================================================
   REST API ENDPOINTS
   ========================================================================== */

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Akshaya Patram',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// 2. Get All Meal Listings (Supports filtering & search)
app.get('/api/meals', (req, res) => {
  const db = readDB();
  let meals = db.meals || [];
  const { q, dietary, status } = req.query;

  // Filter by query (title or address)
  if (q && q.trim()) {
    const query = q.toLowerCase().trim();
    meals = meals.filter(m => 
      m.title.toLowerCase().includes(query) || 
      m.address.toLowerCase().includes(query) ||
      m.donorName.toLowerCase().includes(query)
    );
  }

  // Filter by dietary
  if (dietary && dietary !== 'all') {
    const diet = dietary.toLowerCase().trim();
    meals = meals.filter(m => m.dietary.toLowerCase().includes(diet));
  }

  // Filter by status (available vs claimed)
  if (status && status !== 'all') {
    meals = meals.filter(m => m.status === status);
  }

  res.json({
    success: true,
    count: meals.length,
    data: meals
  });
});

// 3. Get Single Meal By ID
app.get('/api/meals/:id', (req, res) => {
  const db = readDB();
  const meal = (db.meals || []).find(m => m.id === req.params.id);
  if (!meal) {
    return res.status(404).json({ success: false, message: 'Meal not found' });
  }
  res.json({ success: true, data: meal });
});

// 4. Create New Surplus Food Listing (Donor Flow)
app.post('/api/meals', (req, res) => {
  const db = readDB();
  const {
    title,
    portionsNum,
    dietary,
    pickupWindow,
    address,
    donorName,
    donorAvatar,
    image
  } = req.body;

  if (!title || !portionsNum || !address) {
    return res.status(400).json({
      success: false,
      message: 'Title, portions, and address are required'
    });
  }

  const portions = parseInt(portionsNum, 10) || 5;
  const newId = 'AP-' + (100 + (db.meals ? db.meals.length : 0) + 1);

  // Generate map coordinates (simulated around Bengaluru bounds)
  const pinX = 140 + Math.floor(Math.random() * 120);
  const pinY = 180 + Math.floor(Math.random() * 120);

  const newMeal = {
    id: newId,
    title: title.trim(),
    count: `${portions} Meals`,
    portionsNum: portions,
    servings: `${portions} Servings (Estimated ${Math.round(portions * 0.75)}kg)`,
    dietary: dietary || 'Veg, Nut-Free',
    pickupWindow: pickupWindow || '2:30 PM - 5:30 PM Today',
    address: address.trim(),
    distance: `${(1.0 + Math.random() * 2.5).toFixed(1)} km away`,
    donorName: donorName || 'Aisha Khan (Akshaya Kitchen)',
    donorRating: '4.8',
    donorAvatar: donorAvatar || 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=150&q=80',
    image: image || 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?auto=format&fit=crop&w=800&q=80',
    pinX,
    pinY,
    color: portions > 10 ? 'orange' : 'teal',
    clusterCount: 0,
    status: 'available',
    fssaiVerified: true,
    createdAt: new Date().toISOString()
  };

  db.meals.unshift(newMeal);

  // Add notification
  db.notifications.unshift({
    id: 'NOTIF-' + Date.now(),
    type: 'new_listing',
    title: '🍲 New Surplus Food Available',
    message: `${newMeal.donorName} listed ${newMeal.count} (${newMeal.title}) in ${newMeal.address}.`,
    time: 'Just now',
    read: false
  });

  writeDB(db);

  res.status(201).json({
    success: true,
    message: 'Surplus food listing published successfully',
    data: newMeal
  });
});

// 5. Accept Pickup Reservation (Locks inventory & creates Order)
app.post('/api/orders', (req, res) => {
  const db = readDB();
  const { mealId, recipientName } = req.body;

  const mealIndex = (db.meals || []).findIndex(m => m.id === mealId);
  if (mealIndex === -1) {
    return res.status(404).json({ success: false, message: 'Meal listing not found' });
  }

  const meal = db.meals[mealIndex];
  if (meal.status === 'claimed') {
    return res.status(400).json({ success: false, message: 'This food surplus has already been claimed' });
  }

  // Update meal status in database
  meal.status = 'claimed';

  // Generate Unique Order Token
  const orderId = '#AP' + Math.floor(100000 + Math.random() * 900000);
  const newOrder = {
    orderId,
    mealId: meal.id,
    mealTitle: meal.title,
    portions: `${meal.count} (${meal.servings})`,
    pickupSlot: meal.pickupWindow,
    address: meal.address,
    donor: meal.donorName,
    recipientName: recipientName || (db.user ? db.user.name : 'Verified Recipient'),
    status: 'Confirmed',
    createdAt: new Date().toISOString(),
    review: null
  };

  db.orders.unshift(newOrder);

  // Update user impact stats
  if (db.user) {
    db.user.mealsRescued = (db.user.mealsRescued || 0) + meal.portionsNum;
    db.user.foodSavedKg = (db.user.foodSavedKg || 0) + Math.round(meal.portionsNum * 0.75);
    db.user.co2OffsetKg = (db.user.co2OffsetKg || 0) + Math.round(meal.portionsNum * 1.8);
  }

  // Add notification
  db.notifications.unshift({
    id: 'NOTIF-' + Date.now(),
    type: 'order_confirmed',
    title: '✅ Pickup Order Confirmed',
    message: `Order ${orderId} confirmed for ${meal.title}. Please arrive during ${meal.pickupWindow}.`,
    time: 'Just now',
    read: false
  });

  writeDB(db);

  res.status(201).json({
    success: true,
    message: 'Pickup reservation confirmed',
    data: newOrder
  });
});

// 6. Get All Orders (for My Requests)
app.get('/api/orders', (req, res) => {
  const db = readDB();
  res.json({
    success: true,
    count: (db.orders || []).length,
    data: db.orders || []
  });
});

// 7. Submit Review & Rating for an Order
app.post('/api/orders/:id/review', (req, res) => {
  const db = readDB();
  const orderId = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
  const { stars, sentiment, tags, comment } = req.body;

  const order = (db.orders || []).find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  order.review = {
    stars: parseInt(stars, 10) || 5,
    sentiment: sentiment || 'Excellent (5.0)',
    tags: Array.isArray(tags) ? tags : [],
    comment: (comment || '').trim(),
    createdAt: new Date().toISOString()
  };

  writeDB(db);

  res.json({
    success: true,
    message: 'Feedback and rating submitted successfully',
    data: order
  });
});

// 8. Get Notifications
app.get('/api/notifications', (req, res) => {
  const db = readDB();
  res.json({
    success: true,
    count: (db.notifications || []).length,
    data: db.notifications || []
  });
});

// 9. Get User Profile & Impact Stats
app.get('/api/user/profile', (req, res) => {
  const db = readDB();
  res.json({
    success: true,
    data: db.user || {}
  });
});

// 10. Update User Profile / Switch Role
app.post('/api/user/profile', (req, res) => {
  const db = readDB();
  db.user = { ...db.user, ...req.body };
  writeDB(db);
  res.json({
    success: true,
    message: 'Profile updated successfully',
    data: db.user
  });
});

// 11. Reset Database to Seed State
app.post('/api/reset', (req, res) => {
  const seedFile = path.join(__dirname, 'data', 'database.json');
  // Re-read or re-initialize
  const db = readDB();
  (db.meals || []).forEach(m => { m.status = 'available'; });
  writeDB(db);
  res.json({ success: true, message: 'Database reset to initial demo state' });
});

// Start listening
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`Akshaya Patram Server running at: http://localhost:${PORT}`);
  console.log(`API Health: http://localhost:${PORT}/api/health`);
  console.log(`API Meals:  http://localhost:${PORT}/api/meals`);
  console.log(`Serving Frontend at: http://localhost:${PORT}/`);
  console.log(`====================================================`);
});

