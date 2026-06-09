const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// Ensure upload directories exist
const createUploadDirs = () => {
    const dirs = [
        path.join(__dirname, '../../uploads'),
        path.join(__dirname, '../../uploads/documents'),
        path.join(__dirname, '../../uploads/audio'),
        path.join(__dirname, '../../uploads/temp')
    ];
    
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
};

createUploadDirs();

// Document storage configuration
const documentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '../../uploads/documents'));
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

// Audio storage configuration
const audioStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '../../uploads/audio'));
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

// Allowed document types
const documentFileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain',
        'text/csv',
        'application/rtf'
    ];

    const allowedExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.rtf'];
    const ext = path.extname(file.originalname).toLowerCase();

    const isAllowedExt = allowedExtensions.includes(ext);
    const isAllowedMime = allowedTypes.includes(file.mimetype);
    const isGenericMime = file.mimetype === 'application/octet-stream' || file.mimetype === 'binary/octet-stream';

    if (isAllowedExt && (isAllowedMime || isGenericMime)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Allowed types: PDF, DOC, DOCX, XLS, XLSX, TXT, CSV, RTF'), false);
    }
};

// Allowed audio types
const audioFileFilter = (req, file, cb) => {
    const allowedTypes = [
        'audio/mpeg',
        'audio/mp3',
        'audio/wav',
        'audio/webm',
        'audio/ogg',
        'audio/m4a'
    ];

    const allowedExtensions = ['.mp3', '.wav', '.webm', '.ogg', '.m4a'];
    const ext = path.extname(file.originalname).toLowerCase();

    const isAllowedExt = allowedExtensions.includes(ext);
    const isAllowedMime = allowedTypes.includes(file.mimetype);
    const isGenericMime = file.mimetype === 'application/octet-stream' || file.mimetype === 'binary/octet-stream';

    if (isAllowedExt && (isAllowedMime || isGenericMime)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid audio file type. Allowed types: MP3, WAV, WEBM, OGG, M4A'), false);
    }
};

const MAX_DOCUMENT_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800;
const MAX_DOCUMENT_SIZE_MB = Math.max(1, Math.round(MAX_DOCUMENT_SIZE / (1024 * 1024)));

// Document upload middleware
const uploadDocument = multer({
    storage: documentStorage,
    fileFilter: documentFileFilter,
    limits: {
        fileSize: MAX_DOCUMENT_SIZE
    }
});

// Audio upload middleware
const uploadAudio = multer({
    storage: audioStorage,
    fileFilter: audioFileFilter,
    limits: {
        fileSize: 10485760 // 10MB for audio
    }
});

// Handle multer errors
const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                error: `File too large. Maximum size allowed is ${MAX_DOCUMENT_SIZE_MB}MB for documents and 10MB for audio.`
            });
        }
        return res.status(400).json({
            success: false,
            error: `Upload error: ${err.message}`
        });
    }
    if (err) {
        return res.status(400).json({
            success: false,
            error: err.message
        });
    }
    next();
};

module.exports = {
    uploadDocument,
    uploadAudio,
    handleUploadError
};
