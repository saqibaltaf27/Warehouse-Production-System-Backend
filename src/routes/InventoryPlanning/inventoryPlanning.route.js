const express = require('express');
const authenticateToken = require('../../middleware/auth.middleware');
const { getRawMaterials } = require('../../controller/InventoryPlanning/inventoryPlanning.controller');

const router = express.Router();

router.get('/raw-materials', authenticateToken, getRawMaterials);

module.exports = router;
