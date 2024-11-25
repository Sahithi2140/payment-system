const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const session = require('express-session');
const app = express();
const cors = require('cors');
const PORT = process.env.PORT || 3000;

// PostgreSQL pool configuration
const pool = new Pool({
    user: 'postgres',         // Replace with your PostgreSQL user
    host: 'localhost',
    database: 'payment_system',
    password: '123456',       // Replace with your PostgreSQL password
    port: 5432,
});

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.use(session({
  secret: 'bank-employee-secret',
  resave: false,
  saveUninitialized: true,
}));

app.use(cors());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Route to serve the landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Signup route with error handling for `address` array formatting
// Signup route with transaction history on user creation
app.post('/signup', async (req, res) => {
  const { username, date_of_birth, phone_number, address, account_number, upi_pin } = req.body;

  try {
    await pool.query('BEGIN');

    // Insert user into accounts.users
    await pool.query(
      `INSERT INTO accounts.users (username, date_of_birth, phone_number, address, account_number, upi_pin)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [username, date_of_birth, phone_number, address, account_number, upi_pin]
      
    );

    // Insert initial balance into accounts.transactions and create the transaction history
    const initialHistory = [
      {
        type: "Received",
        amount: 1000, // initial balance
        date: new Date().toISOString(),
        balanceAfter: 1000
      }
    ];

    const historyJSON = JSON.stringify(initialHistory);

    await pool.query(
      `INSERT INTO accounts.transactions (account_number, balance, history)
       VALUES ($1, $2, $3)`,
      [account_number, 1000, historyJSON]
    
    );

    await pool.query('COMMIT');
    res.status(201).json({ success: true, message: 'User registered successfully.' });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error during registration:', error);
    res.status(500).json({ success: false, message: 'Registration failed.' });
  }
});

// Login route (submit route)
app.post('/submit', async (req, res) => {
  const { account_number, upi_pin } = req.body;

  try {
    // Query the database to check if the account_number and upi_pin match a user
    const result = await pool.query(
      'SELECT username FROM accounts.users WHERE account_number = $1 AND upi_pin = $2',
      [account_number, upi_pin]
    );

    if (result.rows.length > 0) {
      // User authenticated, render the log page and pass the username
      req.session.account_number = account_number;
      const username = result.rows[0].username;
      res.render('pages/log', { username: username });
    } else {
      // Incorrect credentials, send an error message
      res.send('<script>alert("Incorrect credentials, try signing up."); window.location.href = "/login";</script>');
    }
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Search for account number
app.post('/search', async (req, res) => {
  const { account_number } = req.body;

  try {
    const result = await pool.query(
      'SELECT username FROM accounts.users WHERE account_number = $1',
      [account_number]
    );

    if (result.rows.length > 0) {
      res.json({ exists: true, username: result.rows[0].username });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error searching for account:', error);
    res.status(500).json({ exists: false, message: 'Internal Server Error' });
  }
});

// Pay amount to the searched account
app.post('/pay', async (req, res) => {
  const { account_number, amount, upi_pin } = req.body;
  const senderAccountNumber = req.session.account_number;
  const transferAmount = parseFloat(amount);

  try {
    await pool.query('BEGIN');

    // Verify UPI PIN
    const userResult = await pool.query(
      'SELECT upi_pin FROM accounts.users WHERE account_number = $1',
      [senderAccountNumber]
    );

    if (userResult.rows.length === 0 || userResult.rows[0].upi_pin !== upi_pin) {
      throw new Error('Invalid UPI PIN.');
    }

    // Check sender's balance
    const senderBalanceResult = await pool.query(
      'SELECT balance, history FROM accounts.transactions WHERE account_number = $1 FOR UPDATE',
      [senderAccountNumber]
    );

    if (senderBalanceResult.rows.length === 0) {
      throw new Error('Sender account not found.');
    }

    const senderBalance = parseFloat(senderBalanceResult.rows[0].balance);

    if (senderBalance < transferAmount) {
      throw new Error('Insufficient balance.');
    }

    // Add entry to sender's history
    const senderHistory = senderBalanceResult.rows[0].history;
    const updatedSenderHistory = JSON.parse(senderHistory || '[]');
    updatedSenderHistory.push({
      type: 'Sent',
      amount: transferAmount,
      date: new Date().toISOString(), // Adding date of transaction
      balanceAfter: senderBalance - transferAmount
    });

    await pool.query(
      'UPDATE accounts.transactions SET balance = balance - $1, history = $2 WHERE account_number = $3',
      [transferAmount, JSON.stringify(updatedSenderHistory), senderAccountNumber]
    );

    // Add entry to receiver's history
    const receiverBalanceResult = await pool.query(
      'SELECT balance, history FROM accounts.transactions WHERE account_number = $1 FOR UPDATE',
      [account_number]
    );

    if (receiverBalanceResult.rows.length === 0) {
      throw new Error('Receiver account not found.');
    }

    const receiverBalance = parseFloat(receiverBalanceResult.rows[0].balance);
    const updatedReceiverHistory = JSON.parse(receiverBalanceResult.rows[0].history || '[]');
    updatedReceiverHistory.push({
      type: 'Received',
      amount: transferAmount,
      date: new Date().toISOString(), // Adding date of transaction
      balanceAfter: receiverBalance + transferAmount
    });

    await pool.query(
      'UPDATE accounts.transactions SET balance = balance + $1, history = $2 WHERE account_number = $3',
      [transferAmount, JSON.stringify(updatedReceiverHistory), account_number]
    );

    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error processing payment:', error);
    res.json({ success: false, message: error.message });
  }
});

// Retrieve user balance
app.get('/user-balance', async (req, res) => {
  const accountNumber = req.session.account_number;

  try {
    const balanceResult = await pool.query(
      'SELECT balance FROM accounts.transactions WHERE account_number = $1',
      [accountNumber]
    );

    if (balanceResult.rows.length > 0) {
      const balance = balanceResult.rows[0].balance;
      // Render the balance.ejs page and pass the balance variable to it
      res.render('pages/balance', { balance: balance });
    } else {
      res.render('balance', { error: 'Account not found.' });
    }
  } catch (error) {
    console.error('Error retrieving balance:', error);
    res.render('balance', { error: 'Error retrieving balance.' });
  }
});

// Retrieve user transaction history
app.get('/user-history', async (req, res) => {
  const accountNumber = req.session.account_number;

  try {
    // Retrieve the transaction data for the logged-in account
    const historyResult = await pool.query(
      'SELECT * FROM accounts.transactions WHERE account_number = $1',
      [accountNumber]
    );

    // Ensure that we parse the history field from text to JSON
    const transactions = historyResult.rows.map(row => {
      // Check if the history is valid, otherwise default to an empty array
      let parsedHistory = [];
      try {
        parsedHistory = JSON.parse(row.history || '[]');
      } catch (e) {
        console.error("Error parsing history JSON:", e);
      }

      return {
        account_number: row.account_number,
        balance: row.balance,
        history: parsedHistory // Parsed history data
      };
    });

    // Render the history page with the transactions data
    res.render('pages/history', { transactions });
  } catch (error) {
    console.error('Error retrieving transaction history:', error);
    res.render('pages/history', { error: 'Error retrieving transaction history.' });
  }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

