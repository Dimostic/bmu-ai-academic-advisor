const jwt = require('jsonwebtoken');
const User = require('../models/User');

const getTokenFromHeader = (req) => {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.split(' ')[1];
};

const getTokenFromQuery = (req) => {
    const token = req.query && req.query.token;
    if (typeof token !== 'string') return null;
    const trimmed = token.trim();
    return trimmed ? trimmed : null;
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

        const token = getTokenFromHeader(req); // Bearer TOKEN

        if (!token) {
            return res.status(401).json({ 
                success: false, 
                error: 'Access denied. No token provided.' 
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid token. User not found.' 
            });
        }

        req.user = user;
        next();
    } catch (error) {
        // Debug in non-production to diagnose unexpected 403s
        if ((process.env.NODE_ENV || 'development') !== 'production') {
            console.warn('authenticateToken failed:', {
                name: error.name,
                message: error.message,
                hasAuthHeader: !!req.headers['authorization'],
                authHeaderPrefix: (req.headers['authorization'] || '').slice(0, 20)
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

        const token = getTokenFromHeader(req) || getTokenFromQuery(req);

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Access denied. No token provided.'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Invalid token. User not found.'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        if ((process.env.NODE_ENV || 'development') !== 'production') {
            console.warn('authenticateTokenAllowQuery failed:', {
                name: error.name,
                message: error.message,
                hasAuthHeader: !!req.headers['authorization'],
                hasQueryToken: !!getTokenFromQuery(req)
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
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user) {
                req.user = user;
            }
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
    generateRefreshToken
};
