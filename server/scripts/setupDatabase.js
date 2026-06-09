// Database Setup Script for BMU AI Academic Advisor
// Creates the schema, then applies every migration_*.sql file in lexicographic order.
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// MAMP default port differs by OS: 8889 on macOS, 3306 on Windows.
const isWindows = process.platform === 'win32';
const defaultPort = isWindows ? '3306' : '8889';

const connection = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || defaultPort, 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    multipleStatements: true
});

const query = (sql, params) => new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => err ? reject(err) : resolve(results));
});

async function setupDatabase() {
    console.log('🚀 Starting BMU AI Academic Advisor database setup...\n');

    const dbName = process.env.DB_NAME || 'bmu_academic_advisor';
    const scriptsDir = __dirname;

    try {
        await new Promise((resolve, reject) => {
            connection.connect((err) => {
                if (err) {
                    console.error('❌ Failed to connect to MySQL:', err.message);
                    console.error(`   Host: ${connection.config.host}:${connection.config.port}`);
                    return reject(err);
                }
                console.log(`✅ Connected to MySQL server (${connection.config.host}:${connection.config.port})`);
                resolve();
            });
        });

        // 1. Base schema
        const schemaPath = path.join(scriptsDir, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await query(schema);
        console.log('✅ Base schema applied (schema.sql)');

        // 2. Migrations: every migration_*.sql in lex order
        const migrationFiles = fs.readdirSync(scriptsDir)
            .filter(f => /^migration_.+\.sql$/i.test(f))
            .sort();

        for (const file of migrationFiles) {
            const sql = fs.readFileSync(path.join(scriptsDir, file), 'utf8').trim();
            if (!sql) continue;
            try {
                await query(`USE \`${dbName}\``);
                await query(sql);
                console.log(`✅ Applied ${file}`);
            } catch (e) {
                // Migrations are intentionally idempotent. Tolerate duplicate-column / table errors.
                if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_TABLE_EXISTS_ERROR') {
                    console.log(`⏭️  Skipped ${file} (already applied: ${e.code})`);
                } else {
                    console.error(`❌ Migration ${file} failed:`, e.message);
                    throw e;
                }
            }
        }

        // 3. Seed / reset the default superadmin
        const defaultEmail = 'bmuapps@bmu.edu.ng';
        const defaultPassword = 'Admin@123';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        await query(
            `UPDATE \`${dbName}\`.users SET password = ? WHERE email = ?`,
            [hashedPassword, defaultEmail]
        );
        console.log('✅ Default superadmin password reset');
        console.log(`   Email: ${defaultEmail}`);
        console.log('   Password: Admin@123 (CHANGE THIS IN PRODUCTION!)');

        // 4. Ensure runtime directories exist
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
