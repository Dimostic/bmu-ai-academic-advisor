const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Import routes
const userRoutes = require('./routes/userRoutes');
const chatRoutes = require('./routes/chatRoutes');
const documentRoutes = require('./routes/documentRoutes');
const exportRoutes = require('./routes/exportRoutes');
const adminRoutes = require('./routes/adminRoutes');
const ragRoutes = require('./routes/ragRoutes');
const faqRoutes = require('./routes/faqRoutes');
const vcReportRoutes = require('./routes/vcReportRoutes');
const vcDocumentRoutes = require('./routes/vcDocumentRoutes');
const advisorRoutes = require('./routes/advisorRoutes');

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCES_DIR = path.join(__dirname, '../sources');

function buildPublicationRecord(name, stat) {
    const ext = path.extname(name).slice(1).toLowerCase();
    const previewable = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
    const normalized = name.toLowerCase();
    const yearMatches = normalized.match(/20\d{2}/g) || [];
    const newestYear = yearMatches.length ? Number(yearMatches[yearMatches.length - 1]) : 0;

    return {
        name,
        ext,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        previewable,
        newestYear,
        viewUrl: `/api/publications/file?name=${encodeURIComponent(name)}`,
        downloadUrl: `/api/publications/file?name=${encodeURIComponent(name)}&download=1`
    };
}

function pickLatestPublication(list, pattern) {
    const matches = list.filter(item => pattern.test(item.name));
    if (!matches.length) return null;
    matches.sort((a, b) => {
        if (b.newestYear !== a.newestYear) return b.newestYear - a.newestYear;
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });
    return matches[0];
}

// Trust nginx reverse proxy (required for correct client IP + express-rate-limit behind proxy)
if (process.env.NODE_ENV === 'production') {
    // 1 hop: nginx -> node
    app.set('trust proxy', 1);
}

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            // Allow unsafe-inline for scripts to support onclick handlers in dynamically generated HTML
            // and the Lottie CDN used by the advisor page (optional avatar).
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            // Allow unsafe-inline for styles to support dynamic document content from mammoth
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            // Allow TTSMaker audio URLs + data/blob for in-page audio playback.
            // TTSMaker rotates host suffixes (ttsmaker-vip-file.com, ttsmaker-file*.com,
            // and the *.ttsmaker.com / *.ttsmaker.net domains), so we whitelist the
            // family with broad wildcards.
            mediaSrc: [
                "'self'", "data:", "blob:",
                "https://*.ttsmaker.com",
                "https://*.ttsmaker.net",
                "https://*.ttsmaker-file.com",
                "https://*.ttsmaker-file2.com",
                "https://*.ttsmaker-vip-file.com"
            ],
            // Same-origin fetch + WebSockets + external stylesheet/script fetches by the service worker / advisor page.
            connectSrc: ["'self'", "ws:", "wss:", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        },
    },
    crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://bmu.edu.ng', 'https://agent.bmu.edu.ng'] 
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting - general API
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200, // Increased from 100
    message: {
        success: false,
        error: 'Too many requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for certain paths
    skip: (req) => {
        // Don't rate limit export downloads (auth is checked separately)
        return req.path.includes('/exports/download/');
    }
});

// Stricter rate limit for auth routes to prevent brute force
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 login attempts per 15 minutes
    message: {
        success: false,
        error: 'Too many login attempts, please try again in 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);
app.use('/api/users/login', authLimiter);
app.use('/api/users/register', authLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve icon/logo from project root BEFORE express.static (otherwise SPA fallback/static ordering can return HTML)
app.get('/bmulogo.png', (req, res) => {
    res.type('png');
    res.sendFile(path.join(__dirname, '../bmulogo.png'));
});

// Page routes — explicit routes registered BEFORE express.static so they win
// over any same-name file in client/. The actual auth gating is enforced on
// the API side; the client also redirects to /login when no token exists.
//
//   /          -> public marketing landing (with FAQ teaser)
//   /login     -> sign-in form
//   /register  -> account creation form (auto-approves @bmu.edu.ng)
//   /advisor   -> the talking advisor (login required client-side)
//   /admin     -> advisor-styled admin portal (admin role required client-side)
//   /legacy    -> the inherited assistant SPA (kept for backwards compat)
app.get(['/', '/landing'], (req, res) => {
    res.sendFile(path.join(__dirname, '../client/landing.html'));
});
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/login.html'));
});
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/register.html'));
});
app.get('/calendar-yearbook', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/calendar-yearbook.html'));
});
app.get('/advisor', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/advisor.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/admin.html'));
});
app.get('/handbook', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/handbook.html'));
});
app.get('/change-password', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/change-password.html'));
});
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/reset-password.html'));
});
app.get('/verify-email', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/verify-email.html'));
});
app.get(['/legacy', '/legacy/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Serve static files (client)
app.use(express.static(path.join(__dirname, '../client'), {
    etag: true,
    lastModified: true,
    immutable: false,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
        // Ensure correct MIME types for PWA assets
        if (filePath.endsWith('.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
        }
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        }
        if (filePath.endsWith('.png')) {
            res.setHeader('Content-Type', 'image/png');
        }
        if (filePath.endsWith('.ico')) {
            res.setHeader('Content-Type', 'image/x-icon');
        }
        // Prevent MIME sniffing issues in some browsers
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// Explicit static routes for icons/images referenced by manifest and HTML
app.get(['/bmulogo.png'], (req, res) => {
    res.type('png');
    res.sendFile(path.join(__dirname, '../bmulogo.png'));
});

// Serve generated MP3 files (Edge TTS / cached audio). The directory is
// created on demand by edgeTtsService when the first synthesis runs.
app.use('/uploads/audio',
    express.static(path.join(__dirname, '../uploads/audio'), {
        maxAge: '7d',
        setHeaders(res, filePath) {
            if (filePath.endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            }
        }
    }));

// Ensure PWA assets are served (avoid SPA fallback edge cases)
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, '../client/manifest.webmanifest'));
});

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// Public file catalogue for annual publications (calendar/yearbook).
// Reads from /sources on every request so staff can replace files each
// session without redeploying code.
app.get('/api/publications/annual', async (req, res) => {
    try {
        const dirItems = await fs.promises.readdir(SOURCES_DIR, { withFileTypes: true });
        const fileNames = dirItems.filter(d => d.isFile()).map(d => d.name);

        const fileStats = await Promise.all(fileNames.map(async (name) => {
            const stat = await fs.promises.stat(path.join(SOURCES_DIR, name));
            return buildPublicationRecord(name, stat);
        }));

        const calendar = pickLatestPublication(
            fileStats,
            /(academic\s*)?calendar|sessional\s*calendar/i
        );
        const yearbook = pickLatestPublication(
            fileStats,
            /yearbook|handbook/i
        );

        res.json({
            success: true,
            calendar,
            yearbook,
            totalFiles: fileStats.length,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Annual publications listing error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Could not load annual publications.'
        });
    }
});

// Safe file-serving endpoint restricted to /sources.
app.get('/api/publications/file', async (req, res) => {
    try {
        const requestedName = String(req.query.name || '').trim();
        const safeName = path.basename(requestedName);
        if (!safeName || safeName !== requestedName) {
            return res.status(400).json({ success: false, error: 'Invalid file name' });
        }

        const fullPath = path.join(SOURCES_DIR, safeName);
        await fs.promises.access(fullPath, fs.constants.R_OK);

        if (String(req.query.download || '') === '1') {
            return res.download(fullPath, safeName);
        }
        res.sendFile(fullPath);
    } catch (error) {
        res.status(404).json({ success: false, error: 'File not found' });
    }
});

// API Routes
app.use('/api/users', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/faq', faqRoutes);
app.use('/api/vc-reports', vcReportRoutes);
app.use('/api/vc-documents', vcDocumentRoutes);
app.use('/api/advisor', advisorRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'operational',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Public settings endpoint
app.get('/api/settings/public', async (req, res) => {
    try {
        const { query } = require('../config/db');
        const settings = await query(`
            SELECT setting_key, setting_value
            FROM system_settings
            WHERE is_public = TRUE
        `);
        
        const settingsObject = {};
        settings.forEach(s => {
            settingsObject[s.setting_key] = s.setting_value;
        });
        
        res.json({
            success: true,
            settings: settingsObject
        });
    } catch (error) {
        res.json({
            success: true,
            settings: {
                app_name: 'BMU AI Agent',
                university_name: 'Bayelsa Medical University',
                university_motto: 'Training Healthcare Professionals for Excellence'
            }
        });
    }
});

// Serve frontend for all other non-API routes (SPA support).
// Primary page routes are mounted earlier (before express.static). The
// catch-all below covers deep links and unknown paths.
app.get('*', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    if (req.path === '/uploads' || req.path.startsWith('/uploads/')) return next();
    if (path.extname(req.path)) return next();
    if (req.path.startsWith('/legacy/')) {
        return res.sendFile(path.join(__dirname, '../client/index.html'));
    }
    if (req.path.startsWith('/admin'))    return res.sendFile(path.join(__dirname, '../client/admin.html'));
    if (req.path.startsWith('/advisor'))  return res.sendFile(path.join(__dirname, '../client/advisor.html'));
    if (req.path.startsWith('/login'))    return res.sendFile(path.join(__dirname, '../client/login.html'));
    if (req.path.startsWith('/register')) return res.sendFile(path.join(__dirname, '../client/register.html'));
    if (req.path.startsWith('/calendar-yearbook')) return res.sendFile(path.join(__dirname, '../client/calendar-yearbook.html'));
    if (req.path.startsWith('/reset-password')) return res.sendFile(path.join(__dirname, '../client/reset-password.html'));
    if (req.path.startsWith('/verify-email')) return res.sendFile(path.join(__dirname, '../client/verify-email.html'));
    // Default: marketing landing.
    res.sendFile(path.join(__dirname, '../client/landing.html'));
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production' 
            ? 'An unexpected error occurred' 
            : err.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║          🏥 BMU AI Agent Server Started                  ║
║                                                          ║
║   Bayelsa Medical University Policy Assistant            ║
║                                                          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║   🌐 Server: http://localhost:${PORT}                      ║
║   📚 API:    http://localhost:${PORT}/api                  ║
║   🔧 Mode:   ${process.env.NODE_ENV || 'development'}                           ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);

    // Start cache warming after server is ready
    try {
        const cacheService = require('./services/cacheService');
        cacheService.startCacheWarming({
            intervalMs: 30 * 60 * 1000,  // Every 30 minutes
            popularFAQLimit: 50           // Top 50 FAQs
        });
    } catch (err) {
        console.warn('[App] Cache warming initialization skipped:', err.message);
    }

    // Sync FAISS vector index with database on startup
    // This prevents issues where documents are in DB but missing from search index
    try {
        const vectorStore = require('./services/vectorStore');
        const syncResult = await vectorStore.syncWithDatabase();
        if (syncResult.rebuilt) {
            console.log(`[App] ✅ Vector index rebuilt: ${syncResult.chunks} chunks indexed`);
        }
    } catch (err) {
        console.warn('[App] Vector index sync skipped:', err.message);
    }
});

module.exports = app;
