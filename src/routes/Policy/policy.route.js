const express = require('express');
const multer = require('multer');
const authenticateToken = require('../../middleware/auth.middleware');
const {
  listPolicies,
  createPolicy,
  getPolicyFileUrl,
  deletePolicy,
} = require('../../controller/Policy/policy.controller');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const type = String(file.mimetype || '').toLowerCase();
    const allowed =
      type === 'application/pdf' ||
      type.startsWith('image/') ||
      name.endsWith('.pdf') ||
      /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i.test(name);
    if (!allowed) {
      return cb(new Error('Only PDF or image files are allowed'));
    }
    return cb(null, true);
  },
});

router.get('/', authenticateToken, listPolicies);
router.post('/', authenticateToken, upload.single('file'), createPolicy);
router.get('/:id/file-url', authenticateToken, getPolicyFileUrl);
router.delete('/:id', authenticateToken, deletePolicy);

module.exports = router;
