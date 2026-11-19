const express = require('express');
const authenticateToken = require('../../middleware/auth.middleware');
const {
  getItems,
  listStandards,
  createStandard,
} = require('../../controller/StandardUnitManHours/standardUnitManHours.controller');

const router = express.Router();

router.get('/items', authenticateToken, getItems);
router.get('/', authenticateToken, listStandards);
router.post('/', authenticateToken, createStandard);

module.exports = router;
