const router = require('express').Router();
const { login, getMe } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.post('/login', login);
router.get('/me', authenticate, getMe);

module.exports = router;
