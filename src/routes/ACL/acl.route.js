const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/auth.middleware');
const { isSuperAdmin } = require('../../middleware/super-admin');
const aclController = require('../../controller/ACL/acl.controller');



router.get('/employees', authenticateToken, isSuperAdmin, aclController.getEmployees);
router.get('/employees/:empid', authenticateToken, isSuperAdmin, aclController.getEmployeeById);
router.get('/permissions', authenticateToken, isSuperAdmin, aclController.getPermissions);
router.post('/permissions', authenticateToken, isSuperAdmin, aclController.addPermission);
router.put('/permissions/:id', authenticateToken, isSuperAdmin, aclController.updatePermission);
router.delete('/permissions/:id', authenticateToken, isSuperAdmin, aclController.deletePermission);

router.get('/user-permissions/:empid', authenticateToken, isSuperAdmin, aclController.getUserPermissions);
router.post('/user-permissions/:empid', authenticateToken, isSuperAdmin, aclController.saveUserPermissions);

module.exports = router;
