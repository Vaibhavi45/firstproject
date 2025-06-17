const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./db');
const geolib = require('geolib');
const session = require('express-session');

const app = express();
const port = 3001;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Configure session middleware
app.use(session({
    secret: 'your_secret_key', // Replace with a strong secret key
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true in production with HTTPS
}));

// Authentication middleware
function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        // User is authenticated, proceed to the next middleware or route handler
        next();
    } else {
        // User is not authenticated, send a 401 Unauthorized response
        res.status(401).json({ success: false, message: 'Unauthorized: Please log in.' });
    }
}

// Middleware to check user type (optional, but good practice)
function isUserType(userType) {
    return (req, res, next) => {
        if (req.session && req.session.userType === userType) {
            next();
        } else {
            res.status(403).json({ success: false, message: `Forbidden: Access restricted to ${userType}s.` });
        }
    };
}

// API Routes (placed before static file serving)

// Handle login
app.post('/login', (req, res) => {
    const { email, password, userType } = req.body;
    const table = userType === 'dealer' ? 'dealers' : userType === 'customer' ? 'customers' : 'delivery_boys';

    const query = `SELECT * FROM ${table} WHERE email = ? AND password = ?`;

    db.query(query, [email, password], (err, results) => {
        if (err) {
            console.error('Error during login:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        if (results.length > 0) {
            // Store user info in session
            req.session.userId = results[0].id;
            req.session.userType = userType;
            res.json({ success: true, user: results[0], userType: userType });
        } else {
            res.json({ success: false, message: 'Invalid credentials' });
        }
    });
});

// Handle registration
app.post('/register', (req, res) => {
    const { name, email, password, phone, userType, address, city, state, pincode } = req.body;
    const table = userType === 'dealer' ? 'dealers' : userType === 'customer' ? 'customers' : 'delivery_boys';

    let query;
    let values;

    if (userType === 'customer') {
        query = `INSERT INTO ${table} (name, email, password, phone, address, city, state, pincode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        values = [name, email, password, phone, address, city, state, pincode];
    } else {
        query = `INSERT INTO ${table} (name, email, password, phone) VALUES (?, ?, ?, ?)`;
        values = [name, email, password, phone];
    }

    db.query(query, values, (err, results) => {
        if (err) {
            console.error('Error during registration:', err);
            // Check for duplicate email error
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ success: false, message: 'Email already registered.' });
            }
            return res.status(500).json({ error: 'Database error' });
        }

        // For simplicity, automatically log in the user after successful registration
        // In a real application, you might require email verification or a separate login step
        const userId = results.insertId;
        req.session.userId = userId;
        req.session.userType = userType;

        res.json({ success: true, message: 'Registration successful' });
    });
});

// Register fuel station (Protected - Dealer only)
app.post('/api/register-station', isAuthenticated, isUserType('dealer'), (req, res) => {
    const { name, address, city, state, pincode, contactNumber } = req.body;
    const dealerId = req.session.userId; // Get dealer ID from session

    const query = `INSERT INTO fuel_stations (dealer_id, name, address, city, state, pincode, contact_number)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.query(query, [dealerId, name, address, city, state, pincode, contactNumber], (err, results) => {
        if (err) {
            console.error('Error registering station:', err);
            return res.status(500).json({ success: false, message: 'Failed to register station' });
        }

        // Initialize fuel prices for the new station
        const stationId = results.insertId;
        const priceQuery = `INSERT INTO fuel_prices (station_id, petrol_price, diesel_price, cng_price)
                           VALUES (?, 0.00, 0.00, 0.00)`;

        db.query(priceQuery, [stationId], (err) => {
            if (err) {
                console.error('Error initializing prices:', err);
                // Consider rolling back the station insertion here in a real app
                return res.status(500).json({ success: false, message: 'Failed to initialize prices' });
            }

            res.json({ success: true, message: 'Station registered successfully' });
        });
    });
});

// Update fuel prices (Protected - Dealer only)
app.post('/api/update-prices', isAuthenticated, isUserType('dealer'), (req, res) => {
    const { stationId, petrol, diesel, cng } = req.body;
    const dealerId = req.session.userId; // Get dealer ID from session

    const query = `UPDATE fuel_prices
                  SET petrol_price = ?, diesel_price = ?, cng_price = ?
                  WHERE station_id = ? AND EXISTS (SELECT 1 FROM fuel_stations WHERE id = ? AND dealer_id = ?)`; // Ensure dealer owns the station

    db.query(query, [petrol, diesel, cng, stationId, stationId, dealerId], (err, results) => {
        if (err) {
            console.error('Error updating prices:', err);
            return res.status(500).json({ success: false, message: 'Failed to update prices' });
        }

         if (results.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Station not found or you do not have permission to update prices for this station.' });
        }

        res.json({ success: true, message: 'Prices updated successfully' });
    });
});

// Get current fuel prices for a specific station (Can be accessed by anyone, but maybe add validation if needed)
app.get('/api/get-prices', (req, res) => {
    const stationId = req.query.stationId; // Get stationId from query parameters
    // No authentication required here to allow price checking before login

    if (!stationId) {
        return res.status(400).json({ success: false, message: 'Station ID is required' });
    }

    const query = `SELECT petrol_price, diesel_price, cng_price
                  FROM fuel_prices
                  WHERE station_id = ?`;

    db.query(query, [stationId], (err, results) => {
        if (err) {
            console.error('Error fetching prices:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch prices' });
        }

        if (results.length > 0) {
            res.json({
                success: true,
                prices: {
                    petrol: results[0].petrol_price,
                    diesel: results[0].diesel_price,
                    cng: results[0].cng_price
                }
            });
        } else {
            res.json({ success: false, message: 'No prices found for this station' });
        }
    });
});

// Get sales analytics (Protected - Dealer only)
app.get('/api/get-analytics', isAuthenticated, isUserType('dealer'), (req, res) => {
    const dealerId = req.session.userId; // Get dealer ID from session

    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const query = `
        SELECT
            SUM(CASE WHEN DATE(o.created_at) = ? THEN o.total_amount ELSE 0 END) as today,
            SUM(CASE WHEN DATE(o.created_at) >= ? THEN o.total_amount ELSE 0 END) as week,
            SUM(CASE WHEN DATE(o.created_at) >= ? THEN o.total_amount ELSE 0 END) as month
        FROM orders o
        JOIN fuel_stations fs ON o.station_id = fs.id
        WHERE fs.dealer_id = ? AND o.status = 'delivered'`;

    db.query(query, [today, weekAgo, monthAgo, dealerId], (err, results) => {
        if (err) {
            console.error('Error fetching analytics:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
        }

        res.json({
            success: true,
            today: results[0].today || 0,
            week: results[0].week || 0,
            month: results[0].month || 0
        });
    });
});

// Get dealer's stations (Protected - Dealer only)
app.get('/api/dealer/get-stations', isAuthenticated, isUserType('dealer'), (req, res) => {
    const dealerId = req.session.userId; // Get dealer ID from session

    const query = 'SELECT id, name FROM fuel_stations WHERE dealer_id = ?';

    db.query(query, [dealerId], (err, results) => {
        if (err) {
            console.error('Error fetching dealer stations:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch dealer stations' });
        }

        res.json({ success: true, stations: results });
    });
});

// Get orders for a dealer's stations (Protected - Dealer only)
app.get('/api/dealer/get-orders', isAuthenticated, isUserType('dealer'), (req, res) => {
    const dealerId = req.session.userId; // Get dealer ID from session

    const query = `
        SELECT o.*, c.name as customer_name, fs.name as station_name, db.name as delivery_boy_name
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        JOIN fuel_stations fs ON o.station_id = fs.id
        LEFT JOIN delivery_boys db ON o.delivery_boy_id = db.id
        WHERE fs.dealer_id = ?
        ORDER BY o.created_at DESC`;

    db.query(query, [dealerId], (err, results) => {
        if (err) {
            console.error('Error fetching dealer orders:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch orders' });
        }

        res.json({ success: true, orders: results });
    });
});

// Accept order (Dealer) (Protected - Dealer only)
app.post('/api/dealer/accept-order', isAuthenticated, isUserType('dealer'), (req, res) => {
    const { orderId } = req.body;
    const dealerId = req.session.userId; // Get dealer ID from session

    // Ensure the dealer owns the station associated with the order
    const checkQuery = 'SELECT fs.dealer_id FROM orders o JOIN fuel_stations fs ON o.station_id = fs.id WHERE o.id = ?';
    db.query(checkQuery, [orderId], (checkErr, checkResults) => {
        if (checkErr) {
            console.error('Error checking order ownership:', checkErr);
            return res.status(500).json({ success: false, message: 'Failed to check order ownership' });
        }

        if (checkResults.length === 0 || checkResults[0].dealer_id !== dealerId) {
            return res.status(403).json({ success: false, message: 'You do not have permission to accept this order.' });
        }

        const updateQuery = 'UPDATE orders SET status = ? WHERE id = ?';
        db.query(updateQuery, ['accepted', orderId], (err, results) => {
            if (err) {
                console.error('Error accepting order:', err);
                return res.status(500).json({ success: false, message: 'Failed to accept order' });
            }

            if (results.affectedRows === 0) {
                return res.status(404).json({ success: false, message: 'Order not found' });
            }

            res.json({ success: true, message: 'Order accepted' });
        });
    });
});

// Reject order (Dealer) (Protected - Dealer only)
app.post('/api/dealer/reject-order', isAuthenticated, isUserType('dealer'), (req, res) => {
    const { orderId } = req.body;
    const dealerId = req.session.userId; // Get dealer ID from session

     // Ensure the dealer owns the station associated with the order
    const checkQuery = 'SELECT fs.dealer_id FROM orders o JOIN fuel_stations fs ON o.station_id = fs.id WHERE o.id = ?';
    db.query(checkQuery, [orderId], (checkErr, checkResults) => {
        if (checkErr) {
            console.error('Error checking order ownership:', checkErr);
            return res.status(500).json({ success: false, message: 'Failed to check order ownership' });
        }

        if (checkResults.length === 0 || checkResults[0].dealer_id !== dealerId) {
            return res.status(403).json({ success: false, message: 'You do not have permission to reject this order.' });
        }

        const updateQuery = 'UPDATE orders SET status = ? WHERE id = ?';

        db.query(updateQuery, ['cancelled', orderId], (err, results) => {
            if (err) {
                console.error('Error rejecting order:', err);
                return res.status(500).json({ success: false, message: 'Failed to reject order' });
            }

            if (results.affectedRows === 0) {
                return res.status(404).json({ success: false, message: 'Order not found' });
            }

            res.json({ success: true, message: 'Order rejected' });
        });
    });
});

// Get all delivery boys (Dealer) (Protected - Dealer only)
app.get('/api/dealer/get-delivery-boys', isAuthenticated, isUserType('dealer'), (req, res) => {
    // Select delivery boys who are not currently assigned to any order with status 'accepted' or 'in-progress'
    // Corrected query to handle NULL delivery_boy_id in orders table
    const query = `
        SELECT id, name
        FROM delivery_boys
        WHERE id NOT IN (
            SELECT delivery_boy_id
            FROM orders
            WHERE (status = 'accepted' OR status = 'in-progress') AND delivery_boy_id IS NOT NULL
        )`;

    console.log('Executing query for available delivery boys:', query);

    db.query(query, (err, results) => {
        console.log('Database query callback executed.');
        if (err) {
            console.error('Error fetching delivery boys:', err);
            // Log detailed error object
            console.error('Database error details:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch delivery boys' });
        }

        console.log('Query results for available delivery boys:', results);
        res.json({ success: true, deliveryBoys: results });
    });
});

// Assign delivery boy to order (Dealer) (Protected - Dealer only)
app.post('/api/dealer/assign-delivery-boy', isAuthenticated, isUserType('dealer'), (req, res) => {
    const { orderId, deliveryBoyId } = req.body;
    const dealerId = req.session.userId; // Get dealer ID from session

     // Ensure the dealer owns the station associated with the order
    const checkQuery = 'SELECT fs.dealer_id FROM orders o JOIN fuel_stations fs ON o.station_id = fs.id WHERE o.id = ?';
    db.query(checkQuery, [orderId], (checkErr, checkResults) => {
        if (checkErr) {
            console.error('Error checking order ownership for assignment:', checkErr);
            // Log the detailed error object
            console.error('Database error details:', checkErr);
            return res.status(500).json({ success: false, message: 'Failed to check order ownership' });
        }

        if (checkResults.length === 0 || checkResults[0].dealer_id !== dealerId) {
            return res.status(403).json({ success: false, message: 'You do not have permission to assign a delivery boy to this order.' });
        }

        // Update order by assigning delivery boy and keep status as 'accepted'
        const updateQuery = 'UPDATE orders SET delivery_boy_id = ? WHERE id = ? AND status = ?';

        db.query(updateQuery, [deliveryBoyId, orderId, 'accepted'], (err, results) => {
            if (err) {
                console.error('Error assigning delivery boy:', err);
                // Log the detailed error object
                console.error('Database error details:', err);
                return res.status(500).json({ success: false, message: 'Failed to assign delivery boy' });
            }

            if (results.affectedRows === 0) {
                // Check if order exists but is not in accepted status
                 const statusCheckQuery = 'SELECT status FROM orders WHERE id = ?';
                 db.query(statusCheckQuery, [orderId], (statusCheckErr, statusCheckResults) => {
                     if(statusCheckErr) {
                          console.error('Error checking order status after failed assignment:', statusCheckErr);
                          return res.status(500).json({ success: false, message: 'Failed to check order status after assignment attempt' });
                     }
                     if (statusCheckResults.length > 0) {
                          return res.status(400).json({ success: false, message: `Order not in accepted status (current status: ${statusCheckResults[0].status})` });
                     } else {
                          return res.status(404).json({ success: false, message: 'Order not found' });
                     }
                 });

            } else {
                 res.json({ success: true, message: 'Delivery boy assigned successfully (awaiting delivery boy acceptance)' });
            }
        });
    });
});

// Get assigned orders for a delivery boy (Protected - Delivery Boy only)
app.get('/api/delivery-boy/get-orders', isAuthenticated, isUserType('delivery_boy'), (req, res) => {
    const deliveryBoyId = req.session.userId; // Get delivery boy ID from session

    const query = `
        SELECT o.*, c.name as customer_name, c.phone as customer_phone, fs.name as station_name, fs.address as station_address
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        JOIN fuel_stations fs ON o.station_id = fs.id
        WHERE o.delivery_boy_id = ? AND (o.status = 'accepted' OR o.status = 'in-progress' OR o.status = 'delivered' OR o.status = 'cancelled')
        ORDER BY o.created_at DESC`;

    db.query(query, [deliveryBoyId], (err, results) => {
        if (err) {
            console.error('Error fetching delivery boy orders:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch orders' });
        }

        res.json({ success: true, orders: results });
    });
});

// Delivery boy accepts order (Protected - Delivery Boy only)
app.post('/api/delivery-boy/accept-order', isAuthenticated, isUserType('delivery_boy'), (req, res) => {
    const { orderId } = req.body;
    const deliveryBoyId = req.session.userId; // Get delivery boy ID from session

    const query = 'UPDATE orders SET status = ? WHERE id = ? AND delivery_boy_id = ? AND (status = ? OR status = ?)'; // Allow accepting from 'accepted' or 'in-progress'

    db.query(query, ['in-progress', orderId, deliveryBoyId, 'accepted', 'in-progress'], (err, results) => {
        if (err) {
            console.error('Error accepting order:', err);
            return res.status(500).json({ success: false, message: 'Failed to accept order' });
        }

        if (results.affectedRows === 0) {
             return res.status(400).json({ success: false, message: 'Order not found, not assigned to you, or cannot be accepted at this status' });
        } else {
            res.json({ success: true, message: 'Order accepted' });
        }
    });
});

// Delivery boy rejects order (Protected - Delivery Boy only)
app.post('/api/delivery-boy/reject-order', isAuthenticated, isUserType('delivery_boy'), (req, res) => {
    const { orderId } = req.body;
    const deliveryBoyId = req.session.userId; // Get delivery boy ID from session

    // Update order status to 'accepted' and remove delivery boy assignment
    const query = 'UPDATE orders SET status = ?, delivery_boy_id = NULL WHERE id = ? AND delivery_boy_id = ? AND status = ?';

    db.query(query, ['accepted', orderId, deliveryBoyId, 'in-progress'], (err, results) => {
        if (err) {
            console.error('Error rejecting order:', err);
            return res.status(500).json({ success: false, message: 'Failed to reject order' });
        }

        if (results.affectedRows === 0) {
             return res.status(400).json({ success: false, message: 'Order not found, not assigned to you, or cannot be rejected at this status' });
        } else {
            res.json({ success: true, message: 'Order rejected' });
        }
    });
});

// Delivery boy updates order status (Protected - Delivery Boy only)
app.post('/api/delivery-boy/update-order-status', isAuthenticated, isUserType('delivery_boy'), (req, res) => {
    const { orderId, status } = req.body;
    const deliveryBoyId = req.session.userId; // Get delivery boy ID from session

    // Basic validation
    if (!orderId || !status) {
        return res.status(400).json({ success: false, message: 'Missing orderId or status' });
    }

    // Allow updating status only from 'in-progress' to 'delivered'
    if (status !== 'delivered') {
        return res.status(400).json({ success: false, message: 'Invalid status update' });
    }

    const query = 'UPDATE orders SET status = ? WHERE id = ? AND delivery_boy_id = ? AND status = ?';

    db.query(query, [status, orderId, deliveryBoyId, 'in-progress'], (err, results) => {
        if (err) {
            console.error('Error updating order status:', err);
            return res.status(500).json({ success: false, message: 'Failed to update order status' });
        }

        if (results.affectedRows === 0) {
             // Check if order exists and is assigned to this delivery boy, but maybe not in-progress
             const checkQuery = 'SELECT id, status FROM orders WHERE id = ? AND delivery_boy_id = ?';
             db.query(checkQuery, [orderId, deliveryBoyId], (checkErr, checkResults) => {
                  if (checkErr) {
                      console.error('Error checking order status for update:', checkErr);
                      return res.status(500).json({ success: false, message: 'Failed to check order status' });
                  }
                  if (checkResults.length > 0) {
                       if (checkResults[0].status === 'delivered'){
                           return res.status(400).json({ success: false, message: 'Order is already marked as delivered' });
                       } else {
                           return res.status(400).json({ success: false, message: `Order is not in a status that allows updating to \'delivered\' (current status: ${checkResults[0].status})` });
                       }
                  } else {
                      return res.status(404).json({ success: false, message: 'Order not found or not assigned to you' });
                  }
             });
        } else {
            res.json({ success: true, message: 'Order status updated successfully' });
        }
    });
});

// Place new order (Customer) (Protected - Customer only)
app.post('/api/place-order', isAuthenticated, isUserType('customer'), async (req, res) => {
    const { fuelType, quantity, deliveryAddress, stationId } = req.body;
    const customerId = req.session.userId; // Get customer ID from session

    if (!fuelType || !quantity || !deliveryAddress || !stationId) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (quantity <= 0) {
        return res.status(400).json({ success: false, message: 'Quantity must be positive' });
    }

    try {
        // Fetch the price for the selected station and fuel type
        const priceQuery = `SELECT ${fuelType}_price FROM fuel_prices WHERE station_id = ?`;
        const [priceResults] = await db.promise().query(priceQuery, [stationId]);

        if (priceResults.length === 0) {
            return res.status(404).json({ success: false, message: 'Price information not found for selected station and fuel type' });
        }

        const price = priceResults[0][`${fuelType}_price`];
        if (price === undefined || price === null) {
             return res.status(500).json({ success: false, message: 'Could not retrieve price for selected fuel type' });
        }

        const totalAmount = price * quantity;

        // Insert the order into the database
        const orderQuery = `INSERT INTO orders (customer_id, station_id, fuel_type, quantity, total_amount, delivery_address, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const orderValues = [customerId, stationId, fuelType, quantity, totalAmount, deliveryAddress, 'pending'];

        await db.promise().query(orderQuery, orderValues);

        res.json({ success: true, message: 'Order placed successfully' });

    } catch (err) {
        console.error('Error placing order:', err);
        res.status(500).json({ success: false, message: 'Failed to place order' });
    }
});

// Submit customer feedback (Protected - Customer only)
app.post('/api/customer/submit-feedback', isAuthenticated, isUserType('customer'), (req, res) => {
    const customerId = req.session.userId; // Get customer ID from session
    const { feedbackMessage } = req.body;

    if (!feedbackMessage) {
        return res.status(400).json({ success: false, message: 'Feedback message is required.' });
    }

    const query = 'INSERT INTO feedback (customer_id, feedback_text) VALUES (?, ?)';

    db.query(query, [customerId, feedbackMessage], (err, results) => {
        if (err) {
            console.error('Error submitting feedback:', err);
            return res.status(500).json({ success: false, message: 'Failed to submit feedback.' });
        }

        res.json({ success: true, message: 'Feedback submitted successfully!' });
    });
});

// Get feedback for dealers (Protected - Dealer only)
app.get('/api/dealer/get-feedback', isAuthenticated, isUserType('dealer'), (req, res) => {
    // Fetch all feedback, joining with customers to get customer name
    const query = `
        SELECT f.*, c.name as customer_name
        FROM feedback f
        JOIN customers c ON f.customer_id = c.id
        ORDER BY f.created_at DESC`;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching feedback:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch feedback.' });
        }

        res.json({ success: true, feedback: results });
    });
});

// Get all fuel stations (Can be accessed by anyone)
app.get('/api/get-all-stations', (req, res) => {
    const query = 'SELECT fs.id, fs.name, fs.address, fs.city, fs.state, fs.pincode, fp.petrol_price, fp.diesel_price, fp.cng_price FROM fuel_stations fs JOIN fuel_prices fp ON fs.id = fp.station_id';

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching all stations with prices:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch stations with prices' });
        }

        res.json({ success: true, stations: results });
    });
});

// Get fuel stations by address (Can be accessed by anyone)
app.get('/api/get-stations-by-address', (req, res) => {
    const { city, state, pincode } = req.query; // Get address details from query parameters

    if (!city || !state || !pincode) {
        return res.status(400).json({ success: false, message: 'City, state, and pincode are required for station search.' });
    }

    // Query to find stations matching city, state, and pincode, joining with fuel_prices and dealers
    const query = `
        SELECT fs.id, fs.name, fs.address, fs.city, fs.state, fs.pincode, fp.petrol_price, fp.diesel_price, fp.cng_price, d.phone as dealer_phone
        FROM fuel_stations fs
        JOIN fuel_prices fp ON fs.id = fp.station_id
        JOIN dealers d ON fs.dealer_id = d.id
        WHERE fs.city = ? AND fs.state = ? AND fs.pincode = ?`;

    db.query(query, [city, state, pincode], (err, results) => {
        if (err) {
            console.error('Error fetching stations by address:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch stations.' });
        }

        res.json({ success: true, stations: results });
    });
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

// HTML Routes (placed after static file serving)

// Serve login page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve registration page
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Serve dealer dashboard
app.get('/dealer-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dealer-dashboard.html'));
});

// Serve customer dashboard
app.get('/customer-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer-dashboard.html'));
});

// Serve delivery boy dashboard
app.get('/delivery-dashboard', isAuthenticated, isUserType('delivery_boy'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'delivery-dashboard.html'));
});

// Handle logout
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ success: false, message: 'Failed to log out.' });
        }
        res.json({ success: true, message: 'Logged out successfully.' });
    });
});

// Update Customer Profile (Protected - Customer only)
app.put('/api/customer/update-profile', isAuthenticated, isUserType('customer'), (req, res) => {
    const customerId = req.session.userId; // Get customer ID from session
    const { name, phone, address, city, state, pincode } = req.body;

    // Basic validation (you might want more robust validation)
    if (!name || !phone || !address || !city || !state || !pincode) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const query = 'UPDATE customers SET name = ?, phone = ?, address = ?, city = ?, state = ?, pincode = ? WHERE id = ?';

    db.query(query, [name, phone, address, city, state, pincode, customerId], (err, results) => {
        if (err) {
            console.error('Error updating customer profile:', err);
            return res.status(500).json({ success: false, message: 'Failed to update profile.' });
        }

         if (results.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Customer not found.' });
        }

        res.json({ success: true, message: 'Customer profile updated successfully!' });
    });
});

// Update Dealer Profile (Protected - Dealer only)
app.put('/api/dealer/update-profile', isAuthenticated, isUserType('dealer'), (req, res) => {
    const dealerId = req.session.userId; // Get dealer ID from session
    const { name, phone } = req.body; // Assuming dealers only update name and phone

     // Basic validation
    if (!name || !phone) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const query = 'UPDATE dealers SET name = ?, phone = ? WHERE id = ?';

    db.query(query, [name, phone, dealerId], (err, results) => {
        if (err) {
            console.error('Error updating dealer profile:', err);
            return res.status(500).json({ success: false, message: 'Failed to update profile.' });
        }

         if (results.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Dealer not found.' });
        }

        res.json({ success: true, message: 'Dealer profile updated successfully!' });
    });
});

// Update Delivery Boy Profile (Protected - Delivery Boy only)
app.put('/api/delivery-boy/update-profile', isAuthenticated, isUserType('delivery_boy'), (req, res) => {
    const deliveryBoyId = req.session.userId; // Get delivery boy ID from session
    const { name, phone } = req.body; // Assuming delivery boys only update name and phone

     // Basic validation
    if (!name || !phone) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const query = 'UPDATE delivery_boys SET name = ?, phone = ? WHERE id = ?';

    db.query(query, [name, phone, deliveryBoyId], (err, results) => {
        if (err) {
            console.error('Error updating delivery boy profile:', err);
            return res.status(500).json({ success: false, message: 'Failed to update profile.' });
        }

        if (results.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Delivery boy not found.' });
        }

        res.json({ success: true, message: 'Delivery boy profile updated successfully!' });
    });
});

// Get Customer Profile (Protected - Customer only)
app.get('/api/customer/profile', isAuthenticated, isUserType('customer'), (req, res) => {
    const customerId = req.session.userId; // Get customer ID from session

    const query = 'SELECT name, email, phone, address, city, state, pincode FROM customers WHERE id = ?';

    db.query(query, [customerId], (err, results) => {
        if (err) {
            console.error('Error fetching customer profile:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
        }

        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Customer not found.' });
        }

        res.json({ success: true, profile: results[0] });
    });
});

// Get Dealer Profile (Protected - Dealer only)
app.get('/api/dealer/profile', isAuthenticated, isUserType('dealer'), (req, res) => {
    const dealerId = req.session.userId; // Get dealer ID from session

    const query = 'SELECT name, email, phone FROM dealers WHERE id = ?'; // Assuming dealers only have name, email, phone

    db.query(query, [dealerId], (err, results) => {
        if (err) {
            console.error('Error fetching dealer profile:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
        }

        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Dealer not found.' });
        }

        res.json({ success: true, profile: results[0] });
    });
});

// Get Delivery Boy Profile (Protected - Delivery Boy only)
app.get('/api/delivery-boy/profile', isAuthenticated, isUserType('delivery_boy'), (req, res) => {
    const deliveryBoyId = req.session.userId; // Get delivery boy ID from session

    const query = 'SELECT name, email, phone FROM delivery_boys WHERE id = ?'; // Assuming delivery boys only have name, email, phone

    db.query(query, [deliveryBoyId], (err, results) => {
        if (err) {
            console.error('Error fetching delivery boy profile:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
        }

        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Delivery boy not found.' });
        }

        res.json({ success: true, profile: results[0] });
    });
});

// Cancel Customer Order (Protected - Customer only)
app.post('/api/customer/cancel-order', isAuthenticated, isUserType('customer'), (req, res) => {
    const customerId = req.session.userId; // Get customer ID from session
    const { orderId } = req.body;

    // Basic validation
    if (!orderId) {
        return res.status(400).json({ success: false, message: 'Missing orderId.' });
    }

    // Update order status to 'cancelled', ensuring it belongs to the customer and is in 'pending' status
    const query = 'UPDATE orders SET status = ? WHERE id = ? AND customer_id = ? AND status = ?';

    db.query(query, ['cancelled', orderId, customerId, 'pending'], (err, results) => {
        if (err) {
            console.error('Error cancelling order:', err);
            return res.status(500).json({ success: false, message: 'Failed to cancel order.' });
        }

        if (results.affectedRows === 0) {
            // Check if the order exists and belongs to the customer, but is not in pending status
            const checkQuery = 'SELECT id, status FROM orders WHERE id = ? AND customer_id = ?';
            db.query(checkQuery, [orderId, customerId], (checkErr, checkResults) => {
                 if (checkErr) {
                     console.error('Error checking order status for cancellation:', checkErr);
                     return res.status(500).json({ success: false, message: 'Failed to check order status.' });
                 }
                 if (checkResults.length > 0) {
                      return res.status(400).json({ success: false, message: `Order cannot be cancelled at this status (current status: ${checkResults[0].status}).` });
                 } else {
                     return res.status(404).json({ success: false, message: 'Order not found or does not belong to you.' });
                 }
            });
        } else {
            res.json({ success: true, message: 'Order cancelled successfully!' });
        }
    });
});

// Get delivery boy details and statistics (Protected - Dealer only)
app.get('/api/dealer/get-delivery-boy-details/:deliveryBoyId', isAuthenticated, isUserType('dealer'), async (req, res) => {
    const deliveryBoyId = req.params.deliveryBoyId;

    try {
        // Get delivery boy personal information
        const deliveryBoyQuery = 'SELECT name, email, phone FROM delivery_boys WHERE id = ?';
        const [deliveryBoy] = await db.promise().query(deliveryBoyQuery, [deliveryBoyId]);

        if (deliveryBoy.length === 0) {
            return res.status(404).json({ success: false, message: 'Delivery boy not found' });
        }

        // Get delivery boy statistics
        const statsQuery = `
            SELECT 
                COUNT(*) as totalDeliveries,
                SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as completedDeliveries,
                MAX(CASE WHEN status = 'delivered' THEN created_at END) as lastDelivery,
                SUM(CASE WHEN status IN ('accepted', 'in-progress') THEN 1 ELSE 0 END) as activeOrders
            FROM orders 
            WHERE delivery_boy_id = ?`;

        const [stats] = await db.promise().query(statsQuery, [deliveryBoyId]);

        // Calculate success rate
        const successRate = stats[0].totalDeliveries > 0 
            ? Math.round((stats[0].completedDeliveries / stats[0].totalDeliveries) * 100) 
            : 0;

        res.json({
            success: true,
            deliveryBoy: deliveryBoy[0],
            stats: {
                totalDeliveries: stats[0].totalDeliveries,
                completedDeliveries: stats[0].completedDeliveries,
                successRate: successRate,
                lastDelivery: stats[0].lastDelivery ? new Date(stats[0].lastDelivery).toLocaleString() : null,
                activeOrders: stats[0].activeOrders
            }
        });
    } catch (error) {
        console.error('Error fetching delivery boy details:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch delivery boy details' });
    }
});

// Get customer's orders (Protected - Customer only)
app.get('/api/customer/get-orders', isAuthenticated, isUserType('customer'), (req, res) => {
    const customerId = req.session.userId; // Get customer ID from session

    const query = `
        SELECT o.*, fs.name as station_name, db.name as delivery_boy_name, db.phone as delivery_boy_phone
        FROM orders o
        JOIN fuel_stations fs ON o.station_id = fs.id
        LEFT JOIN delivery_boys db ON o.delivery_boy_id = db.id
        WHERE o.customer_id = ?
        ORDER BY o.created_at DESC`;

    db.query(query, [customerId], (err, results) => {
        if (err) {
            console.error('Error fetching customer orders:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch orders' });
        }

        res.json({ success: true, orders: results });
    });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 