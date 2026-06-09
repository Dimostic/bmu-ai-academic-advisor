const { body, validationResult } = require('express-validator');

// Handle validation errors
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            errors: errors.array().map(err => ({
                field: err.path,
                message: err.msg
            }))
        });
    }
    next();
};

// Registration validation rules
const registerValidation = [
    body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail()
        .custom((value, { req }) => {
            // Check if email is from university domain (for staff) or allow alternate for admin
            const universityDomain = process.env.UNIVERSITY_DOMAIN || 'bmu.edu.ng';
            const isUniversityEmail = value.endsWith(`@${universityDomain}`);
            
            // If role is not specified or is 'staff', must use university email
            if (!req.body.role || req.body.role === 'staff') {
                if (!isUniversityEmail) {
                    throw new Error(`Staff must register with a @${universityDomain} email address`);
                }
            }
            return true;
        }),
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
        .withMessage('Password must contain uppercase, lowercase, number, and special character'),
    body('firstName')
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('First name must be between 2 and 50 characters'),
    body('lastName')
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('Last name must be between 2 and 50 characters'),
    body('phone')
        .optional()
        .matches(/^\+?[\d\s-]{10,}$/)
        .withMessage('Please provide a valid phone number'),
    body('department')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Department name too long'),
    handleValidationErrors
];

// Login validation rules
const loginValidation = [
    body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
    body('password')
        .notEmpty()
        .withMessage('Password is required'),
    handleValidationErrors
];

// Password change validation rules
const passwordChangeValidation = [
    body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
    body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
        .withMessage('Password must contain uppercase, lowercase, number, and special character')
        .custom((value, { req }) => {
            if (value === req.body.currentPassword) {
                throw new Error('New password must be different from current password');
            }
            return true;
        }),
    body('confirmPassword')
        .custom((value, { req }) => {
            if (value !== req.body.newPassword) {
                throw new Error('Password confirmation does not match');
            }
            return true;
        }),
    handleValidationErrors
];

// Password reset request validation
const passwordResetRequestValidation = [
    body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
    handleValidationErrors
];

// Password reset validation
const passwordResetValidation = [
    body('token')
        .notEmpty()
        .withMessage('Reset token is required'),
    body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
        .withMessage('Password must contain uppercase, lowercase, number, and special character'),
    handleValidationErrors
];

// Document upload validation
const documentValidation = [
    body('title')
        .trim()
        .isLength({ min: 3, max: 255 })
        .withMessage('Title must be between 3 and 255 characters'),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('Description too long'),
    body('category')
        .optional()
        .isIn(['policy', 'regulation', 'academic', 'administrative', 'legal', 'general'])
        .withMessage('Invalid category'),
    body('tags')
        .optional()
        .isArray()
        .withMessage('Tags must be an array'),
    handleValidationErrors
];

// Chat message validation
const chatMessageValidation = [
    body('message')
        .trim()
        .isLength({ min: 1, max: 5000 })
        .withMessage('Message must be between 1 and 5000 characters'),
    body('sessionToken')
        .optional()
        .isUUID()
        .withMessage('Invalid session token'),
    handleValidationErrors
];

// Profile update validation
const profileUpdateValidation = [
    body('firstName')
        .optional()
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('First name must be between 2 and 50 characters'),
    body('lastName')
        .optional()
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('Last name must be between 2 and 50 characters'),
    body('phone')
        .optional()
        .matches(/^\+?[\d\s-]{10,}$/)
        .withMessage('Please provide a valid phone number'),
    body('department')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Department name too long'),
    body('whatsappNumber')
        .optional()
        .matches(/^\+?[\d\s-]{10,}$/)
        .withMessage('Please provide a valid WhatsApp number'),
    handleValidationErrors
];

module.exports = {
    registerValidation,
    loginValidation,
    passwordChangeValidation,
    passwordResetRequestValidation,
    passwordResetValidation,
    documentValidation,
    chatMessageValidation,
    profileUpdateValidation,
    handleValidationErrors
};
