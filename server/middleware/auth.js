const jwt = require('jsonwebtoken');
const User = require('../models/User');

const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'bmu_auth';
const AUTH_MARKER_COOKIE_NAME = process.env.AUTH_MARKER_COOKIE_NAME || 'bmu_auth_present';

const cookieOptions = () => ({
    httpOnly: true,
    secure: (process.env.NODE_ENV || 'development') === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24
});

const markerCookieOptions = () => ({
    httpOnly: false,
    secure: (process.env.NODE_ENV || 'development') === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24
});

const parseCookieHeader = (header = '') => {
    const out = {};
    String(header || '').split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx < 0) return;
        const key = part.slice(0, idx).trim();
        if (!key) return;
        const value = part.slice(idx + 1).trim();
        try { out[key] = decodeURIComponent(value); }
        catch (_) { out[key] = value; }
    });
    return out;
};

const getTokenFromHeader = (req) => {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.split(' ')[1];
};

const getTokenFromCookie = (req) => {
    const cookies = parseCookieHeader(req.headers?.cookie || '');
    const token = cookies[AUTH_COOKIE_NAME];
    return token && String(token).trim() ? String(token).trim() : null;
};

const getTokenFromRequest = (req) => getTokenFromHeader(req) || getTokenFromCookie(req);

const getTokenCandidates = (req, { allowQuery = false } = {}) => {
    const values = [
        ['header', getTokenFromHeader(req)],
        ['cookie', getTokenFromCookie(req)]
    ];
    if (allowQuery) values.push(['query', getTokenFromQuery(req)]);
    const seen = new Set();
    return values
        .filter(([, token]) => token && String(token).trim())
        .map(([source, token]) => [source, String(token).trim()])
        .filter(([, token]) => {
            if (seen.has(token)) return false;
            seen.add(token);
            return true;
        });
};

const getTokenFromQuery = (req) => {
    const token = req.query && req.query.token;
    if (typeof token !== 'string') return null;
    const trimmed = token.trim();
    return trimmed ? trimmed : null;
};

const setAuthCookies = (res, token) => {
    if (!res || typeof res.cookie !== 'function' || !token) return;
    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions());
    res.cookie(AUTH_MARKER_COOKIE_NAME, '1', markerCookieOptions());
};

const clearAuthCookies = (res) => {
    if (!res || typeof res.clearCookie !== 'function') return;
    const base = {
        secure: (process.env.NODE_ENV || 'development') === 'production',
        sameSite: 'lax',
        path: '/'
    };
    res.clearCookie(AUTH_COOKIE_NAME, { ...base, httpOnly: true });
    res.clearCookie(AUTH_MARKER_COOKIE_NAME, { ...base, httpOnly: false });
};

const authenticateFromCandidates = async (req, { allowQuery = false } = {}) => {
    const candidates = getTokenCandidates(req, { allowQuery });
    if (!candidates.length) {
        const error = new Error('Access denied. No token provided.');
        error.status = 401;
        error.code = 'NO_TOKEN';
        throw error;
    }

    let lastError = null;
    for (const [source, token] of candidates) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (!user) {
                const error = new Error('Invalid token. User not found.');
                error.status = 401;
                error.code = 'USER_NOT_FOUND';
                throw error;
            }
            req.authTokenSource = source;
            return user;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Invalid token.');
};

// Verify JWT token
const authenticateToken = async (req, res, next) => {
    try {
        if (!process.env.JWT_SECRET) {
            return res.status(500).json({
                success: false,
                error: 'Server authentication is not configured (JWT_SECRET missing).'
            });
        }

        req.user = await authenticateFromCandidates(req);
        next();
    } catch (error) {
        // Debug in non-production to diagnose unexpected 403s
        if ((process.env.NODE_ENV || 'development') !== 'production') {
            console.warn('authenticateToken failed:', {
                name: error.name,
                message: error.message,
                hasAuthHeader: !!req.headers['authorization'],
                hasAuthCookie: !!getTokenFromCookie(req),
                authHeaderPrefix: (req.headers['authorization'] || '').slice(0, 20)
            });
        }

        if (error.code === 'NO_TOKEN') {
            return res.status(401).json({
                success: false,
                error: 'Access denied. No token provided.'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                success: false, 
                error: 'Token expired. Please login again.' 
            });
        }
        return res.status(403).json({ 
            success: false, 
            error: 'Invalid token.' 
        });
    }
};

// Verify JWT token (allows token in query string for audio playback)
const authenticateTokenAllowQuery = async (req, res, next) => {
    try {
        if (!process.env.JWT_SECRET) {
            return res.status(500).json({
                success: false,
                error: 'Server authentication is not configured (JWT_SECRET missing).'
            });
        }

        req.user = await authenticateFromCandidates(req, { allowQuery: true });
        next();
    } catch (error) {
        if ((process.env.NODE_ENV || 'development') !== 'production') {
            console.warn('authenticateTokenAllowQuery failed:', {
                name: error.name,
                message: error.message,
                hasAuthHeader: !!req.headers['authorization'],
                hasAuthCookie: !!getTokenFromCookie(req),
                hasQueryToken: !!getTokenFromQuery(req)
            });
        }

        if (error.code === 'NO_TOKEN') {
            return res.status(401).json({
                success: false,
                error: 'Access denied. No token provided.'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Token expired. Please login again.'
            });
        }
        return res.status(403).json({
            success: false,
            error: 'Invalid token.'
        });
    }
};

// Check if user is admin or superadmin
const requireAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ 
            success: false, 
            error: 'Authentication required.' 
        });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ 
            success: false, 
            error: 'Admin access required.' 
        });
    }

    next();
};

// Check if user is superadmin
const requireSuperAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ 
            success: false, 
            error: 'Authentication required.' 
        });
    }

    if (req.user.role !== 'superadmin') {
        return res.status(403).json({ 
            success: false, 
            error: 'Super Admin access required.' 
        });
    }

    next();
};

// Optional authentication (doesn't fail if no token)
const optionalAuth = async (req, res, next) => {
    try {
        if (getTokenCandidates(req).length) {
            req.user = await authenticateFromCandidates(req);
        }
    } catch (error) {
        // Ignore token errors for optional auth
    }
    next();
};

// Generate JWT token
const generateToken = (user) => {
    return jwt.sign(
        { 
            id: user.id, 
            email: user.email,
            role: user.role 
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );
};

// Generate refresh token
const generateRefreshToken = (user) => {
    return jwt.sign(
        { id: user.id, type: 'refresh' },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
};

module.exports = {
    authenticateToken,
    authenticateTokenAllowQuery,
    requireAdmin,
    requireSuperAdmin,
    optionalAuth,
    generateToken,
    generateRefreshToken,
    setAuthCookies,
    clearAuthCookies,
    _internal: {
        AUTH_COOKIE_NAME,
        AUTH_MARKER_COOKIE_NAME,
        parseCookieHeader,
        getTokenFromCookie,
        getTokenFromRequest,
        getTokenCandidates
    }
};
