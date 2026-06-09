const mysql = require('mysql');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DB_HOST = process.env.DB_HOST || 'localhost';
// MAMP default: 8889 on macOS, 3306 on Windows MAMP. Override via .env.
const isWindows = process.platform === 'win32';
const DB_PORT = parseInt(process.env.DB_PORT || (isWindows ? '3306' : '8889'), 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || 'root';
const DB_NAME = process.env.DB_NAME || 'bmu_academic_advisor';

// Create connection pool for better performance
const pool = mysql.createPool({
    connectionLimit: 10,
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    timezone: 'UTC',
    acquireTimeout: 30000,
    waitForConnections: true,
    queueLimit: 0
});

// Promisified query function
const query = (sql, params) => {
    return new Promise((resolve, reject) => {
        pool.query(sql, params, (error, results) => {
            if (error) {
                reject(error);
            } else {
                resolve(results);
            }
        });
    });
};

// Test connection on startup
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        console.error(`   Target: mysql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);
        if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('   Check your database username and password');
        } else if (err.code === 'ER_BAD_DB_ERROR') {
            console.error('   Database does not exist. Run: npm run setup-db');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('   Connection refused. Ensure MySQL is running (MAMP) and DB_PORT is correct.');
        }
    } else {
        console.log(`✅ Connected to MySQL Database (Pool) ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
        connection.release();
    }
});

// Handle pool errors
pool.on('error', (err) => {
    console.error('Database pool error:', err.message);
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        console.error('Database connection was closed.');
    }
});

module.exports = { pool, query };