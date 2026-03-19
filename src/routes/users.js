const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  listUsers,
  createUser,
  updateUser,
  changePassword,
  deleteUser,
  updateTimezone,
} = require('../controllers/userController');

router.use(authenticate);

router.get('/', requireAdmin, listUsers);
router.post('/', requireAdmin, createUser);
router.put('/:id', updateUser);
router.put('/:id/password', changePassword);
router.delete('/:id', requireAdmin, deleteUser);
router.put('/me/timezone', updateTimezone);

module.exports = router;
