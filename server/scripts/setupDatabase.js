// Database Setup Script for BMU AI Agent
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const connection = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '8889', 10), // MAMP default
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    multipleStatements: true
});

async function setupDatabase() {
    console.log('🚀 Starting BMU AI Agent Database Setup...\n');

    // Allow overriding database name (defaults to schema.sql value)
    const dbName = process.env.DB_NAME || 'bmu_ai_agent';

    try {
        // Read and execute schema
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        connection.connect((err) => {
            if (err) {
                console.error('❌ Failed to connect to MySQL:', err.message);
                console.error(`   Host: ${connection.config.host}:${connection.config.port}`);
                process.exit(1);
            }
            console.log(`✅ Connected to MySQL server (${connection.config.host}:${connection.config.port})`);
        });

        // Execute schema
        await new Promise((resolve, reject) => {
            connection.query(schema, (err, results) => {
                if (err) {
                    console.error('❌ Error executing schema:', err.message);
                    reject(err);
                } else {
                    console.log('✅ Database schema created successfully');
                    resolve(results);
                }
            });
        });

        // Create default superadmin with proper hashed password
        const defaultEmail = 'bmuapps@bmu.edu.ng';
        const defaultPassword = 'Admin@123';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);
        
        const updateAdminQuery = `
            UPDATE ${dbName}.users 
            SET password = ? 
            WHERE email = ?
        `;

        await new Promise((resolve, reject) => {
            connection.query(updateAdminQuery, [hashedPassword, defaultEmail], (err, results) => {
                if (err) {
                    console.error('❌ Error updating admin password:', err.message);
                    reject(err);
                } else {
                    console.log('✅ Default superadmin account created');
                    console.log(`   Email: ${defaultEmail}`);
                    console.log('   Password: Admin@123 (CHANGE THIS IN PRODUCTION!)');
                    resolve(results);
                }
            });
        });

        // Create necessary directories
        const directories = [
            path.join(__dirname, '../../uploads'),
            path.join(__dirname, '../../uploads/documents'),
            path.join(__dirname, '../../uploads/audio'),
            path.join(__dirname, '../../uploads/exports'),
            path.join(__dirname, '../../logs'),
            path.join(__dirname, '../../vector_store')
        ];

        directories.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`✅ Created directory: ${dir}`);
            }
        });

        console.log('\n🎉 Database setup completed successfully!');
        console.log('\n📝 Next steps:');
        console.log('   1. Update your .env file with proper credentials');
        console.log('   2. Change the default admin password');
        console.log('   3. Run: npm install');
        console.log('   4. Run: npm start');
        
        connection.end();
        process.exit(0);

    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        connection.end();
        process.exit(1);
    }
}

setupDatabase();
