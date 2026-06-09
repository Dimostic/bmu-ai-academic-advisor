/**
 * Script to reprocess existing documents and generate HTML content
 * Run this once after adding the content_html column to regenerate HTML for existing documents
 */

const path = require('path');
const fs = require('fs').promises;
const mammoth = require('mammoth');

// Database connection
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bmu_ai_agent'
};

async function extractHtmlFromWord(filePath) {
  try {
    const result = await mammoth.convertToHtml({ path: filePath });
    return result.value;
  } catch (error) {
    console.error(`Error extracting HTML from ${filePath}:`, error.message);
    return null;
  }
}

async function reprocessDocuments() {
  let connection;
  
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('Connected to database');
    
    // Get all documents
    const [documents] = await connection.execute(
      'SELECT id, filename, file_path FROM documents WHERE status = "processed"'
    );
    
    console.log(`Found ${documents.length} processed documents`);
    
    for (const doc of documents) {
      console.log(`\nProcessing: ${doc.filename}`);
      
      const ext = path.extname(doc.filename).toLowerCase();
      
      if (ext === '.docx' || ext === '.doc') {
        const fullPath = path.join(__dirname, '..', doc.file_path);
        
        try {
          await fs.access(fullPath);
          const html = await extractHtmlFromWord(fullPath);
          
          if (html) {
            await connection.execute(
              'UPDATE documents SET content_html = ? WHERE id = ?',
              [html, doc.id]
            );
            console.log(`  ✓ Updated HTML content (${html.length} chars)`);
          } else {
            console.log(`  ✗ Failed to extract HTML`);
          }
        } catch (err) {
          console.log(`  ✗ File not found: ${fullPath}`);
        }
      } else {
        console.log(`  - Skipping non-Word file (${ext})`);
      }
    }
    
    console.log('\n✓ Reprocessing complete');
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

reprocessDocuments();
