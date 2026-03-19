const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getStatus,
  connect,
  disconnect,
  getGroups,
  syncGroups,
  getAllStatuses,
  getGroupsWithPics,
  getContacts,
  getGroupMembers,
} = require('../controllers/whatsappController');

router.use(authenticate);

router.get('/status', getStatus);
router.post('/connect', connect);
router.post('/disconnect', disconnect);
router.get('/groups', getGroups);
router.post('/groups/sync', syncGroups);
router.get('/status/all', getAllStatuses);
router.get('/groups/with-pics', getGroupsWithPics); 
router.get('/groups/:jid/members', getGroupMembers);
router.get('/contacts', getContacts);

module.exports = router;
