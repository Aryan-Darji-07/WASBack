const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const {
  listMessages,
  createMessage,
  sendNow,
  updateMessage,
  deleteMessage,
  triggerNow,
} = require('../controllers/messageController');

router.use(authenticate);

router.get('/', listMessages);
router.post('/', upload.single('media'), createMessage);
router.post('/send-now', upload.single('media'), sendNow);
router.put('/:id', updateMessage);
router.delete('/:id', deleteMessage);
router.post('/trigger', triggerNow);

module.exports = router;
